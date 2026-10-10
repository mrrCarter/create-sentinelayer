import "./setup-env.mjs";
// Session tools and owner actions in an AGENT CONTEXT: SENTINELAYER_AGENT_ID is set, or this
// machine stores agent admission credentials. There, a local MCP session tool runs only on a
// live admission for the agent, and owner mutations (approve, deny, revoke, any mode change)
// are refused. Credential-free: synthetic ids, an invalid example origin, and injected
// transports; nothing here reaches a network.
import test from "node:test";
import assert from "node:assert/strict";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const { createSessionMcpToolHandlers, routeAgentToolsThroughAdmission } = await import(
  "../src/mcp/session-stdio-server.js"
);
const { decideSessionAdmission, revokeSessionAdmission, setSessionAdmissionMode } = await import(
  "../src/session/admission-access.js"
);
const { admissionCredentialPath } = await import("../src/session/admission.js");
const { currentAdmittedAgent } = await import("../src/session/admission-auth.js");

const SESSION = "00000000-0000-4000-8000-000000000001";
const ADMISSION = "00000000-0000-4000-8000-000000000002";
const OTHER_SESSION = "00000000-0000-4000-8000-000000000003";
const AGENT = "env-agent";

async function withEnv(value, fn) {
  const saved = process.env.SENTINELAYER_AGENT_ID;
  if (value === undefined) delete process.env.SENTINELAYER_AGENT_ID;
  else process.env.SENTINELAYER_AGENT_ID = value;
  try {
    return await fn();
  } finally {
    if (saved === undefined) delete process.env.SENTINELAYER_AGENT_ID;
    else process.env.SENTINELAYER_AGENT_ID = saved;
  }
}

async function storeCredential(agentId, overrides = {}) {
  const file = admissionCredentialPath(SESSION, agentId);
  await fsp.mkdir(path.dirname(file), { recursive: true });
  await fsp.writeFile(
    file,
    typeof overrides === "string"
      ? overrides
      : JSON.stringify({
          version: 2,
          sessionId: SESSION,
          agentId,
          apiUrl: "https://api.example.invalid",
          admissionId: ADMISSION,
          token: `sladm_${"A".repeat(43)}`,
          expiresAt: Math.floor(Date.now() / 1000) + 3600,
          ...overrides,
        }),
  );
}

async function clearCredentials() {
  await fsp.rm(path.join(os.homedir(), ".sentinelayer", "agents"), { recursive: true, force: true });
}

function newTool() {
  const calls = [];
  const handlers = routeAgentToolsThroughAdmission({
    brand_new_tool: async (input) => {
      calls.push({ input, admitted: currentAdmittedAgent() });
      return { ok: true };
    },
  });
  return { handlers, calls };
}

test.afterEach(clearCredentials);

test("a new session tool given only a session id, with SENTINELAYER_AGENT_ID set, never runs outside an admission", async () => {
  await withEnv(AGENT, async () => {
    const { handlers, calls } = newTool();
    await assert.rejects(handlers.brand_new_tool({ sessionId: SESSION }), /agent context/);
    assert.equal(calls.length, 0);
  });
});

test("a new session tool binds to the agent's LIVE admission from SENTINELAYER_AGENT_ID and runs inside its scope", async () => {
  await storeCredential(AGENT);
  await withEnv(AGENT, async () => {
    const { handlers, calls } = newTool();
    await handlers.brand_new_tool({ sessionId: SESSION });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].admitted?.agentId, AGENT, "ran inside the admission scope");
  });
});

for (const [state, credential, refusal] of [
  ["expired", { expiresAt: Math.floor(Date.now() / 1000) - 5 }, /expired.*will not fall back/s],
  ["malformed", "{not json", /unreadable.*will not fall back/s],
  ["bound to another session", { sessionId: OTHER_SESSION }, /different session or agent.*will not fall back/s],
]) {
  test(`a new session tool refuses an agent whose stored admission is ${state}`, async () => {
    await storeCredential(AGENT, credential);
    await withEnv(AGENT, async () => {
      const { handlers, calls } = newTool();
      await assert.rejects(handlers.brand_new_tool({ sessionId: SESSION }), refusal);
      assert.equal(calls.length, 0);
    });
  });
}

