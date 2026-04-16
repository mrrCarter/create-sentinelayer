import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import { assertPermittedAuditTarget } from "./url-policy.js";

/**
 * Jules Tanaka — Authenticated Page Audit
 *
 * Provisions an AIdenID ephemeral identity, uses Playwright to log in,
 * then inspects authenticated pages (DevTools console, DOM, headers).
 * Falls back gracefully when AIdenID or Playwright unavailable.
 */

export async function authAudit(input = {}) {
  const operation = String(input.operation || "").trim();
  const requestId = createAuditRequestId();
  if (!AUTH_OPS.has(operation)) {
    const message = "Unknown operation: " + (operation || "<empty>") + ". Valid: " + [...AUTH_OPS].join(", ");
    return finalizeAuditEnvelope(operation || "unknown", requestId, buildUnavailableAuditResponse(
      requestId,
      "AUTH_AUDIT_UNKNOWN_OPERATION",
      message
    ));
  }
  try {
    const result = await AUTH_DISPATCH[operation]({ ...input, requestId, operation });
    return finalizeAuditEnvelope(operation, requestId, result);
  } catch (error) {
    const code = error instanceof AuthAuditError ? "AUTH_AUDIT_VALIDATION_FAILED" : "AUTH_AUDIT_EXECUTION_FAILED";
    const message = normalizeErrorMessage(error, "Auth audit failed");
    const diagnostics = extractErrorDiagnostics(error, operation || "auth_audit");
    return finalizeAuditEnvelope(operation, requestId, buildUnavailableAuditResponse(requestId, code, message, diagnostics));
  }
}

const AUTH_OPS = new Set([
  "provision_test_identity",
  "authenticated_page_check",
  "check_auth_flow_security",
]);

const AUTH_DISPATCH = {
  provision_test_identity: provisionTestIdentity,
  authenticated_page_check: authenticatedPageCheck,
  check_auth_flow_security: checkAuthFlowSecurity,
};

const AUTH_PLAYWRIGHT_EXEC_TIMEOUT_MS = 60_000;
const AUTH_PLAYWRIGHT_EXEC_MAX_RETRIES = 3;
const AUTH_PLAYWRIGHT_EXEC_BASE_BACKOFF_MS = 300;
const AUTH_PLAYWRIGHT_EXEC_TOTAL_BUDGET_MS = 180_000;
const AUTH_PLAYWRIGHT_EXEC_MIN_ATTEMPT_TIMEOUT_MS = 2_000;
const AUTH_AIDENID_PROVISION_TIMEOUT_MS = 12_000;
const AUTH_AIDENID_PROVISION_MAX_RETRIES = 2;
const AUTH_AIDENID_PROVISION_BASE_BACKOFF_MS = 300;
const AUTH_AIDENID_PROVISION_TOTAL_BUDGET_MS =
  (AUTH_AIDENID_PROVISION_TIMEOUT_MS * (AUTH_AIDENID_PROVISION_MAX_RETRIES + 1))
  + (AUTH_AIDENID_PROVISION_BASE_BACKOFF_MS * AUTH_AIDENID_PROVISION_MAX_RETRIES * 2);
const AUTH_AIDENID_PROVISION_MIN_ATTEMPT_TIMEOUT_MS = 1_500;
const AUTH_AUDIT_PROVIDER_BREAKER_FAILURE_THRESHOLD = 3;
const AUTH_AUDIT_PROVIDER_BREAKER_WINDOW_MS = 5 * 60 * 1000;
const AUTH_AUDIT_PROVIDER_BREAKER_COOLDOWN_MS = 2 * 60 * 1000;
const AUTH_AUDIT_PROVIDER_BREAKER_ENTRY_TTL_MS = 15 * 60 * 1000;
const AUTH_AUDIT_PROVIDER_SCOPE_DEFAULT = "default";
const AUTH_AUDIT_PROVIDER_BREAKERS = new Map();
const AUTH_AUDIT_PROVIDER_BREAKER_STATE_FILE_ENV = "SENTINELAYER_AUTH_AUDIT_BREAKER_STATE_FILE";
const AUTH_AUDIT_PROVIDER_BREAKER_STATE_FILE_DEFAULT = "";
const AUTH_AUDIT_PROVIDER_AIDENID = "aidenid";
const AUTH_AUDIT_PROVIDER_PLAYWRIGHT_TARGET = "playwright-target";
const AUTH_MUTATION_ALLOWED_ENV = "SENTINELAYER_ALLOW_AUTH_MUTATION";
const AUTH_AUDIT_ENVELOPE_ENV = "SENTINELAYER_AUTH_AUDIT_ENVELOPE";
const AUTH_AUDIT_ENVELOPE_VERSION = "v2";
const RETRYABLE_PLAYWRIGHT_EXEC_ERROR_CODES = new Set([
  "ETIMEDOUT",
  "ECONNRESET",
  "EPIPE",
  "EAI_AGAIN",
  "ECONNABORTED",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_HEADERS_TIMEOUT",
]);
const RETRYABLE_AIDENID_PROVISION_ERROR_CODES = new Set([
  "ETIMEDOUT",
  "ECONNRESET",
  "ECONNREFUSED",
  "EAI_AGAIN",
  "ENOTFOUND",
  "ECONNABORTED",
  "AIDENID_ATTEMPT_TIMEOUT",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_HEADERS_TIMEOUT",
  "UND_ERR_BODY_TIMEOUT",
]);
const RETRYABLE_AIDENID_PROVISION_STATUS_CODES = new Set([408, 425, 429, 500, 502, 503, 504]);
const RETRYABLE_AIDENID_PROVISION_MESSAGE_PATTERNS = [
  /\bfetch failed\b/i,
  /\bnetwork(?:\s+|-)error\b/i,
  /\btimed?\s*out\b/i,
  /\b(?:econnreset|econnrefused|eai_again|enotfound|etimedout)\b/i,
  /\bconnection\b.*\b(?:reset|closed|terminated)\b/i,
];

let AUTH_AUDIT_PROVIDER_BREAKERS_HYDRATED = false;
const AUTH_AUDIT_JITTER_SECRET = randomBytes(16).toString("hex");
let AUTH_AUDIT_JITTER_COUNTER = 0;

function createAuditRequestId() {
  try {
    return randomUUID();
  } catch {
    const ts = Date.now().toString(36);
    const rand = randomBytes(16).toString("hex");
    return `authaudit-${ts}-${rand}`;
  }
}

function normalizeErrorMessage(error, fallback) {
  const fallbackMessage = String(fallback || "Auth audit failed");
  if (error instanceof Error && error.message) {
    return sanitizeAuditErrorMessage(error.message, fallbackMessage);
  }
  const normalized = String(error || "").trim();
  return sanitizeAuditErrorMessage(normalized || fallbackMessage, fallbackMessage);
}

