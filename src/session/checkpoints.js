import crypto from "node:crypto";
import process from "node:process";

import { SentinelayerApiError, requestJson, requestJsonMutation } from "../auth/http.js";
import { resolveActiveAuthSession } from "../auth/service.js";
import { pollSessionEventsBefore } from "./sync.js";

const DEFAULT_API_BASE_URL = "https://api.sentinelayer.com";
const DEFAULT_CHECKPOINT_LIMIT = 100;
const MAX_CHECKPOINT_LIMIT = 200;
const DEFAULT_MIN_EVENTS = 20;
const DEFAULT_MAX_EVENTS = 80;
const DEFAULT_BATCH_MAX_CHECKPOINTS = 5;
const MAX_BATCH_MAX_CHECKPOINTS = 50;
const DEFAULT_RESTORE_CONTEXT_EVENTS = 3;
const DEFAULT_RESTORE_MAX_EVENTS = 120;
const MAX_RESTORE_CONTEXT_EVENTS = 50;
const MAX_RESTORE_EVENTS = 200;
const DEFAULT_CREATED_BY_AGENT_ID = "senti";

function normalizeString(value) {
  return String(value ?? "").trim();
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

function parseNonNegativeInteger(value, field, fallbackValue = 0) {
  if (value === undefined || value === null || normalizeString(value) === "") {
    return Math.max(0, Math.floor(Number(fallbackValue) || 0));
  }
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new Error(`${field} must be a non-negative integer.`);
  }
  return Math.floor(parsed);
}

function normalizeLimit(value) {
  const parsed = parsePositiveInteger(value, "limit", DEFAULT_CHECKPOINT_LIMIT);
  return Math.max(1, Math.min(MAX_CHECKPOINT_LIMIT, parsed));
}

function normalizeBatchMaxCheckpoints(value) {
  const parsed = parsePositiveInteger(
    value,
    "max-checkpoints",
    DEFAULT_BATCH_MAX_CHECKPOINTS,
  );
  return Math.max(1, Math.min(MAX_BATCH_MAX_CHECKPOINTS, parsed));
}

function normalizeRestoreMaxEvents(value) {
  const parsed = parsePositiveInteger(value, "max-events", DEFAULT_RESTORE_MAX_EVENTS);
  return Math.max(1, Math.min(MAX_RESTORE_EVENTS, parsed));
}

