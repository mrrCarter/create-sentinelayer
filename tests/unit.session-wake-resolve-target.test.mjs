import test from "node:test";
import assert from "node:assert/strict";

import { createResolveTarget } from "../src/session/wake/resolve-target.js";

const base = { agentId: "claude-mythos", host: "claude", sessionId: "sess-mythos" };
const msg = (over = {}) => ({ event: "session_message", agentId: "carter", payload: { message: "hi", ...over.payload }, ...over });

test("Unit resolve-target: requires agentId/host/sessionId", () => {
  assert.throws(() => createResolveTarget({}), /agentId/);
  assert.throws(() => createResolveTarget({ agentId: "a" }), /host/);
  assert.throws(() => createResolveTarget({ agentId: "a", host: "claude" }), /sessionId/);
});

test("Unit resolve-target: directed-to-me message from another wakes us", () => {
  const r = createResolveTarget(base);
  const t = r(msg({ payload: { to: "claude-mythos", message: "ping" } }));
  assert.equal(t.host, "claude");
  assert.equal(t.sessionId, "sess-mythos");
  assert.match(t.message, /Senti wake for claude-mythos/);
  assert.match(t.message, /ping/);
});

test("Unit resolve-target: untargeted room message from another wakes us", () => {
  const r = createResolveTarget(base);
  assert.ok(r(msg()) !== null);
});

test("Unit resolve-target: broadcast recipients wake us", () => {
  const r = createResolveTarget(base);
  for (const to of ["*", "all", "broadcast", "everyone", "agents"]) {
    assert.ok(r(msg({ payload: { to, message: "x" } })) !== null, `broadcast ${to}`);
  }
});

test("Unit resolve-target: self-authored events never self-wake", () => {
  const r = createResolveTarget(base);
  assert.equal(r(msg({ agentId: "claude-mythos" })), null);
  assert.equal(r(msg({ agentId: { id: "claude-mythos" } })), null);
});

test("Unit resolve-target: message directed at a different agent is unroutable (null)", () => {
  const r = createResolveTarget(base);
  assert.equal(r(msg({ payload: { to: "codex", message: "for codex" } })), null);
});

test("Unit resolve-target: non-message event types do not wake (acks/reactions/views)", () => {
  const r = createResolveTarget(base);
  assert.equal(r({ event: "session_reaction", agentId: "carter", payload: { to: "claude-mythos" } }), null);
  assert.equal(r({ event: "session_message_action", agentId: "carter", payload: { to: "claude-mythos" } }), null);
  assert.equal(r({ agentId: "carter", payload: { message: "no type" } }), null);
});

test("Unit resolve-target: agentId as object envelope is handled", () => {
  const r = createResolveTarget(base);
  assert.ok(r({ event: "session_message", agentId: { id: "carter" }, payload: { to: "claude-mythos", message: "x" } }) !== null);
});

test("Unit resolve-target: custom wakeEventTypes + formatMessage honored", () => {
  const r = createResolveTarget({
    ...base,
    wakeEventTypes: new Set(["custom_evt"]),
    formatMessage: () => "FIXED",
  });
  assert.equal(r(msg()), null); // session_message no longer a wake type
  const t = r({ event: "custom_evt", agentId: "carter", payload: { message: "y" } });
  assert.equal(t.message, "FIXED");
});

test("Unit resolve-target: oversized message is capped by default formatter", () => {
  const r = createResolveTarget(base);
  const t = r(msg({ payload: { to: "claude-mythos", message: "z".repeat(20000) } }));
  assert.ok(t.message.length <= 16000);
});