function sanitizeAuditErrorMessage(message, fallback = "Auth audit failed") {
  const fallbackMessage = String(fallback || "Auth audit failed");
  const normalized = String(message || "").trim();
  const candidate = normalized || fallbackMessage;
  const sanitized = candidate
    .replace(/\bbearer\s+[a-z0-9._~+/=-]+\b/gi, "bearer [REDACTED]")
    .replace(/\b(token|secret|password|api[_-]?key|access[_-]?token|refresh[_-]?token|id[_-]?token)\b\s*[:=]\s*["']?[^"'\s,;]+["']?/gi, "$1=[REDACTED]")
    .replace(/\b[a-z0-9_-]+\.[a-z0-9_-]+\.[a-z0-9_-]+\b/gi, "[REDACTED_JWT]")
    .replace(/\bhttps?:\/\/[^\s"'`]+/gi, (rawUrl) => sanitizeDiagnosticUrl(rawUrl))
    .replace(/\b[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}\b/gi, "<redacted-email>");
  if (sanitized.length <= 512) {
    return sanitized;
  }
  return `${sanitized.slice(0, 509)}...`;
}

function sanitizeDiagnosticUrl(rawUrl) {
  const candidate = String(rawUrl || "").trim();
  if (!candidate) {
    return "<redacted-url>";
  }
  try {
    const parsed = new URL(candidate);
    if (!parsed.hostname) {
      return "<redacted-url>";
    }
    return `${parsed.protocol}//${parsed.host}/<redacted-path>`;
  } catch {
    return "<redacted-url>";
  }
}

function buildUnavailableAuditResponse(requestId, code, message, options = {}) {
  const safeMessage = sanitizeAuditErrorMessage(message, "Auth audit unavailable");
  const errorPayload = {
    code,
    message: safeMessage,
    requestId,
    retryable: options.retryable === true,
  };
  const phase = String(options.phase || "").trim();
  if (phase) {
    errorPayload.phase = phase;
  }
  const parsedStatusCode = Number.parseInt(String(options.statusCode || ""), 10);
  if (Number.isInteger(parsedStatusCode) && parsedStatusCode > 0) {
    errorPayload.statusCode = parsedStatusCode;
  }
  const errorCode = String(options.errorCode || "").trim();
  if (errorCode) {
    errorPayload.errorCode = errorCode.toUpperCase();
  }
  if (options.retryTelemetry && typeof options.retryTelemetry === "object") {
    errorPayload.retryTelemetry = options.retryTelemetry;
  }
  if (options.providerBreaker && typeof options.providerBreaker === "object") {
    errorPayload.providerBreaker = options.providerBreaker;
  }
  return {
    available: false,
    requestId,
    reason: safeMessage,
    error: errorPayload,
  };
}

function extractErrorDiagnostics(error, phase = "auth_audit") {
  const diagnostics = {
    phase: String(phase || "auth_audit").trim().slice(0, 64) || "auth_audit",
  };
  const statusCode = resolveAidenidProvisionStatusCode(error);
  if (Number.isInteger(statusCode) && statusCode > 0) {
    diagnostics.statusCode = statusCode;
  }
  let errorCode = resolveAidenidProvisionErrorCode(error);
  if (!errorCode && error instanceof Error) {
    errorCode = String(error.name || "").trim().toUpperCase();
  }
  if (errorCode) {
    diagnostics.errorCode = errorCode.toUpperCase();
  }
  return diagnostics;
}

function isAuditEnvelopeV2Enabled() {
  const normalized = String(process.env[AUTH_AUDIT_ENVELOPE_ENV] || "").trim().toLowerCase();
  return normalized === "" || normalized === "true" || normalized === "1" || normalized === AUTH_AUDIT_ENVELOPE_VERSION;
}

function buildAuditDataEnvelope(payload) {
  const data = { ...(payload && typeof payload === "object" ? payload : {}) };
  delete data.ok;
  delete data.operation;
  delete data.envelope;
  delete data.data;
  return data;
}

function finalizeAuditEnvelope(operation, requestId, payload) {
  const normalizedPayload = payload && typeof payload === "object" ? { ...payload } : { result: payload };
  const normalizedRequestId = String(normalizedPayload.requestId || requestId || createAuditRequestId());
  normalizedPayload.requestId = normalizedRequestId;
  if (!Object.prototype.hasOwnProperty.call(normalizedPayload, "available")) {
    normalizedPayload.available = !normalizedPayload.error;
  }
  if (!isAuditEnvelopeV2Enabled()) {
    return normalizedPayload;
  }
  normalizedPayload.ok = normalizedPayload.available === true;
  normalizedPayload.operation = String(operation || normalizedPayload.operation || "unknown");
  normalizedPayload.envelope = AUTH_AUDIT_ENVELOPE_VERSION;
  if (normalizedPayload.ok) {
    normalizedPayload.data = buildAuditDataEnvelope(normalizedPayload);
  } else {
    if (!normalizedPayload.error || typeof normalizedPayload.error !== "object") {
      normalizedPayload.error = {
        code: "AUTH_AUDIT_FAILED",
        message: String(normalizedPayload.reason || "Auth audit failed"),
        requestId: normalizedRequestId,
        retryable: false,
      };
    } else if (!normalizedPayload.error.requestId) {
      normalizedPayload.error = {
        ...normalizedPayload.error,
        requestId: normalizedRequestId,
      };
    }
    normalizedPayload.reason = String(
      normalizedPayload.reason
      || normalizedPayload.error.message
      || "Auth audit failed"
    );
    normalizedPayload.data = null;
  }
  return normalizedPayload;
}

function resolveAidenidProvisionStatusCode(error) {
  if (!(error instanceof Error)) {
    return 0;
  }
  const directStatus = Number.parseInt(String(error.statusCode || error.status || ""), 10);
  if (Number.isInteger(directStatus) && directStatus > 0) {
    return directStatus;
  }
  const statusMatch = String(error.message || "").match(/\bstatus\s+(\d{3})\b/i);
  if (!statusMatch) {
    return 0;
  }
  const parsed = Number.parseInt(statusMatch[1], 10);
  return Number.isInteger(parsed) ? parsed : 0;
}

function resolveAidenidProvisionErrorCode(error) {
  if (!(error instanceof Error)) {
    return "";
  }
  const explicitCode = String(error.errorCode || "").toUpperCase();
  if (explicitCode) {
    return explicitCode;
  }
  const directCode = String(error.code || "").toUpperCase();
  if (directCode) {
    return directCode;
  }
  const cause = error.cause;
  if (!cause || typeof cause !== "object") {
    return "";
  }
  return String(cause.code || cause.errno || "").toUpperCase();
}

function classifyAidenidProvisionFailure(error) {
  const classification = {
    retryable: false,
    statusCode: 0,
    errorCode: "",
  };
  if (!(error instanceof Error)) {
    return classification;
  }
  classification.errorCode = resolveAidenidProvisionErrorCode(error);
  classification.statusCode = resolveAidenidProvisionStatusCode(error);
  if (typeof error.retryable === "boolean") {
    classification.retryable = error.retryable;
    return classification;
  }
  if (error.name === "AbortError" || error.name === "TimeoutError") {
    classification.retryable = true;
    return classification;
  }
  if (RETRYABLE_AIDENID_PROVISION_ERROR_CODES.has(classification.errorCode)) {
    classification.retryable = true;
    return classification;
  }
  if (RETRYABLE_AIDENID_PROVISION_STATUS_CODES.has(classification.statusCode)) {
    classification.retryable = true;
    return classification;
  }
  const normalized = `${error.name} ${error.message || ""}`.toLowerCase();
  classification.retryable = RETRYABLE_AIDENID_PROVISION_MESSAGE_PATTERNS.some((pattern) => pattern.test(normalized));
  return classification;
}

function isRetryableAidenidProvisionError(error) {
  return classifyAidenidProvisionFailure(error).retryable;
}

function deriveAidenidBackoffSeed(requestId) {
  const normalizedRequestId = String(requestId || "").trim();
  const counter = AUTH_AUDIT_JITTER_COUNTER++;
  const seedMaterial = `${AUTH_AUDIT_JITTER_SECRET}:${normalizedRequestId || "fallback"}:${counter}`;
  return createHash("sha256").update(seedMaterial).digest().readUInt32BE(0);
}

function computeAidenidProvisionBackoffMs(
  attempt,
  baseBackoffMs = AUTH_AIDENID_PROVISION_BASE_BACKOFF_MS,
  jitterSeed = 0
) {
  const cappedBase = Math.max(1, Number.isFinite(baseBackoffMs) ? Math.trunc(baseBackoffMs) : AUTH_AIDENID_PROVISION_BASE_BACKOFF_MS);
  const exponential = Math.min(2500, cappedBase * Math.pow(2, Math.max(0, attempt)));
  const normalizedSeed = Number.isFinite(jitterSeed) ? Math.abs(Math.trunc(jitterSeed)) : 0;
  const deterministicJitter = ((Math.max(0, attempt) * 1664525 + 1013904223 + normalizedSeed) % 1000) / 1000;
  const jitterFactor = 0.5 + (deterministicJitter * 0.5);
  return Math.max(1, Math.trunc(exponential * jitterFactor));
}

function normalizeAidenidTotalBudgetMs(value) {
  if (!Number.isFinite(value) || value <= 0) {
    return AUTH_AIDENID_PROVISION_TOTAL_BUDGET_MS;
  }
  return Math.max(1, Math.trunc(value));
}

function normalizeProviderBreakerScope(scope) {
  const normalized = String(scope || "").trim().toLowerCase();
  if (!normalized) {
    return AUTH_AUDIT_PROVIDER_SCOPE_DEFAULT;
  }
  return normalized.replace(/[^a-z0-9._:/-]/g, "-").replace(/-+/g, "-").slice(0, 120) || AUTH_AUDIT_PROVIDER_SCOPE_DEFAULT;
}

function deriveProviderBreakerScope(options = {}) {
  const explicitScope = normalizeProviderBreakerScope(
    options.contextId || options.scopeId || options.repoScope || ""
  );
  if (explicitScope !== AUTH_AUDIT_PROVIDER_SCOPE_DEFAULT) {
    return explicitScope;
  }
  const parts = [];
  const urlCandidate = String(options.targetUrl || options.apiUrl || "").trim();
  if (urlCandidate) {
    try {
      const parsed = new URL(urlCandidate);
      if (parsed.hostname) {
        parts.push(parsed.hostname.toLowerCase());
      }
    } catch {
      // Fall through to non-URL scoped dimensions.
    }
  }
  const orgScope = normalizeProviderBreakerScope(options.orgId || options.organizationId || "");
  if (orgScope !== AUTH_AUDIT_PROVIDER_SCOPE_DEFAULT) {
    parts.push(`org-${orgScope}`);
  }
  const projectScope = normalizeProviderBreakerScope(options.projectId || "");
  if (projectScope !== AUTH_AUDIT_PROVIDER_SCOPE_DEFAULT) {
    parts.push(`proj-${projectScope}`);
  }
  const repoScope = normalizeProviderBreakerScope(process.env.GITHUB_REPOSITORY || "");
  if (repoScope !== AUTH_AUDIT_PROVIDER_SCOPE_DEFAULT) {
    parts.push(`repo-${repoScope}`);
  }
  if (parts.length === 0) {
    const workspaceFallback = createHash("sha256")
      .update(process.cwd())
      .digest("hex")
      .slice(0, 20);
    parts.push(`ws-${workspaceFallback}`);
  }
  return normalizeProviderBreakerScope(parts.join(":"));
}

function getProviderBreakerKey(provider, scope) {
  return `${provider}:${scope}`;
}

function getProviderBreakerStatePath() {
  const configuredPath = String(
    process.env[AUTH_AUDIT_PROVIDER_BREAKER_STATE_FILE_ENV] || AUTH_AUDIT_PROVIDER_BREAKER_STATE_FILE_DEFAULT
  ).trim();
  if (!configuredPath) {
    return "";
  }
  const repoScope = String(process.env.GITHUB_REPOSITORY || "local").trim() || "local";
  const runScope = String(process.env.GITHUB_RUN_ID || process.pid || "0").trim();
  const scopeSuffix = createHash("sha256")
    .update(`${repoScope}:${runScope}`)
    .digest("hex")
    .slice(0, 12);
  const resolvedPath = path.isAbsolute(configuredPath)
    ? configuredPath
    : path.resolve(process.cwd(), configuredPath);
  const ext = path.extname(resolvedPath) || ".json";
  const base = resolvedPath.endsWith(ext) ? resolvedPath.slice(0, -ext.length) : resolvedPath;
  return `${base}.${scopeSuffix}${ext}`;
}

function hydrateProviderBreakerState() {
  if (AUTH_AUDIT_PROVIDER_BREAKERS_HYDRATED) {
    return;
  }
  AUTH_AUDIT_PROVIDER_BREAKERS_HYDRATED = true;
  const statePath = getProviderBreakerStatePath();
  if (!statePath || !fs.existsSync(statePath)) {
    return;
  }
  const nowMs = Date.now();
  try {
    const raw = fs.readFileSync(statePath, "utf-8");
    const parsed = JSON.parse(raw);
    const entries = Array.isArray(parsed?.entries) ? parsed.entries : [];
    for (const entry of entries) {
      const lastUpdatedAtMs = Number.isFinite(entry?.lastUpdatedAtMs)
        ? Math.max(0, Math.trunc(entry.lastUpdatedAtMs))
        : Number.isFinite(entry?.windowStartedAt)
          ? Math.max(0, Math.trunc(entry.windowStartedAt))
          : 0;
      if (lastUpdatedAtMs > 0 && (nowMs - lastUpdatedAtMs) > AUTH_AUDIT_PROVIDER_BREAKER_ENTRY_TTL_MS) {
        continue;
      }
      const provider = String(entry?.provider || "").trim().toLowerCase();
      if (!provider) {
        continue;
      }
      const scope = normalizeProviderBreakerScope(entry?.scope);
      const key = getProviderBreakerKey(provider, scope);
      AUTH_AUDIT_PROVIDER_BREAKERS.set(key, {
        key,
        provider,
        scope,
        consecutiveFailures: Number.isFinite(entry?.consecutiveFailures) ? Math.max(0, Math.trunc(entry.consecutiveFailures)) : 0,
        windowStartedAt: Number.isFinite(entry?.windowStartedAt) ? Math.max(0, Math.trunc(entry.windowStartedAt)) : 0,
        openUntilMs: Number.isFinite(entry?.openUntilMs) ? Math.max(0, Math.trunc(entry.openUntilMs)) : 0,
        lastFailureCode: String(entry?.lastFailureCode || "").trim().toUpperCase(),
        lastUpdatedAtMs,
      });
    }
  } catch {
    // Fall back to in-memory behavior if persisted state cannot be loaded.
  }
}

function persistProviderBreakerState(nowMs = Date.now()) {
  const statePath = getProviderBreakerStatePath();
  if (!statePath) {
    return;
  }
  try {
    fs.mkdirSync(path.dirname(statePath), { recursive: true });
    const payload = {
      version: 1,
      updatedAtMs: nowMs,
      entries: [...AUTH_AUDIT_PROVIDER_BREAKERS.values()].map((state) => ({
        provider: state.provider,
        scope: state.scope,
        consecutiveFailures: state.consecutiveFailures,
        windowStartedAt: state.windowStartedAt,
        openUntilMs: state.openUntilMs,
        lastFailureCode: state.lastFailureCode,
        lastUpdatedAtMs: state.lastUpdatedAtMs || nowMs,
      })),
    };
    const tmpPath = `${statePath}.${process.pid}.tmp`;
    fs.writeFileSync(tmpPath, JSON.stringify(payload), "utf-8");
    fs.renameSync(tmpPath, statePath);
  } catch {
    // Persistence is best-effort; in-memory safeguards remain active.
  }
}

function sweepProviderBreakers(nowMs = Date.now()) {
  let mutated = false;
  for (const [breakerKey, state] of AUTH_AUDIT_PROVIDER_BREAKERS.entries()) {
    const isOpen = Number(state.openUntilMs || 0) > nowMs;
    const lastUpdatedAtMs = Number(state.lastUpdatedAtMs || state.windowStartedAt || 0);
    if (isOpen) {
      continue;
    }
    if (lastUpdatedAtMs > 0 && (nowMs - lastUpdatedAtMs) > AUTH_AUDIT_PROVIDER_BREAKER_ENTRY_TTL_MS) {
      AUTH_AUDIT_PROVIDER_BREAKERS.delete(breakerKey);
      mutated = true;
    }
  }
  if (mutated) {
    persistProviderBreakerState(nowMs);
  }
}

function getProviderBreakerState(provider, scope) {
  hydrateProviderBreakerState();
  const normalizedProvider = String(provider || "").trim().toLowerCase();
  if (!normalizedProvider) {
    return null;
  }
  const normalizedScope = normalizeProviderBreakerScope(scope);
  const breakerKey = getProviderBreakerKey(normalizedProvider, normalizedScope);
  const nowMs = Date.now();
  sweepProviderBreakers(nowMs);
  if (!AUTH_AUDIT_PROVIDER_BREAKERS.has(breakerKey)) {
    AUTH_AUDIT_PROVIDER_BREAKERS.set(breakerKey, {
      key: breakerKey,
      provider: normalizedProvider,
      scope: normalizedScope,
      consecutiveFailures: 0,
      windowStartedAt: 0,
      openUntilMs: 0,
      lastFailureCode: "",
      lastUpdatedAtMs: nowMs,
    });
    persistProviderBreakerState(nowMs);
  }
  return AUTH_AUDIT_PROVIDER_BREAKERS.get(breakerKey);
}

function getProviderBreakerSnapshot(provider, scope, nowMs = Date.now()) {
  const state = getProviderBreakerState(provider, scope);
  if (!state) {
    return null;
  }
  const remainingCooldownMs = state.openUntilMs > nowMs ? state.openUntilMs - nowMs : 0;
  return {
    key: state.key,
    provider: state.provider,
    scope: state.scope,
    consecutiveFailures: state.consecutiveFailures,
    windowStartedAt: state.windowStartedAt || 0,
    remainingCooldownMs,
    cooldownUntilMs: state.openUntilMs || 0,
    lastFailureCode: state.lastFailureCode || "",
  };
}

function enforceProviderBreaker(provider, scope, requestId) {
  const state = getProviderBreakerState(provider, scope);
  if (!state) {
    return;
  }
  const nowMs = Date.now();
  if (state.openUntilMs > nowMs) {
    const snapshot = getProviderBreakerSnapshot(provider, scope, nowMs);
    const blocked = new AuthAuditError(
      `Provider circuit is open for ${state.provider}/${state.scope}; retry after cooldown (requestId=${requestId}).`
    );
    blocked.errorCode = "AUTH_AUDIT_PROVIDER_CIRCUIT_OPEN";
    blocked.retryable = false;
    blocked.providerBreaker = snapshot;
    throw blocked;
  }
  if (state.openUntilMs > 0 && state.openUntilMs <= nowMs) {
    state.consecutiveFailures = 0;
    state.windowStartedAt = nowMs;
    state.openUntilMs = 0;
    state.lastFailureCode = "";
    state.lastUpdatedAtMs = nowMs;
    AUTH_AUDIT_PROVIDER_BREAKERS.set(state.key, state);
    persistProviderBreakerState(nowMs);
  }
}

function recordProviderBreakerSuccess(provider, scope) {
  const state = getProviderBreakerState(provider, scope);
  if (!state) {
    return;
  }
  state.consecutiveFailures = 0;
  state.windowStartedAt = 0;
  state.openUntilMs = 0;
  state.lastFailureCode = "";
  state.lastUpdatedAtMs = Date.now();
  AUTH_AUDIT_PROVIDER_BREAKERS.set(state.key, state);
  persistProviderBreakerState(state.lastUpdatedAtMs);
}

function recordProviderBreakerFailure(provider, scope, errorCode = "") {
  const state = getProviderBreakerState(provider, scope);
  if (!state) {
    return null;
  }
  const nowMs = Date.now();
  if (!state.windowStartedAt || (nowMs - state.windowStartedAt) > AUTH_AUDIT_PROVIDER_BREAKER_WINDOW_MS) {
    state.windowStartedAt = nowMs;
    state.consecutiveFailures = 0;
  }
  state.consecutiveFailures += 1;
  state.lastFailureCode = String(errorCode || "").trim().toUpperCase();
  if (state.consecutiveFailures >= AUTH_AUDIT_PROVIDER_BREAKER_FAILURE_THRESHOLD) {
    state.openUntilMs = nowMs + AUTH_AUDIT_PROVIDER_BREAKER_COOLDOWN_MS;
  }
  state.lastUpdatedAtMs = nowMs;
  AUTH_AUDIT_PROVIDER_BREAKERS.set(state.key, state);
  persistProviderBreakerState(nowMs);
  return getProviderBreakerSnapshot(provider, scope, nowMs);
}

function isAbortSignalLike(signal) {
  return Boolean(
    signal &&
    typeof signal === "object" &&
    typeof signal.aborted === "boolean" &&
    typeof signal.addEventListener === "function" &&
    typeof signal.removeEventListener === "function"
  );
}

function composeAbortSignals(primarySignal, secondarySignal) {
  const hasPrimary = isAbortSignalLike(primarySignal);
  const hasSecondary = isAbortSignalLike(secondarySignal);
  if (!hasPrimary && !hasSecondary) {
    return { signal: undefined, cleanup: () => {} };
  }
  if (!hasPrimary) {
    return { signal: secondarySignal, cleanup: () => {} };
  }
  if (!hasSecondary) {
    return { signal: primarySignal, cleanup: () => {} };
  }
  const mergedController = new AbortController();
  const forwardAbort = () => {
    if (!mergedController.signal.aborted) {
      mergedController.abort();
    }
  };
  if (primarySignal.aborted || secondarySignal.aborted) {
    forwardAbort();
    return { signal: mergedController.signal, cleanup: () => {} };
  }
  primarySignal.addEventListener("abort", forwardAbort, { once: true });
  secondarySignal.addEventListener("abort", forwardAbort, { once: true });
  return {
    signal: mergedController.signal,
    cleanup: () => {
      primarySignal.removeEventListener("abort", forwardAbort);
      secondarySignal.removeEventListener("abort", forwardAbort);
    },
  };
}

async function provisionEmailIdentityWithRetry(provisionEmailIdentity, options = {}) {
  const timeoutMs = Number.isFinite(options.timeoutMs) && options.timeoutMs > 0
    ? Math.trunc(options.timeoutMs)
    : AUTH_AIDENID_PROVISION_TIMEOUT_MS;
  const maxRetries = Number.isInteger(options.maxRetries) && options.maxRetries >= 0
    ? options.maxRetries
    : AUTH_AIDENID_PROVISION_MAX_RETRIES;
  const baseBackoffMs = Number.isFinite(options.baseBackoffMs) && options.baseBackoffMs > 0
    ? Math.trunc(options.baseBackoffMs)
    : AUTH_AIDENID_PROVISION_BASE_BACKOFF_MS;
  const requestOptions = options.requestOptions && typeof options.requestOptions === "object"
    ? { ...options.requestOptions }
    : {};
  const requestId = String(options.requestId || createAuditRequestId());
  const jitterSeed = Number.isFinite(options.jitterSeed)
    ? Math.abs(Math.trunc(options.jitterSeed))
    : deriveAidenidBackoffSeed(requestId);
  const totalBudgetMs = normalizeAidenidTotalBudgetMs(options.totalBudgetMs);
  const minAttemptTimeoutMs = Number.isFinite(options.minAttemptTimeoutMs) && options.minAttemptTimeoutMs > 0
    ? Math.trunc(options.minAttemptTimeoutMs)
    : AUTH_AIDENID_PROVISION_MIN_ATTEMPT_TIMEOUT_MS;
  const effectiveMinAttemptTimeoutMs = Math.max(1, Math.min(timeoutMs, minAttemptTimeoutMs));
  const attemptMetrics = [];
  const retryWindowStartedAt = Date.now();
  for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
    const elapsedMs = Date.now() - retryWindowStartedAt;
    const remainingBudgetMs = totalBudgetMs - elapsedMs;
    if (remainingBudgetMs <= 0) {
      const exhausted = new AuthAuditError(
        `AIdenID provisioning retry budget exhausted after ${attempt} attempt(s) (requestId=${requestId})`
      );
      exhausted.errorCode = "AIDENID_RETRY_BUDGET_EXHAUSTED";
      exhausted.retryable = false;
      exhausted.retryTelemetry = {
        requestId,
        attempts: attempt,
        totalBudgetMs,
        minAttemptTimeoutMs: effectiveMinAttemptTimeoutMs,
        totalElapsedMs: elapsedMs,
        attemptMetrics,
      };
      throw exhausted;
    }
    if (remainingBudgetMs < effectiveMinAttemptTimeoutMs) {
      const exhausted = new AuthAuditError(
        `AIdenID provisioning remaining retry budget (${remainingBudgetMs}ms) fell below minimum attempt window (${effectiveMinAttemptTimeoutMs}ms) (requestId=${requestId})`
      );
      exhausted.errorCode = "AIDENID_RETRY_BUDGET_EXHAUSTED";
      exhausted.retryable = false;
      exhausted.retryTelemetry = {
        requestId,
        attempts: attempt,
        totalBudgetMs,
        minAttemptTimeoutMs: effectiveMinAttemptTimeoutMs,
        totalElapsedMs: elapsedMs,
        attemptMetrics,
      };
      throw exhausted;
    }
    const attemptTimeoutMs = Math.max(effectiveMinAttemptTimeoutMs, Math.min(timeoutMs, remainingBudgetMs));
    const attemptStartedAt = Date.now();
    const attemptMetric = {
      attempt: attempt + 1,
      timeoutMs: attemptTimeoutMs,
      budgetBeforeAttemptMs: remainingBudgetMs,
    };
    try {
      const attemptPromise = provisionEmailIdentity({
        ...requestOptions,
        fetchImpl: async (resource, init = {}) => {
          const callerSignal = isAbortSignalLike(init.signal) ? init.signal : undefined;
          const controller = new AbortController();
          const timeoutHandle = setTimeout(() => controller.abort(), attemptTimeoutMs);
          const { signal: compositeSignal, cleanup: cleanupCompositeSignal } = composeAbortSignals(callerSignal, controller.signal);
          const nextInit = {
            ...init,
            ...(compositeSignal ? { signal: compositeSignal } : {}),
          };
          try {
            const response = await fetch(resource, nextInit);
            if (response && RETRYABLE_AIDENID_PROVISION_STATUS_CODES.has(Number(response.status || 0))) {
              if (response.body && typeof response.body.cancel === "function") {
                try {
                  await response.body.cancel();
                } catch {
                  // No-op: retry classification still applies if body drain fails.
                }
              }
              const transientHttpError = new AuthAuditError(`AIdenID transient HTTP ${response.status}`);
              transientHttpError.errorCode = "AIDENID_HTTP_RETRYABLE";
              transientHttpError.statusCode = Number(response.status || 0);
              transientHttpError.retryable = true;
              throw transientHttpError;
            }
            return response;
          } catch (error) {
            if (callerSignal && callerSignal.aborted === true) {
              const aborted = new AuthAuditError("AIdenID provisioning aborted by caller");
              aborted.errorCode = "AIDENID_ABORTED_BY_CALLER";
              aborted.retryable = false;
              throw aborted;
            }
            const failure = classifyAidenidProvisionFailure(error);
            if (failure.retryable) {
              const wrapped = new AuthAuditError(normalizeErrorMessage(error, "AIdenID provisioning transport failed"));
              wrapped.errorCode = failure.errorCode || "AIDENID_TRANSPORT_RETRYABLE";
              wrapped.statusCode = failure.statusCode || 0;
              wrapped.retryable = true;
              throw wrapped;
            }
            throw error;
          } finally {
            clearTimeout(timeoutHandle);
            cleanupCompositeSignal();
          }
        },
      });
      const result = await Promise.race([
        attemptPromise,
        new Promise((_, reject) => {
          const timer = setTimeout(() => {
            const timeoutError = new AuthAuditError(
              `AIdenID provisioning attempt ${attempt + 1} timed out after ${attemptTimeoutMs}ms (requestId=${requestId})`
            );
            timeoutError.errorCode = "AIDENID_ATTEMPT_TIMEOUT";
            timeoutError.retryable = true;
            reject(timeoutError);
          }, attemptTimeoutMs);
          // `finally()` returns a new promise. Swallow its rejection path so late
          // attempt failures never escape as unhandledRejection after timeout wins.
          void attemptPromise
            .finally(() => clearTimeout(timer))
            .catch(() => {});
        }),
      ]);
      attemptMetric.durationMs = Date.now() - attemptStartedAt;
      attemptMetric.outcome = "success";
      attemptMetrics.push(attemptMetric);
      const retryTelemetry = {
        requestId,
        attempts: attempt + 1,
        totalBudgetMs,
        minAttemptTimeoutMs: effectiveMinAttemptTimeoutMs,
        totalElapsedMs: Date.now() - retryWindowStartedAt,
        attemptMetrics,
      };
      if (result && typeof result === "object" && !Array.isArray(result)) {
        return {
          ...result,
          retryTelemetry,
        };
      }
      return {
        value: result,
        retryTelemetry,
      };
    } catch (error) {
      const failure = classifyAidenidProvisionFailure(error);
      attemptMetric.durationMs = Date.now() - attemptStartedAt;
      attemptMetric.outcome = failure.retryable ? "retryable_error" : "terminal_error";
      attemptMetric.errorCode = failure.errorCode || "AIDENID_PROVISION_FAILED";
      attemptMetric.statusCode = failure.statusCode || 0;
      attemptMetrics.push(attemptMetric);
      if (!failure.retryable || attempt >= maxRetries) {
        const reason = normalizeErrorMessage(error, "AIdenID provisioning failed");
        const terminal = new AuthAuditError(
          `AIdenID provisioning failed after ${attempt + 1} attempt(s) (requestId=${requestId}): ${reason}`
        );
        terminal.errorCode = failure.errorCode || "AIDENID_PROVISION_FAILED";
        terminal.retryable = false;
        terminal.retryTelemetry = {
          requestId,
          attempts: attempt + 1,
          totalBudgetMs,
          minAttemptTimeoutMs: effectiveMinAttemptTimeoutMs,
          totalElapsedMs: Date.now() - retryWindowStartedAt,
          attemptMetrics,
        };
        throw terminal;
      }
    }
    const backoffMs = computeAidenidProvisionBackoffMs(attempt, baseBackoffMs, jitterSeed);
    const remainingAfterAttemptMs = totalBudgetMs - (Date.now() - retryWindowStartedAt);
    if (remainingAfterAttemptMs <= 0) {
      break;
    }
    await sleep(Math.min(backoffMs, remainingAfterAttemptMs));
  }
  const exhausted = new AuthAuditError(`AIdenID provisioning failed after retry budget was exhausted (requestId=${requestId})`);
  exhausted.errorCode = "AIDENID_RETRY_BUDGET_EXHAUSTED";
  exhausted.retryable = false;
  exhausted.retryTelemetry = {
    requestId,
    attempts: maxRetries + 1,
    totalBudgetMs,
    minAttemptTimeoutMs: effectiveMinAttemptTimeoutMs,
    totalElapsedMs: Date.now() - retryWindowStartedAt,
    attemptMetrics,
  };
  throw exhausted;
}

function normalizeHeaderValue(value) {
  const normalized = String(value || "").trim();
  return normalized || "";
}

function evaluateAuthenticatedHeaderFindings(targetUrl, headers = {}, authSignals = {}) {
  const findings = [];
  const normalizedHeaders = headers && typeof headers === "object" ? headers : {};
  const csp = normalizeHeaderValue(normalizedHeaders["content-security-policy"]);
  const hsts = normalizeHeaderValue(normalizedHeaders["strict-transport-security"]);
  const xFrameOptions = normalizeHeaderValue(normalizedHeaders["x-frame-options"]);
  let requiresHsts = false;
  try {
    requiresHsts = new URL(targetUrl).protocol === "https:";
  } catch {
    requiresHsts = String(targetUrl || "").startsWith("https://");
  }

  if (!csp) {
    findings.push({
      severity: "P2",
      title: "Authenticated page missing Content-Security-Policy header",
      file: targetUrl,
    });
  }
  if (requiresHsts && !hsts) {
    findings.push({
      severity: "P1",
      title: "Authenticated page missing Strict-Transport-Security header",
      file: targetUrl,
    });
  }
  if (!xFrameOptions) {
    findings.push({
      severity: "P2",
      title: "Authenticated page missing X-Frame-Options header",
      file: targetUrl,
    });
  } else if (!/^(deny|sameorigin)$/i.test(xFrameOptions)) {
    findings.push({
      severity: "P2",
      title: "Authenticated page has weak X-Frame-Options policy: " + xFrameOptions,
      file: targetUrl,
    });
  }

  if (authSignals && typeof authSignals === "object") {
    authSignals.headerPolicyPassed = findings.length === 0;
    authSignals.headerPolicyFindingCount = findings.length;
  }
  return findings;
}

async function provisionTestIdentity(input) {
  const requestId = String(input.requestId || createAuditRequestId());
  const providerKey = AUTH_AUDIT_PROVIDER_AIDENID;
  const providerScope = deriveProviderBreakerScope({
    contextId: input.providerContextId || input.contextId || input.scopeId,
    apiUrl: input.apiUrl,
    orgId: input.orgId || input.aidenidOrgId,
    projectId: input.projectId || input.aidenidProjectId,
  });
  try {
    enforceProviderBreaker(providerKey, providerScope, requestId);
    const executeRequested = input.execute === true;
    const allowLiveProvision = input.allowProvisioning === true || process.env.SENTINELAYER_ALLOW_LIVE_IDENTITY_PROVISION === "1";
    if (executeRequested && !allowLiveProvision) {
      return buildUnavailableAuditResponse(
        requestId,
        "AIDENID_PROVISION_APPROVAL_REQUIRED",
        "Live AIdenID provisioning requires explicit allowProvisioning=true (or SENTINELAYER_ALLOW_LIVE_IDENTITY_PROVISION=1)."
      );
    }

    const { provisionEmailIdentity, resolveAidenIdCredentials } = await import("../../../ai/aidenid.js");
    const creds = await resolveAidenIdCredentials();
    if (!creds.apiKey) {
      return buildUnavailableAuditResponse(
        requestId,
        "AIDENID_API_KEY_MISSING",
        "AIdenID API key not configured (set AIDENID_API_KEY)"
      );
    }
    const result = await provisionEmailIdentityWithRetry(provisionEmailIdentity, {
      timeoutMs: AUTH_AIDENID_PROVISION_TIMEOUT_MS,
      maxRetries: AUTH_AIDENID_PROVISION_MAX_RETRIES,
      baseBackoffMs: AUTH_AIDENID_PROVISION_BASE_BACKOFF_MS,
      totalBudgetMs: AUTH_AIDENID_PROVISION_TOTAL_BUDGET_MS,
      minAttemptTimeoutMs: AUTH_AIDENID_PROVISION_MIN_ATTEMPT_TIMEOUT_MS,
      requestId,
      requestOptions: {
        apiUrl: creds.apiUrl,
        apiKey: creds.apiKey,
        tags: ["jules-audit", "frontend-test"],
        ttlSeconds: 3600,
        dryRun: !executeRequested,
      },
    });
    const identity = result && typeof result === "object"
      ? (Object.prototype.hasOwnProperty.call(result, "identity") ? result.identity : (Object.prototype.hasOwnProperty.call(result, "value") ? result.value : result))
      : result;
    const retryTelemetry = result && typeof result === "object" && result.retryTelemetry
      ? result.retryTelemetry
      : null;
    recordProviderBreakerSuccess(providerKey, providerScope);
    return { available: true, requestId, dryRun: !executeRequested, identity, retryTelemetry };
  } catch (err) {
    const message = "AIdenID provisioning failed: " + normalizeErrorMessage(err, "unknown error");
    const retryable = isRetryableAidenidProvisionError(err);
    let providerBreaker = err && typeof err === "object" && err.providerBreaker ? err.providerBreaker : null;
    if (retryable) {
      providerBreaker = recordProviderBreakerFailure(providerKey, providerScope, err && typeof err === "object" ? err.errorCode : "") || providerBreaker;
    } else if (!providerBreaker) {
      providerBreaker = getProviderBreakerSnapshot(providerKey, providerScope);
    }
    return buildUnavailableAuditResponse(requestId, "AIDENID_PROVISION_FAILED", message, {
      retryable,
      retryTelemetry: err && typeof err === "object" && err.retryTelemetry ? err.retryTelemetry : null,
      providerBreaker,
    });
  }
}

/**
 * Run Playwright to authenticate and inspect the page.
 * - Runtime values loaded from a secure temp context file (credentials not exposed in process env)
 * - Auth verification checks URL change + cookie presence (not just click success)
 * - Console errors redacted to prevent sensitive data leakage
 * - Cookie values never captured (names + flags only)
 * - Temp script/context cleanup in finally block (not just success path)
 */
async function authenticatedPageCheck(input) {
  const requestId = String(input.requestId || createAuditRequestId());
  const providerKey = AUTH_AUDIT_PROVIDER_PLAYWRIGHT_TARGET;
  const url = input.url;
  if (!url) throw new AuthAuditError("authenticated_page_check requires url");
  const targetUrl = resolveAuthAuditTarget(url, input, "authenticated_page_check.target");
  const providerScope = deriveProviderBreakerScope({
    contextId: input.providerContextId || input.contextId || input.scopeId,
    targetUrl,
  });

  const loginUrlCandidate = input.loginUrl || targetUrl + "/login";
  const loginUrl = resolveAuthAuditTarget(loginUrlCandidate, input, "authenticated_page_check.login");
  const allowAuthMutation = input.allowAuthMutation === true || process.env[AUTH_MUTATION_ALLOWED_ENV] === "1";

  try {
    enforceProviderBreaker(providerKey, providerScope, requestId);
    const authContextJson = JSON.stringify({
      email: input.email || "",
      password: input.password || "",
      emailField: input.emailField || "",
      passwordField: input.passwordField || "",
      submitSelector: input.submitSelector || "",
    });
    // Use scrubbed env — strip API keys/tokens from child process
    const { buildScrubbedEnv } = await import("./shell.js");
    const env = {
      ...buildScrubbedEnv(),
      SL_AUDIT_TARGET_URL: targetUrl,
      SL_AUDIT_LOGIN_URL: loginUrl,
      SL_AUDIT_ALLOW_AUTH_MUTATION: allowAuthMutation ? "1" : "0",
    };

    const output = await runPlaywrightAuditScriptWithRetry(null, env, {
      scriptSource: PLAYWRIGHT_AUTH_SCRIPT,
      stdinPayload: authContextJson,
    });

    const result = JSON.parse(output.trim());
    const findings = [];
    for (const cookie of (result.cookies || [])) {
      if (cookie.sensitive && !cookie.httpOnly) {
        findings.push({ severity: "P1", title: "Sensitive cookie '" + cookie.name + "' missing httpOnly flag", file: targetUrl });
      }
      if (cookie.sensitive && !cookie.secure) {
        findings.push({ severity: "P1", title: "Sensitive cookie '" + cookie.name + "' missing Secure flag", file: targetUrl });
      }
      if (cookie.sensitive && cookie.sameSite === "None") {
        findings.push({ severity: "P2", title: "Sensitive cookie '" + cookie.name + "' has SameSite=None", file: targetUrl });
      }
    }
    findings.push(...evaluateAuthenticatedHeaderFindings(targetUrl, result.headers || {}, result.authSignals || {}));
    recordProviderBreakerSuccess(providerKey, providerScope);
    return { available: true, requestId, method: "playwright", mutationAllowed: allowAuthMutation, findings, ...result };
  } catch (err) {
    const code = err instanceof AuthAuditError ? "AUTH_AUDIT_VALIDATION_FAILED" : "AUTH_AUDIT_PLAYWRIGHT_FAILED";
    const baseMessage = err instanceof AuthAuditError ? err.message : "Playwright auth audit failed: " + normalizeErrorMessage(err, "unknown error");
    const retryable = isRetryablePlaywrightExecutionError(err);
    let providerBreaker = err && typeof err === "object" && err.providerBreaker ? err.providerBreaker : null;
    if (retryable) {
      providerBreaker = recordProviderBreakerFailure(providerKey, providerScope, err && typeof err === "object" ? err.errorCode : "") || providerBreaker;
    } else if (!providerBreaker) {
      providerBreaker = getProviderBreakerSnapshot(providerKey, providerScope);
    }
    return buildUnavailableAuditResponse(requestId, code, baseMessage, {
      retryable,
      providerBreaker,
    });
  }
}

// Playwright script as a constant — no string interpolation of URLs/credentials.
// Dynamic auth context is read from stdin at runtime to avoid local credential temp files.
const PLAYWRIGHT_AUTH_SCRIPT = `
const { chromium } = require('playwright');
const fs = require('node:fs');

(async () => {
  const targetUrl = process.env.SL_AUDIT_TARGET_URL;
  const loginUrl = process.env.SL_AUDIT_LOGIN_URL;
  const allowAuthMutation = process.env.SL_AUDIT_ALLOW_AUTH_MUTATION === '1';
  let context = {};
  try {
    let stdinPayload = fs.readFileSync(0, 'utf-8');
    if (stdinPayload) {
      context = JSON.parse(stdinPayload) || {};
    }
    stdinPayload = '';
  } catch {
    context = {};
  }

  let email = context.email || '';
  let password = context.password || '';
  const emailSelector = context.emailField || 'input[type="email"]';
  const passwordSelector = context.passwordField || 'input[type="password"]';
  const submitSelector = context.submitSelector || 'button[type="submit"]';
  if (Object.prototype.hasOwnProperty.call(context, 'password')) delete context.password;
  if (Object.prototype.hasOwnProperty.call(context, 'token')) delete context.token;
  if (Object.prototype.hasOwnProperty.call(context, 'secret')) delete context.secret;

  let browser = null;
  const results = { authenticated: false, authSignals: {}, errors: [], cookies: [], headers: {}, domStats: {}, executionFailed: false };
  results.authSignals.mutationAllowed = allowAuthMutation;
  function normalizePath(value) {
    const normalized = String(value || '/').replace(/\\/+$/, '');
    return normalized || '/';
  }
  function didLeaveLoginSurface(currentValue, loginValue) {
    try {
      const currentUrl = new URL(currentValue);
      const loginParsed = new URL(loginValue);
      return (
        currentUrl.origin !== loginParsed.origin ||
        normalizePath(currentUrl.pathname) !== normalizePath(loginParsed.pathname)
      );
    } catch {
      return String(currentValue || '') !== String(loginValue || '');
    }
  }
  function sanitizeErrorText(value) {
    return String(value || '')
      .replace(/\\s+/g, ' ')
      .replace(/Bearer\\s+[^\\s,;]+/gi, 'Bearer [REDACTED]')
      .replace(/\\b(?:authorization|x-api-key|api-key|token|access_token|refresh_token|id_token|session|cookie|set-cookie|secret|password|passwd)\\b\\s*[:=]\\s*["']?[^"'\\s,;]+/gi, '$1=[REDACTED]')
      .replace(/\\b[A-Za-z0-9_-]{16,}\\.[A-Za-z0-9_-]{16,}\\.[A-Za-z0-9_-]{8,}\\b/g, '[REDACTED_JWT]')
      .replace(/\\b(?:gh[pousr]_[A-Za-z0-9]{20,}|sk-[A-Za-z0-9]{16,}|AIza[0-9A-Za-z-_]{20,}|xox[baprs]-[0-9A-Za-z-]{10,})\\b/g, '[REDACTED_TOKEN]')
      .replace(/\\b[A-Fa-f0-9]{32,}\\b/g, '[REDACTED_HEX]')
      .replace(/\\b[A-Za-z0-9_-]{40,}\\b/g, '[REDACTED_TOKEN]')
      .slice(0, 200);
  }

  try {
    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();
    page.on('console', msg => {
      if (msg.type() === 'error') {
        const text = sanitizeErrorText(msg.text());
        results.errors.push({ type: 'console', text });
      }
    });
    page.on('pageerror', err => {
      const text = sanitizeErrorText(err && err.message ? err.message : String(err || ''));
      results.errors.push({ type: 'pageerror', text });
    });

    if (email && password && loginUrl) {
      await page.goto(loginUrl, { waitUntil: 'networkidle', timeout: 30000 });
      if (allowAuthMutation) {
        await page.fill(emailSelector, email);
        await page.fill(passwordSelector, password);
        await page.click(submitSelector);
        let navigationError = null;
        await page.waitForNavigation({ waitUntil: 'networkidle', timeout: 15000 }).catch((err) => {
          navigationError = sanitizeErrorText(err && err.message ? err.message : 'navigation timeout');
        });
        if (navigationError) {
          results.authSignals.navigationTimeout = true;
          results.errors.push({ type: 'navigation', text: navigationError });
        }
        results.authSignals.mutationPerformed = true;
      } else {
        results.authSignals.mutationPerformed = false;
      }
      const authVerificationMaxAttempts = allowAuthMutation ? 3 : 1;
      let verificationAttemptsUsed = 0;
      let urlChanged = false;
      let authCookiePresent = false;
      let loginFormVisible = true;
      for (let verificationAttempt = 1; verificationAttempt <= authVerificationMaxAttempts; verificationAttempt += 1) {
        verificationAttemptsUsed = verificationAttempt;
        const currentUrl = page.url();
        const postCookies = await page.context().cookies();
        urlChanged = didLeaveLoginSurface(currentUrl, loginUrl);
        authCookiePresent = postCookies.some(c => /(?:^|[-_])(session|token|auth|jwt)(?:$|[-_])/i.test(c.name) && (c.httpOnly || c.secure));
        loginFormVisible = await page.evaluate((emailSel, passwordSel) => (
          Boolean(document.querySelector(emailSel) && document.querySelector(passwordSel))
        ), emailSelector, passwordSelector).catch(() => false);
        const navigationSucceeded = results.authSignals.navigationTimeout !== true;
        results.authenticated = navigationSucceeded && !loginFormVisible && urlChanged && authCookiePresent;
        if (results.authenticated) {
          break;
        }
        if (verificationAttempt < authVerificationMaxAttempts) {
          await page.waitForTimeout(400 * verificationAttempt);
        }
      }
      results.authSignals = {
        urlChanged,
        authCookiePresent,
        loginFormVisible,
        authVerificationAttemptsUsed: verificationAttemptsUsed,
        authVerificationMaxAttempts,
      };
      results.authSignals.authVerificationRetried = verificationAttemptsUsed > 1;
      results.authSignals.mutationAllowed = allowAuthMutation;
      results.authSignals.mutationPerformed = allowAuthMutation ? true : false;
      email = '';
      password = '';
    }

    const targetResponse = await page.goto(targetUrl, { waitUntil: 'networkidle', timeout: 30000 });

    const cookies = await page.context().cookies();
    results.cookies = cookies.map(c => ({
      name: c.name, domain: c.domain,
      httpOnly: c.httpOnly, secure: c.secure,
      sameSite: c.sameSite,
      sensitive: /session|token|auth|jwt/i.test(c.name),
    }));

    results.domStats = await page.evaluate(() => ({
      title: document.title,
      nodeCount: document.querySelectorAll('*').length,
      formCount: document.querySelectorAll('form').length,
      inputCount: document.querySelectorAll('input').length,
    }));

    const response = targetResponse || null;
    const targetLoginFormVisible = await page.evaluate((emailSel, passwordSel) => (
      Boolean(document.querySelector(emailSel) && document.querySelector(passwordSel))
    ), emailSelector, passwordSelector).catch(() => true);
    const targetStatus = response ? response.status() : null;
    const targetStatusOk = typeof targetStatus === 'number' ? targetStatus < 400 : false;
    results.authSignals.targetLoginFormVisible = targetLoginFormVisible;
    results.authSignals.targetStatus = targetStatus;
    results.authSignals.targetStatusOk = targetStatusOk;
    if (results.authenticated) {
      results.authenticated = !targetLoginFormVisible && targetStatusOk;
    }
    if (response) {
      const h = response.headers();
      results.headers = {
        'content-security-policy': h['content-security-policy'] || null,
        'x-frame-options': h['x-frame-options'] || null,
        'strict-transport-security': h['strict-transport-security'] || null,
        'cache-control': h['cache-control'] || null,
      };
      const normalizedFramePolicy = String(results.headers['x-frame-options'] || '').trim().toLowerCase();
      const headerPolicyBreaches = [];
      if (!results.headers['content-security-policy']) {
        headerPolicyBreaches.push('missing_content_security_policy');
      }
      if (String(targetUrl || '').startsWith('https://') && !results.headers['strict-transport-security']) {
        headerPolicyBreaches.push('missing_strict_transport_security');
      }
      if (!normalizedFramePolicy) {
        headerPolicyBreaches.push('missing_x_frame_options');
      } else if (!(normalizedFramePolicy === 'deny' || normalizedFramePolicy === 'sameorigin')) {
        headerPolicyBreaches.push('weak_x_frame_options');
      }
      results.authSignals.headerPolicyBreaches = headerPolicyBreaches;
      results.authSignals.headerPolicyPassed = headerPolicyBreaches.length === 0;
      results.authSignals.headerPolicyFailed = headerPolicyBreaches.length > 0;
    } else {
      results.authSignals.headerPolicyBreaches = ['target_response_unavailable'];
      results.authSignals.headerPolicyPassed = false;
      results.authSignals.headerPolicyFailed = true;
    }
  } catch (err) {
    results.executionFailed = true;
    const text = sanitizeErrorText('Playwright error: ' + (err && err.message ? err.message : ''));
    results.errors.push({ type: 'playwright', text });
  } finally {
    try { console.log(JSON.stringify(results)); } catch {}
    if (browser) {
      await browser.close().catch(() => {});
    }
    if (results.executionFailed) {
      process.exitCode = 1;
    }
  }
})();
`;

const MAX_AUTH_REDIRECT_HOPS = 5;
const AUTH_FLOW_FETCH_TIMEOUT_MS = 10_000;
const AUTH_FLOW_FETCH_MAX_RETRIES = 2;
const AUTH_FLOW_FETCH_BASE_BACKOFF_MS = 200;
const RETRYABLE_AUTH_FLOW_STATUS_CODES = new Set([408, 425, 429, 500, 502, 503, 504]);
const RETRYABLE_AUTH_FLOW_ERROR_CODES = new Set([
  "ECONNRESET",
  "EAI_AGAIN",
  "ENOTFOUND",
  "ECONNREFUSED",
  "ETIMEDOUT",
  "ECONNABORTED",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_HEADERS_TIMEOUT",
  "UND_ERR_BODY_TIMEOUT",
]);
const RETRYABLE_AUTH_FLOW_MESSAGE_PATTERNS = [
  /\bfetch failed\b/i,
  /\bnetwork(?:\s+|-)error\b/i,
  /\bsocket hang up\b/i,
  /\btimed?\s*out\b/i,
  /\b(?:econnreset|eai_again|enotfound|econnrefused|etimedout)\b/i,
  /\btemporary(?:\s+|-)failure\b/i,
  /\bconnection\b.*\b(?:reset|terminated|closed)\b/i,
];
const AUTH_FLOW_LOCAL_TEST_HOSTS = new Set(["localhost", "127.0.0.1", "::1"]);
const DEFAULT_APPROVED_AUTH_AUDIT_HOSTS = new Set(["example.com", "www.example.com"]);
const AUTH_AUDIT_ALLOWED_HOSTS_ENV = "SENTINELAYER_AUTH_AUDIT_ALLOWED_HOSTS";

function computePlaywrightBackoffMs(attempt, baseBackoffMs = AUTH_PLAYWRIGHT_EXEC_BASE_BACKOFF_MS) {
  const cappedBase = Math.max(1, Number.isFinite(baseBackoffMs) ? Math.trunc(baseBackoffMs) : AUTH_PLAYWRIGHT_EXEC_BASE_BACKOFF_MS);
  const exponential = Math.min(4000, cappedBase * Math.pow(2, Math.max(0, attempt)));
  const deterministicJitter = ((Math.max(0, attempt) * 1103515245 + 12345) % 1000) / 1000;
  const jitterFactor = 0.5 + (deterministicJitter * 0.5);
  return Math.max(1, Math.trunc(exponential * jitterFactor));
}

function isRetryablePlaywrightExecutionError(error) {
  if (!(error instanceof Error)) {
    return false;
  }
  if (error.name === "AbortError" || error.name === "TimeoutError") {
    return true;
  }
  const code = String(error.code || "").toUpperCase();
  if (RETRYABLE_PLAYWRIGHT_EXEC_ERROR_CODES.has(code)) {
    return true;
  }
  if (error.killed === true && (error.signal === "SIGTERM" || error.signal === "SIGKILL")) {
    return true;
  }
  const causeCode = String(error.cause?.code || error.cause?.errno || "").toUpperCase();
  return RETRYABLE_PLAYWRIGHT_EXEC_ERROR_CODES.has(causeCode);
}

function normalizeAuthAuditErrorMessage(error, fallbackMessage) {
  if (error instanceof Error && error.message) {
    return error.message;
  }
  const normalized = String(error || "").trim();
  return normalized || fallbackMessage;
}

export async function runPlaywrightAuditScriptWithRetry(scriptPath, env, options = {}) {
  const scriptSource = String(options.scriptSource || "");
  const runArgs = scriptSource ? ["-e", scriptSource] : (scriptPath ? [scriptPath] : []);
  if (runArgs.length === 0) {
    throw new AuthAuditError("Playwright auth audit failed: missing script path");
  }
  const stdinPayload = String(options.stdinPayload || "");
  const timeoutMs = Number.isFinite(options.timeoutMs) && options.timeoutMs > 0
    ? Math.trunc(options.timeoutMs)
    : AUTH_PLAYWRIGHT_EXEC_TIMEOUT_MS;
  const maxRetries = Number.isInteger(options.maxRetries) && options.maxRetries >= 0
    ? options.maxRetries
    : AUTH_PLAYWRIGHT_EXEC_MAX_RETRIES;
  const baseBackoffMs = Number.isFinite(options.baseBackoffMs) && options.baseBackoffMs > 0
    ? Math.trunc(options.baseBackoffMs)
    : AUTH_PLAYWRIGHT_EXEC_BASE_BACKOFF_MS;
  const totalBudgetMs = Number.isFinite(options.totalBudgetMs) && options.totalBudgetMs > 0
    ? Math.trunc(options.totalBudgetMs)
    : AUTH_PLAYWRIGHT_EXEC_TOTAL_BUDGET_MS;
  const minAttemptTimeoutMs = Number.isFinite(options.minAttemptTimeoutMs) && options.minAttemptTimeoutMs > 0
    ? Math.trunc(options.minAttemptTimeoutMs)
    : AUTH_PLAYWRIGHT_EXEC_MIN_ATTEMPT_TIMEOUT_MS;
  const execute = typeof options.exec === "function" ? options.exec : execFileSync;
  const now = typeof options.now === "function" ? options.now : Date.now;
  const sleepFn = typeof options.sleep === "function" ? options.sleep : sleep;
  const retryWindowStartedAt = now();

  for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
    const elapsedMs = now() - retryWindowStartedAt;
    const remainingBudgetMs = totalBudgetMs - elapsedMs;
    if (remainingBudgetMs <= 0) {
      throw new AuthAuditError(
        `Playwright auth audit failed: retry budget exhausted after ${attempt} attempt(s) over ${totalBudgetMs}ms`
      );
    }
    if (remainingBudgetMs < minAttemptTimeoutMs) {
      throw new AuthAuditError(
        `Playwright auth audit failed: remaining retry budget (${remainingBudgetMs}ms) below minimum attempt timeout (${minAttemptTimeoutMs}ms)`
      );
    }
    const attemptTimeoutMs = Math.max(minAttemptTimeoutMs, Math.min(timeoutMs, remainingBudgetMs));
    try {
      return execute(process.execPath, runArgs, {
        encoding: "utf-8",
        timeout: attemptTimeoutMs,
        stdio: ["pipe", "pipe", "pipe"],
        env,
        input: stdinPayload,
      });
    } catch (error) {
      if (!isRetryablePlaywrightExecutionError(error) || attempt >= maxRetries) {
        const reason = normalizeAuthAuditErrorMessage(error, "Playwright execution failed");
        throw new AuthAuditError(`Playwright auth audit failed after ${attempt + 1} attempt(s): ${reason}`);
      }
    }
    const backoffMs = computePlaywrightBackoffMs(attempt, baseBackoffMs);
    const remainingAfterAttemptMs = totalBudgetMs - (now() - retryWindowStartedAt);
    if (remainingAfterAttemptMs <= 0) {
      throw new AuthAuditError(
        `Playwright auth audit failed: retry budget exhausted after ${attempt + 1} attempt(s) over ${totalBudgetMs}ms`
      );
    }
    await sleepFn(Math.min(backoffMs, remainingAfterAttemptMs));
  }

  throw new AuthAuditError("Playwright auth audit failed after retry budget was exhausted");
}