function normalizeRestoreContextEvents(value) {
  const parsed = parseNonNegativeInteger(value, "context-events", DEFAULT_RESTORE_CONTEXT_EVENTS);
  return Math.max(0, Math.min(MAX_RESTORE_CONTEXT_EVENTS, parsed));
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

function buildBatchIdempotencyKey(baseKey, index) {
  const normalizedBase = normalizeString(baseKey);
  if (!normalizedBase) return "";
  return `${normalizedBase}:${Number(index) + 1}`;
}

function normalizeReason(value, fallbackValue = "checkpoint_generate_failed") {
  return (
    normalizeString(value)
      .toLowerCase()
      .replace(/[^a-z0-9_:-]+/g, "_")
      .replace(/^_+|_+$/g, "") || fallbackValue
  );
}

function buildCheckpointNoop(reason, extra = {}) {
  return {
    ok: false,
    created: false,
    duplicate: false,
    reason: normalizeReason(reason),
    checkpoint: null,
    checkpointId: null,
    eventCount: null,
    ...extra,
  };
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

function checkpointIdOf(checkpoint = {}) {
  return normalizeString(checkpoint.checkpointId || checkpoint.checkpoint_id);
}

function checkpointSequenceValue(checkpoint = {}, camelKey, snakeKey) {
  const parsed = Number(checkpoint[camelKey] ?? checkpoint[snakeKey]);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : 0;
}

function eventSequenceValue(event = {}) {
  const parsed = Number(event.sequenceId ?? event.sequence_id ?? event.sequence);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : 0;
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

export function findCheckpointById(checkpoints = [], checkpointId = "") {
  const normalizedCheckpointId = normalizeString(checkpointId);
  if (!normalizedCheckpointId) return null;
  return Array.isArray(checkpoints)
    ? checkpoints.find((checkpoint) => checkpointIdOf(checkpoint) === normalizedCheckpointId) || null
    : null;
}

export function buildCheckpointRestoreWindow(checkpoint = {}, {
  contextEvents = DEFAULT_RESTORE_CONTEXT_EVENTS,
  maxEvents = DEFAULT_RESTORE_MAX_EVENTS,
} = {}) {
  const startSequence = checkpointSequenceValue(checkpoint, "startSequence", "start_sequence");
  const endSequence = checkpointSequenceValue(checkpoint, "endSequence", "end_sequence");
  if (startSequence <= 0) {
    throw new Error("checkpoint startSequence is required for restore.");
  }
  if (endSequence <= 0) {
    throw new Error("checkpoint endSequence is required for restore.");
  }
  if (startSequence > endSequence) {
    throw new Error("checkpoint startSequence must be less than or equal to endSequence.");
  }
  const normalizedContext = normalizeRestoreContextEvents(contextEvents);
  const normalizedMaxEvents = normalizeRestoreMaxEvents(maxEvents);
  const sourceEventCountExpected = endSequence - startSequence + 1;
  const requestedEventCount = sourceEventCountExpected + normalizedContext * 2;
  const limit = Math.min(normalizedMaxEvents, requestedEventCount, MAX_RESTORE_EVENTS);
  return {
    checkpointId: checkpointIdOf(checkpoint) || null,
    startSequence,
    endSequence,
    contextEvents: normalizedContext,
    maxEvents: normalizedMaxEvents,
    limit,
    beforeSequence: endSequence + normalizedContext + 1,
    lowerBoundSequence: Math.max(1, startSequence - normalizedContext),
    sourceEventCountExpected,
    truncatedByLimit: limit < requestedEventCount,
  };
}

export function classifyCheckpointRestoreEvents(events = [], window = {}) {
  const normalizedEvents = Array.isArray(events) ? events : [];
  const startSequence = Number(window.startSequence || 0);
  const endSequence = Number(window.endSequence || 0);
  const sourceEventCountExpected = Number(window.sourceEventCountExpected || 0);
  const beforeContextEvents = [];
  const sourceEvents = [];
  const afterContextEvents = [];
  const sourceSequenceIds = new Set();

  for (const event of normalizedEvents) {
    const sequence = eventSequenceValue(event);
    if (sequence <= 0) continue;
    if (sequence < startSequence) {
      beforeContextEvents.push(event);
    } else if (sequence > endSequence) {
      afterContextEvents.push(event);
    } else {
      sourceEvents.push(event);
      sourceSequenceIds.add(sequence);
    }
  }

  const missingStart = startSequence > 0 && !sourceSequenceIds.has(startSequence);
  const missingEnd = endSequence > 0 && !sourceSequenceIds.has(endSequence);
  const missingSourceEvents = Math.max(0, sourceEventCountExpected - sourceSequenceIds.size);
  return {
    events: normalizedEvents,
    beforeContextEvents,
    sourceEvents,
    afterContextEvents,
    eventCount: normalizedEvents.length,
    beforeContextCount: beforeContextEvents.length,
    sourceEventCount: sourceEvents.length,
    afterContextCount: afterContextEvents.length,
    missingStart,
    missingEnd,
    missingSourceEvents,
    completeSourceRange:
      sourceEventCountExpected > 0 &&
      !missingStart &&
      !missingEnd &&
      missingSourceEvents === 0,
    partial:
      Boolean(window.truncatedByLimit) ||
      missingStart ||
      missingEnd ||
      missingSourceEvents > 0,
  };
}

export function normalizeCheckpointGenerationResult(payload = {}) {
  const source = payload && typeof payload === "object" && !Array.isArray(payload) ? payload : {};
  const checkpoint =
    source.checkpoint && typeof source.checkpoint === "object" && !Array.isArray(source.checkpoint)
      ? source.checkpoint
      : null;
  const checkpointId = normalizeString(
    source.checkpointId ||
      source.checkpoint_id ||
      checkpoint?.checkpointId ||
      checkpoint?.checkpoint_id,
  ) || null;
  const eventCount = Number(source.eventCount ?? source.event_count);
  const minEvents = Number(source.minEvents ?? source.min_events ?? DEFAULT_MIN_EVENTS);
  const maxEvents = Number(source.maxEvents ?? source.max_events ?? DEFAULT_MAX_EVENTS);
  return {
    ...source,
    ok: source.ok !== false,
    created: Boolean(source.created || checkpoint),
    duplicate: Boolean(source.duplicate),
    reason: normalizeReason(source.reason, ""),
    checkpoint,
    checkpointId,
    eventCount: Number.isFinite(eventCount) ? Math.max(0, Math.floor(eventCount)) : null,
    minEvents: Number.isFinite(minEvents) ? Math.max(1, Math.floor(minEvents)) : DEFAULT_MIN_EVENTS,
    maxEvents: Number.isFinite(maxEvents) ? Math.max(1, Math.floor(maxEvents)) : DEFAULT_MAX_EVENTS,
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

export async function showSessionCheckpoint(sessionId, checkpointId, {
  targetPath = process.cwd(),
  contextEvents = DEFAULT_RESTORE_CONTEXT_EVENTS,
  maxEvents = DEFAULT_RESTORE_MAX_EVENTS,
  resolveAuthSession = resolveActiveAuthSession,
  request = requestJson,
  fetchEventsBefore = pollSessionEventsBefore,
} = {}) {
  const normalizedSessionId = normalizeString(sessionId);
  if (!normalizedSessionId) {
    throw new Error("session id is required.");
  }
  const normalizedCheckpointId = normalizeString(checkpointId);
  if (!normalizedCheckpointId) {
    throw new Error("checkpoint id is required.");
  }

  const listed = await listSessionCheckpoints(normalizedSessionId, {
    targetPath,
    limit: MAX_CHECKPOINT_LIMIT,
    resolveAuthSession,
    request,
  });
  const checkpoint = findCheckpointById(listed.checkpoints, normalizedCheckpointId);
  if (!checkpoint) {
    throw new Error(`Checkpoint '${normalizedCheckpointId}' was not found in session ${normalizedSessionId}.`);
  }
  const restoreWindow = buildCheckpointRestoreWindow(checkpoint, {
    contextEvents,
    maxEvents,
  });
  const remote = await fetchEventsBefore(normalizedSessionId, {
    targetPath,
    beforeSequence: restoreWindow.beforeSequence,
    limit: restoreWindow.limit,
    forceCircuitProbe: true,
    resolveAuthSession,
  });
  const classified = classifyCheckpointRestoreEvents(remote?.events || [], restoreWindow);
  return {
    ok: Boolean(remote?.ok),
    reason: normalizeString(remote?.reason),
    sessionId: normalizedSessionId,
    checkpointId: normalizedCheckpointId,
    apiUrl: listed.apiUrl,
    checkpoint,
    window: {
      ...restoreWindow,
      ...classified,
      remoteOk: Boolean(remote?.ok),
      remoteReason: normalizeString(remote?.reason),
      remoteBeforeSequence: remote?.beforeSequence || null,
      remoteCursor: remote?.cursor || null,
    },
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

export async function generateSessionCheckpointBatch(sessionId, options = {}) {
  const normalizedSessionId = normalizeString(sessionId);
  if (!normalizedSessionId) {
    throw new Error("session id is required.");
  }
  const maxCheckpoints = normalizeBatchMaxCheckpoints(options.maxCheckpoints);
  const results = [];
  const seenCheckpointIds = new Set();
  let stoppedReason = "max_checkpoints";

  for (let index = 0; index < maxCheckpoints; index += 1) {
    const result = await generateSessionCheckpoint(normalizedSessionId, {
      ...options,
      idempotencyKey: buildBatchIdempotencyKey(options.idempotencyKey, index),
    });
    const normalized = normalizeCheckpointGenerationResult(result);
    results.push(normalized);

    if (!normalized.checkpoint || normalized.duplicate || !normalized.created) {
      stoppedReason = normalized.reason || (normalized.duplicate ? "duplicate_checkpoint" : "not_created");
      break;
    }

    if (normalized.checkpointId) {
      if (seenCheckpointIds.has(normalized.checkpointId)) {
        stoppedReason = "repeated_checkpoint";
        break;
      }
      seenCheckpointIds.add(normalized.checkpointId);
    }
  }

  const created = results.filter((result) => result.created && !result.duplicate && result.checkpoint);
  const duplicates = results.filter((result) => result.duplicate);
  const lastResult = results.at(-1) || null;
  return {
    ok: results.every((result) => result.ok !== false),
    sessionId: normalizedSessionId,
    apiUrl: results.find((result) => result.apiUrl)?.apiUrl || null,
    catchUp: true,
    maxCheckpoints,
    attemptedCount: results.length,
    createdCount: created.length,
    duplicateCount: duplicates.length,
    checkpointIds: created.map((result) => result.checkpointId).filter(Boolean),
    stoppedReason,
    lastResult,
    results,
  };
}

export async function generateSessionCheckpointBestEffort(sessionId, options = {}) {
  const normalizedSessionId = normalizeString(sessionId);
  if (!normalizedSessionId) {
    return buildCheckpointNoop("invalid_session_id");
  }
  if (normalizeString(process.env.SENTINELAYER_SKIP_REMOTE_SYNC || "") === "1") {
    return buildCheckpointNoop("remote_sync_disabled_env");
  }
  try {
    const result = await generateSessionCheckpoint(normalizedSessionId, {
      ...options,
      createdByAgentId: normalizeString(options.createdByAgentId) || DEFAULT_CREATED_BY_AGENT_ID,
    });
    return normalizeCheckpointGenerationResult(result);
  } catch (error) {
    if (error instanceof SentinelayerApiError) {
      return buildCheckpointNoop(`api_${error.status || error.code || "error"}`, {
        status: error.status || null,
        code: error.code || null,
        requestId: error.requestId || null,
      });
    }
    const message = normalizeString(error?.message);
    const reason = /auth|login|token/i.test(message) ? "not_authenticated" : message;
    return buildCheckpointNoop(reason || "checkpoint_generate_failed");
  }
}

export {
  DEFAULT_CREATED_BY_AGENT_ID,
  DEFAULT_BATCH_MAX_CHECKPOINTS,
  DEFAULT_MAX_EVENTS,
  DEFAULT_MIN_EVENTS,
  DEFAULT_RESTORE_CONTEXT_EVENTS,
  DEFAULT_RESTORE_MAX_EVENTS,
  MAX_BATCH_MAX_CHECKPOINTS,
  MAX_RESTORE_CONTEXT_EVENTS,
  MAX_RESTORE_EVENTS,
};
