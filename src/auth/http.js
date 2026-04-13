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
const circuitStateByScope = new Map();
const REQUEST_ID_HEADERS = ["x-request-id", "request-id", "x-correlation-id"];

function resolveCircuitScope(url) {
  try {
    const parsed = new URL(String(url));
    return parsed.origin;
  } catch {
    return "unknown";
  }
}

function getCircuitState(scope) {
  const key = String(scope || "unknown");
  if (!circuitStateByScope.has(key)) {
    circuitStateByScope.set(key, { consecutiveFailures: 0, openedAtMs: 0 });
  }
  return circuitStateByScope.get(key);
}

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

function resolveRequestId(headers) {
  if (!headers || typeof headers.get !== "function") {
    return null;
  }
  for (const headerName of REQUEST_ID_HEADERS) {
    const value = headers.get(headerName);
    if (value) {
      return String(value);
    }
  }
  return null;
}

function hasIdempotencyKey(headers) {
  if (!headers) {
    return false;
  }
  if (typeof headers.get === "function") {
    const value =
      headers.get("idempotency-key") ||
      headers.get("Idempotency-Key") ||
      headers.get("IDEMPOTENCY-KEY");
    return Boolean(String(value || "").trim());
  }
  if (typeof headers !== "object") {
    return false;
  }
  for (const [key, value] of Object.entries(headers)) {
    if (String(key || "").toLowerCase() === "idempotency-key" && String(value || "").trim()) {
      return true;
    }
  }
  return false;
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

function isCircuitOpen(scope) {
  const circuitState = getCircuitState(scope);
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

function recordFailureForCircuit(scope) {
  const circuitState = getCircuitState(scope);
  circuitState.consecutiveFailures += 1;
  if (circuitState.consecutiveFailures >= CIRCUIT_BREAKER_THRESHOLD) {
    circuitState.openedAtMs = Date.now();
  }
}

function recordSuccessForCircuit(scope) {
  const circuitState = getCircuitState(scope);
  circuitState.consecutiveFailures = 0;
  circuitState.openedAtMs = 0;
}

function shouldRetryStatus(statusCode) {
  return RETRYABLE_STATUS_CODES.has(Number(statusCode || 0));
}

function shouldRecordFailureForStatus(statusCode) {
  return CIRCUIT_TRACK_STATUS_CODES.has(Number(statusCode || 0));
}

export function __resetRequestCircuitForTests(scope) {
  if (scope) {
    const circuitState = getCircuitState(scope);
    circuitState.consecutiveFailures = 0;
    circuitState.openedAtMs = 0;
    return;
  }
  circuitStateByScope.clear();
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
 *   allowEmptyBody?: boolean
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
    allowEmptyBody = false,
  } = {}
) {
  const normalizedMethod = String(method || "GET").trim().toUpperCase();
  const isIdempotentMutation = hasIdempotencyKey(headers);
  const retryableMethod =
    normalizedMethod === "GET" ||
    normalizedMethod === "HEAD" ||
    normalizedMethod === "OPTIONS" ||
    (isIdempotentMutation &&
      (normalizedMethod === "POST" ||
        normalizedMethod === "PUT" ||
        normalizedMethod === "PATCH" ||
        normalizedMethod === "DELETE"));
  const circuitScope = resolveCircuitScope(url);
  if (isCircuitOpen(circuitScope)) {
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
        method: normalizedMethod,
        headers: {
          "Content-Type": "application/json",
          ...headers,
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        redirect: "error",
        signal: controller.signal,
      });

      const rawBody = await response.text();
      const trimmedBody = rawBody.trim();
      const contentType = response.headers.get("content-type") || "";
      const isJson = /application\/json/i.test(contentType);
      let json = {};
      if (!trimmedBody) {
        const statusCode = Number(response.status || 0);
        const allowEmpty = Boolean(allowEmptyBody) || statusCode === 204 || statusCode === 205;
        if (response.ok && !allowEmpty) {
          const requestId = resolveRequestId(response.headers);
          throw new SentinelayerApiError("Empty response body returned by API.", {
            status: response.status,
            code: "EMPTY_BODY",
            requestId,
          });
        }
      } else {
        if (response.ok && !isJson) {
          const requestId = resolveRequestId(response.headers);
          throw new SentinelayerApiError("Invalid content-type returned by API.", {
            status: response.status,
            code: "INVALID_CONTENT_TYPE",
            requestId,
          });
        }
        if (isJson) {
          try {
            json = JSON.parse(rawBody);
          } catch {
            const requestId = resolveRequestId(response.headers);
            if (response.ok) {
              throw new SentinelayerApiError("Invalid JSON returned by API.", {
                status: response.status,
                code: "INVALID_JSON",
                requestId,
              });
            }
          }
        }
      }

      if (response.ok) {
        recordSuccessForCircuit(circuitScope);
        return json;
      }

      const apiError = normalizeApiError(json && typeof json === "object" ? json.error : {});
      const requestId = apiError.requestId || resolveRequestId(response.headers);
      const statusCode = Number(response.status || 500);
      const retryable = retryableMethod && shouldRetryStatus(statusCode);
      const shouldRecordCircuitFailure = shouldRecordFailureForStatus(statusCode);
      const error = new SentinelayerApiError(apiError.message, {
        status: statusCode,
        code: apiError.code,
        requestId,
      });

      if (!retryable || attempt >= normalizedMaxRetries) {
        if (shouldRecordCircuitFailure) {
          recordFailureForCircuit(circuitScope);
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

      if (!retryableMethod || attempt >= normalizedMaxRetries) {
        recordFailureForCircuit(circuitScope);
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
