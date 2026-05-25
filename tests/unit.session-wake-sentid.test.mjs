import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { createSentid } from "../src/session/wake/sentid.js";

function fakeAdapter(hostName) {
  const calls = [];
  return {
    hostName,
    calls,
    wake(target) {
      calls.push(target);
      return Promise.resolve({ ok: true, hostName, sessionId: target.sessionId, code: 0, reason: null });
    },
  };
}

async function withTempRoot(fn) {
  const root = await mkdtemp(path.join(os.tmpdir(), "cs-sentid-"));
  try { return await fn(root); } finally { await rm(root, { recursive: true, force: true }); }
}

const base = { sessionId: "sess-1", agentId: "claude-mythos", host: "claude", resumeSessionId: "resume-1" };

test("Unit sentid: validates required fields", () => {
  assert.throws(() => createSentid({}), /sessionId/);
  assert.throws(() => createSentid({ sessionId: "s" }), /agentId/);
  assert.throws(() => createSentid({ sessionId: "s", agentId: "a" }), /host/);
  assert.throws(() => createSentid({ sessionId: "s", agentId: "a", host: "claude" }), /resumeSessionId/);
});

test("Unit sentid: registers the default adapters (claude + codex)", () => {
  const s = createSentid({ ...base, pollImpl: async () => ({ events: [] }) });
  assert.deepEqual(s.registry.hosts().sort(), ["claude", "codex"]);
});

test("Unit sentid: throws if the agent's host has no registered adapter", () => {
  assert.throws(
    () => createSentid({ ...base, host: "copilot", adapters: [fakeAdapter("claude")], pollImpl: async () => ({ events: [] }) }),
    /no adapter registered for host "copilot"/
  );
});

test("Unit sentid: a directed message wakes the agent via the right host adapter", async () => {
  await withTempRoot(async (root) => {
    const claude = fakeAdapter("claude");
    const codex = fakeAdapter("codex");
    const pollImpl = async (sessionId, { since }) => ({
      ok: true,
      events: [{ sequenceId: 1, cursor: "c1", event: "session_message", agentId: "carter", payload: { to: "claude-mythos", message: "hi mythos" } }],
      cursor: "c1",
    });
    const s = createSentid({ ...base, adapters: [claude, codex], pollImpl, targetPath: root });
    const tick = await s.tickOnce({ fetchCursor: null });

    assert.equal(claude.calls.length, 1, "claude adapter woken");
    assert.equal(codex.calls.length, 0, "codex adapter not woken");
    assert.equal(claude.calls[0].sessionId, "resume-1", "resumes the agent's host session");
    assert.match(claude.calls[0].message, /hi mythos/);
    assert.equal(s.getCursor(), 1);
    assert.equal(tick.fetchCursor, "c1");
  });
});

test("Unit sentid: self-authored and other-directed messages do not wake", async () => {
  await withTempRoot(async (root) => {
    const claude = fakeAdapter("claude");
    const pollImpl = async () => ({
      ok: true,
      events: [
        { sequenceId: 2, cursor: "c2", event: "session_message", agentId: "claude-mythos", payload: { message: "my own post" } },
        { sequenceId: 3, cursor: "c3", event: "session_message", agentId: "carter", payload: { to: "codex", message: "for codex" } },
      ],
      cursor: "c3",
    });
    const s = createSentid({ ...base, adapters: [claude, fakeAdapter("codex")], pollImpl, targetPath: root });
    await s.tickOnce({ fetchCursor: null });
    assert.equal(claude.calls.length, 0, "neither self-post nor other-directed wakes us");
    assert.equal(s.getCursor(), 3, "both are clean skips that advance the cursor");
  });
});

test("Unit sentid: a failing poll (ok:false) is treated as idle, no crash", async () => {
  await withTempRoot(async (root) => {
    const claude = fakeAdapter("claude");
    const pollImpl = async () => ({ ok: false, reason: "circuit_breaker_open", events: [], cursor: null });
    const s = createSentid({ ...base, adapters: [claude, fakeAdapter("codex")], pollImpl, targetPath: root });
    const tick = await s.tickOnce({ fetchCursor: "c0" });
    assert.equal(tick.idle, true);
    assert.equal(claude.calls.length, 0);
  });
});
