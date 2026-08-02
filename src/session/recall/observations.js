/**
 * ENGRAM §1 — the OBSERVATION layer (immutable facts).
 *
 * Tri-layer data model (ENGRAM §3): a session EVENT is an immutable
 * `observation`. We never mutate or destructively merge them; entities and
 * bindings (entities.js) are the mutable interpretation layer built ON TOP.
 * Content-hash dedup comes for free from the server's `idempotency_token`
 * (sentinelayer-api SessionEvent), with stable fallbacks so a local-only
 * event still gets a deterministic id.
 *
 * Control-plane events (file locks, listener lifecycle, quiet reactions) are
 * NOT facts about the work — they are dropped from the observation set via
 * the repo's existing `filterSessionMaterialEvents` (control-events.js).
 * They still contribute edges/occurrences (see entities.js), but they are
 * never retrievable memories themselves.
 */

import { filterSessionMaterialEvents } from "../control-events.js";
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

/**
 * Pull the human/agent-readable text out of an event payload. Kept
 * exhaustive rather than clever: sessions carry many event types and we
 * would rather index a little extra structure than silently miss a fact.
 */
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
  // Structured decision lists (checkpoints record these).
  for (const key of ["decisions", "highlights", "actionItems", "action_items"]) {
    if (Array.isArray(payload[key])) {
      for (const entry of payload[key]) {
        const value = typeof entry === "string" ? entry : normalizeString(entry?.text || entry?.title);
        if (value) parts.push(value);
      }
    }
  }
  // Finding / tool context: file + rule + tool make the memory searchable
  // by its lexical anchors (ENGRAM §7 stage 2b).
  for (const key of ["file", "path", "ruleId", "rule_id", "layer", "tool", "name", "code"]) {
    const value = normalizeString(payload[key]);
    if (value) parts.push(value);
  }
  if (Array.isArray(payload.files)) {
    for (const f of payload.files) {
      const value = normalizeString(f);
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
  // Path-looking tokens from the text: contain a dot-extension we recognize.
  for (const token of tokenize(text)) {
    const dot = token.lastIndexOf(".");
    if (dot > 0 && dot < token.length - 1) {
      const ext = token.slice(dot + 1);
      if (FILE_EXTENSIONS.has(ext)) files.add(token);
    }
  }
  return Array.from(files);
}

function extractPrRefs(text) {
  const refs = new Set();
  const re = /#(\d{1,6})\b/g;
  let match;
  while ((match = re.exec(text)) !== null) {
    refs.add(`#${match[1]}`);
  }
  return Array.from(refs);
}

function extractMentions(event, text) {
  const payload = event?.payload && typeof event.payload === "object" ? event.payload : {};
  const mentions = new Set();
  for (const value of asStringArray(payload.to)) mentions.add(value.toLowerCase());
  for (const value of asStringArray(payload.recipient)) mentions.add(value.toLowerCase());
  for (const value of asStringArray(payload.mentions)) mentions.add(value.toLowerCase());
  const re = /@([a-z0-9][a-z0-9_-]{1,})/gi;
  let match;
  while ((match = re.exec(text)) !== null) {
    mentions.add(match[1].toLowerCase());
  }
  return Array.from(mentions);
}

function replyTargetSequence(event) {
  const payload = event?.payload && typeof event.payload === "object" ? event.payload : {};
  const seq = Number(
    payload.targetSequenceId ?? payload.target_sequence_id ?? payload.replyTo ?? payload.reply_to ?? 0,
  );
  return Number.isFinite(seq) && seq > 0 ? Math.floor(seq) : 0;
}

/**
 * Resolve a stable, content-addressed observation id (ENGRAM §3 "content
 * hash — dedup for free"). Prefers the server idempotency token, then the
 * event id, then (session, sequence), then a hash of the salient fields.
 */
function resolveObservationId(event, sessionId, index, kind, agentId, ts, text) {
  const token = normalizeString(event?.idempotencyToken || event?.idempotency_token);
  if (token) return token;
  const eventId = normalizeString(event?.eventId || event?.id);
  if (eventId) return eventId;
  const seq = Number(event?.sequenceId ?? event?.sequence_id);
  if (Number.isFinite(seq) && seq > 0) return `${sessionId || "s"}:${Math.floor(seq)}`;
  return `h:${contentHash(`${kind}|${agentId}|${ts}|${index}|${text}`)}`;
}

/**
 * Build immutable observations from a list of raw session events.
 *
 * @param {object[]} events  Raw/normalized session events (local NDJSON shape).
 * @param {object}   [options]
 * @param {string}   [options.sessionId]
 * @param {boolean}  [options.includeControlEvents=false]  Index control events too (default: drop).
 * @returns {{observations: object[], droppedControlEvents: number, materialCount: number}}
 */
export function buildObservations(events = [], { sessionId = "", includeControlEvents = false } = {}) {
  const source = Array.isArray(events) ? events : [];
  const material = includeControlEvents ? source : filterSessionMaterialEvents(source);
  const droppedControlEvents = source.length - material.length;

  const byId = new Map();
  const observations = [];
  material.forEach((event, index) => {
    const kind = eventType(event) || "event";
    const agentId = eventAgentId(event);
    const ts = eventTimestamp(event);
    const text = extractText(event);
    const id = resolveObservationId(event, sessionId, index, kind, agentId, ts, text);

    // Content-hash dedup: a duplicate id (same idempotency token relayed by
    // both CLI + web) is a no-op — never a destructive merge (§3).
    if (byId.has(id)) return;

    const seqRaw = Number(event?.sequenceId ?? event?.sequence_id);
    const observation = {
      id,
      sessionId: normalizeString(event?.sessionId) || sessionId,
      sequenceId: Number.isFinite(seqRaw) && seqRaw > 0 ? Math.floor(seqRaw) : 0,
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
    droppedControlEvents,
    materialCount: observations.length,
  };
}
