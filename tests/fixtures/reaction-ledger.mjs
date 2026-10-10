// A stateful model of sentinelayer-api#914's reaction contract (head 1506f345:
// docs/hosted-mcp-capabilities.md "Reaction contract", session_relay_service.py
// create_session_message_action / _message_action_replay), small enough to read:
//   - like/dislike/unlike/undislike are append-only rows folded per
//     (actor, target, reaction) slot; an undo retracts the slot's active row
//   - a key that produced a result REPLAYS it (duplicate: true), including a
//     retained collapsed key, and never re-activates anything
//   - a repeat like/dislike is a no-op whose key is retained as a collapsed row
//     (duplicate: true, collapsedActionId)
//   - an undo with nothing active is 409 REACTION_NOT_ACTIVE and records nothing
//   - a key reused for a different intent is 409 IDEMPOTENCY_KEY_CONFLICT
// Every write returns { status, body } exactly as the route would serialise it.

const UNDO = { unlike: "like", undislike: "dislike" };

export function createReactionLedger() {
  const rows = [];
  const byKey = new Map();
  let next = 0;

  const targetOf = (request) =>
    request.targetActionId ? `action:${request.targetActionId}` : `seq:${request.targetSequenceId}`;
  const familyOf = (actionType) => UNDO[actionType] || actionType;

  function view(row) {
    return {
      id: row.id,
      sessionId: row.sessionId,
      actionType: row.actionType,
      targetSequenceId: row.targetSequenceId,
      targetCursor: null,
      targetActionId: row.targetActionId,
      actorKind: "agent",
      actorId: row.actorId,
      actorRole: "coder",
      note: null,
      metadata: row.metadata,
      idempotencyKey: row.idempotencyKey,
      createdAt: row.createdAt,
      collapsedIntoActionId: row.collapsedIntoActionId,
    };
  }

  function activeRow(actorId, target, reaction) {
    let active = null;
    for (const row of rows) {
      if (row.collapsedIntoActionId || row.actorId !== actorId || row.target !== target) continue;
      if (familyOf(row.actionType) !== reaction) continue;
      active = UNDO[row.actionType] ? null : row;
    }
    return active;
  }

  function record(sessionId, request, extra = {}) {
    next += 1;
    const row = {
      id: `00000000-0000-4000-8000-${String(next).padStart(12, "0")}`,
      sessionId,
      actionType: request.actionType,
      targetSequenceId: request.targetSequenceId || 42,
      targetActionId: request.targetActionId || null,
      target: targetOf(request),
      actorId: request.metadata?.agentId,
      metadata: request.metadata || {},
      idempotencyKey: request.idempotencyKey,
      createdAt: new Date(Date.UTC(2026, 9, 6, 0, 0, next)).toISOString(),
      collapsedIntoActionId: null,
      ...extra,
    };
    rows.push(row);
    byKey.set(row.idempotencyKey, row);
    return row;
  }

  function apply(sessionId, request) {
    const actorId = request.metadata?.agentId;
    const target = targetOf(request);
    const existing = byKey.get(request.idempotencyKey);
    if (existing) {
      const sameIntent =
        existing.actorId === actorId && existing.actionType === request.actionType && existing.target === target;
      if (!sameIntent) {
        return {
          status: 409,
          body: { error: { code: "IDEMPOTENCY_KEY_CONFLICT", message: "conflict", request_id: "req-ledger" } },
        };
      }
      if (existing.collapsedIntoActionId) {
        const anchor = rows.find((row) => row.id === existing.collapsedIntoActionId);
        return {
          status: 200,
          body: { ok: true, duplicate: true, action: view(anchor), collapsedActionId: existing.id },
        };
      }
      return { status: 200, body: { ok: true, duplicate: true, action: view(existing) } };
    }
    const reaction = familyOf(request.actionType);
    const active = activeRow(actorId, target, reaction);
    if (UNDO[request.actionType]) {
      if (!active) {
        return {
          status: 409,
          body: {
            error: {
              code: "REACTION_NOT_ACTIVE",
              message: `no active ${reaction} by this actor on the target to undo`,
              request_id: "req-ledger",
            },
          },
        };
      }
      return { status: 200, body: { ok: true, duplicate: false, action: view(record(sessionId, request)) } };
    }
    if (active) {
      const collapsed = record(sessionId, request, { collapsedIntoActionId: active.id });
      return {
        status: 200,
        body: { ok: true, duplicate: true, action: view(active), collapsedActionId: collapsed.id },
      };
    }
    return { status: 200, body: { ok: true, duplicate: false, action: view(record(sessionId, request)) } };
  }

  return {
    apply,
    rows,
    /** Is this actor's `reaction` (like/dislike) active on target seq/action? */
    isActive(actorId, { targetSequenceId = null, targetActionId = null }, reaction) {
      return Boolean(activeRow(actorId, targetOf({ targetSequenceId, targetActionId }), reaction));
    },
  };
}
