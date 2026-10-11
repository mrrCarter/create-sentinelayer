import "./setup-env.mjs";
// A session id names exactly one directory directly under <target>/.sentinelayer/sessions/.
// Every legitimate id shape resolves there; any other id is refused before a file is read or
// written, through every exported resolver and every other place that builds a path from an id.
import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs";
import fsp from "node:fs/promises";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { writeStoredSession } from "../src/auth/session-store.js";
import {
  normalizeListenerProcessKey,
  readGlobalListenerPidRecord,
  removeListenerPidRecord,
  resolveGlobalListenerPidPath,
  writeListenerPidRecord,
} from "../src/session/listener-process.js";
import {
  SESSION_ID_RESERVED_RULE,
  SESSION_ID_RULE,
  SESSION_ID_SEGMENT_RULE,
  isValidSessionId,
  normalizeSessionId,
  resolveSessionChildDir,
  resolveSessionDir,
  resolveSessionPaths,
  resolveSessionsRoot,
} from "../src/session/paths.js";
import { createSession, getSession, listActiveSessions, listAllSessions } from "../src/session/store.js";
import { appendToStream, readStream } from "../src/session/stream.js";

const CLI = fileURLToPath(new URL("../bin/sl.js", import.meta.url));

// Every shape a real id takes (local, API, billing, chat and test-fixture ids).
const LEGITIMATE_IDS = [
  "4f9c2e1a-7b3d-4c5e-9f00-112233445566", // randomUUID() in createSession, and API ids
  "4F9C2E1A-7B3D-4C5E-9F00-112233445566",
  "omargate-1785093835211-26a3127c-infrastructure-swarm-10-ai", // billing ids derived from run ids
  "review-20261010-123456-1a2b3c4d-ai",
  "scan-ai-precheck",
  "20261010-123456-k3j9x2", // `sl chat ask` ids
  "sess-web-abcdef0123456789",
  "sess_persist_1",
  "6cf7e861",
  "s",
  "a.b",
  "a..b",
  "x".repeat(128),
  `${"x".repeat(127)}_`,
  "ends-with-dash-",
  // close to a device name, but not one
  "console",
  "con-1",
  "nul_x",
  "com0",
  "com10",
  "lpt",
  "auxiliary",
];

// Ids that are not one path segment: the one-directory check refuses them on its own.
const PATH_SHAPED_IDS = [".", "..", "../x", "..\\x", "a/../../b", "a/b", "a\\b", "/tmp/x", "C:\\x", "\\\\server\\share", "a/.."];
// Ids that are one segment but outside the allowlist.
const OUTSIDE_ALLOWLIST_IDS = ["C:x", "a:b", "a\0b", ".hidden", "-x", "_x", "a b", "a/", "x".repeat(129)];
// Ids ending with '.': Windows drops it, so "abc." and "abc" would name the same directory.
const TRAILING_DOT_IDS = ["abc.", "a.", "a..", "sess-1.", `${"x".repeat(127)}.`];
// Windows device names, any case, with or without an extension.
const RESERVED_IDS = ["con", "CON", "Prn", "aux", "nul", "NUL.txt", "nul.tar.gz", "com1", "COM9", "com1.log", "lpt1", "LPT9.json"];
const HOSTILE_IDS = [...PATH_SHAPED_IDS, ...OUTSIDE_ALLOWLIST_IDS, ...TRAILING_DOT_IDS, ...RESERVED_IDS];

async function tempTarget(t) {
  const base = await fsp.mkdtemp(path.join(os.tmpdir(), "sl-session-id-paths-"));
  t.after(() => fsp.rm(base, { recursive: true, force: true }));
  const targetPath = path.join(base, "target");
  await fsp.mkdir(targetPath, { recursive: true });
  return { base, targetPath, root: resolveSessionsRoot({ targetPath }) };
}

// Every file and directory under `dir`, as paths relative to it.
function tree(dir) {
  const out = [];
  const walk = (current) => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      out.push(path.relative(dir, full));
      if (entry.isDirectory()) walk(full);
    }
  };
  walk(dir);
  return out.sort();
}