function computeAuthFlowBackoffMs(attempt) {
  const computed = AUTH_FLOW_FETCH_BASE_BACKOFF_MS * Math.pow(2, Math.max(0, attempt));
  return Math.min(1000, computed);
}

function resolveAuthFlowErrorCode(error) {
  if (!(error instanceof Error)) {
    return "";
  }
  const directCode = String(error.code || "").toUpperCase();
  if (directCode) {
    return directCode;
  }
  const cause = error.cause;
  if (!cause || typeof cause !== "object") {
    return "";
  }
  return String(cause.code || cause.errno || "").toUpperCase();
}

function isRetryableAuthFlowError(error) {
  if (!(error instanceof Error)) {
    return false;
  }
  if (error.name === "AbortError" || error.name === "TimeoutError") {
    return true;
  }
  const code = resolveAuthFlowErrorCode(error);
  if (RETRYABLE_AUTH_FLOW_ERROR_CODES.has(code)) {
    return true;
  }
  const normalized = `${error.name} ${error.message || ""}`.toLowerCase();
  if (error.name === "TypeError") {
    return RETRYABLE_AUTH_FLOW_MESSAGE_PATTERNS.some((pattern) => pattern.test(normalized));
  }
  return RETRYABLE_AUTH_FLOW_MESSAGE_PATTERNS.some((pattern) => pattern.test(normalized));
}

