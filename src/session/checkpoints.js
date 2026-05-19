import crypto from "node:crypto";
import process from "node:process";

import { requestJson, requestJsonMutation } from "../auth/http.js";
import { resolveActiveAuthSession } from "../auth/service.js";

const DEFAULT_API_BASE_URL = "https://api.sentinelayer.com";
const DEFAULT_CHECKPOINT_LIMIT = 100;
const MAX_CHECKPOINT_LIMIT = 200;
const DEFAULT_MIN_EVENTS = 20;
const DEFAULT_MAX_EVENTS = 80;

function normalizeString(value) {
  return String(value || "").trim();
}

function normalizeApiUrl(value) {
  return (normalizeString(value) || DEFAULT_API_BASE_URL).replace(/\/+$/g, "");
}

function parsePositiveInteger(value, field, fallbackValue = null) {
  if (value === undefined || value === null || normalizeString(value) === "") {
    if (fallbackValue !== null) return fallbackValue;
    throw new Error(`${field} is required.`);
  }
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`${field} must be a positive integer.`);
  }
  return Math.floor(parsed);
}

function normalizeLimit(value) {
  const parsed = parsePositiveInteger(value, "limit", DEFAULT_CHECKPOINT_LIMIT);
  return Math.max(1, Math.min(MAX_CHECKPOINT_LIMIT, parsed));
}

function stableHash(value) {
  return crypto
    .createHash("sha256")
    .update(JSON.stringify(stableJson(value)))
    .digest("hex");
}

function stableJson(value) {
  if (Array.isArray(value)) {
    return value.map((item) => stableJson(item));
  }
  if (!value || typeof value !== "object") {
    return value;
  }
  const out = {};
  for (const key of Object.keys(value).sort()) {
    const next = stableJson(value[key]);
    if (next !== undefined && next !== null && next !== "") {
      out[key] = next;
    }
  }
  return out;
}

function buildCheckpointFingerprint(payload) {
  return stableHash(stableJson(payload));
}

function buildStableCheckpointId(sessionId, payload) {
  const fingerprint = buildCheckpointFingerprint({
    sessionId: normalizeString(sessionId),
    startSequence: payload.startSequence,
    endSequence: payload.endSequence,
    kind: payload.kind,
    title: payload.title,
    summary: payload.summary,
    createdByAgentId: payload.createdByAgentId,
    tokenRange: payload.tokenRange || null,
  });
  return `cp_cli_${fingerprint.slice(0, 24)}`;
}

function buildStableIdempotencyKey(sessionId, operation, payload) {
  const fingerprint = buildCheckpointFingerprint({
    sessionId: normalizeString(sessionId),
    operation,
    payload,
  });
  return `sl_cli_session_checkpoint_${fingerprint}`;
}

function buildInvocationIdempotencyKey(operation) {
  let suffix;
  try {
    suffix = crypto.randomUUID();
  } catch {
    suffix = crypto.randomBytes(16).toString("hex");
  }
  return `sl_cli_session_checkpoint_${normalizeString(operation) || "mutation"}_${suffix}`;
}

function normalizeTokenRange({ tokenStart, tokenEnd } = {}) {
  const hasStart = tokenStart !== undefined && normalizeString(tokenStart) !== "";
  const hasEnd = tokenEnd !== undefined && normalizeString(tokenEnd) !== "";
  if (!hasStart && !hasEnd) return null;
  const start = hasStart ? parsePositiveInteger(tokenStart, "token-start") : null;
  const end = hasEnd ? parsePositiveInteger(tokenEnd, "token-end") : null;
  if (start !== null && end !== null && start > end) {
    throw new Error("token-start must be less than or equal to token-end.");
  }
  return { start, end };
}

export function buildManualCheckpointPayload(sessionId, {
  checkpointId = "",
  startSequence,
  endSequence,
  kind = "summary",
  title,
  summary,
  createdByAgentId = "",
  tokenStart,
  tokenEnd,
} = {}) {
  const normalizedSessionId = normalizeString(sessionId);
  if (!normalizedSessionId) {
    throw new Error("session id is required.");
  }
  const normalizedStart = parsePositiveInteger(startSequence, "start-sequence");
  const normalizedEnd = parsePositiveInteger(endSequence, "end-sequence");
  if (normalizedStart > normalizedEnd) {
    throw new Error("start-sequence must be less than or equal to end-sequence.");
  }
  const normalizedTitle = normalizeString(title);
  if (!normalizedTitle) {
    throw new Error("title is required.");
  }
  const normalizedSummary = normalizeString(summary);
  if (!normalizedSummary) {
    throw new Error("summary is required.");
  }
  const normalizedKind = normalizeString(kind) || "summary";
  const normalizedCreatedBy = normalizeString(createdByAgentId);
  const tokenRange = normalizeTokenRange({ tokenStart, tokenEnd });
  const body = {
    startSequence: normalizedStart,
    endSequence: normalizedEnd,
    kind: normalizedKind,
    title: normalizedTitle,
    summary: normalizedSummary,
  };
  if (normalizedCreatedBy) {
    body.createdByAgentId = normalizedCreatedBy;
  }
  if (tokenRange) {
    body.tokenRange = tokenRange;
  }
  body.checkpointId = normalizeString(checkpointId) || buildStableCheckpointId(normalizedSessionId, body);
  return {
    body,
    idempotencyKey: buildStableIdempotencyKey(normalizedSessionId, "create", body),
  };
}

