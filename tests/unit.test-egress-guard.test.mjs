import "./setup-env.mjs";

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
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

test("destination policy: loopback and reserved test names only; look-alikes refused", () => {
  for (const ok of [
    "http://127.0.0.1:9/x", "http://localhost:3000", "http://[::1]:8080/", "https://api.fixture.invalid/v1",
    "https://svc.test/a", "http://app.localhost/", "data:text/plain,hi",
  ]) {
    assert.equal(isAllowedTestDestination(ok), true, ok);
  }
  for (const bad of [
    "https://api.sentinelayer.com/api/v1/sessions", "https://localhost.com/", "https://127.0.0.1.nip.io/",
    "https://evil.invalid.example.com/", "ftp://localhost/", "file:///etc/passwd", "not a url", "",
  ]) {
    assert.equal(isAllowedTestDestination(bad), false, bad);
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
