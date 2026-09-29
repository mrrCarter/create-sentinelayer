import "./setup-env.mjs";

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  getBlockedTestEgress,
  isAllowedTestDestination,
  isTestEgressGuardInstalled,
} from "../src/net/test-egress-guard.js";
import {
  fetchSessionFromApi,
  listSessionsFromApi,
  resetSessionSyncStateForTests,
} from "../src/session/sync.js";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const GUARD_URL = pathToFileURL(path.join(REPO_ROOT, "src", "net", "test-egress-guard.js")).href;
const SYNC_URL = pathToFileURL(path.join(REPO_ROOT, "src", "session", "sync.js")).href;
const HTTP_URL = pathToFileURL(path.join(REPO_ROOT, "src", "auth", "http.js")).href;
const SETUP_URL = pathToFileURL(path.join(REPO_ROOT, "tests", "setup-env.mjs")).href;

function withEnv(overrides, fn) {
  const saved = {};
  for (const key of Object.keys(overrides)) saved[key] = process.env[key];
  for (const [key, value] of Object.entries(overrides)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  const restore = () => {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  };
  return Promise.resolve().then(fn).finally(restore);
}

test("the preload isolates the home directory and installs the egress guard", () => {
  assert.equal(isTestEgressGuardInstalled(), true);
  assert.equal(os.homedir(), process.env.SENTINELAYER_TEST_HOME);
  assert.ok(
    path.resolve(os.homedir()).startsWith(path.resolve(os.tmpdir())),
    `home ${os.homedir()} must be a temp dir, never the developer's real profile`,
  );
  assert.equal(process.env.USERPROFILE, process.env.SENTINELAYER_TEST_HOME);
  assert.equal(process.env.SENTINELAYER_DISABLE_KEYRING, "1");
});

test("worst case: skip flag cleared by the reset helper and a token present, prod reads never leave the process", async () => {
  await withEnv(
    {
      SENTINELAYER_SKIP_REMOTE_SYNC: undefined,
      SENTINELAYER_TOKEN: "tripwire-placeholder-value",
      SENTINELAYER_API_URL: undefined,
    },
    async () => {
      resetSessionSyncStateForTests(); // deletes SENTINELAYER_SKIP_REMOTE_SYNC, as the real tests do
      assert.equal(process.env.SENTINELAYER_SKIP_REMOTE_SYNC, undefined);
      const before = getBlockedTestEgress().length;
      const fetched = await fetchSessionFromApi("sess-egress-tripwire");
      const listed = await listSessionsFromApi();
      const blocked = getBlockedTestEgress().slice(before);
      assert.ok(
        blocked.includes("https://api.sentinelayer.com"),
        `expected the prod origin to be refused by the guard, saw ${JSON.stringify(blocked)}`,
      );
      assert.notEqual(fetched?.ok, true);
      assert.notEqual(listed?.ok, true);
    },
  );
  process.env.SENTINELAYER_SKIP_REMOTE_SYNC = "1";
});

test("a direct fetch to a production host is refused with a typed error", async () => {
  await assert.rejects(fetch("https://api.sentinelayer.com/health"), { code: "TEST_EGRESS_BLOCKED" });
  await assert.rejects(fetch(new URL("https://example.com/")), { code: "TEST_EGRESS_BLOCKED" });
  await assert.rejects(fetch(new Request("https://api.openai.com/v1/models")), { code: "TEST_EGRESS_BLOCKED" });
});

test("destination policy: numeric loopback 127.0.0.1/[::1] only; names and look-alikes refused natively", () => {
  for (const ok of ["http://127.0.0.1:9/x", "http://[::1]:8080/", "http://127.1/", "data:text/plain,hi"]) {
    assert.equal(isAllowedTestDestination(ok), true, ok);
  }
  for (const bad of [
    "https://api.sentinelayer.com/api/v1/sessions", "http://localhost:3000", "https://api.fixture.invalid/v1",
    "https://svc.test/a", "http://app.localhost/", "http://127.0.0.2/", "https://localhost.com/",
    "https://127.0.0.1.nip.io/", "http://[::ffff:127.0.0.1]/", "ftp://127.0.0.1/", "file:///etc/passwd",
    "not a url", "",
  ]) {
    assert.equal(isAllowedTestDestination(bad), false, bad);
  }
});

async function withLoopbackServer(handler, fn) {
  const hits = [];
  const server = http.createServer((req, res) => {
    hits.push(`${req.method} ${req.url}`);
    handler(req, res);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    return await fn(`http://127.0.0.1:${server.address().port}`, hits);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

test("one normalization: string, URL and Request inputs reach loopback; what is checked is what is dispatched", async () => {
  await withLoopbackServer((req, res) => {
    res.writeHead(200);
    res.end(req.url);
  }, async (base, hits) => {
    assert.equal(await (await fetch(`${base}/s`)).text(), "/s");
    assert.equal(await (await fetch(new URL(`${base}/u`))).text(), "/u");
    assert.equal(await (await fetch(new Request(`${base}/r`))).text(), "/r");
    // An object whose .url and toString() disagree is converted exactly as native fetch converts it
    // (toString), so an allowed-looking .url cannot smuggle a disallowed destination...
    const smuggle = { url: `${base}/looks-allowed`, toString: () => "http://127.0.0.2:9/actual" };
    const before = getBlockedTestEgress().length;
    await assert.rejects(fetch(smuggle), { code: "TEST_EGRESS_BLOCKED" });
    assert.deepEqual(getBlockedTestEgress().slice(before), ["http://127.0.0.2:9"]);
    // ...and the reverse goes where toString() points, which is where the check looked.
    const reverse = { url: "https://api.sentinelayer.com/x", toString: () => `${base}/actual-loopback` };
    assert.equal(await (await fetch(reverse)).text(), "/actual-loopback");
    assert.deepEqual(hits, ["GET /s", "GET /u", "GET /r", "GET /actual-loopback"]);
  });
});

test("an init getter cannot answer the check and the dispatch differently", async () => {
  await withLoopbackServer((req, res) => {
    res.writeHead(302, { location: "https://api.sentinelayer.com/api/v1/sessions" });
    res.end();
  }, async (base, hits) => {
    let reads = 0;
    const init = {
      get redirect() {
        reads += 1;
        return reads === 1 ? "manual" : "follow";
      },
    };
    const before = getBlockedTestEgress().length;
    let outcome;
    try {
      outcome = (await fetch(`${base}/start`, init)).status;
    } catch (error) {
      outcome = error.code;
    }
    // Read once by the single Request conversion: either manual (the 302 is returned, not followed) or
    // follow (walked by the guard and refused at the hop). Never an unchecked follow to prod.
    assert.ok(outcome === 302 || outcome === "TEST_EGRESS_BLOCKED", `unexpected outcome ${outcome}`);
    assert.equal(reads, 1);
    const blocked = getBlockedTestEgress().slice(before);
    assert.ok(blocked.every((origin) => origin === "https://api.sentinelayer.com"));
    assert.deepEqual(hits, ["GET /start"]);
  });
});

test("redirects: every hop is checked; a loopback-to-loopback redirect is followed", async () => {
  await withLoopbackServer((req, res) => {
    if (req.url === "/start") {
      res.writeHead(302, { location: "/final" });
      res.end();
      return;
    }
    res.writeHead(200);
    res.end("final-ok");
  }, async (base, hits) => {
    const response = await fetch(`${base}/start`);
    assert.equal(await response.text(), "final-ok");
    assert.deepEqual(hits, ["GET /start", "GET /final"]);
  });
});

test("redirects: an allowed URL redirecting to a disallowed host is refused at that hop", async () => {
  for (const target of ["http://127.0.0.2:9/next", "https://api.sentinelayer.com/api/v1/sessions"]) {
    await withLoopbackServer((req, res) => {
      res.writeHead(302, { location: target });
      res.end();
    }, async (base, hits) => {
      const before = getBlockedTestEgress().length;
      await assert.rejects(fetch(`${base}/start`), { code: "TEST_EGRESS_BLOCKED" });
      assert.deepEqual(getBlockedTestEgress().slice(before), [new URL(target).origin]);
      assert.deepEqual(hits, ["GET /start"]);
    });
  }
});

test("redirects: 303 is followed as GET; a 307 that would re-send a body is refused; manual mode is untouched", async () => {
  await withLoopbackServer((req, res) => {
    if (req.url === "/see-other") {
      res.writeHead(303, { location: "/after" });
      res.end();
      return;
    }
    if (req.url === "/temporary") {
      res.writeHead(307, { location: "/after" });
      res.end();
      return;
    }
    res.writeHead(200);
    res.end(req.method);
  }, async (base, hits) => {
    const seeOther = await fetch(`${base}/see-other`, { method: "POST", body: "x" });
    assert.equal(await seeOther.text(), "GET");
    await assert.rejects(fetch(`${base}/temporary`, { method: "POST", body: "x" }), { code: "TEST_EGRESS_BLOCKED" });
    const manual = await fetch(`${base}/see-other`, { method: "POST", body: "x", redirect: "manual" });
    assert.equal(manual.status, 303);
    assert.deepEqual(hits, ["POST /see-other", "GET /after", "POST /temporary", "POST /see-other"]);
  });
});

test("redirects: only 301/302/303/307/308 are followed; a 300 or 304 with Location is returned as-is", async () => {
  for (const status of [300, 304]) {
    await withLoopbackServer((req, res) => {
      if (req.url === "/start") {
        res.writeHead(status, { location: "/elsewhere" });
        res.end();
        return;
      }
      res.writeHead(200);
      res.end("followed");
    }, async (base, hits) => {
      const response = await fetch(`${base}/start`);
      assert.equal(response.status, status);
      assert.deepEqual(hits, ["GET /start"], `a ${status} must not be followed`);
    });
  }
});

test("redirects: credentials are dropped on an origin change and kept on the same origin; 303 drops body headers", async () => {
  const seen = [];
  await withLoopbackServer((req, res) => {
    seen.push({ path: req.url, authorization: req.headers.authorization, cookie: req.headers.cookie,
      custom: req.headers["x-custom"], contentType: req.headers["content-type"], method: req.method });
    res.writeHead(200);
    res.end("b");
  }, async (otherBase) => {
    await withLoopbackServer((req, res) => {
      seen.push({ path: req.url, authorization: req.headers.authorization, cookie: req.headers.cookie,
        custom: req.headers["x-custom"], contentType: req.headers["content-type"], method: req.method });
      if (req.url === "/cross") {
        res.writeHead(302, { location: `${otherBase}/landed` });
      } else if (req.url === "/same") {
        res.writeHead(302, { location: "/same-landed" });
      } else if (req.url === "/post") {
        res.writeHead(303, { location: "/after-post" });
      } else {
        res.writeHead(200);
      }
      res.end();
    }, async (base) => {
      const headers = { authorization: "Bearer placeholder", cookie: "c=placeholder", "x-custom": "kept" };
      await fetch(`${base}/cross`, { headers });
      await fetch(`${base}/same`, { headers });
      await fetch(`${base}/post`, { method: "POST", body: "x", headers: { "content-type": "text/plain", "x-custom": "kept" } });
    });
  });
  const landed = seen.find((r) => r.path === "/landed");
  assert.equal(landed.authorization, undefined);
  assert.equal(landed.cookie, undefined);
  assert.equal(landed.custom, "kept");
  const sameLanded = seen.find((r) => r.path === "/same-landed");
  assert.equal(sameLanded.authorization, "Bearer placeholder");
  assert.equal(sameLanded.cookie, "c=placeholder");
  const afterPost = seen.find((r) => r.path === "/after-post");
  assert.equal(afterPost.method, "GET");
  assert.equal(afterPost.contentType, undefined);
  assert.equal(afterPost.custom, "kept");
});

test("inherited state-path overrides and credentials cannot escape the temp home (external sentinel)", () => {
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), "sl-external-sentinel-"));
  try {
    const env = {
      ...process.env,
      SENTINELAYER_CIRCUIT_STATE_DIR: outside,
      SENTINELAYER_AUTH_AUDIT_BREAKER_STATE_FILE: path.join(outside, "breaker.json"),
      SENTINELAYER_SECRET_SINK_FILE: path.join(outside, "sink.txt"),
      SENTINELAYER_TOKEN: "inherited-placeholder",
      SENTINELAYER_API_TOKEN: "inherited-placeholder",
    };
    const out = runChild(
      `await import(${JSON.stringify(SETUP_URL)});
       await import(${JSON.stringify(HTTP_URL)});
       const os = await import("node:os");
       console.log(JSON.stringify({
         home: os.homedir(),
         circuit: process.env.SENTINELAYER_CIRCUIT_STATE_DIR,
         breaker: process.env.SENTINELAYER_AUTH_AUDIT_BREAKER_STATE_FILE,
         sink: process.env.SENTINELAYER_SECRET_SINK_FILE ?? null,
         token: process.env.SENTINELAYER_TOKEN ?? null,
         apiToken: process.env.SENTINELAYER_API_TOKEN ?? null,
       }));`,
      env,
    );
    const seen = JSON.parse(out);
    assert.ok(path.resolve(seen.circuit).startsWith(path.resolve(seen.home)), `circuit dir ${seen.circuit} escaped ${seen.home}`);
    assert.ok(path.resolve(seen.breaker).startsWith(path.resolve(seen.home)), `breaker file ${seen.breaker} escaped`);
    assert.equal(seen.sink, null);
    assert.equal(seen.token, null);
    assert.equal(seen.apiToken, null);
    assert.deepEqual(fs.readdirSync(outside), [], "nothing may be written to the inherited external path");
  } finally {
    fs.rmSync(outside, { recursive: true, force: true });
  }
});

test("positive control: a loopback server is still reachable through the guard", async () => {
  const server = http.createServer((req, res) => {
    res.writeHead(200, { "content-type": "text/plain" });
    res.end("loopback-ok");
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const { port } = server.address();
    const response = await fetch(`http://127.0.0.1:${port}/`);
    assert.equal(await response.text(), "loopback-ok");
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test("a test's own fetch mock replaces the guard, and restoring the original puts the guard back", async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async () => new Response("mocked");
  try {
    assert.equal(isTestEgressGuardInstalled(), false);
    assert.equal(await (await fetch("https://api.sentinelayer.com/x")).text(), "mocked");
  } finally {
    globalThis.fetch = original;
  }
  assert.equal(isTestEgressGuardInstalled(), true);
  await assert.rejects(fetch("https://api.sentinelayer.com/x"), { code: "TEST_EGRESS_BLOCKED" });
});

function runChild(source, env) {
  const result = spawnSync(process.execPath, ["--input-type=module", "-e", source], {
    env,
    encoding: "utf8",
    timeout: 20_000,
  });
  assert.equal(result.status, 0, `child failed: ${result.stderr}`);
  return result.stdout.trim();
}

test("a spawned child without the preload inherits the guard through the env marker", () => {
  const env = { ...process.env, SENTINELAYER_TEST_EGRESS_GUARD: "1" };
  delete env.NODE_TEST_CONTEXT; // prove the marker alone is enough
  const out = runChild(
    `await import(${JSON.stringify(SYNC_URL)});
     try { await fetch("https://api.sentinelayer.com/health"); console.log("REACHED"); }
     catch (error) { console.log(error.code); }`,
    env,
  );
  assert.equal(out, "TEST_EGRESS_BLOCKED");
});

test("outside tests the guard is a no-op (production processes are unaffected)", () => {
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  delete env.SENTINELAYER_TEST_EGRESS_GUARD;
  const out = runChild(
    `const guard = await import(${JSON.stringify(GUARD_URL)});
     console.log(String(guard.installTestEgressGuard()) + "," + String(guard.isTestEgressGuardInstalled()));`,
    env,
  );
  assert.equal(out, "false,false");
});
