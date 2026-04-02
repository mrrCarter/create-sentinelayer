import { setTimeout as sleep } from "node:timers/promises";

export const DEFAULT_REQUEST_TIMEOUT_MS = 20_000;
export const DEFAULT_REQUEST_MAX_ATTEMPTS = 3;
export const DEFAULT_REQUEST_RETRY_BACKOFF_MS = 250;
const CIRCUIT_BREAKER_FAILURE_THRESHOLD = 3;
const CIRCUIT_BREAKER_COOLDOWN_MS = 30_000;

const RETRYABLE_STATUS_CODES = new Set([408, 425, 429, 500, 502, 503, 504]);

const circuitBreakerState = {
  consecutiveFailures: 0,
  openedAtEpochMs: 0,
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
  constructor(message, { status = 500, code = "UNKNOWN", requestId = null } = {}) {
    super(String(message || "Sentinelayer API error"));
    this.name = "SentinelayerApiError";
    this.status = Number(status || 500);
    this.code = String(code || "UNKNOWN");
    this.requestId = requestId ? String(requestId) : null;
  }
}

function normalizePositiveInteger(rawValue, fallbackValue) {
  const normalized = Number(rawValue);
  if (!Number.isFinite(normalized) || normalized <= 0) {
    return fallbackValue;
  }
  return Math.floor(normalized);
}

function normalizeUnknownError(error) {
  if (error instanceof SentinelayerApiError) {
    return error;
  }
  if (error && typeof error === "object" && error.name === "AbortError") {
    return new SentinelayerApiError("Request timed out.", {
      status: 408,
      code: "TIMEOUT",
    });
  }
  return new SentinelayerApiError(
    error instanceof Error ? error.message : String(error || "Request failed"),
    {
      status: 503,
      code: "NETWORK_ERROR",
    }
  );
}

function resetCircuitBreaker() {
  circuitBreakerState.consecutiveFailures = 0;
  circuitBreakerState.openedAtEpochMs = 0;
}

export function __resetAuthHttpCircuitBreakerForTests() {
  resetCircuitBreaker();
}

function registerCircuitFailure(nowEpochMs = Date.now()) {
  circuitBreakerState.consecutiveFailures += 1;
  if (
    circuitBreakerState.consecutiveFailures >= CIRCUIT_BREAKER_FAILURE_THRESHOLD &&
    !circuitBreakerState.openedAtEpochMs
  ) {
    circuitBreakerState.openedAtEpochMs = nowEpochMs;
  }
}

function isCircuitOpen(nowEpochMs = Date.now()) {
  if (!circuitBreakerState.openedAtEpochMs) {
    return false;
  }
  const elapsedMs = nowEpochMs - circuitBreakerState.openedAtEpochMs;
  if (elapsedMs >= CIRCUIT_BREAKER_COOLDOWN_MS) {
    resetCircuitBreaker();
    return false;
  }
  return true;
}

function shouldRetry(error) {
  if (!(error instanceof SentinelayerApiError)) {
    return false;
  }
  return RETRYABLE_STATUS_CODES.has(Number(error.status || 0));
}

function getRetryDelayMs(attemptIndex, retryBackoffMs) {
  const base = normalizePositiveInteger(retryBackoffMs, DEFAULT_REQUEST_RETRY_BACKOFF_MS);
  const delay = base * (2 ** Math.max(0, attemptIndex));
  return Math.min(delay, 2_000);
}

export async function requestJson(
  url,
  {
    method = "GET",
    headers = {},
    body,
    timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS,
    maxAttempts = DEFAULT_REQUEST_MAX_ATTEMPTS,
    retryBackoffMs = DEFAULT_REQUEST_RETRY_BACKOFF_MS,
    fetchImpl = fetch,
  } = {}
) {
  if (isCircuitOpen()) {
    throw new SentinelayerApiError("Upstream circuit breaker is open. Retry after cooldown.", {
      status: 503,
      code: "CIRCUIT_OPEN",
    });
  }

  const attempts = normalizePositiveInteger(maxAttempts, DEFAULT_REQUEST_MAX_ATTEMPTS);
  const normalizedTimeoutMs = normalizePositiveInteger(timeoutMs, DEFAULT_REQUEST_TIMEOUT_MS);

  for (let attemptIndex = 0; attemptIndex < attempts; attemptIndex += 1) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), normalizedTimeoutMs);

    try {
      const response = await fetchImpl(String(url), {
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
          throw new SentinelayerApiError("Invalid JSON returned by API.", {
            status: response.status,
            code: "INVALID_JSON",
          });
        }
      }

      if (!response.ok) {
        const apiError = normalizeApiError(json && typeof json === "object" ? json.error : {});
        throw new SentinelayerApiError(apiError.message, {
          status: response.status,
          code: apiError.code,
          requestId: apiError.requestId,
        });
      }

      resetCircuitBreaker();
      return json;
    } catch (error) {
      const normalizedError = normalizeUnknownError(error);
      if (shouldRetry(normalizedError) && attemptIndex < attempts - 1) {
        await sleep(getRetryDelayMs(attemptIndex, retryBackoffMs));
        continue;
      }

      registerCircuitFailure();
      throw normalizedError;
    } finally {
      clearTimeout(timeout);
      await sleep(0);
    }
  }

  registerCircuitFailure();
  throw new SentinelayerApiError("Request failed after retry attempts.", {
    status: 503,
    code: "MAX_RETRIES_EXHAUSTED",
  });
}