function isAllowedHttpAuthFlowTarget(urlObject) {
  if (urlObject.protocol !== "http:") {
    return true;
  }
  if (process.env.NODE_ENV !== "test") {
    return false;
  }
  return AUTH_FLOW_LOCAL_TEST_HOSTS.has(urlObject.hostname);
}

function isUnapprovedAuthAuditBypassEnabled() {
  if (process.env.NODE_ENV === "test") {
    return true;
  }
  if (process.env.SENTINELAYER_ALLOW_UNAPPROVED_AUTH_AUDIT_TARGETS === "1") {
    return true;
  }
  return false;
}

function normalizeHostEntry(value) {
  return String(value || "").trim().toLowerCase();
}

function resolveApprovedAuthAuditHosts(input) {
  const approvedHosts = new Set(DEFAULT_APPROVED_AUTH_AUDIT_HOSTS);
  const hostLists = [];
  if (Array.isArray(input?.approvedHosts)) {
    hostLists.push(input.approvedHosts);
  }
  if (Array.isArray(input?.approvedHostnames)) {
    hostLists.push(input.approvedHostnames);
  }
  const envHosts = String(process.env[AUTH_AUDIT_ALLOWED_HOSTS_ENV] || "")
    .split(",")
    .map((entry) => normalizeHostEntry(entry))
    .filter(Boolean);
  hostLists.push(envHosts);
  for (const list of hostLists) {
    for (const host of list) {
      const normalized = normalizeHostEntry(host);
      if (normalized) {
        approvedHosts.add(normalized);
      }
    }
  }
  return approvedHosts;
}

