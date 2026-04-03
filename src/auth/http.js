import { setTimeout as sleep } from "node:timers/promises";
import { createHash, createHmac, randomBytes, randomInt } from "node:crypto";

export const DEFAULT_REQUEST_TIMEOUT_MS = 20_000;
export const DEFAULT_REQUEST_MAX_ATTEMPTS = 3;
export const DEFAULT_REQUEST_RETRY_BACKOFF_MS = 250;
const CIRCUIT_BREAKER_FAILURE_THRESHOLD = 3;
const CIRCUIT_BREAKER_COOLDOWN_MS = 30_000;
const CIRCUIT_BREAKER_STALE_WINDOW_MS = CIRCUIT_BREAKER_COOLDOWN_MS * 4;
const MAX_CIRCUIT_BREAKER_BUCKETS = 64;

const RETRYABLE_STATUS_CODES = new Set([408, 425, 429, 500, 502, 503, 504]);
const MAX_RETRY_AFTER_DELAY_MS = 15_000;
const MAX_EXPONENTIAL_RETRY_DELAY_MS = 15_000;
const MIN_JITTER_RETRY_DELAY_MS = 100;
const RANDOM_JITTER_BUCKETS = 1000;
const MIN_RANDOM_JITTER_RATIO = 0.25;
const MAX_REQUEST_BODY_BYTES = 256_000;
const MAX_RESPONSE_BODY_BYTES = 1_000_000;
const MAX_ERROR_RESPONSE_BODY_BYTES = 128_000;

const circuitBreakerStates = new Map();
let requestJitterFallbackCounter = 0;
const REQUEST_JITTER_STARTUP_SECRET = initializeRequestJitterStartupSecret();

