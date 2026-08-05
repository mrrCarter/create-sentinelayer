/**
 * Pure observation normalization shared by session and detachable ENGRAM
 * adapters. It deliberately knows nothing about which event types a host
 * considers control-plane noise.
 */

import {
  clipSnippet,
  contentHash,
  normalizeString,
  tokenize,
} from "./text.js";

const FILE_EXTENSIONS = new Set([
  "js", "mjs", "cjs", "ts", "tsx", "jsx", "py", "md", "json", "sql", "yml",
  "yaml", "tf", "go", "rs", "java", "rb", "sh", "toml", "ini", "html", "css",
  "txt", "lock", "cfg", "env",
]);

function eventType(event) {
  return normalizeString(event?.event || event?.type).toLowerCase();
}

function eventAgentId(event) {
  return (
    normalizeString(event?.agent?.id) ||
    normalizeString(event?.agentId) ||
    normalizeString(event?.agent_id) ||
    "unknown"
  );
}

function eventTimestamp(event) {
  return normalizeString(event?.ts || event?.timestamp || event?.time || event?.at);
}

function toEpochMs(iso) {
  const ms = Date.parse(normalizeString(iso));
  return Number.isFinite(ms) ? ms : 0;
}

function asStringArray(value) {
  if (Array.isArray(value)) {
    return value.map((entry) => normalizeString(entry)).filter(Boolean);
  }
  const single = normalizeString(value);
  return single ? [single] : [];
}

function extractText(event) {
  const payload =
    event?.payload && typeof event.payload === "object" && !Array.isArray(event.payload)
      ? event.payload
      : {};
  const parts = [];
  for (const key of [
    "message", "response", "text", "summary", "note", "title", "alert",
    "reason", "details", "reasoning", "decision", "content", "body",
  ]) {
    const value = normalizeString(payload[key]);
    if (value) parts.push(value);
  }
  for (const key of ["decisions", "highlights", "actionItems", "action_items"]) {
    if (Array.isArray(payload[key])) {
      for (const entry of payload[key]) {
        const value = typeof entry === "string" ? entry : normalizeString(entry?.text || entry?.title);
        if (value) parts.push(value);
      }
    }
  }
  for (const key of ["file", "path", "ruleId", "rule_id", "layer", "tool", "name", "code"]) {
    const value = normalizeString(payload[key]);
    if (value) parts.push(value);
  }
  if (Array.isArray(payload.files)) {
    for (const file of payload.files) {
      const value = normalizeString(file);
      if (value) parts.push(value);
    }
  }
  return parts.join(" · ");
}

function extractFiles(event, text) {
  const payload = event?.payload && typeof event.payload === "object" ? event.payload : {};
  const files = new Set();
  for (const value of asStringArray(payload.file)) files.add(value);
  for (const value of asStringArray(payload.files)) files.add(value);
  for (const value of asStringArray(payload.path)) files.add(value);
  for (const token of tokenize(text)) {
    const dot = token.lastIndexOf(".");
    if (dot > 0 && dot < token.length - 1) {
      const extension = token.slice(dot + 1);
      if (FILE_EXTENSIONS.has(extension)) files.add(token);
    }
  }
  return Array.from(files);
}

function extractPrRefs(text) {
  const refs = new Set();
  const pattern = /#(\d{1,6})\b/g;
  let match;
  while ((match = pattern.exec(text)) !== null) refs.add(`#${match[1]}`);
  return Array.from(refs);
}

function extractMentions(event, text) {
  const payload = event?.payload && typeof event.payload === "object" ? event.payload : {};
  const mentions = new Set();
  for (const value of asStringArray(payload.to)) mentions.add(value.toLowerCase());
  for (const value of asStringArray(payload.recipient)) mentions.add(value.toLowerCase());
  for (const value of asStringArray(payload.mentions)) mentions.add(value.toLowerCase());
  const pattern = /@([a-z0-9][a-z0-9_-]{1,})/gi;
  let match;
  while ((match = pattern.exec(text)) !== null) mentions.add(match[1].toLowerCase());
  return Array.from(mentions);
}

function replyTargetSequence(event) {
  const payload = event?.payload && typeof event.payload === "object" ? event.payload : {};
  const sequence = Number(
    payload.targetSequenceId ?? payload.target_sequence_id ?? payload.replyTo ?? payload.reply_to ?? 0,
  );
  return Number.isFinite(sequence) && sequence > 0 ? Math.floor(sequence) : 0;
}

function resolveObservationId(event, sessionId, index, kind, agentId, ts, text) {
  const token = normalizeString(event?.idempotencyToken || event?.idempotency_token);
  if (token) return token;
  const eventId = normalizeString(event?.eventId || event?.id);
  if (eventId) return eventId;
  const sequence = Number(event?.sequenceId ?? event?.sequence_id);
  if (Number.isFinite(sequence) && sequence > 0) {
    return `${sessionId || "s"}:${Math.floor(sequence)}`;
  }
  return `h:${contentHash(`${kind}|${agentId}|${ts}|${index}|${text}`)}`;
}

/** Normalize an already-selected set of events into immutable observations. */
export function buildEventObservations(events = [], { sessionId = "" } = {}) {
  const source = Array.isArray(events) ? events : [];
  const byId = new Map();
  const observations = [];

  source.forEach((event, index) => {
    const kind = eventType(event) || "event";
    const agentId = eventAgentId(event);
    const ts = eventTimestamp(event);
    const text = extractText(event);
    const id = resolveObservationId(event, sessionId, index, kind, agentId, ts, text);
    if (byId.has(id)) return;

    const sequence = Number(event?.sequenceId ?? event?.sequence_id);
    const observation = {
      id,
      sessionId: normalizeString(event?.sessionId) || sessionId,
      sequenceId: Number.isFinite(sequence) && sequence > 0 ? Math.floor(sequence) : 0,
      index,
      ts,
      tsMs: toEpochMs(ts),
      kind,
      agentId,
      agentModel: normalizeString(event?.agent?.model || event?.agentModel),
      text,
      tokens: tokenize(text),
      mentions: extractMentions(event, text),
      files: extractFiles(event, text),
      prRefs: extractPrRefs(text),
      replyToSequence: replyTargetSequence(event),
      snippet: clipSnippet(text),
      raw: event,
    };
    byId.set(id, observation);
    observations.push(observation);
  });

  return {
    observations,
    droppedControlEvents: 0,
    materialCount: observations.length,
  };
}