function assertApprovedAuthAuditTarget(parsed, input, operation) {
  if (isUnapprovedAuthAuditBypassEnabled()) {
    return parsed;
  }
  const allowLiveProvision = input?.allowProvisioning === true || process.env.SENTINELAYER_ALLOW_LIVE_IDENTITY_PROVISION === "1";
  const approvedTargetId = String(input?.approvedTargetId || "").trim();
  if (!allowLiveProvision || !approvedTargetId) {
    throw new AuthAuditError(
      `Live ${operation} requires allowProvisioning=true and approvedTargetId to prevent unapproved outbound probing.`
    );
  }
  const approvedHosts = resolveApprovedAuthAuditHosts(input);
  const normalizedHost = normalizeHostEntry(parsed.hostname);
  if (!approvedHosts.has(normalizedHost)) {
    throw new AuthAuditError(
      `Blocked unapproved auth audit host for ${operation}: ${normalizedHost}. ` +
      `Add host to approvedHosts or ${AUTH_AUDIT_ALLOWED_HOSTS_ENV}.`
    );
  }
  return parsed;
}

function assertSecureAuthFlowTarget(urlValue, options = {}) {
  let parsed;
  try {
    parsed = assertPermittedAuditTarget(urlValue, {
      operation: "check_auth_flow_security",
      allowPrivateTargets: options.allowPrivateTargets === true,
    });
  } catch (error) {
    throw new AuthAuditError(error.message);
  }
  assertApprovedAuthAuditTarget(parsed, options.auditInput || {}, "check_auth_flow_security");
  if (!isAllowedHttpAuthFlowTarget(parsed)) {
    throw new AuthAuditError(
      `HTTPS downgrade detected in auth flow target: ${parsed.toString()}`
    );
  }
  return parsed;
}

