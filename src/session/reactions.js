// reactions.js -- the ONE path every like / dislike / unlike / undislike takes, from
// the native CLI (`sl session react|action`) and the local MCP server
// (`session_react`, `session_action`) alike.
//
// Three guarantees. Separate copies of this logic once broke each of them:
//
//   1. Authority. The write runs inside withAgentAdmission for (session, agent): an
//      admitted agent acts on ITS admission credential, a tombstoned (expired,
//      malformed, mis-bound) admission is refused before any request, and nothing
//      falls back to the human's broader token or legacy agent grants.
//   2. Intent. The API replays a reused idempotency key instead of acting on it
//      (sentinelayer-api#914 reaction contract), so a key derived from
//      (type, target, actor) makes like -> unlike -> like a silent no-op. Each NEW
//      intent gets a fresh operation key. An explicit key is a retry of the intent
//      that minted it, and is sent unchanged.
//   3. Truth. Every result names its outcome and carries its operation key, so an
//      ambiguous failure (the request may have landed) can be retried as the SAME
//      intent instead of becoming a new one that could retract a newer reaction.

import { randomBytes } from "node:crypto";
import process from "node:process";

import { assertCanonicalAgentId, canonicalAgentId, withAgentAdmission } from "./admission-auth.js";
import { createSessionMessageAction } from "./sync.js";

export const SESSION_REACTION_TYPES = Object.freeze(["like", "dislike", "unlike", "undislike"]);
const REACTION_TYPES = new Set(SESSION_REACTION_TYPES);
const UNDO_TARGETS = new Map([
  ["unlike", "like"],
  ["undislike", "dislike"],
]);

// createSessionMessageAction failures that happen before any request leaves this machine.
const NOT_SENT_REASONS = new Set([
  "invalid_input",
  "remote_sync_disabled_env",
  "circuit_breaker_open",
  "no_session",
  "not_authenticated",
]);

/**
 * Every outcome a reaction can have. `ok` is true only for the first three.
 *   applied     -- this request recorded a new reaction row
 *   no_op       -- an equal reaction was already active; nothing changed. With
 *                  `collapsedActionId` the server retained this request as evidence.
 *   replayed    -- an explicit (retry) key had already been recorded; the server
 *                  returned that original result and did not re-check current state
 *   not_active  -- an undo with nothing of this actor's active to retract (409)
 *   unsupported -- a server without reaction undo rejected the action value (422)
 *   refused     -- any other definitive refusal; nothing was recorded
 *   not_sent    -- the request never left this machine; nothing was recorded
 *   unknown     -- the request may or may not have been recorded (timeout, lost
 *                  response, 5xx): retry with the SAME operation key
 */
export const SESSION_REACTION_OUTCOMES = Object.freeze([
  "applied",
  "no_op",
  "replayed",
  "not_active",
  "unsupported",
  "refused",
  "not_sent",
  "unknown",
]);

function normalizeString(value) {
  return String(value ?? "").trim();
}

export function isSessionReactionType(value) {
  return REACTION_TYPES.has(normalizeString(value).toLowerCase());
}

/** The like/dislike an undo retracts, or "" for a non-undo. */
export function reactionUndoTarget(value) {
  return UNDO_TARGETS.get(normalizeString(value).toLowerCase()) || "";
}

function targetKey({ targetSequenceId, targetCursor, targetActionId }) {
  if (normalizeString(targetActionId)) return `action:${normalizeString(targetActionId)}`;
  if (targetSequenceId) return `seq:${targetSequenceId}`;
  return `cursor:${normalizeString(targetCursor)}`;
}

function targetLabel({ targetSequenceId, targetCursor, targetActionId }) {
  if (normalizeString(targetActionId)) return `reply ${normalizeString(targetActionId)}`;
  if (targetSequenceId) return `#${targetSequenceId}`;
  return normalizeString(targetCursor) || "target";
}

/** A key for a NEW intent. Never derived from (type, target, actor) alone. */
export function newReactionOperationKey({ surface, reaction, agentId, ...target } = {}) {
  return `${surface}:${reaction}:${targetKey(target)}:${agentId}:${randomBytes(8).toString("hex")}`;
}

/**
 * The exact 422 a server without reaction undo (sentinelayer-api before #914) returns
 * for this action: FastAPI's validation envelope around the route's action-type
 * validator, a single entry echoing the value sent. Anything looser could relabel a
 * different validation failure as "undo unsupported", so the match is exact.
 */
export function isUndoUnsupportedValidationError(result = {}, actionType = "") {
  if (result.status !== 422) return false;
  const detail = result.error?.detail;
  if (!Array.isArray(detail) || detail.length !== 1) return false;
  const [entry] = detail;
  return (
    entry?.type === "value_error" &&
    Array.isArray(entry.loc) &&
    entry.loc.length === 2 &&
    entry.loc[0] === "body" &&
    entry.loc[1] === "actionType" &&
    entry.msg === "Value error, unsupported message action type" &&
    entry.input === actionType
  );
}

