import "./setup-env.mjs";
// One identifier, one URL path segment. The CLI puts session, admission, ticket, lease,
// checkpoint, run, token, message, reply, scan and AIdenID ids into API URL paths.
// Each must be encoded as exactly one path segment. Covered here:
//   - urlPathSegment (src/net/url-path.js): what it refuses and what it encodes
//   - the sender: credentialedRequest and checkedTransport refuse a raw URL string whose path has
//     a dot segment in any spelling, before anything is sent
//   - a census of src/: every identifier beside a "/" in a URL path goes through urlPathSegment
//   - the real CLI and the real MCP stdio server against a loopback API that records every path
import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { once } from "node:events";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { requestJson } from "../src/auth/http.js";
import {
  CredentialDestinationRefused,
  CredentialPathRefused,
  checkedTransport,
  credentialedRequest,
  resolveTrustContext,
  userCredential,
} from "../src/auth/credential-destinations.js";
import { urlPathSegment } from "../src/net/url-path.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CLI = path.join(ROOT, "bin", "sl.js");
const API = "http://127.0.0.1:9";
const TOKEN = `sl_user_${"u".repeat(40)}`;
// A session id is refused by name; the local session-store check, where present, may refuse it first.
const SESSION_ID_REFUSED = /sessionId must /;

// ---------------------------------------------------------------- the helper

test("urlPathSegment refuses a value that is not exactly one path segment", () => {
  const refused = [undefined, null, "", ".", "..", "/", "a/b", "../x", "\\", "a\\b", "a\u0000b", "a\nb", "\t", "a\u007f", "a\u0085"];
  for (const value of refused) {
    assert.throws(
      () => urlPathSegment(value, { label: "ticketId" }),
      (error) => error instanceof Error && error.message.startsWith("ticketId must be a single URL path segment"),
      JSON.stringify(value),
    );
  }
});

test("urlPathSegment encodes an accepted value as one segment that URL parsing keeps", () => {
  const accepted = [
    ["sess-1", "sess-1"],
    ["...", "..."],
    [".a", ".a"],
    ["a.", "a."],
    [".well-known", ".well-known"],
    ["%2e", "%252e"],
    ["%2E%2e", "%252E%252e"],
    ["%2e%2e", "%252e%252e"],
    [".%2e", ".%252e"],
    ["a b", "a%20b"],
    ["a?b#c", "a%3Fb%23c"],
    ["\u00e9", "%C3%A9"],
    [42, "42"],
  ];
  for (const [value, encoded] of accepted) {
    const segment = urlPathSegment(value);
    assert.equal(segment, encoded, JSON.stringify(value));
    const { pathname } = new URL(`${API}/api/v1/sessions/${segment}/events`);
    assert.equal(pathname, `/api/v1/sessions/${encoded}/events`, JSON.stringify(value));
    // one decode on the server gives back the value itself: "%2e%2e" stays the literal "%2e%2e"
    assert.equal(decodeURIComponent(pathname.split("/")[4]), String(value));
  }
});

// ---------------------------------------------------------------- the sender

async function apiCredential() {
  const context = await resolveTrustContext({ env: { SENTINELAYER_API_URL: API }, homeDir: os.tmpdir() });
  return userCredential(TOKEN, { context });
}

function recorder() {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    return new Response("{}", { status: 200, headers: { "Content-Type": "application/json" } });
  };
  return { calls, fetchImpl };
}

const DOT_SPELLINGS = [".", "..", "%2e", "%2E", ".%2e", "%2e.", ".%2E", "%2E.", "%2e%2e", "%2E%2E", "%2e%2E"];
const DOT_URLS = [
  ...DOT_SPELLINGS.flatMap((dots) => [
    `${API}/api/v1/sessions/${dots}/admin`,
    `${API}/api/v1/sessions/${dots}`,
    `${API}/api/v1/sessions/sess-1/${dots}?limit=1`,
    `${API}/api/v1/sessions/sess-1/${dots}#top`,
    `${API}/api/v1/sessions\\${dots}\\admin`,
  ]),
  // the URL parser drops tabs and newlines and trims C0 controls and spaces before it reads segments
  `${API}/api/v1/sessions/.\t./admin`,
  `${API}/api/v1/sessions/.\n%2e/admin`,
  `${API}/api/v1/sessions/.. `,
];