test("every legitimate id shape resolves to one directory directly under the sessions root", async (t) => {
  const { targetPath, root } = await tempTarget(t);
  for (const id of LEGITIMATE_IDS) {
    assert.equal(isValidSessionId(id), true, id);
    assert.equal(normalizeSessionId(id), id);
    assert.equal(normalizeSessionId(`  ${id}\n`), id, "surrounding whitespace is trimmed, as before");
    const dir = resolveSessionDir(id, { targetPath });
    assert.equal(path.dirname(dir), root, id);
    assert.equal(path.basename(dir), id);
    assert.equal(resolveSessionChildDir(root, id), dir);
    const paths = resolveSessionPaths(id, { targetPath });
    assert.equal(paths.sessionId, id);
    assert.equal(paths.sessionDir, dir);
    assert.equal(path.dirname(paths.metadataPath), dir);
    assert.equal(path.dirname(paths.agentsDir), dir);
  }
});

test("a path-shaped id is refused by the one-directory check, through every exported resolver", async (t) => {
  const { base, targetPath, root } = await tempTarget(t);
  for (const id of PATH_SHAPED_IDS) {
    assert.equal(isValidSessionId(id), false, id);
    assert.throws(() => resolveSessionDir(id, { targetPath }), { message: SESSION_ID_SEGMENT_RULE }, id);
    assert.throws(() => resolveSessionPaths(id, { targetPath }), { message: SESSION_ID_SEGMENT_RULE }, id);
    assert.throws(() => resolveSessionChildDir(root, id), { message: SESSION_ID_SEGMENT_RULE }, id);
    assert.throws(() => normalizeSessionId(id), { message: SESSION_ID_RULE }, id);
  }
  assert.deepEqual(tree(base), ["target"], "nothing was created");
});

test("a one-segment id outside the allowlist is refused, through every exported resolver", async (t) => {
  const { base, targetPath, root } = await tempTarget(t);
  for (const id of OUTSIDE_ALLOWLIST_IDS) {
    assert.equal(isValidSessionId(id), false, JSON.stringify(id));
    assert.throws(() => resolveSessionDir(id, { targetPath }), { message: SESSION_ID_RULE }, JSON.stringify(id));
    assert.throws(() => resolveSessionPaths(id, { targetPath }), { message: SESSION_ID_RULE }, JSON.stringify(id));
    assert.throws(() => resolveSessionChildDir(root, id), { message: SESSION_ID_RULE }, JSON.stringify(id));
    assert.throws(() => normalizeSessionId(id), { message: SESSION_ID_RULE }, JSON.stringify(id));
  }
  for (const empty of ["", "   ", null, undefined]) {
    assert.throws(() => resolveSessionDir(empty, { targetPath }), { message: "sessionId is required." });
  }
  assert.deepEqual(tree(base), ["target"], "nothing was created");
});

test("an id ending with '.' is refused, through every exported resolver", async (t) => {
  const { base, targetPath, root } = await tempTarget(t);
  for (const id of TRAILING_DOT_IDS) {
    assert.equal(isValidSessionId(id), false, id);
    assert.throws(() => resolveSessionDir(id, { targetPath }), { message: SESSION_ID_RULE }, id);
    assert.throws(() => resolveSessionPaths(id, { targetPath }), { message: SESSION_ID_RULE }, id);
    assert.throws(() => resolveSessionChildDir(root, id), { message: SESSION_ID_RULE }, id);
    assert.throws(() => normalizeSessionId(id), { message: SESSION_ID_RULE }, id);
  }
  assert.deepEqual(tree(base), ["target"], "nothing was created");
});

test("a reserved device name is refused on every platform, through every exported resolver", async (t) => {
  const { base, targetPath, root } = await tempTarget(t);
  for (const id of RESERVED_IDS) {
    assert.equal(isValidSessionId(id), false, id);
    assert.throws(() => resolveSessionDir(id, { targetPath }), { message: SESSION_ID_RESERVED_RULE }, id);
    assert.throws(() => resolveSessionPaths(id, { targetPath }), { message: SESSION_ID_RESERVED_RULE }, id);
    assert.throws(() => resolveSessionChildDir(root, id), { message: SESSION_ID_RESERVED_RULE }, id);
    assert.throws(() => normalizeSessionId(id), { message: SESSION_ID_RESERVED_RULE }, id);
  }
  assert.deepEqual(tree(base), ["target"], "nothing was created");
});

