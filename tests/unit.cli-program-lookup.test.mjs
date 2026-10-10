import "./setup-env.mjs";
// The CLI entry (runCli) turns off Windows' working-directory program lookup for the whole
// process, before any command runs. Its own test file: the setting is process-wide.
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { runCli } from "../src/cli.js";
import { collectGitState } from "../src/review/replay.js";

const CLI_PATH = fileURLToPath(new URL("../bin/sl.js", import.meta.url));

// A committed repository whose root also holds a git.exe that fails every call (a copy of
// whoami.exe). Starts from the Windows default lookup (some shells set
// NoDefaultCurrentDirectoryInExePath already) and checks that a bare "git" run there would be the
// repository's git.exe.
async function repositoryWithStandInGit() {
  const repo = await fsp.mkdtemp(path.join(os.tmpdir(), "sl-program-lookup-"));
  const git = (...args) => spawnSync("git", ["-C", repo, ...args], { cwd: os.tmpdir(), encoding: "utf8" });
  assert.equal(git("init", "-q").status, 0);
  await fsp.writeFile(path.join(repo, "README.md"), "x\n");
  assert.equal(git("add", "README.md").status, 0);
  assert.equal(git("-c", "user.name=t", "-c", "user.email=t@example.invalid", "commit", "-q", "-m", "x").status, 0);
  const head = git("rev-parse", "HEAD").stdout.trim();

  const whoami = path.join(process.env.SystemRoot || "C:\\Windows", "System32", "whoami.exe");
  await fsp.copyFile(whoami, path.join(repo, "git.exe"));
  delete process.env.NoDefaultCurrentDirectoryInExePath;
  assert.notEqual(
    spawnSync("git", ["rev-parse", "HEAD"], { cwd: repo, encoding: "utf8" }).stdout.trim(),
    head,
    "precondition: without the setting, the repository's git.exe runs",
  );
  return { repo, head };
}

test("after runCli starts, review's git runs from PATH, never from the repository", async (t) => {
  if (process.platform !== "win32") {
    t.skip("the working-directory program lookup is Windows behaviour");
    return;
  }
  const { repo, head } = await repositoryWithStandInGit();
  try {
    const log = console.log;
    console.log = () => {};
    try {
      await runCli(["--version"]);
    } finally {
      console.log = log;
    }

    assert.equal(collectGitState(repo).commitSha, head, "review's git state comes from the real git");
  } finally {
    await fsp.rm(repo, { recursive: true, force: true });
  }
});

test("sl review --diff run inside such a repository reads it with the git on PATH", async (t) => {
  if (process.platform !== "win32") {
    t.skip("the working-directory program lookup is Windows behaviour");
    return;
  }
  const { repo, head } = await repositoryWithStandInGit();
  try {
    await fsp.appendFile(path.join(repo, "README.md"), "y\n");
    const env = {
      ...process.env,
      NODE_ENV: "test",
      SENTINELAYER_CLI_TEST_MODE: "1",
      SENTINELAYER_CLI_TEST_BYPASS_NONCE: "e2e-bypass-nonce",
      SENTINELAYER_CLI_SKIP_AUTH: "1",
      SENTINELAYER_TOKEN: "api_token_e2e_test_session",
    };
    delete env.NoDefaultCurrentDirectoryInExePath;

    // The command's own spawns run in the real CLI process, so this covers the order: the setting
    // must be in place before review starts git, not only once the command has finished.
    const result = spawnSync(process.execPath, [CLI_PATH, "review", "--diff", "--json"], {
      cwd: repo,
      env,
      encoding: "utf8",
      timeout: 120_000,
    });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.mode, "diff");
    assert.ok(payload.scopedFiles.includes("README.md"), `the changed file is in scope: ${payload.scopedFiles}`);
    const context = JSON.parse(await fsp.readFile(payload.runContextPath, "utf8"));
    assert.equal(context.gitState.commitSha, head, "the run records the real commit");
  } finally {
    await fsp.rm(repo, { recursive: true, force: true });
  }
});
