import "./setup-env.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { editSessionMessage, pollHumanMessages } from "../src/session/sync.js";
import { createSessionMutationCsrfToken } from "../src/session/invitations.js";
import { createAgentEvent, normalizeAgentEvent } from "../src/events/schema.js";
import { dedupeSessionEvents, sessionEventUpgradesExisting } from "../src/session/event-identity.js";
import { projectSessionMessageEdits, replyRevisionEvent } from "../src/session/message-edits.js";
import { appendToStream, readStream } from "../src/session/stream.js";
import { createSession } from "../src/session/store.js";
import { hydrateSessionFromRemote } from "../src/session/remote-hydrate.js";
import { mergeLiveSources, watchLocalStream } from "../src/session/live-source.js";
import { createResolveTarget } from "../src/session/wake/resolve-target.js";
import { eventMatchesAgent } from "../src/session/listener.js";

const messageId = "10000000-0000-4000-8000-000000000001";
const replyId = "20000000-0000-4000-8000-000000000002";
const fixtureToken = ["unit", "message", "edit", "token"].join("-");
const original = createAgentEvent({ id: messageId, event: "session_message", agentId: "author", sessionId: "edit-room", sequenceId: 42,
  cursor: "42:message", payload: { message: "original", to: ["verity"], clientMessageId: "local-post" }, messageRevision: 1, canEdit: true, editedAt: null, editedBy: null,
  ts: "2026-10-03T12:00:00.000Z" });
const revised = { ...original, messageRevision: 2, editedAt: "2026-10-03T13:00:00.000Z", editedBy: { actorKind: "agent", actorId: "author" },
  revisionEvidence: { appliesToRevision: 2, currentTextValidation: "not_revalidated" },
  payload: { ...original.payload, message: "replacement" } };
function notification(snapshot = revised, sequence = 43) {
  return createAgentEvent({ id: `notification-${sequence}`, event: "session_message_edited", eventId: `edit-${sequence}`, agentId: "author", sessionId: "edit-room",
    sequenceId: sequence, cursor: `${sequence}:edit`, ts: "2026-10-03T13:00:00.000Z",
    payload: { schema: "session-message-edit:v1", targetMessageId: messageId, targetSequenceId: 42, targetActionId: null, messageRevision: snapshot.messageRevision,
      editedAt: snapshot.editedAt, editedBy: snapshot.editedBy, event: snapshot, reply: null } });
}
async function withRemote(action) {
  const previous = process.env.SENTINELAYER_SKIP_REMOTE_SYNC;
  process.env.SENTINELAYER_SKIP_REMOTE_SYNC = "0";
  try { return await action(); } finally { process.env.SENTINELAYER_SKIP_REMOTE_SYNC = previous; }
}
const auth = async () => ({ token: fixtureToken, apiUrl: "http://127.0.0.1:3000" });
// The fixture API is the configured API: the user's credential is only sent to that origin.
process.env.SENTINELAYER_API_URL = "http://127.0.0.1:3000";
const json = (payload, status = 200) => new Response(JSON.stringify(payload), { status, headers: { "Content-Type": "application/json" } });

test("human compatibility poll preserves current revision identity and cannot wake a historical directive", async () => {
  const result = await pollHumanMessages("human-edit-poll", {
    resolveAuthSession: auth,
    fetchImpl: async () => json({ messages: [{
      id: "human-client-id", eventId: messageId, sequenceId: 42,
      cursor: "seq:42", ts: original.ts, senderId: "operator", message: "corrected human text",
      messageRevision: 2, editedAt: revised.editedAt, editedBy: { actorKind: "human", actorId: "operator" },
      canEdit: false, revisionEvidence: revised.revisionEvidence,
    }] }),
  });
  assert.equal(result.ok, true);
  assert.equal(result.events.length, 1);
  const [event] = result.events;
  assert.equal(event.id, messageId);
  assert.equal(event.eventId, messageId);
  assert.equal(event.sequenceId, 42);
  assert.equal(event.cursor, "seq:42");
  assert.equal(event.messageRevision, 2);
  assert.equal(event.editedAt, revised.editedAt);
  assert.deepEqual(event.editedBy, { actorKind: "human", actorId: "operator" });
  assert.deepEqual(event.revisionEvidence, revised.revisionEvidence);
  assert.equal(event.canEdit, false);
  const resolver = createResolveTarget({ sessionId: "human-edit-poll", agentId: "verity", host: "codex" });
  assert.equal(await resolver(event), null);
});

