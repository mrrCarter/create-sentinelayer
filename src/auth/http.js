import { setTimeout as sleep } from "node:timers/promises";

/**
 * Default timeout applied to Sentinelayer API requests when no override is provided.
 * @type {number}
 */
export const DEFAULT_REQUEST_TIMEOUT_MS = 20_000;
export const DEFAULT_MAX_RETRIES = 2;
export const DEFAULT_RETRY_DELAY_MS = 250;
export const MAX_RETRY_DELAY_MS = 2_000;
export const CIRCUIT_BREAKER_THRESHOLD = 5;
export const CIRCUIT_BREAKER_COOLDOWN_MS = 30_000;

const RETRYABLE_STATUS_CODES = new Set([408, 425, 429, 500, 502, 503, 504]);
const CIRCUIT_TRACK_STATUS_CODES = new Set([401, 403, 408, 425, 429, 500, 502, 503, 504]);
const circuitState = {
  consecutiveFailures: 0,
  openedAtMs: 0,
};

function normalizeApiError(errorPayload = {}) {
  if (!errorPayload || typeof errorPayload !== "object" || Array.isArray(errorPayload)) {
    return {
      code: "UNKNOWN",
      message: "Unknown API error",
      requestId: null,
    };
  }
  return {
    code: String(errorPayload.code || "UNKNOWN"),
    message: String(errorPayload.message || "Unknown API error"),
    requestId: errorPayload.request_id ? String(errorPayload.request_id) : null,
  };
}

export class SentinelayerApiError extends Error {
  /**
   * @param {string} message
   * @param {{ status?: number, code?: string, requestId?: string | null }} [options]
   */
  constructor(message, { status = 500, code = "UNKNOWN", requestId = null } = {}) {
    super(String(message || "Sentinelayer API error"));
    this.name = "SentinelayerApiError";
    this.status = Number(status || 500);
    this.code = String(code || "UNKNOWN");
    this.requestId = requestId ? String(requestId) : null;
  }
}

function normalizePositiveNumber(value, fallback) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallback;
  }
  return parsed;
}

function normalizeNonNegativeInteger(value, fallback) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) {
    return fallback;
  }
  return Math.floor(parsed);
}

function parseRetryAfterMs(value) {
  const raw = String(value || "").trim();
  if (!raw) {
    return null;
  }
  const seconds = Number(raw);
  if (Number.isFinite(seconds) && seconds >= 0) {
    return Math.round(seconds * 1000);
  }
  const parsedDate = Date.parse(raw);
  if (Number.isFinite(parsedDate)) {
    const delta = parsedDate - Date.now();
    if (delta > 0) {
      return delta;
    }
  }
  return null;
}

function computeBackoffMs({ attempt, retryDelayMs, retryAfterHeader }) {
  const retryAfterMs = parseRetryAfterMs(retryAfterHeader);
  if (retryAfterMs !== null) {
    return Math.min(retryAfterMs, MAX_RETRY_DELAY_MS);
  }
  const exponent = Math.max(0, Number(attempt) - 1);
  const computed = Math.round(retryDelayMs * Math.pow(2, exponent));
  return Math.min(Math.max(1, computed), MAX_RETRY_DELAY_MS);
}

function isCircuitOpen() {
  if (circuitState.openedAtMs <= 0) {
    return false;
  }
  if (Date.now() - circuitState.openedAtMs >= CIRCUIT_BREAKER_COOLDOWN_MS) {
    circuitState.openedAtMs = 0;
    circuitState.consecutiveFailures = 0;
    return false;
  }
  return true;
}

function recordFailureForCircuit() {
  circuitState.consecutiveFailures += 1;
  if (circuitState.consecutiveFailures >= CIRCUIT_BREAKER_THRESHOLD) {
    circuitState.openedAtMs = Date.now();
  }
}

function recordSuccessForCircuit() {
  circuitState.consecutiveFailures = 0;
  circuitState.openedAtMs = 0;
}

function shouldRetryStatus(statusCode) {
  return RETRYABLE_STATUS_CODES.has(Number(statusCode || 0));
}

function shouldRecordFailureForStatus(statusCode) {
  return CIRCUIT_TRACK_STATUS_CODES.has(Number(statusCode || 0));
}

