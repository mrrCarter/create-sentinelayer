import "./setup-env.mjs";
// One identifier, one URL path segment. The CLI puts session, admission, ticket, lease,
// checkpoint, run, token, message, reply, scan and AIdenID ids into API URL paths.
// Each must be encoded as exactly one path segment. Covered here:
//   - urlPathSegment and isUrlPathSegment (src/net/url-path.js): what they refuse and encode
//   - the URL builders that take raw ids (tickets, admissions, file leases, message edits), through
//     their public functions with a recording transport
//   - a refused message-edit id never counts against the outbound breaker
//   - the sender: credentialedRequest and checkedTransport take a URL string only, and refuse one
//     whose path is not plain segments, in every spelling, before anything is sent
//   - a census of src/ (the rules it applies are listed with it, below)
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
import { isUrlPathSegment, urlPathSegment } from "../src/net/url-path.js";
import { CLAIM_DOMAIN, runAdmissionJoin } from "../src/session/admission.js";
import { lockFile } from "../src/session/file-locks.js";
import { __resetCircuitStateForTests, editSessionMessage } from "../src/session/sync.js";
import { claimTicket } from "../src/session/tickets.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CLI = path.join(ROOT, "bin", "sl.js");
const API = "http://127.0.0.1:9";
const TOKEN = `sl_user_${"u".repeat(40)}`;
// The in-process request functions below bind the test token to the configured API.
process.env.SENTINELAYER_API_URL = API;
const fakeAuth = async () => ({ token: TOKEN, apiUrl: API });
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

test("isUrlPathSegment answers exactly what urlPathSegment accepts, unpaired surrogates included", () => {
  const unpaired = `a${String.fromCharCode(0xd800)}b`;
  for (const value of [undefined, "", ".", "..", "a/b", "a\\b", "a\nb", unpaired]) {
    assert.equal(isUrlPathSegment(value), false, JSON.stringify(value));
    assert.throws(() => urlPathSegment(value), /must be a single URL path segment/);
  }
  for (const value of ["sess-1", "...", "%2e%2e", "a?b", 42]) {
    assert.equal(isUrlPathSegment(value), true, JSON.stringify(value));
    assert.doesNotThrow(() => urlPathSegment(value));
  }
});

// ---------------------------------------------------------------- the URL builders that take raw ids

async function tempDir(prefix) {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), prefix));
  return { dir, close: () => fsp.rm(dir, { recursive: true, force: true }) };
}

test("tickets: the ticket id is encoded by the URL builder (claim)", async () => {
  const tmp = await tempDir("sl-url-ticket-");
  const urls = [];
  const requestMutation = async (url) => {
    urls.push(url);
    return { version: 3, ticket: { lease: { holderKind: "human", holder: "me" } }, lease: { leaseId: "l-1", fence: 1, expiresAt: null } };
  };
  try {
    const options = { identity: "human", homeDir: tmp.dir, targetPath: tmp.dir, resolveAuthSession: fakeAuth, requestMutation };
    await claimTicket("sess-1", "T:1", options);
    assert.deepEqual(urls, [`${API}/api/v1/sessions/sess-1/tickets/T%3A1/claim`]);
    // an id that is not one segment is refused before any request
    await assert.rejects(claimTicket("sess-1", "a/b", options));
    assert.equal(urls.length, 1);
  } finally {
    await tmp.close();
  }
});

test("file leases: a lease id from the server that is not one segment is never put in a URL", async () => {
  const tmp = await tempDir("sl-url-lease-");
  const calls = [];
  const requestMutation = async (url, { body }) => {
    calls.push(url);
    // acquire: the server answers with a lease id that is not one path segment
    return { ok: true, authoritative: true, lease: { leaseId: "a/b", path: body.path, holderId: body.holderId, ttlSeconds: 300, revision: 1 } };
  };
  try {
    await fsp.writeFile(path.join(tmp.dir, "package.json"), "{}\n");
    await assert.rejects(
      lockFile("sess-1", "codex", "src/one.js", { targetPath: tmp.dir, resolveAuthSession: fakeAuth, requestMutation }),
      /edit blocked/,
    );
    // the acquire only: the compensating release for "a/b" was refused before it was sent
    assert.deepEqual(calls, [`${API}/api/v1/sessions/sess-1/file-leases`]);
  } finally {
    await tmp.close();
  }
});