function classify(reaction, result, retry) {
  const status = Number.isInteger(result?.status) ? result.status : null;
  if (result?.ok && result.action) {
    if (normalizeString(result.collapsedActionId)) return "no_op";
    if (result.duplicate) return retry ? "replayed" : "no_op";
    return "applied";
  }
  if (status === null) {
    return NOT_SENT_REASONS.has(normalizeString(result?.reason)) ? "not_sent" : "unknown";
  }
  if (status >= 500) return "unknown";
  if (isUndoUnsupportedValidationError(result, reaction)) return "unsupported";
  if (status === 409 && reactionUndoTarget(reaction) && result.error?.error?.code === "REACTION_NOT_ACTIVE") {
    return "not_active";
  }
  if (status >= 400) return "refused";
  return "unknown";
}

function describe(outcome, { reaction, agentId, target, operationKey, reason, errorCode, collapsedActionId }) {
  const where = targetLabel(target);
  switch (outcome) {
    case "applied":
      return `${agentId} ${reaction} recorded on ${where}.`;
    case "no_op":
      return (
        `No change: ${agentId} already has an active ${reaction} on ${where}.` +
        (collapsedActionId ? ` This request is retained as evidence ${collapsedActionId}.` : "")
      );
    case "replayed":
      return (
        `Replayed: operation ${operationKey} was already recorded. The server returned its ` +
        `original result and did not re-check the current state.`
      );
    case "not_active":
      return `Nothing to undo: ${agentId} has no active ${reactionUndoTarget(reaction)} on ${where}.`;
    case "unsupported":
      return `This server doesn't support undo yet (no '${reaction}' action). Nothing was changed.`;
    case "refused":
      return `The server refused this ${reaction} (${errorCode || reason}). Nothing was recorded.`;
    case "not_sent":
      return `Not sent (${reason}). Nothing was recorded.`;
    default:
      return (
        `Outcome unknown (${reason || "no response"}): the server may have recorded this ${reaction}. ` +
        `To retry this same intent, resend it with idempotency key ${operationKey}; ` +
        `without that key it is a new intent.`
      );
  }
}

/**
 * Submit one reaction. Throws only for invalid input or a refused admission (before
 * any request); every server answer, network failure and timeout is an outcome.
 */
export async function submitSessionReaction({
  surface,
  sessionId,
  agentId,
  reaction,
  targetSequenceId = null,
  targetCursor = "",
  targetActionId = "",
  note = "",
  idempotencyKey = "",
  targetPath = process.cwd(),
  timeoutMs = 15_000,
  dryRun = false,
  createSessionMessageActionFn = createSessionMessageAction,
} = {}) {
  const sid = normalizeString(sessionId);
  const type = normalizeString(reaction).toLowerCase();
  if (!sid) throw new Error("session id is required.");
  if (!REACTION_TYPES.has(type)) {
    throw new Error(`reaction must be one of: ${SESSION_REACTION_TYPES.join(", ")}.`);
  }
  // One canonical identity for authorisation and execution (see admission-auth.js).
  assertCanonicalAgentId(agentId, "agentId");
  const agent = canonicalAgentId(agentId);
  if (!agent) throw new Error("agentId is required.");
  const target = {
    targetSequenceId: targetSequenceId || null,
    targetCursor: normalizeString(targetCursor),
    targetActionId: normalizeString(targetActionId),
  };
  if (!target.targetSequenceId && !target.targetCursor && !target.targetActionId) {
    throw new Error("Provide a target sequence, cursor, or action id.");
  }
  const explicitKey = normalizeString(idempotencyKey);
  const operationKey =
    explicitKey || newReactionOperationKey({ surface, reaction: type, agentId: agent, ...target });
  const base = {
    sessionId: sid,
    agentId: agent,
    actionType: type,
    ...target,
    note: normalizeString(note),
    operationKey,
    idempotencyKey: operationKey,
    retry: Boolean(explicitKey),
  };
  if (dryRun) return { ok: true, dryRun: true, outcome: "dry_run", ...base };

  const result = await withAgentAdmission(sid, agent, () =>
    createSessionMessageActionFn(sid, {
      actionType: type,
      targetPath,
      ...target,
      note: base.note,
      metadata: { source: surface, agentId: agent },
      idempotencyKey: operationKey,
      timeoutMs,
    }),
  );
  const outcome = classify(type, result, base.retry);
  const collapsedActionId = normalizeString(result?.collapsedActionId) || null;
  const status = Number.isInteger(result?.status) ? result.status : null;
  const reason = normalizeString(result?.reason);
  const errorCode = normalizeString(result?.error?.error?.code) || null;
  return {
    ok: outcome === "applied" || outcome === "no_op" || outcome === "replayed",
    outcome,
    ...base,
    duplicate: Boolean(result?.duplicate),
    collapsedActionId,
    status,
    reason,
    errorCode,
    message: describe(outcome, {
      reaction: type,
      agentId: agent,
      target,
      operationKey,
      reason,
      errorCode,
      collapsedActionId,
    }),
    action: result?.ok && result.action ? result.action : null,
  };
}