test("credentialedRequest refuses a path that is not plain segments, in every spelling, with zero requests", async () => {
  const credential = await apiCredential();
  const { calls, fetchImpl } = recorder();
  for (const url of DOT_URLS) {
    await assert.rejects(
      credentialedRequest(credential, url, {}, { fetchImpl }),
      (error) =>
        error instanceof CredentialPathRefused &&
        error instanceof CredentialDestinationRefused && // callers treat it as final: no retry
        error.code === "CREDENTIAL_PATH_REFUSED" &&
        !error.message.includes(TOKEN),
      JSON.stringify(url),
    );
  }
  assert.deepEqual(calls, []);
});

test("checkedTransport refuses a path that is not plain segments, in every spelling, with zero requests", async () => {
  const credential = await apiCredential();
  const calls = [];
  const send = checkedTransport(async (url) => {
    calls.push(url);
    return {};
  });
  for (const url of DOT_URLS) {
    await assert.rejects(send(url, { method: "GET", credential }), CredentialPathRefused, JSON.stringify(url));
  }
  assert.deepEqual(calls, []);
});

test("requestJson treats the refusal as final: nothing sent, no retry", async () => {
  const credential = await apiCredential();
  const original = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    return new Response("{}", { status: 200, headers: { "Content-Type": "application/json" } });
  };
  try {
    await assert.rejects(
      requestJson(`${API}/api/v1/sessions/../admin`, { credential, maxRetries: 3, retryDelayMs: 1 }),
      CredentialPathRefused,
    );
  } finally {
    globalThis.fetch = original;
  }
  assert.equal(calls, 0);
});

test("credentialedRequest still sends a URL of plain segments, as the exact string", async () => {
  const credential = await apiCredential();
  const sendable = [
    `${API}/api/v1/sessions/sess-1/events`,
    `${API}/api/v1/sessions/sess-1/events?after=../x&limit=1`,
    `${API}/api/v1/sessions/sess-1/events#../x`,
    `${API}/api/v1/sessions/.../events`,
    `${API}/api/v1/sessions/a.b./events`,
    `${API}/.well-known/oauth-protected-resource`,
    `${API}/api/v1/sessions/${urlPathSegment("%2e%2e")}/events`,
  ];
  for (const url of sendable) {
    const { calls, fetchImpl } = recorder();
    await credentialedRequest(credential, url, { method: "GET" }, { fetchImpl });
    assert.equal(calls.length, 1, url);
    assert.equal(calls[0].url, url);
    assert.equal(calls[0].init.headers.Authorization, `Bearer ${TOKEN}`);
  }
});

test("the origin check is unchanged: another origin is refused as a destination", async () => {
  const credential = await apiCredential();
  const { calls, fetchImpl } = recorder();
  for (const url of ["http://127.0.0.2:9/api/v1/sessions/sess-1", "http://127.0.0.2:9/api/v1/sessions/../admin"]) {
    await assert.rejects(
      credentialedRequest(credential, url, {}, { fetchImpl }),
      (error) => error instanceof CredentialDestinationRefused && !(error instanceof CredentialPathRefused),
    );
  }
  assert.deepEqual(calls, []);
});

// ---------------------------------------------------------------- the census