/** A fake admission API: the server picks the admission id; every request URL is recorded. */
function admissionApi(admissionId) {
  const urls = [];
  let publicKey = null;
  const requestMutation = async (url, { body }) => {
    urls.push(url);
    if (url.endsWith("/admissions")) {
      publicKey = body.publicKey;
      return { admissionId, status: "pending" };
    }
    return {
      admissionId,
      status: "active",
      credential: { token: `sladm_${"S".repeat(43)}` },
      grant: { expiresAt: Math.floor(Date.now() / 1000) + 3600, actions: ["read"] },
      identity: { subject: "sl-agent:u/codex", passportId: "pid" },
    };
  };
  const requestRead = async (url) => {
    urls.push(url);
    return {
      status: "approved",
      claim: { domain: CLAIM_DOMAIN, preimage: { admissionId, sessionId: "sess-1", agentId: "codex", publicKey, keyThumbprint: "t", nonce: "n" } },
    };
  };
  return { urls, requestMutation, requestRead };
}

async function joinWith(api, tmp) {
  return runAdmissionJoin("sess-1", {
    agentId: "codex",
    goal: "check the URL builders",
    targetPath: tmp.dir,
    homeDir: tmp.dir,
    resolveAuthSession: fakeAuth,
    requestMutation: api.requestMutation,
    requestRead: api.requestRead,
    sleep: async () => {},
  });
}

test("admissions: the admission id from the server is encoded by the URL builder (poll and claim)", async () => {
  const tmp = await tempDir("sl-url-admission-");
  try {
    const api = admissionApi("adm?x");
    const result = await joinWith(api, tmp);
    assert.equal(result.status, "active");
    const admissions = `${API}/api/v1/sessions/sess-1/admissions`;
    assert.deepEqual(api.urls, [admissions, `${admissions}/adm%3Fx`, `${admissions}/adm%3Fx/claim`]);
  } finally {
    await tmp.close();
  }
});

test("admissions: an admission id from the server that is not one segment stops before the poll", async () => {
  const tmp = await tempDir("sl-url-admission-bad-");
  try {
    const api = admissionApi("a/b");
    await assert.rejects(joinWith(api, tmp), /admissionId must be a single URL path segment/);
    assert.deepEqual(api.urls, [`${API}/api/v1/sessions/sess-1/admissions`]);
  } finally {
    await tmp.close();
  }
});

