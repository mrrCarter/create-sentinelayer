import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const cliPath = fileURLToPath(new URL("../bin/create-sentinelayer.js", import.meta.url));
const slowFsPath = new URL("./fixtures/session-start-slow-fs.mjs", import.meta.url).href;

async function fixture(fn) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "sl-start-bounded-"));
  const workspace = path.join(root, "workspace");
  const isolatedHome = path.join(root, "home");
  await fs.mkdir(workspace);
  await fs.mkdir(isolatedHome);
  const env = {
    ...process.env,
    HOME: isolatedHome,
    USERPROFILE: isolatedHome,
    APPDATA: isolatedHome,
    LOCALAPPDATA: isolatedHome,
    XDG_CONFIG_HOME: isolatedHome,
    SENTINELAYER_CIRCUIT_STATE_DIR: path.join(isolatedHome, ".sentinelayer"),
    SENTINELAYER_DISABLE_KEYRING: "1",
    SENTINELAYER_TOKEN: "test_session_start_bounded_not_a_real_credential",
    SENTINELAYER_SKIP_REMOTE_SYNC: "1",
    SENTINELAYER_SKIP_SENTI_AUTOSTART: "0",
  };
  delete env.NODE_OPTIONS;
  delete env.SENTINELAYER_SKIP_FIRST_MESSAGE;
  try { await fn({ workspace, env }); }
  finally { await fs.rm(root, { recursive: true, force: true }); }
}

function runStart(workspace, env, { imports = [], timeoutMs = 6_000, args = null } = {}) {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const child = spawn(process.execPath, [
      ...imports.flatMap((file) => ["--import", file]), cliPath,
      ...(args || ["session", "start", "--title", "Hack Nation Crew", "--no-daemon", "--json"]),
    ], { cwd: workspace, env, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; child.kill(); }, timeoutMs);
    child.stdout.on("data", (data) => { stdout += data; });
    child.stderr.on("data", (data) => { stderr += data; });
    child.once("error", (error) => { clearTimeout(timer); reject(error); });
    child.once("close", (code) => {
      clearTimeout(timer);
      resolve({ stdout, stderr, code, timedOut, elapsedMs: Date.now() - started });
    });
  });
}

test("E2E start: slow optional scan cannot prevent JSON and no-daemon process exit", async () => {
  await fixture(async ({ workspace, env }) => {
    const result = await runStart(workspace, { ...env, SL_TEST_SLOW_CONTEXT_PATH: workspace }, { imports: [slowFsPath] });
    assert.equal(result.timedOut, false, `cold scan blocked startup: stdout bytes=${result.stdout.length}`);
    assert.equal(result.code, 0, result.stderr);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.title, "Hack Nation Crew");
    assert.equal(payload.sentiDaemon.reason, "opt_out");
    assert.equal(payload.firstMessage.posted, true);
    const stored = JSON.parse(await fs.readFile(payload.metadataPath, "utf8"));
    assert.equal(stored.sessionId, payload.sessionId);
  });
});

for (const status of [401, 403, 404, 503]) {
  test(`E2E session probe: ${status} never materializes or joins an inaccessible room`, async () => {
    await fixture(async ({ workspace, env }) => {
      const calls = [];
      const server = http.createServer((req, res) => {
        calls.push({ method: req.method, url: req.url });
        req.resume();
        res.setHeader("Content-Type", "application/json");
        if (req.url.includes("?")) { res.end('{"sessions":[]}'); return; }
        res.writeHead(status);
        res.write('{"error":'); // Denial body must not be awaited or retried.
      });
      await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
      try {
        const result = await runStart(workspace, { ...env, SENTINELAYER_SKIP_REMOTE_SYNC: "0", SENTINELAYER_API_URL: `http://127.0.0.1:${server.address().port}` }, {
          args: ["session", "join", "inaccessible-fixture", "--agent", "fixture-reviewer", "--json"],
        });
        assert.equal(result.timedOut, false);
        assert.notEqual(result.code, 0);
        assert.equal(result.stdout.trim(), "");
        assert.equal(calls.filter((req) => req.method !== "GET").length, 0);
        assert.equal(calls.filter((req) => !req.url.includes("?")).length, status === 503 ? 2 : 1);
        await assert.rejects(fs.access(path.join(workspace, ".sentinelayer", "sessions", "inaccessible-fixture")));
        assert.equal(result.stderr.includes(env.SENTINELAYER_TOKEN), false);
      } finally {
        server.closeAllConnections();
        await new Promise((resolve) => server.close(resolve));
      }
    });
  });
}

