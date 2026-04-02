import { setTimeout as sleep } from "node:timers/promises";

export const DEFAULT_REQUEST_TIMEOUT_MS = 20_000;
export const DEFAULT_REQUEST_MAX_ATTEMPTS = 3;
export const DEFAULT_REQUEST_RETRY_BACKOFF_MS = 250;
const CIRCUIT_BREAKER_FAILURE_THRESHOLD = 3;
const CIRCUIT_BREAKER_COOLDOWN_MS = 30_000;
const CIRCUIT_BREAKER_STALE_WINDOW_MS = CIRCUIT_BREAKER_COOLDOWN_MS * 4;
const MAX_CIRCUIT_BREAKER_BUCKETS = 64;

const RETRYABLE_STATUS_CODES = new Set([408, 425, 429, 500, 502, 503, 504]);
const MAX_RETRY_AFTER_DELAY_MS = 15_000;

const circuitBreakerStates = new Map();

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
  constructor(message, { status = 500, code = "UNKNOWN", requestId = null, retryAfterMs = null } = {}) {
    super(String(message || "Sentinelayer API error"));
    this.name = "SentinelayerApiError";
    this.status = Number(status || 500);
    this.code = String(code || "UNKNOWN");
    this.requestId = requestId ? String(requestId) : null;
    this.retryAfterMs = Number.isFinite(Number(retryAfterMs)) ? Number(retryAfterMs) : null;
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

function resolveCircuitBreakerScope(url) {
  try {
    return new URL(String(url)).origin;
  } catch {
    return "global";
  }
}

function createCircuitBreakerState(nowEpochMs = Date.now()) {
  return {
    consecutiveFailures: 0,
    openedAtEpochMs: 0,
    touchedAtEpochMs: nowEpochMs,
  };
}

function getCircuitBreakerState(scope, nowEpochMs = Date.now()) {
  const normalizedScope = String(scope || "global");
  const existing = circuitBreakerStates.get(normalizedScope);
  if (existing) {
    existing.touchedAtEpochMs = nowEpochMs;
    return existing;
  }
  const created = createCircuitBreakerState(nowEpochMs);
  circuitBreakerStates.set(normalizedScope, created);
  return created;
}

function pruneCircuitBreakerStates(nowEpochMs = Date.now()) {
  for (const [scope, state] of circuitBreakerStates.entries()) {
    if (nowEpochMs - Number(state.touchedAtEpochMs || 0) > CIRCUIT_BREAKER_STALE_WINDOW_MS) {
      circuitBreakerStates.delete(scope);
    }
  }
  if (circuitBreakerStates.size <= MAX_CIRCUIT_BREAKER_BUCKETS) {
    return;
  }
  const entries = Array.from(circuitBreakerStates.entries()).sort(
    (a, b) => Number(a[1].touchedAtEpochMs || 0) - Number(b[1].touchedAtEpochMs || 0)
  );
  for (const [scope] of entries) {
    circuitBreakerStates.delete(scope);
    if (circuitBreakerStates.size <= MAX_CIRCUIT_BREAKER_BUCKETS) {
      break;
    }
  }
}

function resetCircuitBreaker(scope = null, nowEpochMs = Date.now()) {
  if (!scope) {
    circuitBreakerStates.clear();
    return;
  }
  const state = getCircuitBreakerState(scope, nowEpochMs);
  state.consecutiveFailures = 0;
  state.openedAtEpochMs = 0;
  state.touchedAtEpochMs = nowEpochMs;
  pruneCircuitBreakerStates(nowEpochMs);
}

export function __resetAuthHttpCircuitBreakerForTests() {
  resetCircuitBreaker();
}

function registerCircuitFailure(scope, nowEpochMs = Date.now()) {
  const state = getCircuitBreakerState(scope, nowEpochMs);
  state.consecutiveFailures += 1;
  state.touchedAtEpochMs = nowEpochMs;
  if (
    state.consecutiveFailures >= CIRCUIT_BREAKER_FAILURE_THRESHOLD &&
    !state.openedAtEpochMs
  ) {
    state.openedAtEpochMs = nowEpochMs;
  }
  pruneCircuitBreakerStates(nowEpochMs);
}

function isCircuitOpen(scope, nowEpochMs = Date.now()) {
  const state = getCircuitBreakerState(scope, nowEpochMs);
  if (!state.openedAtEpochMs) {
    return false;
  }
  const elapsedMs = nowEpochMs - state.openedAtEpochMs;
  if (elapsedMs >= CIRCUIT_BREAKER_COOLDOWN_MS) {
    resetCircuitBreaker(scope, nowEpochMs);
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

function parseRetryAfterDelayMs(rawValue) {
  const normalized = String(rawValue || "").trim();
  if (!normalized) {
    return null;
  }

  if (/^\d+$/.test(normalized)) {
    const seconds = Number(normalized);
    if (!Number.isFinite(seconds) || seconds < 0) {
      return null;
    }
    return Math.min(Math.round(seconds * 1000), MAX_RETRY_AFTER_DELAY_MS);
  }

  const retryEpoch = Date.parse(normalized);
  if (!Number.isFinite(retryEpoch)) {
    return null;
  }
  const delayMs = Math.max(0, retryEpoch - Date.now());
  return Math.min(delayMs, MAX_RETRY_AFTER_DELAY_MS);
}

function getRetryDelayMs(attemptIndex, retryBackoffMs, retryAfterMs = null) {
  if (Number.isFinite(Number(retryAfterMs)) && Number(retryAfterMs) > 0) {
    return Math.min(Math.round(Number(retryAfterMs)), MAX_RETRY_AFTER_DELAY_MS);
  }
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
  const circuitScope = resolveCircuitBreakerScope(url);
  if (isCircuitOpen(circuitScope)) {
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
        const retryAfterMs = parseRetryAfterDelayMs(response.headers.get("retry-after"));
        throw new SentinelayerApiError(apiError.message, {
          status: response.status,
          code: apiError.code,
          requestId: apiError.requestId,
          retryAfterMs,
        });
      }

      resetCircuitBreaker(circuitScope);
      return json;
    } catch (error) {
      const normalizedError = normalizeUnknownError(error);
      registerCircuitFailure(circuitScope);
      if (shouldRetry(normalizedError) && attemptIndex < attempts - 1) {
        await sleep(getRetryDelayMs(attemptIndex, retryBackoffMs, normalizedError.retryAfterMs));
        continue;
      }

      throw normalizedError;
    } finally {
      clearTimeout(timeout);
      await sleep(0);
    }
  }

  throw new SentinelayerApiError("Request failed after retry attempts.", {
    status: 503,
    code: "MAX_RETRIES_EXHAUSTED",
  });
}
