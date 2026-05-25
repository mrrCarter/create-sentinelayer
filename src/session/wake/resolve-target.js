// Wake target resolver for the sentid daemon (Wake-Up Bus L2 live-wiring).
//
// A sentid instance serves one local agent. This factory builds the
// resolveTarget(event) the dispatcher (dispatcher.js) calls to decide whether a
// session event should wake THAT agent, and if so with what host/sessionId.
//
// Targeting policy (returning null = "intentionally unroutable", which the
// dispatcher treats as a clean skip that advances the cursor):
//   - only wake event TYPES count (a session_message), not acks/reactions/views;
//   - never wake the agent on its OWN events (no self-wake loop);
//   - wake when the message is directed to this agent, is a broadcast, or is an
//     untargeted room message; a message directed to a DIFFERENT agent is null.
//
// Routing mirrors listener.js's eventMatchesAgent vocabulary, but is kept
// self-contained on purpose: importing listener.js would drag its whole
// transitive graph (auth/sync/`open`/...) into the wake daemon. The matcher
// here is small enough to own.

const BROADCAST_RECIPIENTS = new Set(["*", "all", "broadcast", "everyone", "anyone", "agents", "all-agents"]);
const DEFAULT_WAKE_EVENT_TYPES = new Set(["session_message", "help_request"]);
const MAX_WAKE_MESSAGE_CHARS = 16_000;

function requireNonEmptyString(value, label) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new TypeError(`resolve-target: ${label} must be a non-empty string`);
  }
  return value.trim();
}

function agentIdOf(event) {
  const payload = event && typeof event.payload === "object" && event.payload ? event.payload : {};
  const a = event?.agentId ?? event?.agent_id ?? event?.agent ?? payload.agentId ?? payload.agent_id;
  if (a && typeof a === "object") return typeof a.id === "string" ? a.id : null;
  return typeof a === "string" ? a : null;
}

function eventTypeOf(event) {
  return event?.event || event?.type || event?.payload?.event || null;
}

function normalizeComparableId(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/^@+/, "")
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function addRecipientValue(out, value) {
  if (value === undefined || value === null) return;
  if (Array.isArray(value)) {
    for (const item of value) addRecipientValue(out, item);
    return;
  }
  if (value && typeof value === "object") {
    addRecipientValue(out, value.id ?? value.agentId ?? value.agent_id ?? value.name);
    return;
  }
  for (const token of String(value).split(/[\s,;]+/g)) {
    const normalized = normalizeComparableId(token);
    if (normalized) out.push(normalized);
  }
}

// Collect recipient tokens from the shapes the session stream uses.
function recipientsOf(event) {
  const payload = event && typeof event.payload === "object" && event.payload ? event.payload : {};
  const out = [];
  for (const src of [
    event?.to,
    event?.recipient,
    event?.recipients,
    event?.targetAgent,
    event?.targetAgentId,
    payload.to,
    payload.recipient,
    payload.recipients,
    payload.targetAgent,
    payload.targetAgentId,
  ]) {
    addRecipientValue(out, src);
  }
  return out;
}

// Mirrors listener.js eventMatchesAgent: broadcast flag, broadcast tokens,
// untargeted (no recipients) => match, or a directed match.
function matchesAgent(event, selfLower) {
  const payload = event && typeof event.payload === "object" && event.payload ? event.payload : {};
  if (event?.broadcast === true || payload.broadcast === true) return true;
  const recipients = recipientsOf(event);
  if (recipients.length === 0) return true;
  return recipients.some((r) => BROADCAST_RECIPIENTS.has(r) || r === selfLower);
}

function defaultFormatMessage(event, agentId) {
  const author = agentIdOf(event) || "unknown";
  const text = event?.payload?.message ?? event?.message ?? "";
  const body = typeof text === "string" ? text : "";
  const head = `Senti wake for ${agentId}: new message from ${author}.`;
  const combined = body ? `${head}\n\n${body}` : head;
  return combined.length > MAX_WAKE_MESSAGE_CHARS ? combined.slice(0, MAX_WAKE_MESSAGE_CHARS) : combined;
}

/**
 * @param {object} opts
 * @param {string} opts.agentId   the local agent this daemon wakes (e.g. "claude-mythos")
 * @param {string} opts.host      host adapter name (e.g. "claude")
 * @param {string} opts.sessionId resume session id passed to the host adapter
 * @param {Set<string>} [opts.wakeEventTypes]
 * @param {(event:object, agentId:string) => string} [opts.formatMessage]
 * @returns {(event:object) => ({host:string, sessionId:string, message:string}|null)}
 */
export function createResolveTarget({
  agentId,
  host,
  sessionId,
  wakeEventTypes = DEFAULT_WAKE_EVENT_TYPES,
  formatMessage = defaultFormatMessage,
} = {}) {
  const selfId = requireNonEmptyString(agentId, "agentId");
  const hostName = requireNonEmptyString(host, "host");
  const resumeId = requireNonEmptyString(sessionId, "sessionId");
  const selfLower = normalizeComparableId(selfId);

  return function resolveTarget(event) {
    // Only wake on real message events; acks/reactions/views/system are skips.
    const type = eventTypeOf(event);
    if (!type || !wakeEventTypes.has(type)) return null;

    // No self-wake: never wake the agent on its own message. Normalize both
    // sides (handles @-prefix / casing / punctuation) so the loop-guard can't
    // be slipped by a non-canonical author id.
    const author = agentIdOf(event);
    if (author && normalizeComparableId(author) === selfLower) return null;

    // Routing: directed-to-me / broadcast / untargeted-room wakes us; a message
    // aimed at a different specific agent is intentionally unroutable.
    if (!matchesAgent(event, selfLower)) return null;

    return { host: hostName, sessionId: resumeId, message: formatMessage(event, selfId) };
  };
}

export default createResolveTarget;
