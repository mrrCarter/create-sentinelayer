import "./setup-env.mjs";
// The CLI refuses to run on a Windows runtime that would ignore NoDefaultCurrentDirectoryInExePath
// (libuv before 1.48.0, which is every Node.js 20). CI runs this file on Windows under Node.js 22
// and under Node.js 20, so the refusal is also shown with a real old libuv.
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { restrictProgramLookupToPath } from "../src/program-lookup.js";

const CLI_PATH = fileURLToPath(new URL("../bin/sl.js", import.meta.url));
const REAL_LIBUV_HONOURS_SETTING = restrictProgramLookupToPath({ platform: "win32", env: {} }).ok;

test("the libuv floor applies on Windows only, from 1.48.0", () => {
  const cases = [
    ["win32", "1.46.0", false],
    ["win32", "1.47.9", false],
    ["win32", "1.48.0", true],
    ["win32", "1.51.0", true],
    ["win32", "2.0.0", true],
    ["win32", "1.48", true],
    ["win32", "", false],
    ["win32", null, false],
    ["win32", "1.x.0", false],
    ["win32", "1", false],
    ["linux", "1.44.2", true],
    ["darwin", "1.44.2", true],
  ];
  for (const [platform, libuv, ok] of cases) {
    const env = {};
    const result = restrictProgramLookupToPath({ platform, libuv, nodeVersion: "v0.0.0-test", env });
    assert.equal(result.ok, ok, `${platform} libuv ${libuv}`);
    const set = env.NoDefaultCurrentDirectoryInExePath === "1";
    assert.equal(set, platform === "win32" && ok, `${platform} libuv ${libuv} sets the variable only when it works`);
    if (!ok) {
      assert.match(result.message, /needs Node\.js 22 or later \(libuv 1\.48\.0 or later\)/);
      assert.match(result.message, /v0\.0\.0-test/);
    }
  }
});

test("on Windows with a libuv that ignores the setting, sl runs nothing", async (t) => {
  if (process.platform !== "win32") {
    t.skip("the floor is Windows behaviour");
    return;
  }
  const repo = await fsp.mkdtemp(path.join(os.tmpdir(), "sl-runtime-floor-"));
  try {
    const git = (...args) => spawnSync("git", ["-C", repo, ...args], { cwd: os.tmpdir(), encoding: "utf8" });
    assert.equal(git("init", "-q").status, 0);
    await fsp.writeFile(path.join(repo, "README.md"), "x\n");
    assert.equal(git("add", "README.md").status, 0);
    assert.equal(git("-c", "user.name=t", "-c", "user.email=t@example.invalid", "commit", "-q", "-m", "x").status, 0);
    await fsp.appendFile(path.join(repo, "README.md"), "y\n");

    // Under Node.js 20 this is the real libuv. Under a newer runtime, report an old one.
    const args = [];
    if (REAL_LIBUV_HONOURS_SETTING) {
      const preload = path.join(repo, "..", `${path.basename(repo)}-old-libuv.mjs`);
      await fsp.writeFile(preload, 'Object.defineProperty(process.versions, "uv", { value: "1.46.0" });\n');
      args.push("--import", pathToFileURL(preload).href);
      t.after(() => fsp.rm(preload, { force: true }));
    }
    const env = {
      ...process.env,
      NODE_ENV: "test",
      SENTINELAYER_CLI_TEST_MODE: "1",
      SENTINELAYER_CLI_TEST_BYPASS_NONCE: "e2e-bypass-nonce",
      SENTINELAYER_CLI_SKIP_AUTH: "1",
      SENTINELAYER_TOKEN: "api_token_e2e_test_session",
    };
    delete env.NoDefaultCurrentDirectoryInExePath;

    const result = spawnSync(process.execPath, [...args, CLI_PATH, "review", "--diff", "--json"], {
      cwd: repo,
      env,
      encoding: "utf8",
      timeout: 120_000,
    });
    assert.equal(result.status, 1, result.stderr || result.stdout);
    assert.match(result.stderr, /needs Node\.js 22 or later/);
    assert.equal(result.stdout.trim(), "", "no command output");
    assert.equal(fs.existsSync(path.join(repo, ".sentinelayer")), false, "review never started");
  } finally {
    await fsp.rm(repo, { recursive: true, force: true });
  }
});