test("stored admissions alone make an agent context: a tool naming no agent is refused", async () => {
  await storeCredential("some-agent");
  await withEnv(undefined, async () => {
    const { handlers, calls } = newTool();
    await assert.rejects(handlers.brand_new_tool({ sessionId: SESSION }), /no agent id was given/);
    assert.equal(calls.length, 0);
  });
});

test("with no agent signal at all, session tools run as before", async () => {
  await withEnv(undefined, async () => {
    const { handlers, calls } = newTool();
    await handlers.brand_new_tool({ sessionId: SESSION });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].admitted, null);
  });
});

test("session_locks in an agent context lists leases only on the agent's admission", async () => {
  const listed = [];
  const handlers = createSessionMcpToolHandlers({
    targetPath: os.tmpdir(),
    listFileLocksFn: async () => {
      listed.push(currentAdmittedAgent());
      return [];
    },
  });
  await withEnv(AGENT, async () => {
    // no admission for the agent: refused, the lease list is never requested
    await assert.rejects(handlers.session_locks({ sessionId: SESSION }), /agent context/);
    assert.equal(listed.length, 0);
    // unusable admissions: refused too
    for (const credential of [{ expiresAt: 1 }, "{not json", { sessionId: OTHER_SESSION }]) {
      await storeCredential(AGENT, credential);
      await assert.rejects(handlers.session_locks({ sessionId: SESSION }), /will not fall back/);
    }
    assert.equal(listed.length, 0, "never listed on another credential");
    // live admission: listed inside its scope
    await storeCredential(AGENT);
    const result = await handlers.session_locks({ sessionId: SESSION });
    assert.equal(result.ok, true);
    assert.equal(listed.length, 1);
    assert.equal(listed[0]?.agentId, AGENT);
  });
});

test("memory tools stay local in an agent context and send no request", async () => {
  const originalFetch = globalThis.fetch;
  let fetches = 0;
  globalThis.fetch = async () => {
    fetches += 1;
    throw new Error("memory tools must not reach the network");
  };
  try {
    const targetPath = await fsp.mkdtemp(path.join(os.tmpdir(), "sl-agent-context-memory-"));
    const handlers = createSessionMcpToolHandlers({ targetPath });
    await withEnv(AGENT, async () => {
      const written = await handlers["memory.write"]({
        scope: "project:agent-context",
        items: [{ text: "lease policy decided", kind: "decision" }],
      });
      assert.notEqual(written?.ok, false, JSON.stringify(written));
      await handlers["memory.recall"]({ scope: "project:agent-context", query: "lease policy" });
    });
    assert.equal(fetches, 0);
    await fsp.rm(targetPath, { recursive: true, force: true });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("owner mutations are refused in an agent context, including the ones that only reduce access", async () => {
  const calls = [];
  const common = {
    resolveAuthSession: async () => ({ token: "synthetic-owner-token", apiUrl: "https://example.invalid" }),
    requestMutation: async (url, options) => {
      calls.push({ url, body: options.body });
      return { ok: true };
    },
  };
  await withEnv(AGENT, async () => {
    for (const mutation of [
      () => decideSessionAdmission(SESSION, ADMISSION, { ...common, decision: "approve" }),
      () => decideSessionAdmission(SESSION, ADMISSION, { ...common, decision: "deny" }),
      () => revokeSessionAdmission(SESSION, ADMISSION, common),
      () => setSessionAdmissionMode(SESSION, "required", common),
      () => setSessionAdmissionMode(SESSION, "legacy", common),
    ]) {
      await assert.rejects(mutation(), /unavailable in an agent context/);
    }
  });
  assert.deepEqual(calls, [], "no owner mutation reached the transport");
});