export function __resetRequestCircuitForTests() {
  circuitState.consecutiveFailures = 0;
  circuitState.openedAtMs = 0;
}

/**
 * Execute an HTTP request against the Sentinelayer API and parse a JSON response.
 * Throws `SentinelayerApiError` for transport errors, timeouts, API failures, and invalid JSON.
 *
 * @param {string} url
 * @param {{
 *   method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE",
 *   headers?: Record<string, string>,
 *   body?: unknown,
 *   timeoutMs?: number
 *   maxRetries?: number,
 *   retryDelayMs?: number
 * }} [options]
 * @returns {Promise<any>}
 */
export async function requestJson(
  url,
  {
    method = "GET",
    headers = {},
    body,
    timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS,
    maxRetries = DEFAULT_MAX_RETRIES,
    retryDelayMs = DEFAULT_RETRY_DELAY_MS,
  } = {}
) {
  if (isCircuitOpen()) {
    throw new SentinelayerApiError("Request circuit breaker is open after consecutive API failures.", {
      status: 503,
      code: "CIRCUIT_OPEN",
    });
  }

  const normalizedTimeoutMs = normalizePositiveNumber(timeoutMs, DEFAULT_REQUEST_TIMEOUT_MS);
  const normalizedMaxRetries = normalizeNonNegativeInteger(maxRetries, DEFAULT_MAX_RETRIES);
  const normalizedRetryDelayMs = normalizePositiveNumber(retryDelayMs, DEFAULT_RETRY_DELAY_MS);

  let lastRetryableError = null;
  for (let attempt = 0; attempt <= normalizedMaxRetries; attempt += 1) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), normalizedTimeoutMs);

    try {
      const response = await fetch(String(url), {
        method,
        headers: {
          "Content-Type": "application/json",
          ...headers,
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: controller.signal,
      });

      const rawBody = await response.text();
      let json = {};
      if (rawBody.trim()) {
        try {
          json = JSON.parse(rawBody);
        } catch {
          if (response.ok) {
            throw new SentinelayerApiError("Invalid JSON returned by API.", {
              status: response.status,
              code: "INVALID_JSON",
            });
          }
        }
      }

      if (response.ok) {
        recordSuccessForCircuit();
        return json;
      }

      const apiError = normalizeApiError(json && typeof json === "object" ? json.error : {});
      const statusCode = Number(response.status || 500);
      const retryable = shouldRetryStatus(statusCode);
      const shouldRecordCircuitFailure = shouldRecordFailureForStatus(statusCode);
      const error = new SentinelayerApiError(apiError.message, {
        status: statusCode,
        code: apiError.code,
        requestId: apiError.requestId,
      });

      if (!retryable || attempt >= normalizedMaxRetries) {
        if (shouldRecordCircuitFailure) {
          recordFailureForCircuit();
        }
        throw error;
      }

      lastRetryableError = error;
      const delayMs = computeBackoffMs({
        attempt: attempt + 1,
        retryDelayMs: normalizedRetryDelayMs,
        retryAfterHeader: response.headers.get("retry-after"),
      });
      await sleep(delayMs);
      continue;
    } catch (error) {
      if (error instanceof SentinelayerApiError) {
        throw error;
      }

      const isAbortError = Boolean(error && typeof error === "object" && error.name === "AbortError");
      const normalizedError = new SentinelayerApiError(
        isAbortError ? "Request timed out." : (error instanceof Error ? error.message : String(error || "Request failed")),
        {
          status: isAbortError ? 408 : 503,
          code: isAbortError ? "TIMEOUT" : "NETWORK_ERROR",
        }
      );

      if (attempt >= normalizedMaxRetries) {
        recordFailureForCircuit();
        throw normalizedError;
      }

      lastRetryableError = normalizedError;
      const delayMs = computeBackoffMs({
        attempt: attempt + 1,
        retryDelayMs: normalizedRetryDelayMs,
        retryAfterHeader: null,
      });
      await sleep(delayMs);
      continue;
    } finally {
      clearTimeout(timeout);
      await sleep(0);
    }
  }

  if (lastRetryableError instanceof SentinelayerApiError) {
    throw lastRetryableError;
  }
  throw new SentinelayerApiError("Request failed without a terminal response.", {
    status: 503,
    code: "NETWORK_ERROR",
  });
}