function initializeRequestJitterStartupSecret() {
  try {
    return randomBytes(32);
  } catch {
    return null;
  }
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
    requestId: errorPayload.request_id
      ? String(errorPayload.request_id)
      : errorPayload.requestId
        ? String(errorPayload.requestId)
        : null,
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

function normalizeUnknownError(error, { timedOut = false, externalAbort = false } = {}) {
  if (error instanceof SentinelayerApiError) {
    return error;
  }
  if (error && typeof error === "object" && error.name === "AbortError") {
    if (externalAbort && !timedOut) {
      return new SentinelayerApiError("Request canceled by caller.", {
        status: 499,
        code: "CLIENT_ABORTED",
      });
    }
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
  if (String(error.code || "") === "CLIENT_ABORTED") {
    return false;
  }
  return RETRYABLE_STATUS_CODES.has(Number(error.status || 0));
}

function resolveMonotonicEpochMs() {
  if (
    typeof globalThis.performance === "object" &&
    Number.isFinite(Number(globalThis.performance.timeOrigin)) &&
    typeof globalThis.performance.now === "function"
  ) {
    return Number(globalThis.performance.timeOrigin) + Number(globalThis.performance.now());
  }
  return Date.now();
}

function parseRetryAfterDelayMs(rawValue, responseDateHeader = "") {
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
  const responseDateEpoch = Date.parse(String(responseDateHeader || "").trim());
  let delayMs = null;
  if (Number.isFinite(responseDateEpoch)) {
    delayMs = retryEpoch - responseDateEpoch;
  } else {
    delayMs = retryEpoch - resolveMonotonicEpochMs();
  }
  delayMs = Math.max(0, Number(delayMs || 0));
  return Math.min(delayMs, MAX_RETRY_AFTER_DELAY_MS);
}

function createRequestJitterSeed(url, method = "GET") {
  if (!REQUEST_JITTER_STARTUP_SECRET) {
    throw new SentinelayerApiError("Unable to initialize retry jitter entropy.", {
      status: 500,
      code: "JITTER_ENTROPY_UNAVAILABLE",
    });
  }
  const normalizedMethod = String(method || "GET").trim().toUpperCase();
  const normalizedUrl = String(url || "").trim();
  try {
    const entropy = randomBytes(16).toString("hex");
    return createHmac("sha256", REQUEST_JITTER_STARTUP_SECRET)
      .update(
        [
          "primary",
          normalizedMethod,
          normalizedUrl,
          String(process.pid),
          String(resolveMonotonicEpochMs()),
          entropy,
        ].join(":")
      )
      .digest("hex");
  } catch {
    requestJitterFallbackCounter += 1;
    return createHmac("sha256", REQUEST_JITTER_STARTUP_SECRET)
      .update(
        [
          "fallback",
          normalizedMethod,
          normalizedUrl,
          String(Math.max(0, requestJitterFallbackCounter)),
        ].join(":")
      )
      .digest("hex");
  }
}

function getRetryDelayMs(attemptIndex, retryBackoffMs, retryAfterMs = null, requestJitterSeed = "") {
  if (Number.isFinite(Number(retryAfterMs)) && Number(retryAfterMs) > 0) {
    return Math.min(Math.round(Number(retryAfterMs)), MAX_RETRY_AFTER_DELAY_MS);
  }
  const base = normalizePositiveInteger(retryBackoffMs, DEFAULT_REQUEST_RETRY_BACKOFF_MS);
  const exponentialCap = Math.min(base * (2 ** Math.max(0, attemptIndex)), MAX_EXPONENTIAL_RETRY_DELAY_MS);
  if (exponentialCap <= MIN_JITTER_RETRY_DELAY_MS) {
    return exponentialCap;
  }
  let jitterBucket = 0;
  try {
    jitterBucket = randomInt(0, RANDOM_JITTER_BUCKETS + 1);
  } catch {
    const normalizedSeed = String(requestJitterSeed || "global");
    const fallbackDigest = createHash("sha256")
      .update(`${Math.max(0, attemptIndex)}:${base}:${process.pid}:${normalizedSeed}`)
      .digest();
    jitterBucket = fallbackDigest.readUInt16BE(0) % (RANDOM_JITTER_BUCKETS + 1);
  }
  const jitterRatio =
    MIN_RANDOM_JITTER_RATIO +
    (jitterBucket / RANDOM_JITTER_BUCKETS) * (1 - MIN_RANDOM_JITTER_RATIO);
  const jitteredDelay = Math.round(exponentialCap * jitterRatio);
  return Math.max(MIN_JITTER_RETRY_DELAY_MS, jitteredDelay);
}

function createAbortError() {
  const error = new Error("Request aborted while reading response body.");
  error.name = "AbortError";
  return error;
}

async function readResponseBodyWithLimit(
  response,
  maxBytes = MAX_RESPONSE_BODY_BYTES,
  { timeoutAtEpochMs = null, signal = null } = {}
) {
  const createBodyReadTimeoutError = () =>
    new SentinelayerApiError("Request timed out while reading response body.", {
      status: 408,
      code: "TIMEOUT",
    });

  const resolveRemainingTimeoutMs = () => {
    if (!Number.isFinite(Number(timeoutAtEpochMs))) {
      return null;
    }
    return Math.max(0, Math.floor(Number(timeoutAtEpochMs) - Date.now()));
  };

  const runWithTimeoutBudget = async (operation) => {
    const remainingMs = resolveRemainingTimeoutMs();
    if (remainingMs !== null && remainingMs <= 0) {
      throw createBodyReadTimeoutError();
    }
    const hasAbortSignal =
      signal &&
      typeof signal === "object" &&
      typeof signal.addEventListener === "function" &&
      typeof signal.removeEventListener === "function";
    if (remainingMs === null && !hasAbortSignal) {
      return operation();
    }

    let timerHandle = null;
    let onAbort = null;
    const racers = [operation()];
    if (remainingMs !== null) {
      racers.push(
        new Promise((_, reject) => {
          timerHandle = setTimeout(() => {
            reject(createBodyReadTimeoutError());
          }, remainingMs);
        })
      );
    }
    if (hasAbortSignal) {
      racers.push(
        new Promise((_, reject) => {
          onAbort = () => reject(createAbortError());
          signal.addEventListener("abort", onAbort, { once: true });
          if (signal.aborted) {
            onAbort();
          }
        })
      );
    }

    try {
      return await Promise.race(racers);
    } finally {
      if (timerHandle) {
        clearTimeout(timerHandle);
      }
      if (hasAbortSignal && onAbort) {
        signal.removeEventListener("abort", onAbort);
      }
    }
  };

  const declaredLength = Number(response?.headers?.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
    throw new SentinelayerApiError("API response exceeded maximum allowed size.", {
      status: 502,
      code: "RESPONSE_TOO_LARGE",
    });
  }
  if (!response?.body || typeof response.body.getReader !== "function") {
    const rawBody = await runWithTimeoutBudget(() => response.text());
    if (Buffer.byteLength(rawBody, "utf8") > maxBytes) {
      throw new SentinelayerApiError("API response exceeded maximum allowed size.", {
        status: 502,
        code: "RESPONSE_TOO_LARGE",
      });
    }
    return rawBody;
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let totalBytes = 0;
  let rawBody = "";
  try {
    while (true) {
      const { done, value } = await runWithTimeoutBudget(() => reader.read());
      if (done) {
        break;
      }
      const chunk = value instanceof Uint8Array ? value : new Uint8Array(value || 0);
      totalBytes += chunk.byteLength;
      if (totalBytes > maxBytes) {
        await reader.cancel();
        throw new SentinelayerApiError("API response exceeded maximum allowed size.", {
          status: 502,
          code: "RESPONSE_TOO_LARGE",
        });
      }
      rawBody += decoder.decode(chunk, { stream: true });
    }
  } catch (error) {
    await reader.cancel().catch(() => {});
    throw error;
  }
  rawBody += decoder.decode();
  return rawBody;
}

function isPassThroughBody(body) {
  if (body === undefined || body === null) {
    return false;
  }
  if (typeof body === "string") {
    return true;
  }
  if (body instanceof Uint8Array || body instanceof ArrayBuffer || ArrayBuffer.isView(body)) {
    return true;
  }
  if (typeof URLSearchParams !== "undefined" && body instanceof URLSearchParams) {
    return true;
  }
  if (typeof FormData !== "undefined" && body instanceof FormData) {
    return true;
  }
  if (typeof Blob !== "undefined" && body instanceof Blob) {
    return true;
  }
  return false;
}

function assertRequestBodyWithinLimit(byteLength) {
  const normalizedBytes = Number(byteLength || 0);
  if (normalizedBytes <= MAX_REQUEST_BODY_BYTES) {
    return;
  }
  throw new SentinelayerApiError("Request body exceeded maximum allowed size.", {
    status: 413,
    code: "REQUEST_TOO_LARGE",
  });
}

function serializeRequestBody(body, requestHeaders = {}) {
  if (body === undefined) {
    return undefined;
  }
  if (isPassThroughBody(body)) {
    if (typeof body === "string") {
      assertRequestBodyWithinLimit(Buffer.byteLength(body, "utf8"));
      return body;
    }
    if (body instanceof Uint8Array) {
      assertRequestBodyWithinLimit(body.byteLength);
      return body;
    }
    if (body instanceof ArrayBuffer) {
      assertRequestBodyWithinLimit(body.byteLength);
      return body;
    }
    if (ArrayBuffer.isView(body)) {
      assertRequestBodyWithinLimit(body.byteLength);
      return body;
    }
    if (typeof URLSearchParams !== "undefined" && body instanceof URLSearchParams) {
      assertRequestBodyWithinLimit(Buffer.byteLength(body.toString(), "utf8"));
      return body;
    }
    if (typeof Blob !== "undefined" && body instanceof Blob) {
      assertRequestBodyWithinLimit(body.size);
      return body;
    }
    return body;
  }
  const contentType = String(
    requestHeaders["Content-Type"] || requestHeaders["content-type"] || ""
  )
    .trim()
    .toLowerCase();
  const expectsJson = !contentType || contentType.includes("application/json") || contentType.includes("+json");
  if (expectsJson) {
    let serializedJson = "";
    try {
      serializedJson = JSON.stringify(body);
    } catch {
      throw new SentinelayerApiError("Request body could not be JSON serialized.", {
        status: 400,
        code: "INVALID_REQUEST_BODY",
      });
    }
    assertRequestBodyWithinLimit(Buffer.byteLength(serializedJson, "utf8"));
    return serializedJson;
  }
  const serialized = String(body);
  assertRequestBodyWithinLimit(Buffer.byteLength(serialized, "utf8"));
  return serialized;
}

function composeRequestAbortSignal(controller, signal) {
  if (!signal || typeof signal !== "object") {
    return {
      activeSignal: controller.signal,
      cleanup: () => {},
    };
  }

  if (typeof AbortSignal === "function" && typeof AbortSignal.any === "function") {
    return {
      activeSignal: AbortSignal.any([controller.signal, signal]),
      cleanup: () => {},
    };
  }

  if (
    typeof signal.addEventListener !== "function" ||
    typeof signal.removeEventListener !== "function"
  ) {
    return {
      activeSignal: controller.signal,
      cleanup: () => {},
    };
  }

  const onAbort = () => {
    controller.abort();
  };
  signal.addEventListener("abort", onAbort, { once: true });
  if (signal.aborted) {
    controller.abort();
  }
  return {
    activeSignal: controller.signal,
    cleanup: () => {
      signal.removeEventListener("abort", onAbort);
    },
  };
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
    signal = null,
    fetchImpl = fetch,
  } = {}
) {
  const circuitScope = resolveCircuitBreakerScope(url);
  const requestJitterSeed = createRequestJitterSeed(url, method);
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
    let timedOut = false;
    const timeoutAtEpochMs = Date.now() + normalizedTimeoutMs;
    const timeout = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, normalizedTimeoutMs);
    const { activeSignal, cleanup } = composeRequestAbortSignal(controller, signal);

    try {
      const requestHeaders = {
        Accept: "application/json",
        ...headers,
      };
      const hasExplicitContentType =
        requestHeaders["Content-Type"] !== undefined || requestHeaders["content-type"] !== undefined;
      if (
        body !== undefined &&
        !hasExplicitContentType &&
        !isPassThroughBody(body)
      ) {
        requestHeaders["Content-Type"] = "application/json";
      }
      const requestBody = serializeRequestBody(body, requestHeaders);
      const response = await fetchImpl(String(url), {
        method,
        headers: requestHeaders,
        body: requestBody,
        signal: activeSignal,
      });

      const responseBodyLimit = response.ok ? MAX_RESPONSE_BODY_BYTES : MAX_ERROR_RESPONSE_BODY_BYTES;
      const rawBody = await readResponseBodyWithLimit(response, responseBodyLimit, {
        timeoutAtEpochMs,
        signal: activeSignal,
      });
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
        const retryAfterMs = parseRetryAfterDelayMs(
          response.headers.get("retry-after"),
          response.headers.get("date")
        );
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
      const normalizedError = normalizeUnknownError(error, {
        timedOut,
        externalAbort: Boolean(signal && typeof signal === "object" && signal.aborted),
      });
      if (normalizedError.code === "CLIENT_ABORTED") {
        throw normalizedError;
      }
      const shouldRecordCircuitFailure = shouldRetry(normalizedError);
      if (shouldRecordCircuitFailure) {
        registerCircuitFailure(circuitScope);
      }
      if (shouldRetry(normalizedError) && attemptIndex < attempts - 1) {
        await sleep(
          getRetryDelayMs(attemptIndex, retryBackoffMs, normalizedError.retryAfterMs, requestJitterSeed)
        );
        continue;
      }

      throw normalizedError;
    } finally {
      cleanup();
      clearTimeout(timeout);
      await sleep(0);
    }
  }

  throw new SentinelayerApiError("Request failed after retry attempts.", {
    status: 503,
    code: "MAX_RETRIES_EXHAUSTED",
  });
}
