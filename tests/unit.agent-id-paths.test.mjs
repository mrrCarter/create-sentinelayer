import "./setup-env.mjs";
// An agent id names exactly one entry directly under the directory that holds per-agent files:
// <run>/agents/<id>.json for an audit run and <session>/agents/<id>.json for a session. Every
// legitimate id shape resolves there; any other id is refused before a file is read or written,
// through the helper, the audit registry, the audit orchestrator, the session agent registry
// and the real `sl audit` and `sl session kill` commands.
import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  AGENT_ID_ENTRY_RULE,
  AGENT_ID_RESERVED_RULE,
  AGENT_ID_RULE,
  agentIdProblem,
  resolveAgentIdPath,
} from "../src/agents/agent-id-path.js";
import { runAuditOrchestrator } from "../src/audit/orchestrator.js";
import { listBuiltinAuditAgents, loadAuditRegistry } from "../src/audit/registry.js";
import { FULL_DEPTH_PERSONAS } from "../src/review/scan-modes.js";
import { canonicalAgentId } from "../src/session/admission-auth.js";
import {
  generateAgentId,
  heartbeatAgent,
  listAgents,
  registerAgent,
  rememberAgentIdentity,
  unregisterAgent,
} from "../src/session/agent-registry.js";
import { resolveSessionPaths } from "../src/session/paths.js";
import { createSession } from "../src/session/store.js";
import { listBuiltinSwarmAgents } from "../src/swarm/registry.js";

const CLI = fileURLToPath(new URL("../bin/sl.js", import.meta.url));

// Every shape a real id takes: built-in agents and personas, ids from --agent (canonicalised),
// generated and friendly session ids, daemon ids, and ids used in tests and docs.
const LEGITIMATE_IDS = [
  ...listBuiltinAuditAgents().map((agent) => agent.id),
  ...listBuiltinSwarmAgents().map((agent) => agent.id),
  ...FULL_DEPTH_PERSONAS,
  ...["", "claude-opus-4", "gpt-5.3-codex", "gemini-2.5-pro", "Some Model/v2:beta"].map((model) => generateAgentId(model)),
  "claude-a1b2",
  "codex-c3d4",
  "claude-3",
  "guest-1",
  "cli-user",
  "senti",
  "scope-engine",
  "error-daemon",
  "audit-orchestrator",
  "investor-dd",
  "codex-task-holder-1",
  "omargate-supply-chain-subagent-12",
  "human-4f9c2e1a-7b3d-4c5e-9f00-112233445566",
  "custom-domain",
  "a",
  "9",
  "a.b",
  "a..b",
  "a_b",
  "x_",
  "x".repeat(64),
  `${"x".repeat(63)}_`,
  // close to a device name, but not one
  "console",
  "con-1",
  "nul_x",
  "com0",
  "com10",
  "lpt",
  "auxiliary",
];

// Ids that are not one entry under the directory: the one-entry check refuses them on its own.
const PATH_SHAPED_IDS = ["../x", "..\\x", "a/b", "a\\b", "a/../../b", "x/..", "a/", "/tmp/x", "C:\\x", "\\\\server\\share\\x"];
// Only as a bare entry (no suffix) do these leave the directory.
const BARE_PATH_SHAPED_IDS = [".", ".."];
// One entry, but outside the rule.
const OUTSIDE_RULE_IDS = [
  ".",
  "..",
  ".hidden",
  "-x",
  "_x",
  "x-",
  "a b",
  " a",
  "a\n",
  "a\0b",
  "A",
  "Codex",
  "CON",
  "é",
  "a@b",
  "x".repeat(65),
];
// Ending with '.': Windows drops it, so "abc." and "abc" would name the same file.
const TRAILING_DOT_IDS = ["abc.", "a.", "a..", "codex-1.", `${"x".repeat(63)}.`];
// Windows device names, with or without an extension (lowercase: uppercase is already outside the rule).
const RESERVED_IDS = ["con", "prn", "aux", "nul", "com1", "com9", "lpt1", "lpt9", "con.json", "nul.tar.gz", "com1.log"];
// A drive-relative or stream-like spelling: the one-entry check refuses it on Windows, the rule elsewhere.
const PLATFORM_IDS = ["C:x", "c:x", "a:b"];
const REFUSED_IDS = [...PATH_SHAPED_IDS, ...OUTSIDE_RULE_IDS, ...TRAILING_DOT_IDS, ...RESERVED_IDS, ...PLATFORM_IDS];