async function fetchWithTimeout(url, options, timeoutMs) {
  const callerSignal = isAbortSignalLike(options?.signal) ? options.signal : undefined;
  const controller = new AbortController();
  const timeoutHandle = setTimeout(() => controller.abort(), timeoutMs);
  const { signal: compositeSignal, cleanup: cleanupCompositeSignal } = composeAbortSignals(callerSignal, controller.signal);
  try {
    return await fetch(url, {
      ...options,
      ...(compositeSignal ? { signal: compositeSignal } : {}),
    });
  } finally {
    clearTimeout(timeoutHandle);
    cleanupCompositeSignal();
  }
}

async function fetchLoginResponseWithRetry(currentUrl) {
  for (let attempt = 0; attempt <= AUTH_FLOW_FETCH_MAX_RETRIES; attempt += 1) {
    try {
      const response = await fetchWithTimeout(currentUrl, {
        method: "GET",
        redirect: "manual",
      }, AUTH_FLOW_FETCH_TIMEOUT_MS);
      if (!RETRYABLE_AUTH_FLOW_STATUS_CODES.has(response.status)) {
        return response;
      }
      if (attempt >= AUTH_FLOW_FETCH_MAX_RETRIES) {
        throw new AuthAuditError(
          `Auth flow header fetch failed after ${attempt + 1} attempt(s): HTTP ${response.status}`
        );
      }
    } catch (error) {
      if (error instanceof AuthAuditError) {
        throw error;
      }
      if (!isRetryableAuthFlowError(error) || attempt >= AUTH_FLOW_FETCH_MAX_RETRIES) {
        const message = error instanceof Error ? error.message : String(error || "request failed");
        throw new AuthAuditError(`Auth flow header fetch failed after ${attempt + 1} attempt(s): ${message}`);
      }
    }
    await sleep(computeAuthFlowBackoffMs(attempt));
  }
  throw new AuthAuditError("Auth flow header fetch failed after retry budget was exhausted");
}