// [rule, pattern]: an identifier beside a "/" in a URL path that does not go through urlPathSegment.
const PATH_RULES = [
  // encodeURIComponent next to a "/" encodes a path segment, and leaves "." and ".." as they are
  ["encoded-after-slash", /\/\$\{\s*encodeURIComponent\(/],
  ["encoded-before-slash", /encodeURIComponent\(.*?\)\s*\}\//],
  ["encoded-concat", /\/["'`]\s*\+\s*encodeURIComponent\(|encodeURIComponent\(.*?\)\s*\+\s*["'`]\//],
  // a value put raw into a versioned API path (/api/v1/..., /v1/...)
  ["api-path-raw", /\/(?:api\/)?v\d+\w*\/[^`]*\/\$\{(?!\s*urlPathSegment\()/],
  ["api-path-concat", /["'`][^"'`]*\/(?:api\/)?v\d+\w*\/[^"'`]*\/["'`]\s*\+(?!\s*urlPathSegment\()/],
];

function sourceFiles(dir = path.join(ROOT, "src")) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(full);
    return entry.name.endsWith(".js") ? [full] : [];
  });
}

const srcFiles = () =>
  sourceFiles().map((full) => ({ file: path.relative(ROOT, full).split(path.sep).join("/"), text: fs.readFileSync(full, "utf8") }));

/** Every rule match in a set of files, comments excepted, as "file:line rule". */
function pathCensus(files) {
  const sites = [];
  for (const { file, text } of files) {
    text.split("\n").forEach((line, index) => {
      const code = line.trim();
      if (code.startsWith("//") || code.startsWith("*") || code.startsWith("/*")) return;
      for (const [rule, re] of PATH_RULES) {
        if (re.test(line)) sites.push(`${file}:${index + 1} ${rule}`);
      }
    });
  }
  return sites;
}

test("census: every identifier in a URL path in src/ goes through urlPathSegment", () => {
  assert.deepEqual(pathCensus(srcFiles()), [], "build the segment with urlPathSegment (src/net/url-path.js)");
});

test("census: catches encodeURIComponent and raw values beside a '/', and nothing else", () => {
  const planted = {
    file: "src/session/new-feature.js",
    text: [
      "const a = `${base}/api/v1/sessions/${encodeURIComponent(id)}/events`;",
      "return ticketsUrl(apiUrl, sid, `/${encodeURIComponent(ticketId)}/claim`);",
      "const b = `${encodeURIComponent(leaseId)}/renew`;",
      'const c = base + "/runs/" + encodeURIComponent(runId);',
      'const d = encodeURIComponent(runId) + "/status";',
      "const e = `${apiUrl}/api/v1/sessions/${sid}/events`;",
      'const pollUrl = apiUrl + "/api/v1/scan/url/" + scanId;',
      "const f = `${apiUrl}/v1/identities/${identityId}/revoke`;",
      // not path segments, or built through the helper
      'const g = `${apiUrl}/api/v1/sessions/${urlPathSegment(sid, { label: "sessionId" })}/events?after=${encodeURIComponent(cursor)}`;',
      "const file = `request-${encodeURIComponent(id)}-${stamp}.json`;",
      'const h = apiUrl + "/api/v1/scan/url/" + urlPathSegment(scanId);',
      "// `${base}/api/v1/sessions/${encodeURIComponent(id)}` in a comment",
    ].join("\n"),
  };
  assert.deepEqual(
    pathCensus([planted]).map((site) => site.replace(/^src\/session\/new-feature\.js:/, "")),
    [
      "1 encoded-after-slash",
      "1 encoded-before-slash",
      "1 api-path-raw",
      "2 encoded-after-slash",
      "2 encoded-before-slash",
      "3 encoded-before-slash",
      "4 encoded-concat",
      "5 encoded-concat",
      "6 api-path-raw",
      "7 api-path-concat",
      "8 api-path-raw",
    ],
  );
});

// ---------------------------------------------------------------- the real CLI and MCP server

async function startRecordingApi() {
  const requests = [];
  const sockets = new Set();
  const server = createServer(async (req, res) => {
    for await (const _chunk of req) {
      // drain
    }
    requests.push(`${req.method} ${req.url}`);
    const text = JSON.stringify(/\/events\/before|\/actions/.test(req.url) ? { events: [], actions: [], count: 0 } : { detail: "not found" });
    res.writeHead(/\/events\/before|\/actions/.test(req.url) ? 200 : 404, {
      "Content-Type": "application/json",
      "Content-Length": Buffer.byteLength(text),
    });
    res.end(text);
  });
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return {
    apiUrl: `http://127.0.0.1:${server.address().port}`,
    requests,
    close: () =>
      new Promise((resolve) => {
        for (const socket of sockets) socket.destroy();
        server.close(resolve);
      }),
  };
}

async function workspace() {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "sl-url-path-"));
  return { dir, close: () => fsp.rm(dir, { recursive: true, force: true }) };
}

function cliEnv(dir, apiUrl) {
  const env = {
    ...process.env,
    HOME: dir,
    USERPROFILE: dir,
    APPDATA: path.join(dir, "AppData", "Roaming"),
    LOCALAPPDATA: path.join(dir, "AppData", "Local"),
    XDG_CONFIG_HOME: path.join(dir, ".config"),
    SENTINELAYER_CIRCUIT_STATE_DIR: path.join(dir, ".sentinelayer"),
    NODE_ENV: "test",
    SENTINELAYER_CLI_TEST_MODE: "1",
    SENTINELAYER_CLI_SKIP_AUTH: "1",
    SENTINELAYER_SKIP_SENTI_AUTOSTART: "1",
    SENTINELAYER_SKIP_REMOTE_SYNC: "0",
    SENTINELAYER_TOKEN: TOKEN,
    SENTINELAYER_API_URL: apiUrl,
  };
  for (const name of ["SENTINELAYER_API_TOKEN", "SENTINELAYER_AGENT_ID", "SENTI_POCKET_URL"]) delete env[name];
  return env;
}

function runCli(args, { dir, apiUrl }) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [CLI, ...args], {
      cwd: dir,
      env: cliEnv(dir, apiUrl),
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => child.kill(), 120_000);
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
  });
}