test("native edit: one current GET resolves sequence and revision, then signed guarded PATCH", async () => withRemote(async () => {
  const calls = [];
  const result = await editSessionMessage("edit-room", { targetSequenceId: 42, text: "replacement", agentId: "author", idempotencyKey: "edit-attempt-1", resolveAuthSession: auth,
    fetchImpl: async (url, options) => {
      calls.push({ url, ...options });
      return options.method === "GET" ? json({ ok: true, event: original, reply: null }) : json({ ok: true, changed: true, replayed: false, event: revised, reply: null, notification: notification() });
    } });
  assert.equal(result.ok, true);
  assert.equal(calls.length, 2);
  assert.match(calls[0].url, /\/messages\/by-sequence\/42\?agentId=author$/);
  assert.match(calls[1].url, new RegExp(`/messages/${messageId}$`));
  assert.deepEqual(JSON.parse(calls[1].body), { text: "replacement", expectedRevision: 1, agentId: "author" });
  assert.equal(calls[1].headers["Idempotency-Key"], "edit-attempt-1");
  assert.equal(calls[1].headers["X-Sentinelayer-Session-Mutation"], "session-mutation");
  assert.equal(calls[1].headers["X-CSRF-Token"], createSessionMutationCsrfToken({ bearerToken: fixtureToken, sessionId: "edit-room", routeId: "PATCH /api/v1/sessions/{session_id}/messages/{message_id}", idempotencyKey: "edit-attempt-1" }));
}));

test("native reply edit: explicit revision PATCH needs no lookup and retains replay/noop semantics", async () => withRemote(async () => {
  const calls = [];
  const reply = { id: replyId, actionType: "reply", messageRevision: 3, note: "replacement" };
  const result = await editSessionMessage("edit-room", { targetActionId: replyId, text: "replacement", expectedRevision: 2, resolveAuthSession: auth,
    fetchImpl: async (url, options) => { calls.push({ url, ...options }); return json({ ok: true, changed: false, replayed: true, event: original, reply, notification: null }); } });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].method, "PATCH");
  assert.match(calls[0].url, new RegExp(`/replies/${replyId}$`));
  assert.equal(result.replayed, true);
  assert.equal(result.changed, false);
  assert.equal(result.notification, null);
  assert.equal(calls[0].headers["X-CSRF-Token"], createSessionMutationCsrfToken({ bearerToken: fixtureToken, sessionId: "edit-room", routeId: "PATCH /api/v1/sessions/{session_id}/replies/{action_id}", idempotencyKey: calls[0].headers["Idempotency-Key"] }));
}));

test("native edit: revision/auth/schema/unsupported failures never retry or invent local success", async () => withRemote(async () => {
  for (const [status, code] of [[409, "MESSAGE_REVISION_CONFLICT"], [409, "MESSAGE_EDIT_IDEMPOTENCY_CONFLICT"], [403, "MESSAGE_EDIT_FORBIDDEN"], [404, "MESSAGE_NOT_FOUND"], [422, "MESSAGE_EDIT_INVALID"]]) {
    let calls = 0;
    const result = await editSessionMessage("edit-room", { targetMessageId: messageId, text: "replacement", expectedRevision: 1, resolveAuthSession: auth,
      fetchImpl: async () => { calls += 1; return json({ detail: { code } }, status); } });
    assert.equal(result.ok, false);
    assert.equal(result.reason, code);
    assert.equal(calls, 1);
    assert.equal(result.event, undefined);
  }
  let writes = 0;
  const denied = await editSessionMessage("edit-room", { targetSequenceId: 42, text: "replacement", resolveAuthSession: auth,
    fetchImpl: async (_url, options) => { if (options.method !== "GET") writes += 1; return json({ ok: true, event: { ...original, canEdit: false } }); } });
  assert.equal(denied.reason, "MESSAGE_EDIT_FORBIDDEN");
  assert.equal(writes, 0);
}));

test("schema keeps UUID, revision, attribution and caller capability", () => {
  assert.deepEqual(normalizeAgentEvent(revised, { allowLegacy: false }), revised);
  assert.equal(normalizeAgentEvent(original, { allowLegacy: false }).editedAt, null);
});

test("identity revisions are monotonic in either order, routing is replaced and notifications remain distinct", () => {
  const newest = { ...revised, messageRevision: 3, payload: { message: "newest" } };
  for (const rows of [[original, revised, newest, original], [newest, revised, original]]) {
    const current = dedupeSessionEvents(rows);
    assert.equal(current.length, 1);
    assert.equal(current[0].payload.message, "newest");
    assert.equal(current[0].payload.to, undefined);
  }
  assert.equal(sessionEventUpgradesExisting(newest, { ...original, cursor: "durable-upgrade" }), false);
  assert.equal(dedupeSessionEvents([original, notification(), notification(newest, 44)]).length, 3);
});