test("message edits: refused ids send nothing and never open the outbound breaker; the next edit is sent", async () => {
  const previous = process.env.SENTINELAYER_SKIP_REMOTE_SYNC;
  process.env.SENTINELAYER_SKIP_REMOTE_SYNC = "0";
  __resetCircuitStateForTests();
  const calls = [];
  const json = (payload) => new Response(JSON.stringify(payload), { status: 200, headers: { "Content-Type": "application/json" } });
  const fetchImpl = async (url, options) => {
    calls.push(`${options.method} ${url}`);
    if (options.method === "GET") return json({ ok: true, event: { id: "..", messageRevision: 1 } });
    return json({ ok: true, changed: true, replayed: false, event: { id: "m-1", messageRevision: 2 }, reply: null, notification: null });
  };
  const edit = (sessionId, target) => editSessionMessage(sessionId, { text: "replacement", resolveAuthSession: fakeAuth, fetchImpl, ...target });
  try {
    // well above the breaker threshold (3), each refused before the request try
    for (let attempt = 0; attempt < 5; attempt += 1) {
      for (const [sessionId, target] of [
        ["..", { targetMessageId: "m-1", expectedRevision: 1 }],
        ["sess-1", { targetMessageId: "..", expectedRevision: 1 }],
        ["sess-1", { targetMessageId: "a/b", expectedRevision: 1 }],
        ["sess-1", { targetActionId: "..", expectedRevision: 1 }],
      ]) {
        assert.deepEqual(await edit(sessionId, target), { ok: false, reason: "invalid_input" }, JSON.stringify(target));
      }
    }
    assert.deepEqual(calls, []);
    // a message id from the lookup that is not one segment ends the edit without a PATCH or a breaker count
    for (let attempt = 0; attempt < 5; attempt += 1) {
      assert.deepEqual(await edit("sess-1", { targetSequenceId: 42 }), { ok: false, reason: "invalid_edit_target" });
    }
    assert.equal(calls.length, 5);
    assert.ok(calls.every((call) => call === `GET ${API}/api/v1/sessions/sess-1/messages/by-sequence/42`));
    // the breaker is still closed: the next legitimate edit is sent
    const sent = await edit("sess-1", { targetMessageId: "m-1", expectedRevision: 1 });
    assert.equal(sent.ok, true, JSON.stringify(sent));
    assert.equal(calls.at(-1), `PATCH ${API}/api/v1/sessions/sess-1/messages/m-1`);
  } finally {
    process.env.SENTINELAYER_SKIP_REMOTE_SYNC = previous;
    __resetCircuitStateForTests();
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
// one decode gives "/" or "\" inside the segment, or the segment does not decode
const ENCODED_SPELLINGS = ["..%2f", "..%2F", "%2e%2e%2f", "%2E%2E%2F", "..%5c", "..%5C", "%2e%2e%5c", "a%2Fb", "%2f", "%5C", "%zz", "%C3", "%"];
const DOT_URLS = [
  ...DOT_SPELLINGS.flatMap((dots) => [
    `${API}/api/v1/sessions/${dots}/admin`,
    `${API}/api/v1/sessions/${dots}`,
    `${API}/api/v1/sessions/sess-1/${dots}?limit=1`,
    `${API}/api/v1/sessions/sess-1/${dots}#top`,
    `${API}/api/v1/sessions\\${dots}\\admin`,
  ]),
  ...ENCODED_SPELLINGS.flatMap((segment) => [
    `${API}/api/v1/sessions/${segment}/events`,
    `${API}/api/v1/sessions/sess-1/${segment}`,
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
    `${API}/api/v1/sessions/${urlPathSegment("%2F")}/events`,
    `${API}/api/v1/sessions/${urlPathSegment("a b:c")}/events`,
    `${API}/api/v1/sessions/%C3%A9/events`,
    `${API}/api/v1/sessions/sess-1/events?path=a%2Fb&x=%zz`,
  ];
  for (const url of sendable) {
    const { calls, fetchImpl } = recorder();
    await credentialedRequest(credential, url, { method: "GET" }, { fetchImpl });
    assert.equal(calls.length, 1, url);
    assert.equal(calls[0].url, url);
    assert.equal(calls[0].init.headers.Authorization, `Bearer ${TOKEN}`);
  }
});

test("the sender takes the URL as a string: a URL object (already normalized) or other object is refused", async () => {
  const credential = await apiCredential();
  const { calls, fetchImpl } = recorder();
  const transportCalls = [];
  const send = checkedTransport(async (url) => {
    transportCalls.push(url);
    return {};
  });
  const objects = [
    new URL(`${API}/api/v1/sessions/sess-1/events`),
    new URL(`${API}/api/v1/sessions/../admin`), // its path is already /api/v1/admin
    { toString: () => `${API}/api/v1/sessions/sess-1/events` },
  ];
  const refusedAsObject = (error) => error instanceof TypeError && /takes its URL as a string/.test(error.message);
  for (const url of objects) {
    await assert.rejects(credentialedRequest(credential, url, {}, { fetchImpl }), refusedAsObject);
    await assert.rejects(send(url, { method: "GET", credential }), refusedAsObject);
    await assert.rejects(requestJson(url, { credential, maxRetries: 3, retryDelayMs: 1 }), refusedAsObject);
  }
  assert.deepEqual(calls, []);
  assert.deepEqual(transportCalls, []);
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
//
// What the census checks, exactly. It reads src/**/*.js line by line, comments skipped.
//
// In every file:
//   - encodeURIComponent next to a "/" (template or "+" concatenation, either side): a path
//     segment must be built with urlPathSegment instead
//   - in a line with a versioned API path (/api/vN/... or /vN/...): a "/${...}" that is not
//     urlPathSegment(...), or a '".../" + value' that is not urlPathSegment(...)
//
// In every file that sends a request (it calls fetch, fetchImpl, credentialedRequest,
// checkedTransport, requestJson, requestJsonMutation, fetchJsonWithFullTimeout or
// fetchWithTimeout), every way of building a path from a value:
//   - a "/${...}" that is not urlPathSegment(...)
//   - '".../" + value' that is not urlPathSegment(...), and 'value + "/..."'
//   - .join("/"), path.posix.join / path.posix.resolve, .concat(
//   - new URL(value, base) (relative resolution)
// unless the line is on NON_PATH_LINES below, each with the reason it builds no API URL path from
// an identifier.
//
// It is line-based: it does not follow a value across variables, functions or files, and a URL
// built in a file that sends no request is checked by the first set of rules only. The URL
// builders that take ids (tickets, admissions, file leases, message edits) are also covered by
// the behaviour tests above.

const ALL_FILE_RULES = [
  ["encoded-after-slash", /\/\$\{\s*encodeURIComponent\(/],
  ["encoded-before-slash", /encodeURIComponent\(.*?\)\s*\}\//],
  ["encoded-concat", /\/["'`]\s*\+\s*encodeURIComponent\(|encodeURIComponent\(.*?\)\s*\+\s*["'`]\//],
  ["api-path-raw", /\/(?:api\/)?v\d+\w*\/[^`]*\/\$\{(?!\s*urlPathSegment\()/],
  ["api-path-concat", /["'`][^"'`]*\/(?:api\/)?v\d+\w*\/[^"'`]*\/["'`]\s*\+(?!\s*urlPathSegment\()/],
];

const SENDS_REQUESTS =
  /\b(?:fetch|fetchImpl|credentialedRequest|checkedTransport|requestJson|requestJsonMutation|fetchJsonWithFullTimeout|fetchWithTimeout)\s*\(/;

const REQUEST_FILE_RULES = [
  ["slash-interpolation", /\/\$\{(?!\s*urlPathSegment\()/],
  ["slash-concat", /\/["'`]\s*\+(?!\s*urlPathSegment\()/],
  ["concat-slash", /\+\s*["'`]\//],
  ["join-slash", /\.join\(\s*["'`]\/["'`]\s*\)/],
  ["posix-join", /\bposix\.(?:join|resolve)\(/],
  ["concat-call", /\.concat\(/],
  ["relative-url", /\bnew URL\([^)]*,/],
];

// [file, rule, a fragment of the line, why it builds no API URL path from an identifier]
const NON_PATH_LINES = [
  ["src/agents/jules/tools/auth-audit.js", "slash-interpolation", "${parsed.protocol}//${parsed.host}/<redacted-path>", "a redacted display URL"],
  ["src/agents/jules/tools/auth-audit.js", "slash-interpolation", "Provider circuit is open for ${state.provider}/${state.scope}", "message text"],
  ["src/agents/jules/tools/auth-audit.js", "concat-slash", 'targetUrl + "/login"', "the audited site's own login page (a fixed route)"],
  ["src/agents/jules/tools/auth-audit.js", "relative-url", "new URL(location, currentParsedUrl)", "a redirect hop on the audited site, checked by assertSecureAuthFlowTarget"],
  ["src/agents/jules/tools/runtime-audit.js", "slash-concat", '"https://" + alias', "a deploy alias host from vercel.json, not a path"],
  ["src/agents/jules/tools/runtime-audit.js", "concat-slash", 'apiUrl + "/api/v1/scan/url"', "a fixed API route"],
  ["src/commands/session.js", "slash-interpolation", "`.../${segments.slice(-2).join(\"/\")}`", "a shortened local path for display"],
  ["src/commands/session.js", "join-slash", "`.../${segments.slice(-2).join(\"/\")}`", "a shortened local path for display"],
  ["src/commands/session.js", "slash-interpolation", "Pinned messages (${result.count}/${pinLimit})", "message text"],
  ["src/commands/session.js", "slash-interpolation", "active=${activeIntervalSeconds}s/${activeWindowSeconds}s", "message text"],
  ["src/commands/session.js", "slash-interpolation", "${result.window.sourceEventCount}/${result.window.sourceEventCountExpected}", "message text"],
  ["src/commands/session.js", "slash-interpolation", "${liveListenerCount}/${listenerRows.length}", "message text"],
  ["src/daemon/pulse.js", "slash-interpolation", "Turns: ${state.turnsCompleted}/${state.turnsMax", "message text"],
  ["src/daemon/pulse.js", "concat-slash", '"https://api.telegram.org/bot" + botToken + "/sendMessage"', "the Telegram Bot API, a fixed route"],
  ["src/daemon/watchdog.js", "slash-interpolation", "https://${SLACK_WEBHOOK_HOST}/.", "message text naming a fixed host"],
  ["src/daemon/watchdog.js", "slash-interpolation", "https://${TELEGRAM_API_HOST}/bot${channel.botToken}/sendMessage", "the Telegram Bot API, a fixed host and route"],
  ["src/legacy-cli.js", "relative-url", 'new URL("../package.json", import.meta.url)', "a file next to the module"],
  ["src/legacy-cli.js", "slash-interpolation", "${sshMatch[1]}/${sshMatch[2]}", "an owner/repo slug parsed from a git remote"],
  ["src/legacy-cli.js", "slash-interpolation", "${httpsMatch[1]}/${httpsMatch[2]}", "an owner/repo slug parsed from a git remote"],
  ["src/legacy-cli.js", "slash-interpolation", "${sshUrlMatch[1]}/${sshUrlMatch[2]}", "an owner/repo slug parsed from a git remote"],
  ["src/legacy-cli.js", "slash-interpolation", "${base}/${normalizeRepoSlug(repoSlug)}.git", "a git remote URL, not an API request"],
  ["src/legacy-cli.js", "slash-interpolation", "personaRouting.effectivePersonas.length}/${", "report text"],
  ["src/legacy-cli.js", "slash-interpolation", "`repos/${repoSlug}`", "a gh CLI argument for a validated owner/repo slug, not a SentinelLayer API URL"],
  ["src/mcp/doctor.js", "slash-interpolation", "${normalizedBase}/${normalizedSuffix}", "joins a base URL and a fixed route; every caller passes a constant"],
  ["src/mcp/smoke.js", "slash-interpolation", "${normalizedBase}/${normalizedSuffix}", "joins a base URL and a fixed route; every caller passes a constant"],
  ["src/mcp/token-service.js", "slash-interpolation", "${base}/${suffix}", "joins a base URL and a fixed route; every caller passes a constant"],
  ["src/session/file-locks.js", "join-slash", 'segments.join("/")', "a workspace file path"],
  ["src/session/recall/embedder.js", "concat-call", "tokens.concat(bigrams(tokens))", "an array of tokens"],
  ["src/swarm/pentest.js", "slash-interpolation", 'raw.startsWith("/") ? raw : `/${raw}`', "a probe path on the user's own pentest target"],
  ["src/swarm/pentest.js", "relative-url", "new URL(request.path, targetUrl)", "a probe path on the user's own pentest target"],
  ["src/swarm/pentest.js", "slash-interpolation", "`identity://${normalizedTargetId}/agent/omar`", "a credential reference label, not a URL that is requested"],
  ["src/swarm/pentest.js", "slash-interpolation", "`identity://${normalizedTargetId}/agent/security`", "a credential reference label, not a URL that is requested"],
  ["src/swarm/pentest.js", "slash-interpolation", "`identity://${normalizedTargetId}/agent/testing`", "a credential reference label, not a URL that is requested"],
  ["src/telemetry/sync.js", "concat-slash", 'apiUrl + "/api/v1/telemetry"', "a fixed API route"],
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

/** Every rule match in a set of files, comments skipped: { file, line, rule, text }. */
function pathCensus(files) {
  const sites = [];
  for (const { file, text } of files) {
    const rules = SENDS_REQUESTS.test(text) ? [...ALL_FILE_RULES, ...REQUEST_FILE_RULES] : ALL_FILE_RULES;
    text.split("\n").forEach((line, index) => {
      const code = line.trim();
      if (code.startsWith("//") || code.startsWith("*") || code.startsWith("/*")) return;
      for (const [rule, re] of rules) {
        if (re.test(line)) sites.push({ file, line: index + 1, rule, text: code });
      }
    });
  }
  return sites;
}

const isNonPath = (site) =>
  NON_PATH_LINES.some(([file, rule, fragment]) => file === site.file && rule === site.rule && site.text.includes(fragment));
const unreviewed = (sites) => sites.filter((site) => !isNonPath(site)).map((s) => `${s.file}:${s.line} ${s.rule}`);

test("census: src/ passes every rule listed above, and every reviewed line still exists", () => {
  const sites = pathCensus(srcFiles());
  assert.deepEqual(unreviewed(sites), [], "build the segment with urlPathSegment (src/net/url-path.js), or review the line");
  const stale = NON_PATH_LINES.filter(([file, rule, fragment]) =>
    !sites.some((s) => s.file === file && s.rule === rule && s.text.includes(fragment)),
  ).map(([file, rule, fragment]) => `${file} [${rule}] ${fragment}`);
  assert.deepEqual(stale, [], "a reviewed line that no longer exists");
});

test("census: catches each form it names, in a file that sends requests, and nothing else", () => {
  const sender = {
    file: "src/session/new-feature.js",
    text: [
      "const send = checkedTransport(requestJsonMutation);",
      "const a = `${base}/api/v1/sessions/${encodeURIComponent(id)}/events`;",
      "const b = `${encodeURIComponent(leaseId)}/renew`;",
      'const c = base + "/runs/" + encodeURIComponent(runId);',
      'const d = encodeURIComponent(runId) + "/status";',
      "const e = `${apiUrl}/api/v1/sessions/${sid}/events`;",
      'const pollUrl = apiUrl + "/api/v1/scan/url/" + scanId;',
      "const f = mutate(ticketsUrl(apiUrl, sessionId, `/${ticketId}/claim`), {",
      "return `${leaseCollectionUrl(apiUrl, sessionId)}/${leaseId}${route}`;",
      "admissionUrl(auth.apiUrl, sid, `/${state.admissionId}/claim`),",
      'const g = base + "/tickets/" + ticketId;',
      'const h = ticketId + "/claim";',
      'const i = [base, "tickets", ticketId].join("/");',
      "const j = path.posix.join(base, ticketId);",
      'const k = base.concat("/x");',
      "const l = new URL(ticketId, base);",
      // not path segments, or built through the helper
      'const m = `${apiUrl}/api/v1/sessions/${urlPathSegment(sid, { label: "sessionId" })}/events?after=${encodeURIComponent(cursor)}`;',
      'return `${ticketsUrl(apiUrl, sessionId)}/${urlPathSegment(ticketId, { label: "ticketId" })}${route}`;',
      "const file = `request-${encodeURIComponent(id)}-${stamp}.json`;",
      "// `${base}/api/v1/sessions/${ticketId}` in a comment",
    ].join("\n"),
  };
  assert.deepEqual(
    pathCensus([sender]).map((site) => `${site.line} ${site.rule}`),
    [
      "2 encoded-after-slash",
      "2 encoded-before-slash",
      "2 api-path-raw",
      "2 slash-interpolation",
      "3 encoded-before-slash",
      "4 encoded-concat",
      "4 slash-concat",
      "4 concat-slash",
      "5 encoded-concat",
      "5 concat-slash",
      "6 api-path-raw",
      "6 slash-interpolation",
      "7 api-path-concat",
      "7 slash-concat",
      "7 concat-slash",
      "8 slash-interpolation",
      "9 slash-interpolation",
      "10 slash-interpolation",
      "11 slash-concat",
      "11 concat-slash",
      "12 concat-slash",
      "13 join-slash",
      "14 posix-join",
      "15 concat-call",
      "16 relative-url",
    ],
  );
  // a file that sends no request is held to the all-file rules only
  const helperOnly = { file: "src/session/strings.js", text: sender.text.split("\n").slice(1).join("\n") };
  assert.deepEqual(
    pathCensus([helperOnly]).map((site) => `${site.line + 1} ${site.rule}`),
    [
      "2 encoded-after-slash",
      "2 encoded-before-slash",
      "2 api-path-raw",
      "3 encoded-before-slash",
      "4 encoded-concat",
      "5 encoded-concat",
      "6 api-path-raw",
      "7 api-path-concat",
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