export function buildGenerateCheckpointPayload(sessionId, {
  minEvents = DEFAULT_MIN_EVENTS,
  maxEvents = DEFAULT_MAX_EVENTS,
  createdByAgentId = "",
  idempotencyKey = "",
} = {}) {
  const normalizedSessionId = normalizeString(sessionId);
  if (!normalizedSessionId) {
    throw new Error("session id is required.");
  }
  const normalizedMin = parsePositiveInteger(minEvents, "min-events", DEFAULT_MIN_EVENTS);
  const normalizedMax = parsePositiveInteger(maxEvents, "max-events", DEFAULT_MAX_EVENTS);
  if (normalizedMin > 200) {
    throw new Error("min-events must be less than or equal to 200.");
  }
  if (normalizedMax > 200) {
    throw new Error("max-events must be less than or equal to 200.");
  }
  if (normalizedMax < normalizedMin) {
    throw new Error("max-events must be greater than or equal to min-events.");
  }
  const body = {
    minEvents: normalizedMin,
    maxEvents: normalizedMax,
  };
  const normalizedCreatedBy = normalizeString(createdByAgentId);
  if (normalizedCreatedBy) {
    body.createdByAgentId = normalizedCreatedBy;
  }
  return {
    body,
    idempotencyKey:
      normalizeString(idempotencyKey) || buildInvocationIdempotencyKey("generate"),
  };
}

async function resolveCheckpointApi({
  targetPath = process.cwd(),
  resolveAuthSession = resolveActiveAuthSession,
} = {}) {
  const auth = await resolveAuthSession({
    cwd: targetPath,
    env: process.env,
    autoRotate: false,
  });
  if (!auth || !auth.token) {
    throw new Error("Sentinelayer auth is required. Run `sl auth login` first.");
  }
  return {
    apiUrl: normalizeApiUrl(auth.apiUrl),
    headers: { Authorization: `Bearer ${auth.token}` },
  };
}

export async function listSessionCheckpoints(sessionId, {
  targetPath = process.cwd(),
  limit = DEFAULT_CHECKPOINT_LIMIT,
  resolveAuthSession = resolveActiveAuthSession,
  request = requestJson,
} = {}) {
  const normalizedSessionId = normalizeString(sessionId);
  if (!normalizedSessionId) {
    throw new Error("session id is required.");
  }
  const { apiUrl, headers } = await resolveCheckpointApi({ targetPath, resolveAuthSession });
  const params = new URLSearchParams({ limit: String(normalizeLimit(limit)) });
  const response = await request(
    `${apiUrl}/api/v1/sessions/${encodeURIComponent(normalizedSessionId)}/checkpoints?${params.toString()}`,
    { method: "GET", headers },
  );
  const checkpoints = Array.isArray(response?.checkpoints) ? response.checkpoints : [];
  return {
    ok: true,
    sessionId: normalizedSessionId,
    apiUrl,
    checkpoints,
    count: Number(response?.count ?? checkpoints.length) || checkpoints.length,
  };
}

export async function createSessionCheckpoint(sessionId, options = {}) {
  const normalizedSessionId = normalizeString(sessionId);
  const {
    targetPath = process.cwd(),
    resolveAuthSession = resolveActiveAuthSession,
    requestMutation = requestJsonMutation,
  } = options;
  const { body, idempotencyKey } = buildManualCheckpointPayload(normalizedSessionId, options);
  const { apiUrl, headers } = await resolveCheckpointApi({ targetPath, resolveAuthSession });
  const response = await requestMutation(
    `${apiUrl}/api/v1/sessions/${encodeURIComponent(normalizedSessionId)}/checkpoints`,
    {
      operationName: "session-checkpoint-create",
      headers,
      body,
      idempotencyKey,
    },
  );
  return {
    ...response,
    sessionId: normalizedSessionId,
    apiUrl,
    checkpoint: response?.checkpoint || null,
    idempotencyKey,
  };
}

export async function generateSessionCheckpoint(sessionId, options = {}) {
  const normalizedSessionId = normalizeString(sessionId);
  const {
    targetPath = process.cwd(),
    resolveAuthSession = resolveActiveAuthSession,
    requestMutation = requestJsonMutation,
  } = options;
  const { body, idempotencyKey } = buildGenerateCheckpointPayload(normalizedSessionId, options);
  const { apiUrl, headers } = await resolveCheckpointApi({ targetPath, resolveAuthSession });
  const response = await requestMutation(
    `${apiUrl}/api/v1/sessions/${encodeURIComponent(normalizedSessionId)}/checkpoints/generate`,
    {
      operationName: "session-checkpoint-generate",
      headers,
      body,
      idempotencyKey,
    },
  );
  return {
    ...response,
    sessionId: normalizedSessionId,
    apiUrl,
    checkpoint: response?.checkpoint || null,
    idempotencyKey,
  };
}