test("end to end: the real session store refuses a hostile id before any file is read or written", async (t) => {
  const { base, targetPath, root } = await tempTarget(t);
  // A real session in another workspace, next to the target.
  const otherPath = path.join(base, "other");
  await fsp.mkdir(otherPath, { recursive: true });
  await createSession({ targetPath: otherPath, sessionId: "s1" });
  await appendToStream("s1", { event: "session_message", agent: { id: "a1" }, payload: { message: "hello" } }, {
    targetPath: otherPath,
    syncRemote: false,
  });
  const otherDir = resolveSessionDir("s1", { targetPath: otherPath });
  const toOther = path.relative(root, otherDir); // ../../../other/.sentinelayer/sessions/s1
  assert.ok(toOther.startsWith(".."), toOther);
  const before = tree(base);
  const otherStream = await fsp.readFile(path.join(otherDir, "stream.ndjson"));
  const otherMetadata = await fsp.readFile(path.join(otherDir, "metadata.json"));

  const event = { event: "session_message", agent: { id: "a2" }, payload: { message: "elsewhere" } };
  for (const id of [toOther, toOther.split(path.sep).join("/"), otherDir]) {
    await assert.rejects(appendToStream(id, event, { targetPath, syncRemote: false }), { message: SESSION_ID_SEGMENT_RULE }, id);
    await assert.rejects(readStream(id, { targetPath }), { message: SESSION_ID_SEGMENT_RULE }, id);
    await assert.rejects(getSession(id, { targetPath }), { message: SESSION_ID_SEGMENT_RULE }, id);
  }
  for (const id of HOSTILE_IDS) {
    await assert.rejects(createSession({ targetPath, sessionId: id }), Error, JSON.stringify(id));
    await assert.rejects(appendToStream(id, event, { targetPath, syncRemote: false }), Error, JSON.stringify(id));
  }

  assert.deepEqual(tree(base), before, "no file or directory was created anywhere");
  assert.deepEqual(await fsp.readFile(path.join(otherDir, "stream.ndjson")), otherStream, "the other session's stream is unchanged");
  assert.deepEqual(await fsp.readFile(path.join(otherDir, "metadata.json")), otherMetadata, "the other session's metadata is unchanged");
});

test("listing skips directories under the sessions root that are not session ids", async (t) => {
  const { targetPath, root } = await tempTarget(t);
  await createSession({ targetPath, sessionId: "kept-1" });
  const metadataPath = resolveSessionPaths("kept-1", { targetPath }).metadataPath;
  for (const stray of [".tmp", "a b", "_x"]) {
    await fsp.mkdir(path.join(root, stray), { recursive: true });
    await fsp.copyFile(metadataPath, path.join(root, stray, "metadata.json"));
  }
  assert.deepEqual((await listActiveSessions({ targetPath })).map((session) => session.sessionId), ["kept-1"]);
  assert.deepEqual((await listAllSessions({ targetPath })).map((session) => session.sessionId), ["kept-1"]);
});

// ---------------------------------------------------------------------------------------------
// Other places that build a path from a session id.

test("the global listener pid record is held to the session-id rule", async (t) => {
  const { base, targetPath } = await tempTarget(t);
  const homeDir = path.join(base, "home");
  const stateDir = path.join(homeDir, ".sentinelayer");
  await fsp.mkdir(stateDir, { recursive: true });
  // A file already in <home>/.sentinelayer must be left exactly as it is.
  const credentials = path.join(stateDir, "credentials.json");
  const credentialBytes = Buffer.from(JSON.stringify({ pid: process.pid, token: "stored-token-0000" }));
  await fsp.writeFile(credentials, credentialBytes);
  const before = tree(base);

  // Legitimate ids keep the existing layout: session-listeners/<listener key of the id>/<agent key>.json.
  const listenersRoot = path.join(stateDir, "session-listeners");
  for (const id of LEGITIMATE_IDS) {
    const pidPath = resolveGlobalListenerPidPath(id, "Agent-A", { homeDir });
    assert.equal(pidPath, path.join(listenersRoot, normalizeListenerProcessKey(id), "agent-a.json"), id);
  }

  for (const id of HOSTILE_IDS) {
    const label = JSON.stringify(id);
    assert.throws(() => resolveGlobalListenerPidPath(id, "credentials", { homeDir }), Error, label);
    await assert.rejects(readGlobalListenerPidRecord(id, "credentials", { homeDir }), Error, label);
    await assert.rejects(writeListenerPidRecord(id, "credentials", { targetPath, homeDir, pid: process.pid }), Error, label);
    await assert.rejects(removeListenerPidRecord(id, "credentials", { targetPath, homeDir }), Error, label);
  }
  assert.deepEqual(tree(base), before, "nothing was created");
  assert.deepEqual(await fsp.readFile(credentials), credentialBytes, "the credentials file is unchanged");
});