async function tempBase(t) {
  const base = await fsp.mkdtemp(path.join(os.tmpdir(), "sl-agent-id-paths-"));
  t.after(() => fsp.rm(base, { recursive: true, force: true }));
  const targetPath = path.join(base, "target");
  await fsp.mkdir(targetPath, { recursive: true });
  await fsp.writeFile(path.join(targetPath, "package.json"), '{"name":"agent-id-paths-fixture","version":"1.0.0"}\n');
  await fsp.writeFile(path.join(targetPath, "index.js"), "export const ok = true;\n");
  return { base, targetPath };
}

// Every file and directory under `dir` (relative path -> file contents, or "<dir>"),
// leaving out anything under the relative prefixes in `skip`.
function tree(dir, { skip = [] } = {}) {
  const out = {};
  const walk = (current) => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      const rel = path.relative(dir, full);
      if (skip.some((prefix) => rel === prefix || rel.startsWith(prefix + path.sep))) continue;
      if (entry.isDirectory()) {
        out[rel] = "<dir>";
        walk(full);
      } else {
        out[rel] = fs.readFileSync(full, "utf-8");
      }
    }
  };
  walk(dir);
  return out;
}

function runCli(args, { cwd }) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CLI, ...args], {
      cwd,
      // the same CLI test-mode environment as the chat test in tests/e2e.test.mjs
      env: {
        ...process.env,
        NODE_ENV: "test",
        SENTINELAYER_CLI_TEST_MODE: "1",
        SENTINELAYER_CLI_TEST_BYPASS_NONCE: "e2e-bypass-nonce",
        SENTINELAYER_CLI_SKIP_AUTH: "1",
        SENTINELAYER_TOKEN: "api_token_e2e_test_session",
      },
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

function rejectsWith(fn, message, label) {
  assert.throws(fn, (error) => {
    assert.equal(error.message, message, label);
    return true;
  });
}

test("every legitimate id shape is a canonical agent id and stays one entry under its directory", () => {
  const dir = path.resolve(os.tmpdir(), "sl-agent-id-paths-dir", "agents");
  for (const id of LEGITIMATE_IDS) {
    assert.equal(agentIdProblem(id), "", id);
    assert.equal(canonicalAgentId(id), id, `${id} is already canonical`);
    for (const suffix of ["", ".json"]) {
      const resolved = resolveAgentIdPath(dir, id, suffix);
      assert.equal(path.dirname(resolved), dir, id);
      assert.equal(path.basename(resolved), `${id}${suffix}`, id);
    }
  }
});

test("a path-shaped id is refused by the one-entry check, before the rule is consulted", () => {
  const dir = path.resolve(os.tmpdir(), "sl-agent-id-paths-dir", "agents");
  for (const id of PATH_SHAPED_IDS) {
    for (const suffix of ["", ".json"]) {
      rejectsWith(() => resolveAgentIdPath(dir, id, suffix), AGENT_ID_ENTRY_RULE, `${JSON.stringify(id)}${suffix}`);
    }
  }
  for (const id of BARE_PATH_SHAPED_IDS) {
    rejectsWith(() => resolveAgentIdPath(dir, id), AGENT_ID_ENTRY_RULE, id);
  }
});

test("an id outside the rule, ending with '.', or naming a device is refused even as one entry", () => {
  const dir = path.resolve(os.tmpdir(), "sl-agent-id-paths-dir", "agents");
  for (const id of [...OUTSIDE_RULE_IDS, ...TRAILING_DOT_IDS]) {
    assert.equal(agentIdProblem(id), AGENT_ID_RULE, JSON.stringify(id));
    rejectsWith(() => resolveAgentIdPath(dir, id, ".json"), AGENT_ID_RULE, JSON.stringify(id));
  }
  for (const id of TRAILING_DOT_IDS) {
    rejectsWith(() => resolveAgentIdPath(dir, id), AGENT_ID_RULE, id);
  }
  for (const id of RESERVED_IDS) {
    assert.equal(agentIdProblem(id), AGENT_ID_RESERVED_RULE, id);
    rejectsWith(() => resolveAgentIdPath(dir, id, ".json"), AGENT_ID_RESERVED_RULE, id);
    rejectsWith(() => resolveAgentIdPath(dir, id), AGENT_ID_RESERVED_RULE, id);
  }
  for (const id of PLATFORM_IDS) {
    assert.notEqual(agentIdProblem(id), "", id);
    assert.throws(() => resolveAgentIdPath(dir, id, ".json"), /^Error: agent id must /, id);
  }
  for (const value of ["", null, undefined]) {
    assert.throws(() => resolveAgentIdPath(dir, value, ".json"), /agentId is required/);
  }
});

test("the session agent registry refuses every id outside the rule before a snapshot is read or written", async (t) => {
  const { base, targetPath } = await tempBase(t);
  const session = await createSession({ targetPath, ttlSeconds: 120 });
  const paths = resolveSessionPaths(session.sessionId, { targetPath });
  await fsp.mkdir(paths.agentsDir, { recursive: true });

  // Snapshot-shaped files beside, above and outside the agents directory.
  const bystander = (agentId) =>
    `${JSON.stringify({ sessionId: session.sessionId, agentId, role: "coder", status: "idle", active: true }, null, 2)}\n`;
  const bystanders = [
    path.join(paths.sessionDir, "outside.json"),
    path.join(targetPath, ".sentinelayer", "outside.json"),
    path.join(base, "outside.json"),
  ];
  for (const file of bystanders) await fsp.writeFile(file, bystander("outside"));
  const before = tree(base);

  const leavingIds = ["../outside", "../../../outside", "../../../../../outside", "..\\outside", "..\\..\\..\\..\\..\\outside"];
  // The registry trims an id before using it, as before, so " a" and "a\n" are "a".
  for (const id of [...leavingIds, ...REFUSED_IDS.filter((value) => value.trim() === value)]) {
    const label = JSON.stringify(id);
    await assert.rejects(
      registerAgent(session.sessionId, { agentId: id, model: "codex", role: "coder", targetPath, trackProcessExit: false }),
      /agent id must /,
      label
    );
    await assert.rejects(rememberAgentIdentity(session.sessionId, { agentId: id, model: "codex", targetPath }), /agent id must /, label);
    await assert.rejects(heartbeatAgent(session.sessionId, id, { status: "coding", targetPath }), /agent id must /, label);
    await assert.rejects(unregisterAgent(session.sessionId, id, { reason: "manual", targetPath }), /agent id must /, label);
  }
  assert.deepEqual(tree(base), before, "no snapshot was read into or written anywhere");

  // Control: legitimate ids register, heartbeat and leave under agents/.
  for (const id of ["codex-c3d4", "claude-3", "a..b", `${"x".repeat(63)}_`]) {
    const joined = await registerAgent(session.sessionId, { agentId: id, model: "codex", role: "coder", targetPath, trackProcessExit: false });
    assert.equal(joined.snapshotPath, path.join(paths.agentsDir, `${id}.json`));
    await heartbeatAgent(session.sessionId, id, { status: "coding", targetPath });
    const left = await unregisterAgent(session.sessionId, id, { reason: "manual", targetPath });
    assert.equal(left.active, false);
  }
  const remembered = await rememberAgentIdentity(session.sessionId, { agentId: "senti", model: "senti", targetPath });
  assert.equal(path.dirname(remembered.snapshotPath), paths.agentsDir);
  const generated = await registerAgent(session.sessionId, { model: "claude-opus-4", role: "coder", targetPath, trackProcessExit: false });
  assert.equal(path.dirname(generated.snapshotPath), paths.agentsDir);
  assert.equal((await listAgents(session.sessionId, { targetPath })).length, 6);
  for (const file of bystanders) assert.equal(await fsp.readFile(file, "utf-8"), bystander("outside"), file);
});

test("an audit registry with an agent id that cannot name a file is refused when it is loaded", async (t) => {
  const { base } = await tempBase(t);
  const registryFile = path.join(base, "registry.json");
  for (const id of [...PATH_SHAPED_IDS, "..", ".hidden", "abc.", "con", "NUL.txt", "a b", "C:x", "a:b", "x".repeat(65)]) {
    await fsp.writeFile(registryFile, JSON.stringify({ agents: [{ id: "custom-domain" }, { id, persona: "P", domain: "D" }] }));
    await assert.rejects(loadAuditRegistry({ registryFile }), (error) => {
      assert.match(error.message, /^Invalid audit registry file: agents\[1\]\.id /, JSON.stringify(id));
      assert.match(error.message, /agent id must (be 1-64 characters|not be a reserved device name)/, JSON.stringify(id));
      return true;
    });
  }

  // Control: custom and overriding ids load, folded to lowercase as before.
  await fsp.writeFile(
    registryFile,
    JSON.stringify({ agents: [{ id: "Security", maxTurns: 9 }, { id: "custom-domain", persona: "P", domain: "D" }, { id: "  " }] })
  );
  const registry = await loadAuditRegistry({ registryFile });
  assert.equal(registry.agents.find((agent) => agent.id === "security").maxTurns, 9);
  assert.ok(registry.agents.some((agent) => agent.id === "custom-domain"));
});

test("the audit orchestrator refuses an agent whose id is not one file under agents/ before writing anything", async (t) => {
  const { base, targetPath } = await tempBase(t);
  const before = tree(base);
  for (const id of ["../../../../outside-entry", "..\\..\\..\\..\\outside-entry", "a/b", "/tmp/outside-entry", "con", "abc.", ".hidden"]) {
    await assert.rejects(
      runAuditOrchestrator({
        targetPath,
        agents: [{ id, persona: "P", domain: "D", tools: [], permissionMode: "plan", maxTurns: 1, confidenceFloor: 0 }],
        dryRun: true,
      }),
      /agent id must /,
      JSON.stringify(id)
    );
  }
  assert.deepEqual(tree(base), before, "nothing was written, not even the run directory");

  // Control: a custom agent writes its file directly under the run's agents/ directory.
  const result = await runAuditOrchestrator({
    targetPath,
    agents: [{ id: "custom-domain", persona: "P", domain: "D", tools: [], permissionMode: "plan", maxTurns: 1, confidenceFloor: 0 }],
    dryRun: true,
  });
  const [agentResult] = result.agentResults;
  assert.equal(agentResult.artifactPath, path.join(result.runDirectory, "agents", "custom-domain.json"));
  assert.ok(fs.existsSync(agentResult.artifactPath));
  assert.deepEqual(tree(base, { skip: ["target"] }), {});
});

test("end to end: `sl audit --registry-file` refuses a registry whose agent id is not one file, and writes nothing", async (t) => {
  const { base, targetPath } = await tempBase(t);
  const registryFile = path.join(base, "registry.json");
  const audit = () => runCli(["audit", targetPath, "--registry-file", registryFile, "--dry-run", "--no-session", "--json"], { cwd: base });

  for (const id of ["../../../../outside-entry", "..\\..\\..\\..\\outside-entry", "a/b", "con"]) {
    await fsp.writeFile(registryFile, JSON.stringify({ agents: [{ id, persona: "P", domain: "D" }] }));
    const before = tree(base);
    const refused = await audit();
    assert.notEqual(refused.code, 0, JSON.stringify(id));
    assert.match(refused.stderr + refused.stdout, /Invalid audit registry file: agents\[0\]\.id /, JSON.stringify(id));
    assert.deepEqual(tree(base), before, `nothing was written for ${JSON.stringify(id)}`);
  }

  // Control: a legitimate registry still runs, and writes only under the target.
  await fsp.writeFile(registryFile, JSON.stringify({ agents: [{ id: "custom-domain", persona: "P", domain: "D" }] }));
  const outside = tree(base, { skip: ["target"] });
  const ok = await audit();
  assert.equal(ok.code, 0, ok.stderr || ok.stdout);
  const payload = JSON.parse(ok.stdout);
  assert.ok(payload.selectedAgents.includes("custom-domain"));
  const agentFile = path.join(payload.runDirectory, "agents", "custom-domain.json");
  assert.ok(fs.existsSync(agentFile), agentFile);
  assert.ok(agentFile.startsWith(targetPath + path.sep), agentFile);
  assert.deepEqual(tree(base, { skip: ["target"] }), outside);
});

test("end to end: `sl session kill --agent` reaches the session agent registry only with an id that names one snapshot file", async (t) => {
  const { base, targetPath } = await tempBase(t);
  const session = await createSession({ targetPath, ttlSeconds: 120 });
  const paths = resolveSessionPaths(session.sessionId, { targetPath });
  await registerAgent(session.sessionId, { agentId: "codex-c3d4", model: "codex", role: "coder", targetPath, trackProcessExit: false });
  const bystander = (agentId) =>
    `${JSON.stringify({ sessionId: session.sessionId, agentId, role: "coder", status: "idle", active: true }, null, 2)}\n`;
  // Where each id below would point if it were used as a file name: outside the agents directory
  // for a path-shaped id, inside it for a canonical id that the rule refuses.
  const bystanders = {
    [path.join(paths.sessionDir, "outside.json")]: bystander("outside"),
    [path.join(base, "outside.json")]: bystander("outside"),
    [path.join(paths.agentsDir, ".hidden.json")]: bystander(".hidden"),
    [path.join(paths.agentsDir, "abc..json")]: bystander("abc."),
    [path.join(paths.agentsDir, "...json")]: bystander(".."),
  };
  for (const [file, body] of Object.entries(bystanders)) await fsp.writeFile(file, body);
  const assertBystandersUnchanged = async (label) => {
    for (const [file, body] of Object.entries(bystanders)) assert.equal(await fsp.readFile(file, "utf-8"), body, `${label}: ${file}`);
  };
  const kill = (agentId) =>
    runCli(["session", "kill", "--session", session.sessionId, "--agent", agentId, "--path", targetPath, "--json"], { cwd: base });
  const outside = tree(base, { skip: ["target"] });

  // A path-shaped --agent is not a canonical agent id: the command refuses it before it runs.
  for (const id of ["../outside", "../../../../../outside", "..\\outside"]) {
    const refused = await kill(id);
    assert.notEqual(refused.code, 0, id);
    assert.match(refused.stderr, /is not a canonical agent id/, id);
    await assertBystandersUnchanged(id);
  }
  // A canonical id that cannot name a snapshot file reaches the registry, which refuses it: the
  // agent is not stopped and no snapshot is read or rewritten.
  const ended = await kill("abc.");
  assert.equal(ended.code, 0, ended.stderr || ended.stdout);
  assert.equal(JSON.parse(ended.stdout).results[0].stopped, false);
  await assertBystandersUnchanged("abc.");
  // A leading '.' is refused there too; the command then stops at the lock owner rule
  // (src/session/file-locks.js), which already required a leading letter or digit.
  for (const id of [".hidden", ".."]) {
    const result = await kill(id);
    assert.notEqual(result.code, 0, id);
    assert.match(result.stderr, /agentId must match/, id);
    await assertBystandersUnchanged(id);
  }
  assert.deepEqual(tree(base, { skip: ["target"] }), outside);

  // Control: a registered agent is stopped and its own snapshot marked inactive.
  const ok = await kill("codex-c3d4");
  assert.equal(ok.code, 0, ok.stderr || ok.stdout);
  assert.equal(JSON.parse(ok.stdout).results[0].stopped, true);
  const snapshot = JSON.parse(await fsp.readFile(path.join(paths.agentsDir, "codex-c3d4.json"), "utf-8"));
  assert.equal(snapshot.active, false);
  await assertBystandersUnchanged("control");
});
