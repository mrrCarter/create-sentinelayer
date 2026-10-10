import "./setup-env.mjs";
// Local MCP session tools and owner actions in an AGENT CONTEXT (SENTINELAYER_AGENT_ID is set,
// or this machine stores agent admission credentials), by each tool's class in
// src/session/route-classes.js:
//   (a) the session stores an admission, in any state: bind exactly to it, or refuse
//   (b) the session stores none and the tool is on the legacy data-plane list: as before
//   (c) the session stores none and the tool is control, owner or unclassified/new: refuse
// Owner mutations are refused in an agent context either way. Credential-free: synthetic
// ids, an invalid example origin and injected transports; nothing reaches a network.
import test, { mock } from "node:test";
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

async function storeCredential(agentId, overrides = {}, sessionId = SESSION) {
  const file = admissionCredentialPath(sessionId, agentId);
  await fsp.mkdir(path.dirname(file), { recursive: true });
  await fsp.writeFile(
    file,
    typeof overrides === "string"
      ? overrides
      : JSON.stringify({
          version: 2,
          sessionId,
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

// Synthetic handlers wrapped exactly as the real ones are. A brand-new name is unclassified;
// send_message is on the legacy data-plane list; session_lock is a control tool.
function tools() {
  const calls = [];
  const record = (name) => async (input) => {
    calls.push({ name, input, admitted: currentAdmittedAgent() });
    return { ok: true };
  };
  const handlers = routeAgentToolsThroughAdmission({
    brand_new_tool: record("brand_new_tool"),
    send_message: record("send_message"),
    session_lock: record("session_lock"),
  });
  return { handlers, calls };
}

const BAD_STORED_STATES = [
  ["expired", () => storeCredential(AGENT, { expiresAt: Math.floor(Date.now() / 1000) - 5 }), /expired.*will not fall back/s],
  ["malformed", () => storeCredential(AGENT, "{not json"), /unreadable.*will not fall back/s],
  [
    "bound to another session",
    () => storeCredential(AGENT, { sessionId: OTHER_SESSION }),
    /different session or agent.*will not fall back/s,
  ],
  ["held by a different agent", () => storeCredential("other-agent"), /holds none of the admissions stored for session/],
];

test.afterEach(clearCredentials);

// ---- (c) no admission stored for the session: only the legacy data-plane list runs

test("a new tool given only a session id, with SENTINELAYER_AGENT_ID set and no admission for the session, is refused", async () => {
  await withEnv(AGENT, async () => {
    const { handlers, calls } = tools();
    await assert.rejects(handlers.brand_new_tool({ sessionId: SESSION }), /needs an admission it can bind to/);
    assert.deepEqual(calls, []);
  });
});

test("a control tool with no admission for the session is refused", async () => {
  await withEnv(AGENT, async () => {
    const { handlers, calls } = tools();
    await assert.rejects(handlers.session_lock({ sessionId: SESSION, agentId: AGENT }), /needs one/);
    assert.deepEqual(calls, []);
  });
});

test("session_locks with no admission for the session is refused", async () => {
  let listed = 0;
  const handlers = createSessionMcpToolHandlers({
    targetPath: os.tmpdir(),
    listFileLocksFn: async () => {
      listed += 1;
      return [];
    },
  });
  await withEnv(AGENT, async () => {
    await assert.rejects(handlers.session_locks({ sessionId: SESSION }), /needs one/);
  });
  assert.equal(listed, 0);
});

// ---- (b) the legacy data-plane list keeps today's behaviour in rooms that store no admission

test("a legacy data-plane tool with no admission for the session runs as before", async () => {
  await storeCredential(AGENT, {}, OTHER_SESSION); // an agent context, but not for this session
  await withEnv(AGENT, async () => {
    const { handlers, calls } = tools();
    await handlers.send_message({ sessionId: SESSION, agentId: AGENT, message: "hello" });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].admitted, null, "no admission for this session to bind to");
  });
});

// ---- (a) the session stores an admission: every class binds exactly to it or refuses

test("an admission seen in the listing but gone when it is read refuses, and nothing runs", async () => {
  await storeCredential(AGENT);
  const file = path.resolve(admissionCredentialPath(SESSION, AGENT));
  const readFile = fsp.readFile;
  mock.method(fsp, "readFile", async (target, ...rest) => {
    if (path.resolve(String(target)) === file) throw Object.assign(new Error("removed"), { code: "ENOENT" });
    return readFile.call(fsp, target, ...rest);
  });
  try {
    await withEnv(AGENT, async () => {
      const { handlers, calls } = tools();
      await assert.rejects(
        handlers.send_message({ sessionId: SESSION, agentId: AGENT, message: "hello" }),
        /no longer present.*will not fall back/s,
      );
      assert.deepEqual(calls, []);
    });
  } finally {
    mock.restoreAll();
  }
});

for (const name of ["brand_new_tool", "send_message", "session_lock"]) {
  test(`${name} binds to the LIVE admission stored for its session`, async () => {
    await storeCredential(AGENT);
    await withEnv(AGENT, async () => {
      const { handlers, calls } = tools();
      await handlers[name]({ sessionId: SESSION });
      assert.equal(calls.length, 1);
      assert.equal(calls[0].admitted?.agentId, AGENT, "ran inside the admission scope");
    });
  });

  for (const [state, store, refusal] of BAD_STORED_STATES) {
    test(`${name} refuses when the session's stored admission is ${state}`, async () => {
      await store();
      await withEnv(AGENT, async () => {
        const { handlers, calls } = tools();
        await assert.rejects(handlers[name]({ sessionId: SESSION }), refusal);
        assert.deepEqual(calls, []);
      });
    });
  }
}

test("session_locks lists leases only on the admission its session stores", async () => {
  const listed = [];
  const handlers = createSessionMcpToolHandlers({
    targetPath: os.tmpdir(),
    listFileLocksFn: async () => {
      listed.push(currentAdmittedAgent());
      return [];
    },
  });
  await withEnv(AGENT, async () => {
    for (const [state, store, refusal] of BAD_STORED_STATES) {
      await clearCredentials();
      await store();
      await assert.rejects(handlers.session_locks({ sessionId: SESSION }), refusal, state);
    }
    assert.equal(listed.length, 0, "never listed on another credential");
    await clearCredentials();
    await storeCredential(AGENT);
    const result = await handlers.session_locks({ sessionId: SESSION });
    assert.equal(result.ok, true);
    assert.deepEqual(listed.map((admitted) => admitted?.agentId), [AGENT]);
  });
});

test("a session that stores an admission refuses a tool naming no agent", async () => {
  await storeCredential("some-agent");
  await withEnv(undefined, async () => {
    const { handlers, calls } = tools();
    await assert.rejects(handlers.send_message({ sessionId: SESSION }), /no agent id was given/);
    assert.deepEqual(calls, []);
  });
});

test("in an agent context a tool given no session id is refused", async () => {
  await withEnv(AGENT, async () => {
    const { handlers, calls } = tools();
    await assert.rejects(handlers.send_message({}), /no session id was given/);
    assert.deepEqual(calls, []);
  });
});

// ---- outside an agent context, and the local-only tools

test("with no agent signal at all, every tool runs as before", async () => {
  await withEnv(undefined, async () => {
    const { handlers, calls } = tools();
    await handlers.brand_new_tool({ sessionId: SESSION });
    await handlers.session_lock({ sessionId: SESSION });
    assert.equal(calls.length, 2);
    assert.deepEqual(calls.map((call) => call.admitted), [null, null]);
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
    await storeCredential(AGENT, { expiresAt: 1 });
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

// ---- owner mutations: refused in an agent context whether or not an admission exists

for (const [label, prepare] of [
  ["with no admission stored", async () => {}],
  ["with an admission stored for the session", () => storeCredential(AGENT)],
]) {
  test(`owner mutations are refused in an agent context ${label}`, async () => {
    await prepare();
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
}