async function checkAuthFlowSecurity(input) {
  const requestId = String(input.requestId || createAuditRequestId());
  const loginUrlCandidate = input.loginUrl || input.url;
  if (!loginUrlCandidate) throw new AuthAuditError("check_auth_flow_security requires loginUrl or url");
  const allowPrivateTargets = input.allowPrivateTargets === true;
  const loginUrl = assertSecureAuthFlowTarget(loginUrlCandidate, { allowPrivateTargets, auditInput: input }).toString();

  const findings = [];
  try {
    const { headers, finalUrl, crossOriginRedirect } = await fetchLoginHeaders(loginUrl, { allowPrivateTargets, auditInput: input });

    if (crossOriginRedirect) {
      findings.push({
        severity: "P1",
        title: "Login flow redirects cross-origin before header checks",
        file: loginUrl,
      });
    }

    if (!headers["strict-transport-security"]) {
      findings.push({ severity: "P1", title: "Login page missing HSTS header", file: finalUrl || loginUrl });
    }
    if (!headers["content-security-policy"]) {
      findings.push({ severity: "P2", title: "Login page missing CSP header", file: finalUrl || loginUrl });
    }
    if (headers["x-powered-by"]) {
      findings.push({
        severity: "P2",
        title: "Login page exposes X-Powered-By: " + headers["x-powered-by"],
        file: finalUrl || loginUrl,
      });
    }
  } catch (err) {
    if (err instanceof AuthAuditError && /HTTPS downgrade detected/.test(err.message)) {
      findings.push({
        severity: "P1",
        title: err.message,
        file: loginUrl,
      });
    }
    return {
      ...buildUnavailableAuditResponse(
        requestId,
        "AUTH_FLOW_CHECK_FAILED",
        "auth flow check failed: " + normalizeErrorMessage(err, "unknown error")
      ),
      loginUrl,
      findings,
    };
  }
  return { available: true, requestId, loginUrl, findings };
}

