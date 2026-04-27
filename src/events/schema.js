const AGENT_EVENT_STREAM = "sl_event";
const LEGACY_AGENT_ID = "legacy-emitter";
const AGENT_EVENT_TYPES = Object.freeze([
  "agent_start",
  "agent_complete",
  "agent_abort",
  "agent_error",
  "progress",
  "heartbeat",
  "tool_call",
  "tool_result",
  "finding",
  "reasoning",
  "budget_warning",
  "budget_stop",
  "swarm_start",
  "swarm_complete",
  "phase_start",
  "phase_complete",
  "orchestrator_start",
  "dispatch",
  "reconcile_start",
  "reconcile_complete",
  "orchestrator_complete",
  "convergence_expansion",
  "coverage_gap",
  "llm_error",
]);

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function normalizeNonEmptyString(value) {
  const normalized = String(value || "").trim();
  return normalized || "";
}

function normalizeOptionalString(value) {
  const normalized = normalizeNonEmptyString(value);
  return normalized || undefined;
}

function normalizeTimestamp(value, fallbackTimestamp) {
  const rawValue = normalizeNonEmptyString(value);
  const fallback = normalizeNonEmptyString(fallbackTimestamp) || new Date().toISOString();
  if (!rawValue) {
    return fallback;
  }
  const epoch = Date.parse(rawValue);
  if (!Number.isFinite(epoch)) {
    return fallback;
  }
  return new Date(epoch).toISOString();
}

function stripUndefinedEntries(record) {
  const cleaned = {};
  for (const [key, value] of Object.entries(record || {})) {
    if (value !== undefined) {
      cleaned[key] = value;
    }
  }
  return cleaned;
}

function normalizeAgentShape(input = {}) {
  const fromAgentObject = isPlainObject(input.agent) ? { ...input.agent } : {};
  const fromLegacyString = typeof input.agent === "string" ? input.agent : "";
  const candidateId =
    normalizeNonEmptyString(input.agentId) ||
    normalizeNonEmptyString(fromLegacyString) ||
    normalizeNonEmptyString(fromAgentObject.id);
  if (!candidateId) {
    return null;
  }
  const normalized = {
    ...fromAgentObject,
    id: candidateId,
    model: normalizeOptionalString(input.agentModel) || normalizeOptionalString(fromAgentObject.model),
  };
  return stripUndefinedEntries(normalized);
}

function resolveLegacyPayload(evt) {
  if (isPlainObject(evt.payload)) {
    return { ...evt.payload };
  }
  if (isPlainObject(evt.data)) {
    return { ...evt.data };
  }

  const synthesized = {};
  for (const key of ["alert", "target", "message", "details", "reason", "error"]) {
    if (evt[key] !== undefined) {
      synthesized[key] = evt[key];
    }
  }
  return Object.keys(synthesized).length > 0 ? synthesized : null;
}

export function createAgentEvent({
  event,
  agentId,
  agentModel,
  payload,
  sessionId,
  usage,
  runId,
  workItemId,
  requestId,
  agent,
  ts,
  timestamp,
} = {}) {
  const normalizedEvent = normalizeNonEmptyString(event);
  const normalizedAgent = normalizeAgentShape({
    agentId,
    agentModel,
    agent,
  });
  const normalizedPayload = isPlainObject(payload) ? { ...payload } : null;
  if (!normalizedEvent || !normalizedAgent?.id || !normalizedPayload) {
    throw new Error("createAgentEvent requires event, agentId, and payload");
  }

  const canonicalTs = normalizeTimestamp(ts || timestamp);
  return stripUndefinedEntries({
    stream: AGENT_EVENT_STREAM,
    event: normalizedEvent,
    agent: normalizedAgent,
    payload: normalizedPayload,
    usage: isPlainObject(usage) ? { ...usage } : undefined,
    sessionId: normalizeOptionalString(sessionId),
    runId: normalizeOptionalString(runId),
    workItemId: normalizeOptionalString(workItemId),
    requestId: normalizeOptionalString(requestId),
    ts: canonicalTs,
    // Keep legacy timestamp key for existing consumers while PR0 migrates envelope usage.
    timestamp: canonicalTs,
  });
}

export function normalizeAgentEvent(evt, { allowLegacy = true } = {}) {
  if (!isPlainObject(evt)) {
    return null;
  }

  const stream = normalizeOptionalString(evt.stream);
  if (stream && stream !== AGENT_EVENT_STREAM) {
    return null;
  }
  if (!stream && !allowLegacy) {
    return null;
  }

  const normalizedEvent = normalizeNonEmptyString(evt.event || (allowLegacy ? evt.type : ""));
  if (!normalizedEvent) {
    return null;
  }

  const payload = resolveLegacyPayload(evt);
  if (!payload) {
    return null;
  }

  const normalizedAgent =
    normalizeAgentShape({
      agentId: evt.agentId,
      agentModel: evt.agentModel,
      agent: evt.agent,
    }) ||
    (allowLegacy && !stream
      ? normalizeAgentShape({
          agentId:
            normalizeNonEmptyString(evt.sourceAgentId) ||
            normalizeNonEmptyString(evt.source) ||
            LEGACY_AGENT_ID,
        })
      : null);
  if (!normalizedAgent) {
    return null;
  }

  const rawTimestamp = evt.ts || evt.timestamp || evt.time || evt.at || "";
  if (!rawTimestamp && !allowLegacy) {
    return null;
  }
  const fallbackTimestamp = allowLegacy ? new Date().toISOString() : undefined;
  const normalizedTs = normalizeTimestamp(rawTimestamp, fallbackTimestamp);
  if (!normalizedTs) {
    return null;
  }

  try {
    return createAgentEvent({
      event: normalizedEvent,
      agent: normalizedAgent,
      payload,
      usage: evt.usage,
      sessionId: evt.sessionId,
      runId: evt.runId,
      workItemId: evt.workItemId,
      requestId: evt.requestId,
      ts: normalizedTs,
    });
  } catch {
    return null;
  }
}

export function validateAgentEvent(evt, options = {}) {
  return Boolean(normalizeAgentEvent(evt, options));
}

export { AGENT_EVENT_STREAM, AGENT_EVENT_TYPES };
