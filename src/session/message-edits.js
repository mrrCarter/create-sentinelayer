import { createAgentEvent } from "../events/schema.js";
import { enrichEventWithMentions } from "./mentions.js";
import { sessionEventIdentityKeys } from "./event-identity.js";

export function messageRevision(value = {}) {
  const revision = Number(value.messageRevision ?? value.message_revision ?? 1);
  return Number.isSafeInteger(revision) && revision > 0 ? revision : 1;
}

export function replyRevisionEvent(sessionId, reply = {}) {
  if (!reply.id || (reply.actionType ?? reply.action_type) !== "reply") return null;
  const sequence = reply.targetSequenceId ?? reply.target_sequence_id ?? null;
  const target = sequence ? `#${sequence}` : reply.targetCursor || "target";
  const note = String(reply.note ?? "");
  return createAgentEvent({
    event: "session_reply",
    agentId: reply.actorId ?? reply.actor_id ?? "unknown",
    agentModel: reply.actorKind ?? reply.actor_kind ?? "session-action",
    sessionId,
    eventId: `session-action-${reply.id}`,
    cursor: `action:${reply.id}`,
    ts: reply.createdAt ?? reply.created_at,
    messageRevision: messageRevision(reply),
    editedAt: reply.editedAt,
    editedBy: reply.editedBy,
    canEdit: reply.canEdit,
    revisionEvidence: reply.revisionEvidence,
    payload: {
      actionId: reply.id,
      actionType: "reply",
      targetSequenceId: sequence,
      targetCursor: reply.targetCursor || null,
      targetActionId: reply.targetActionId || null,
      note,
      metadata: reply.metadata && typeof reply.metadata === "object" ? reply.metadata : undefined,
      message: `reply ${target}: ${note}`,
      source: "session_action",
    },
  });
}

// Edits are immutable notifications with their own sequence/identity. Only the
// nested snapshot contributes to the CURRENT body; it is never replayed as a
// new authored message or task directive.
export function sessionMessageEditSnapshot(event = {}) {
  if (event.event !== "session_message_edited" || event.payload?.schema !== "session-message-edit:v1") return null;
  const payload = event.payload;
  if (payload.targetActionId) {
    const reply = payload.reply;
    if (reply?.id !== payload.targetActionId || messageRevision(reply) !== messageRevision(payload)) return null;
    return replyRevisionEvent(event.sessionId, reply);
  }
  const snapshot = payload.event;
  if (!snapshot?.id || snapshot.id !== payload.targetMessageId || messageRevision(snapshot) !== messageRevision(payload)) return null;
  return snapshot;
}

export function projectSessionMessageEdits(events = []) {
  const snapshots = new Map();
  for (const event of events) {
    const snapshot = sessionMessageEditSnapshot(event) || (["session_message", "session_reply"].includes(event.event) ? event : null);
    if (!snapshot) continue;
    for (const key of sessionEventIdentityKeys(snapshot)) {
      if (!snapshots.has(key) || messageRevision(snapshot) > messageRevision(snapshots.get(key))) snapshots.set(key, snapshot);
    }
  }
  return events.map((event) => {
    if (event.event === "session_message_edited") return event;
    const snapshot = sessionEventIdentityKeys(event).map((key) => snapshots.get(key)).filter(Boolean)
      .sort((left, right) => messageRevision(right) - messageRevision(left))[0];
    return snapshot && messageRevision(snapshot) > messageRevision(event) ? { ...event, ...snapshot } : event;
  });
}

// Routing consumes the immutable revision snapshot, but delivery/dedupe always
// consumes the notification's own identity. Reply edits retain parent routing.
export function sessionMessageRoutingEvent(event = {}) {
  const snapshot = sessionMessageEditSnapshot(event);
  if (!snapshot) return event;
  const parentPayload = event.payload?.event?.payload || {};
  const payload = { ...parentPayload, ...snapshot.payload };
  if (event.payload?.reply) payload.message = String(event.payload.reply.note ?? "");
  for (const key of ["to", "recipient", "recipients", "targetAgent", "targetAgentId", "broadcast", "mentions"]) {
    if (event.payload[key] !== undefined) payload[key] = event.payload[key];
  }
  const routed = enrichEventWithMentions({ ...snapshot, agent: event.agent || snapshot.agent, payload });
  if (routed.payload?.mentions?.broadcast?.length) routed.payload.broadcast = true;
  return routed;
}