/** One tools/call through the real `sl mcp server run`; the JSON-RPC response for it. */
async function mcpToolCall(name, args, { dir, apiUrl }) {
  const child = spawn(process.execPath, [CLI, "mcp", "server", "run", "--path", dir], {
    cwd: dir,
    env: cliEnv(dir, apiUrl),
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  });
  const closed = once(child, "close");
  let stdout = "";
  child.stdout.on("data", (chunk) => (stdout += chunk));
  child.stderr.resume();
  child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } })}\n`);
  const deadline = Date.now() + 120_000;
  let response = null;
  while (!response && Date.now() < deadline) {
    for (const line of stdout.split("\n")) {
      try {
        const parsed = JSON.parse(line);
        if (parsed.id === 1) response = parsed;
      } catch {
        // partial line
      }
    }
    if (!response) await new Promise((resolve) => setTimeout(resolve, 50));
  }
  child.stdin.end();
  const timer = setTimeout(() => child.kill(), 10_000);
  await closed;
  clearTimeout(timer);
  return response;
}

test("CLI: `sl session say` with a session id that is not one path segment sends nothing; a real id reaches its own path", async () => {
  const api = await startRecordingApi();
  const ws = await workspace();
  try {
    for (const sessionId of ["..", "."]) {
      const result = await runCli(["session", "say", sessionId, "hello", "--agent", "probe-agent", "--json"], { dir: ws.dir, apiUrl: api.apiUrl });
      assert.notEqual(result.code, 0, `${sessionId}: ${result.stdout}`);
      assert.match(result.stderr, SESSION_ID_REFUSED);
      assert.deepEqual(api.requests, [], `${sessionId}: no request reaches any path`);
    }
    await runCli(["session", "say", "sess-ok", "hello", "--agent", "probe-agent", "--json"], { dir: ws.dir, apiUrl: api.apiUrl });
    assert.ok(api.requests.includes("GET /api/v1/sessions/sess-ok/events?limit=1"), api.requests.join("\n"));
    for (const request of api.requests) assert.match(request, /^[A-Z]+ \/api\/v1\/sessions\/sess-ok\//);
  } finally {
    await api.close();
    await ws.close();
  }
});

test("CLI: `sl session access status` with an admission id that is not one path segment sends nothing; a real id reaches its own path", async () => {
  const api = await startRecordingApi();
  const ws = await workspace();
  try {
    const refused = await runCli(["session", "access", "status", "sess-1", "..", "--json"], { dir: ws.dir, apiUrl: api.apiUrl });
    assert.notEqual(refused.code, 0, refused.stdout);
    assert.match(refused.stderr, /admissionId must be a single URL path segment/);
    assert.deepEqual(api.requests, [], "no request reaches any path");

    await runCli(["session", "access", "status", "sess-1", "adm-1", "--json"], { dir: ws.dir, apiUrl: api.apiUrl });
    assert.ok(api.requests.length > 0);
    for (const request of api.requests) assert.equal(request, "GET /api/v1/sessions/sess-1/admissions/adm-1");
  } finally {
    await api.close();
    await ws.close();
  }
});

test("MCP: read_history with a session id that is not one path segment sends nothing; a real id reaches its own path", async () => {
  const api = await startRecordingApi();
  const ws = await workspace();
  try {
    const refused = await mcpToolCall("read_history", { sessionId: "..", agentId: "codex" }, { dir: ws.dir, apiUrl: api.apiUrl });
    assert.equal(refused?.result?.structuredContent?.ok, false, JSON.stringify(refused));
    assert.match(String(refused.result.structuredContent.reason), SESSION_ID_REFUSED);
    assert.deepEqual(api.requests, [], "no request reaches any path");

    const allowed = await mcpToolCall("read_history", { sessionId: "sess-ok", agentId: "codex" }, { dir: ws.dir, apiUrl: api.apiUrl });
    assert.equal(allowed?.result?.structuredContent?.ok, true, JSON.stringify(allowed));
    assert.ok(api.requests.length > 0);
    for (const request of api.requests) assert.match(request, /^GET \/api\/v1\/sessions\/sess-ok\//);
  } finally {
    await api.close();
    await ws.close();
  }
});