test("E2E start: title429 Retry-After cannot delay startup or trigger a retry", async () => {
  await fixture(async ({ workspace, env }) => {
    let titles = 0;
    const server = http.createServer((req, res) => {
      req.resume();
      res.setHeader("Content-Type", "application/json");
      if (req.url.endsWith("/title")) {
        titles += 1;
        res.writeHead(429, { "Retry-After": "3600" });
        res.end('{"error":{"code":"RATE_LIMITED"}}');
        return;
      }
      res.end(JSON.stringify(req.method === "GET" ? { sessions: [] } : { ok: true }));
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const result = await runStart(workspace, { ...env, SENTINELAYER_SKIP_REMOTE_SYNC: "0", SENTINELAYER_API_URL: `http://127.0.0.1:${server.address().port}` });
      assert.equal(result.timedOut, false);
      assert.equal(result.code, 0, result.stderr);
      assert.equal(JSON.parse(result.stdout).titleSync.synced, false);
      assert.equal(titles, 1);
    } finally {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    }
  });
});

test("E2E start: stalled cached context worker is terminated before returning", async () => {
  await fixture(async ({ workspace, env }) => {
    const cachePath = path.join(workspace, ".sentinelayer", "CODEBASE_INGEST.json");
    await fs.mkdir(path.dirname(cachePath));
    await fs.writeFile(cachePath, JSON.stringify({ summary: { filesScanned: 42 } }));
    const result = await runStart(workspace, { ...env, SL_TEST_SLOW_CACHE_PATH: cachePath }, { imports: [slowFsPath] });
    assert.equal(result.timedOut, false);
    assert.equal(result.code, 0, result.stderr);
    const payload = JSON.parse(result.stdout);
    const stored = JSON.parse(await fs.readFile(payload.metadataPath, "utf8"));
    assert.equal(stored.codebaseContext.summary.filesScanned, 0);
    assert.equal(payload.sentiDaemon.reason, "opt_out");
  });
});

for (const stall of ["headers", "body"]) {
  test(`E2E start: bounded resume ${stall} stall retains the existing ID and exits`, async () => {
    await fixture(async ({ workspace, env }) => {
      const first = await runStart(workspace, env);
      assert.equal(first.code, 0, first.stderr);
      const original = JSON.parse(first.stdout);
      const calls = [];
      const server = http.createServer((req, res) => {
        calls.push({ method: req.method, url: req.url });
        req.resume();
        res.setHeader("Content-Type", "application/json");
        if (req.method === "GET" && req.url === `/api/v1/sessions/${original.sessionId}`) {
          if (stall === "body") { res.writeHead(200); res.write('{"session":'); }
          return;
        }
        res.end(JSON.stringify(req.method === "GET" ? { sessions: [] } : { ok: true }));
      });
      await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
      try {
        const result = await runStart(workspace, { ...env, SENTINELAYER_SKIP_REMOTE_SYNC: "0", SENTINELAYER_API_URL: `http://127.0.0.1:${server.address().port}` }, { timeoutMs: 8_000 });
        assert.equal(result.timedOut, false);
        assert.equal(result.code, 0, result.stderr);
        const payload = JSON.parse(result.stdout);
        assert.equal(payload.sessionId, original.sessionId);
        assert.equal(payload.resumed, true);
        assert.equal(payload.staleResume.action, "kept_local_resume");
        assert.match(payload.staleResume.reason, /timeout/);
        assert.equal(calls.filter((req) => req.url === `/api/v1/sessions/${original.sessionId}`).length, 2);
        assert.equal(calls.filter((req) => req.url.endsWith("/events")).length, 0);
        assert.equal((await fs.readdir(path.dirname(payload.sessionDir))).length, 1);
      } finally {
        server.closeAllConnections();
        await new Promise((resolve) => server.close(resolve));
      }
    });
  });
}

test("E2E start: metadata deadline reports degraded instead of claiming publication", async () => {
  await fixture(async ({ workspace, env }) => {
    const server = http.createServer((req, res) => {
      req.resume();
      if (req.url.endsWith("/metadata") || req.url.endsWith("/events")) return;
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify(req.method === "GET" ? { sessions: [] } : { ok: true }));
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const result = await runStart(workspace, { ...env, SENTINELAYER_SKIP_REMOTE_SYNC: "0", SENTINELAYER_API_URL: `http://127.0.0.1:${server.address().port}` });
      assert.equal(result.timedOut, false);
      assert.equal(result.code, 0, result.stderr);
      const payload = JSON.parse(result.stdout);
      assert.equal(payload.remoteSync.status, "degraded");
      assert.equal(payload.remoteSync.metadataSynced, false);
      assert.equal(payload.firstMessage.posted, true); // Local durable welcome only.
      assert.equal(payload.firstMessage.remoteSynced, false);
      assert.equal(payload.firstMessage.remoteSync.synced, false);
    } finally {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    }
  });
});

test("E2E start: incomplete acknowledgement bodies cannot keep process alive after JSON", async () => {
  await fixture(async ({ workspace, env }) => {
    const requests = [];
    const server = http.createServer((req, res) => {
      requests.push({ method: req.method, url: req.url });
      req.resume();
      res.setHeader("Content-Type", "application/json");
      if (req.url.endsWith("/metadata") || req.url.endsWith("/events")) {
        res.writeHead(200);
        res.write('{"ok":'); // Deliberately never end this response.
      } else {
        res.end(JSON.stringify(req.method === "GET" ? { sessions: [] } : { ok: true }));
      }
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const result = await runStart(workspace, { ...env, SENTINELAYER_SKIP_REMOTE_SYNC: "0", SENTINELAYER_API_URL: `http://127.0.0.1:${server.address().port}` });
      assert.equal(result.timedOut, false, `unread response kept process alive; JSON emitted=${result.stdout.trim().startsWith("{")}`);
      assert.equal(result.code, 0, result.stderr);
      const payload = JSON.parse(result.stdout);
      assert.equal(payload.title, "Hack Nation Crew");
      assert.equal(payload.firstMessage.posted, true);
      assert.equal(payload.firstMessage.remoteSynced, true);
      assert.equal(requests.filter((req) => req.url.endsWith("/events")).length, 1);
      assert.equal(requests.filter((req) => req.url.endsWith("/metadata")).length, 1);
    } finally {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    }
  });
});
