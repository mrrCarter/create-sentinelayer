import crypto from "node:crypto";

import { resolveActiveAuthSession } from "../auth/service.js";
import { requestJson } from "../auth/http.js";

export const DD_REPORT_EMAIL_TIMEOUT_MS = 10_000;

const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

function normalizeString(value) {
  return String(value || "").trim();
}

export function normalizeReportEmail(value) {
  const normalized = normalizeString(value);
  if (!EMAIL_RE.test(normalized)) {
    return "";
  }
  return normalized;
}

export function buildReportEmailIdempotencyKey({ runId, to }) {
  const digest = crypto
    .createHash("sha256")
    .update(`${normalizeString(runId)}\0${normalizeString(to).toLowerCase()}`)
    .digest("hex")
    .slice(0, 32);
  return `sl-cli-dd-email-${digest}`;
}

export function redactDdEmailError(value) {
  return normalizeString(value)
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [REDACTED]")
    .replace(/[A-Za-z]:[\\/][^\s"'<>]+/g, "[LOCAL_PATH]")
    .replace(/api[_-]?key\s*=\s*[^&\s]+/gi, "api_key=[REDACTED]")
    .slice(0, 500);
}

function normalizeTimeoutMs(env = process.env) {
  const parsed = Number(env.SENTINELAYER_DD_EMAIL_TIMEOUT_MS);
  if (Number.isFinite(parsed) && parsed > 0) {
    return Math.max(100, Math.floor(parsed));
  }
  return DD_REPORT_EMAIL_TIMEOUT_MS;
}

function errorResult({ runId, to, code, message, status = 0, requestId = null }) {
  return {
    queued: false,
    sent: false,
    runId: normalizeString(runId),
    to: normalizeString(to),
    code: normalizeString(code) || "DD_EMAIL_FAILED",
    error: redactDdEmailError(message) || "DD report email request failed.",
    status: Number(status || 0),
    requestId: requestId ? String(requestId) : null,
  };
}

/**
 * Trigger the API-side investor-DD report email endpoint for a completed run.
 *
 * The caller owns run completion and event emission. This helper only handles
 * auth resolution, bounded network behavior, idempotency, and redacted errors.
 */
export async function sendDdReportEmail({
  runId,
  to,
  cwd = process.cwd(),
  env = process.env,
  resolveAuthSession = resolveActiveAuthSession,
  requestJsonImpl = requestJson,
  timeoutMs = normalizeTimeoutMs(env),
} = {}) {
  const normalizedRunId = normalizeString(runId);
  const normalizedTo = normalizeReportEmail(to);
  if (!normalizedRunId) {
    return errorResult({ runId, to, code: "DD_EMAIL_RUN_ID_REQUIRED", message: "runId is required." });
  }
  if (!normalizedTo) {
    return errorResult({ runId, to, code: "DD_EMAIL_INVALID_RECIPIENT", message: "Invalid report email recipient." });
  }

  let session = null;
  try {
    session = await resolveAuthSession({
      cwd,
      env,
      autoRotate: false,
    });
  } catch (err) {
    return errorResult({
      runId: normalizedRunId,
      to: normalizedTo,
      code: "DD_EMAIL_AUTH_UNAVAILABLE",
      message: err instanceof Error ? err.message : String(err),
    });
  }

  if (!session || !session.token) {
    return errorResult({
      runId: normalizedRunId,
      to: normalizedTo,
      code: "DD_EMAIL_AUTH_REQUIRED",
      message: "Authenticate before sending DD report email.",
    });
  }

  const apiUrl = normalizeString(session.apiUrl) || "https://api.sentinelayer.com";
  const endpoint = `${apiUrl.replace(/\/+$/, "")}/api/v1/runs/${encodeURIComponent(
    normalizedRunId,
  )}/send-report-email`;
  const idempotencyKey = buildReportEmailIdempotencyKey({
    runId: normalizedRunId,
    to: normalizedTo,
  });

  try {
    const response = await requestJsonImpl(endpoint, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${session.token}`,
      },
      idempotencyKey,
      body: { to: normalizedTo },
      timeoutMs,
      maxRetries: 1,
    });
    return {
      queued: true,
      sent: Boolean(response?.sent ?? true),
      runId: normalizeString(response?.run_id) || normalizedRunId,
      to: normalizeString(response?.to) || normalizedTo,
      messageId: normalizeString(response?.message_id),
      replay: Boolean(response?.replay),
      idempotencyKey,
    };
  } catch (err) {
    return errorResult({
      runId: normalizedRunId,
      to: normalizedTo,
      code: err?.code || "DD_EMAIL_REQUEST_FAILED",
      message: err instanceof Error ? err.message : String(err),
      status: err?.status || 0,
      requestId: err?.requestId || null,
    });
  }
}