test("stream/hydration projects current body without destroying original immutable audit rows or stale rewind", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "sl-message-revisions-"));
  try {
    await createSession({ targetPath: root, sessionId: "edit-room" });
    await appendToStream("edit-room", original, { targetPath: root, syncRemote: false });
    await hydrateSessionFromRemote({ sessionId: "edit-room", targetPath: root, _ensureLocalSession: async () => ({}),
      _poll: async () => ({ ok: true, events: [original] }), _pollEvents: async () => ({ ok: true, events: [revised, notification()], cursor: "43:edit" }) });
    let current = dedupeSessionEvents(await readStream("edit-room", { targetPath: root, tail: 0 }));
    assert.equal(current.find((row) => row.id === messageId).payload.message, "replacement");
    assert.equal(current.filter((row) => row.event === "session_message_edited").length, 1);
    const stale = await hydrateSessionFromRemote({ sessionId: "edit-room", targetPath: root, _ensureLocalSession: async () => ({}),
      _poll: async () => ({ ok: true, events: [] }), _pollEvents: async () => ({ ok: true, events: [original] }) });
    assert.equal(stale.relayed, 0);
    current = dedupeSessionEvents(await readStream("edit-room", { targetPath: root, tail: 0 }));
    assert.equal(current.find((row) => row.id === messageId).messageRevision, 2);
    const raw = (await readFile(path.join(root, ".sentinelayer/sessions/edit-room/stream.ndjson"), "utf8")).trim().split(/\r?\n/).map(JSON.parse);
    assert.equal(raw[0].payload.message, "original");
    assert.equal(raw.some((row) => row.id === messageId && row.messageRevision === 2), true);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("reply notifications update only targeted reply while preserving parent/thread target", () => {
  const reply = { id: replyId, actionType: "reply", actorId: "author", targetSequenceId: 42, note: "old reply", messageRevision: 1, createdAt: original.ts };
  const changed = { ...reply, note: "edited reply", messageRevision: 2, editedAt: revised.editedAt,
    metadata: { thread: "unchanged", originalRevisionEvidence: { appliesToRevision: 1, signature: "original-proof" } } };
  const notice = { ...notification(), payload: { ...notification().payload, targetActionId: replyId, event: original, reply: changed } };
  const projected = projectSessionMessageEdits([original, replyRevisionEvent("edit-room", reply), notice]);
  assert.equal(projected[0].payload.message, "original");
  assert.equal(projected[1].payload.note, "edited reply");
  assert.equal(projected[1].payload.actionId, replyId);
  assert.equal(projected[1].payload.targetSequenceId, 42);
  assert.deepEqual(projected[1].payload.metadata, changed.metadata);
});

test("edit wakes use immutable revised body and normal routing; stale revised originals never wake", () => {
  const resolve = createResolveTarget({ agentId: "verity", host: "codex", sessionId: "host-session" });
  assert.match(resolve(notification()).message, /edited message.*author[\s\S]*replacement/);
  assert.equal(resolve(revised), null);
  assert.equal(resolve({ ...notification(), agent: { id: "verity" } }), null);
  const other = notification({ ...revised, payload: { message: "other", to: ["warden"] } });
  assert.equal(resolve(other), null);
  assert.equal(eventMatchesAgent(other, "verity"), false);
  const broadcast = notification({ ...revised, payload: { message: "@everyone revised" } });
  assert.ok(resolve(broadcast));
  assert.equal(eventMatchesAgent(broadcast, "verity"), true);
  assert.equal(resolve({ ...notification(), payload: { ...notification().payload, event: null } }), null);
});

test("live merger delivers higher revision once and rejects stale cross-source rewind", async () => {
  async function* lane() { for (const event of [original, revised, original, revised, notification()]) yield { source: "fs", event }; }
  const controller = new AbortController();
  const seen = [];
  for await (const item of mergeLiveSources({ sessionId: "edit-room", signal: controller.signal, _localIterator: lane() })) {
    seen.push(item.event);
    if (seen.length === 3) controller.abort();
  }
  assert.deepEqual(seen.map((row) => [row.id, row.messageRevision ?? 1]), [[messageId, 1], [messageId, 2], ["notification-43", 1]]);
});

test("local watcher sees edited projection at original timestamp", async () => {
  const controller = new AbortController();
  let onChange;
  let reads = 0;
  const source = watchLocalStream({ sessionId: "edit-room", targetPath: os.tmpdir(), signal: controller.signal,
    _watch: (_path, _options, callback) => { onChange = callback; return { close() {} }; },
    _readEvents: async () => ++reads === 1 ? [original] : [revised, notification()] });
  assert.equal((await source.next()).value.event.messageRevision, 1);
  const next = source.next();
  await new Promise((resolve) => setImmediate(resolve));
  onChange();
  assert.equal((await next).value.event.messageRevision, 2);
  controller.abort();
  await source.return();
});

test("local watcher establishes full baseline outside initial tail without replaying unchanged history", async () => {
  const controller = new AbortController();
  let onChange;
  let reads = 0;
  const last = { ...original, id: "tail-message", eventId: "tail-event", sequenceId: 43, cursor: "43:tail", payload: { message: "tail" } };
  const source = watchLocalStream({ sessionId: "edit-room", targetPath: os.tmpdir(), signal: controller.signal, initialTail: 1,
    _watch: (_path, _options, callback) => { onChange = callback; return { close() {} }; },
    _readEvents: async () => ++reads === 1 ? [original, last] : [revised, last, notification(revised, 44)] });
  assert.equal((await source.next()).value.event.id, "tail-message");
  const next = source.next();
  await new Promise((resolve) => setImmediate(resolve));
  onChange();
  assert.equal((await next).value.event.messageRevision, 2);
  assert.equal((await source.next()).value.event.event, "session_message_edited");
  controller.abort();
  await source.return();
});