async function fetchLoginHeaders(loginUrl, options = {}) {
  let currentUrl = loginUrl;
  const visitedUrls = new Set();
  let redirectCount = 0;

  while (true) {
    if (redirectCount > MAX_AUTH_REDIRECT_HOPS) {
      throw new AuthAuditError(
        `Exceeded ${MAX_AUTH_REDIRECT_HOPS} redirects while checking auth flow (last=${currentUrl})`
      );
    }
    const currentParsedUrl = assertSecureAuthFlowTarget(currentUrl, options);
    if (visitedUrls.has(currentUrl)) {
      throw new AuthAuditError("Redirect loop detected while checking auth headers");
    }
    visitedUrls.add(currentUrl);

    const response = await fetchLoginResponseWithRetry(currentUrl);
    const headers = Object.fromEntries(response.headers.entries());

    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get("location");
      if (!location) {
        return { headers, finalUrl: currentUrl, crossOriginRedirect: false };
      }
      const nextParsedUrl = assertSecureAuthFlowTarget(new URL(location, currentParsedUrl).toString(), options);
      if (nextParsedUrl.origin !== currentParsedUrl.origin) {
        return { headers, finalUrl: currentUrl, crossOriginRedirect: true };
      }
      currentUrl = nextParsedUrl.toString();
      redirectCount += 1;
      continue;
    }

    return { headers, finalUrl: currentUrl, crossOriginRedirect: false };
  }
}

function resolveAuthAuditTarget(urlValue, input, operation) {
  try {
    const parsed = assertPermittedAuditTarget(urlValue, {
      operation,
      allowPrivateTargets: input.allowPrivateTargets === true,
    });
    assertApprovedAuthAuditTarget(parsed, input, operation);
    return parsed.toString();
  } catch (error) {
    throw new AuthAuditError(error.message);
  }
}

export class AuthAuditError extends Error {
  constructor(message) { super(message); this.name = "AuthAuditError"; }
}