function runCli(args, { cwd, env }) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CLI, ...args], { cwd, env, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

test("end to end: `sl chat ask --session-id` refuses an id that is not one transcript file under chat/sessions", async (t) => {
  const { base, targetPath } = await tempTarget(t);
  const ask = (sessionId) =>
    runCli(["chat", "ask", "--prompt", "hello", "--dry-run", "--no-stream", "--json", "--path", targetPath, "--session-id", sessionId], {
      cwd: targetPath,
      // the same CLI test-mode environment as the chat test in tests/e2e.test.mjs
      env: {
        ...process.env,
        NODE_ENV: "test",
        SENTINELAYER_CLI_TEST_MODE: "1",
        SENTINELAYER_CLI_TEST_BYPASS_NONCE: "e2e-bypass-nonce",
        SENTINELAYER_CLI_SKIP_AUTH: "1",
        SENTINELAYER_TOKEN: "api_token_e2e_test_session",
      },
    });

  // Control: a legitimate id writes its transcript under chat/sessions/.
  const ok = await ask("chat-ok-1");
  assert.equal(ok.code, 0, ok.stderr || ok.stdout);
  const transcriptPath = JSON.parse(ok.stdout).transcriptPath;
  assert.equal(path.basename(transcriptPath), "chat-ok-1.jsonl");
  assert.equal(path.basename(path.dirname(transcriptPath)), "sessions");
  assert.ok(transcriptPath.startsWith(targetPath + path.sep), transcriptPath);
  assert.ok(fs.existsSync(transcriptPath));
  const before = tree(base);

  for (const id of ["../../../escape", "..\\..\\..\\escape", "a/b"]) {
    const refused = await ask(id);
    assert.notEqual(refused.code, 0, id);
    assert.match(refused.stderr + refused.stdout, /sessionId must be 1-128 characters/, id);
  }
  assert.deepEqual(tree(base), before, "no transcript was written anywhere");
});

// A loopback API that records every request and answers the session-event routes the native
// session tools use: an event posted to a session becomes visible in that session's reads.
async function startSessionApi(t) {
  const requests = [];
  const events = new Map();
  const server = createServer(async (req, res) => {
    let body = "";
    for await (const chunk of req) body += chunk;
    requests.push({ method: req.method, url: req.url });
    const match = /^\/api\/v1\/sessions\/([^/?]+)\/events(\/before)?(?:\?|$)/.exec(req.url);
    res.writeHead(match ? 200 : 404, { "Content-Type": "application/json" });
    if (!match) return res.end("{}");
    const stored = events.get(match[1]) || [];
    events.set(match[1], stored);
    if (req.method === "POST") {
      const event = JSON.parse(body || "{}").event || {};
      stored.push({ ...event, sequenceId: stored.length + 1, cursor: `c${stored.length + 1}` });
      return res.end("{}");
    }
    return res.end(JSON.stringify({ events: stored, nextCursor: stored.at(-1)?.cursor || null }));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => new Promise((resolve) => server.close(resolve)));
  return { url: `http://127.0.0.1:${server.address().port}`, requests };
}

// Starts the real `sl mcp server run`, sends the messages, and returns the responses by id.
async function mcpExchange({ ws, env }, messages) {
  const child = spawn(process.execPath, [CLI, "mcp", "server", "run", "--path", ws], {
    cwd: ws,
    env,
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => (stdout += chunk));
  child.stderr.on("data", (chunk) => (stderr += chunk));
  const closed = new Promise((resolve) => child.on("close", resolve));
  for (const message of messages) child.stdin.write(`${JSON.stringify(message)}\n`);
  child.stdin.end();
  const code = await closed;
  assert.equal(code, 0, stderr);
  return new Map(
    stdout
      .split("\n")
      .filter((line) => line.trim())
      .map((line) => JSON.parse(line))
      .map((response) => [response.id, response]),
  );
}

const toolPayload = (response) => JSON.parse(response.result.content[0].text);

test("end to end: the real MCP stdio server refuses native session tools given a hostile sessionId", async (t) => {
  const base = await fsp.mkdtemp(path.join(os.tmpdir(), "sl-session-id-mcp-"));
  t.after(() => fsp.rm(base, { recursive: true, force: true }));
  const home = path.join(base, "home");
  const ws = path.join(base, "workspace");
  await fsp.mkdir(home, { recursive: true });
  await fsp.mkdir(ws, { recursive: true });
  const api = await startSessionApi(t);
  await writeStoredSession(
    { apiUrl: api.url, token: "session-id-mcp-token-0000", tokenExpiresAt: new Date(Date.now() + 86400_000).toISOString() },
    { homeDir: home },
  );
  const env = {
    ...process.env,
    HOME: home,
    USERPROFILE: home,
    APPDATA: path.join(home, "AppData", "Roaming"),
    LOCALAPPDATA: path.join(home, "AppData", "Local"),
    XDG_CONFIG_HOME: path.join(home, ".config"),
    SENTINELAYER_CIRCUIT_STATE_DIR: path.join(home, ".sentinelayer"),
    SENTINELAYER_API_URL: api.url,
  };
  // Remote sync on, against the loopback API above (the egress guard still refuses any other host).
  for (const name of ["SENTINELAYER_SKIP_REMOTE_SYNC", "SENTINELAYER_TOKEN", "SENTINELAYER_API_TOKEN", "SENTINELAYER_AGENT_ID"]) {
    delete env[name];
  }

  // A session inside the root, and a session-shaped directory just outside it, at
  // <ws>/.sentinelayer/escape, which is where "../escape" resolves from the sessions root.
  const root = resolveSessionsRoot({ targetPath: ws });
  await createSession({ targetPath: ws, sessionId: "s-ok" });
  const scratch = path.join(base, "scratch");
  await fsp.mkdir(scratch, { recursive: true });
  await createSession({ targetPath: scratch, sessionId: "escape" });
  const escapeDir = path.join(ws, ".sentinelayer", "escape");
  await fsp.cp(resolveSessionDir("escape", { targetPath: scratch }), escapeDir, { recursive: true });
  const hostile = "../escape";
  assert.equal(path.join(root, hostile), escapeDir);

  // Every file and directory outside the sessions root (the server's own state under home aside),
  // with file contents.
  const outside = () =>
    tree(base)
      .map((entry) => path.join(base, entry))
      .filter((full) => !(full + path.sep).startsWith(home + path.sep))
      .filter((full) => !(full + path.sep).startsWith(root + path.sep))
      .map((full) => (fs.statSync(full).isFile() ? `${full} ${fs.readFileSync(full, "base64")}` : full));
  const before = outside();

  const call = (id, name, args) => ({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } });
  const responses = await mcpExchange({ ws, env }, [
    { jsonrpc: "2.0", id: 1, method: "initialize", params: {} },
    // Control: a legitimate id goes through the API and lands in the local session stream.
    call(2, "send_message", { sessionId: "s-ok", agentId: "agent-a", message: "inside the root" }),
    call(3, "send_message", { sessionId: hostile, agentId: "agent-a", message: "outside the root" }),
    call(4, "attention_request", { sessionId: hostile, agentId: "agent-a", message: "outside the root" }),
    call(5, "poll_inbox", { sessionId: hostile, agentId: "agent-a" }),
    call(6, "read_history", { sessionId: hostile }),
    call(7, "session_react", { sessionId: hostile, agentId: "agent-a", reaction: "ack", targetSequenceId: 1 }),
    call(8, "session_lock", { sessionId: hostile, agentId: "agent-a", files: ["README.md"] }),
    call(9, "session_locks", { session_id: hostile }),
  ]);

  const control = toolPayload(responses.get(2));
  assert.equal(control.ok, true, JSON.stringify(control));
  assert.equal(control.localCache.cached, true, JSON.stringify(control.localCache));
  assert.match(await fsp.readFile(path.join(root, "s-ok", "stream.ndjson"), "utf8"), /inside the root/);

  for (const id of [3, 4, 5, 6, 7, 8, 9]) {
    const payload = toolPayload(responses.get(id));
    assert.equal(responses.get(id).result.isError, true, `call ${id}`);
    assert.equal(payload.reason, SESSION_ID_SEGMENT_RULE, `call ${id}: ${JSON.stringify(payload)}`);
  }
  assert.ok(api.requests.length > 0, "the control call reached the API");
  assert.deepEqual(
    api.requests.filter((request) => !request.url.startsWith("/api/v1/sessions/s-ok/")),
    [],
    "no request was sent for the hostile id",
  );
  assert.deepEqual(outside(), before, "nothing outside the sessions root was created or changed");
});
