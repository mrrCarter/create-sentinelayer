import "./setup-env.mjs";
// The values the CLI puts into GitHub API paths that gh requests with the user's token:
//   - the validators (src/net/gh-api-path.js): what each accepts, refuses and encodes
//   - each call site with a stand-in gh that records its arguments: a refused value starts no gh
//     process, and a valid one produces exactly the expected gh arguments
//   - the real CLI (sl board check, sl scan setup-secrets, sl init) with the recording gh from
//     tests/gh-spy.mjs, found on PATH or through SENTINELAYER_GH_BIN
import test from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createServer } from "node:http";
import { once } from "node:events";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { createGhSpy } from "./gh-spy.mjs";
import { ghCommitSha, ghRefSegment, ghRepoSlug, isGhRepoSlug, isGitRefName } from "../src/net/gh-api-path.js";
import { createEvidenceResolver, createGhRunner } from "../src/board/evidence-resolvers.js";
import { VERDICTS, checkDone } from "../src/board/done-gate.js";
import { setupSecrets } from "../src/scan/gh-secrets.js";
import { writeStoredSession } from "../src/auth/session-store.js";

const CLI = fileURLToPath(new URL("../bin/sl.js", import.meta.url));

// ------------------------------------------------------------------------------- validators

const GOOD_SLUGS = [
  "mrrCarter/create-sentinelayer",
  "a/b",
  "octo-org/.github",
  "o/repo.name_x-1",
  "o/a..b",
  "o/...",
  "alice_acme/repo", // Enterprise Managed Users: handle_shortcode
  `${"a".repeat(39)}/${"r".repeat(100)}`,
];
const BAD_SLUGS = [
  "",
  "..",
  "../..",
  "me/..",
  "me/.",
  "../repo",
  "./repo",
  "me",
  "me/",
  "/me",
  "/me/x",
  "me/x/",
  "me/x/y",
  "me//x",
  "-me/x",
  "_me/x",
  "me.org/x",
  `${"a".repeat(40)}/x`,
  `me/${"r".repeat(101)}`,
  "me/x y",
  " me/x",
  "me/x\n",
  "me/x\t",
  "me/x%2f..",
  "me/%2e%2e",
  "me/x?y",
  "me/x#y",
  "me\\x",
  "me/{repo}",
  "github.com/me/x",
  "https://github.com/me/x",
];

test("repo slugs: exactly owner/repo as GitHub names them", () => {
  for (const slug of GOOD_SLUGS) {
    assert.equal(isGhRepoSlug(slug), true, JSON.stringify(slug));
    assert.equal(ghRepoSlug(slug), slug);
  }
  for (const slug of [...BAD_SLUGS, null, undefined, 42, ["me", "x"]]) {
    assert.equal(isGhRepoSlug(slug), false, JSON.stringify(slug));
    assert.throws(() => ghRepoSlug(slug), /^Error: repo must be a GitHub repository in owner\/repo form\.$/);
  }
  assert.throws(() => ghRepoSlug("me/..", { label: "evidence.repo" }), /^Error: evidence\.repo must be/);
});

test("commit SHAs: 7 to 40 hexadecimal characters", () => {
  for (const sha of ["a6bb012", "A6BB012", "0123456789abcdef0123456789abcdef01234567"]) {
    assert.equal(ghCommitSha(sha), sha);
  }
  for (const sha of ["", "a6bb01", "0123456789abcdef0123456789abcdef012345678", "g6bb012", "HEAD", "main", "a6bb012/..", "a6bb012...main", "a6bb012\n", " a6bb012", "a6bb%30012", 1234567, null]) {
    assert.throws(() => ghCommitSha(sha), /^Error: sha must be a commit SHA of 7 to 40 hexadecimal characters\.$/, JSON.stringify(sha));
  }
});

test("git ref names: git's rules, then percent-encoded as one path segment", () => {
  const encoded = {
    main: "main",
    "feature/board": "feature%2Fboard",
    "release/v1.2": "release%2Fv1.2",
    "heads/main": "heads%2Fmain",
    "refs/heads/main": "refs%2Fheads%2Fmain",
    a6bb012: "a6bb012",
    "fix#12": "fix%2312",
    "x{owner}": "x%7Bowner%7D",
    "a%2fb": "a%252fb",
    "a&b=c+d": "a%26b%3Dc%2Bd",
    "dev/ñ": "dev%2F%C3%B1",
    "v1.0-rc_1": "v1.0-rc_1",
    "a@b": "a%40b",
  };
  for (const [ref, segment] of Object.entries(encoded)) {
    assert.equal(isGitRefName(ref), true, JSON.stringify(ref));
    assert.equal(ghRefSegment(ref), segment, JSON.stringify(ref));
  }
  const refused = [
    "",
    ".",
    "..",
    "a..b",
    "../main",
    "main/..",
    "main/../x",
    ".hidden",
    "a/.b",
    "a.",
    "a/",
    "/a",
    "a//b",
    "-a",
    "a b",
    "a\tb",
    "a\nb",
    "a\u0000b",
    "a\u007fb",
    "a\u0085b",
    "a~1",
    "a^",
    "a:b",
    "a?b",
    "a*b",
    "a[b",
    "a\\b",
    "a.lock",
    "a.lock/b",
    "@",
    "a@{1}",
    "\uD800",
  ];
  for (const ref of [...refused, null, undefined, 7, {}]) {
    assert.equal(isGitRefName(ref), false, JSON.stringify(ref));
    assert.throws(() => ghRefSegment(ref), /^Error: ref must be a valid git branch, tag or ref name\.$/, JSON.stringify(ref));
  }
  assert.throws(() => ghRefSegment("..", { label: "branch" }), /^Error: branch must be/);
});

// ------------------------------------------------------------------- call sites: board resolver

const REPO = "mrrCarter/x";
const PR = { kind: "pr-merged", repo: REPO, number: 851 };
const SHA = { kind: "sha-on-branch", repo: REPO, sha: "a6bb012", branch: "feature/board" };
const CHK = { kind: "check-conclusive", repo: REPO, ref: "release/v1.2", check: "Native Quality Gates" };

function recordingRun() {
  const calls = [];
  return {
    calls,
    run: async (argv) => {
      calls.push(argv);
      return { ok: false, stderr: "stand-in" };
    },
  };
}

// Each field of each evidence kind, with values that are refused before gh runs.
const REFUSED_EVIDENCE = [
  ...["me/..", "../..", "me/x/y", "-me/x", "me", "https://github.com/me/x", "github.com/me/x", "me/x?y"].flatMap((repo) => [
    [{ ...PR, repo }, /^repo must be/],
    [{ ...SHA, repo }, /^repo must be/],
    [{ ...CHK, repo }, /^repo must be/],
  ]),
  ...["0", "-1", "1.5", "1 --web", "--web", "851/files", "https://github.com/other/repo/pull/1", true].map((number) => [
    { ...PR, number },
    /^number must be a pull request number\.$/,
  ]),
  ...["a6bb012/..", "a6bb012...main", "HEAD", "abc12", "g6bb012"].map((sha) => [{ ...SHA, sha }, /^sha must be/]),
  ...["../main", "main/..", "a..b", "main/", "-main", "ma in", "main\n", "feat//x", ".hidden", "x/.lock"].flatMap((name) => [
    [{ ...SHA, branch: name }, /^branch must be a valid git branch, tag or ref name\.$/],
    [{ ...CHK, ref: name }, /^ref must be a valid git branch, tag or ref name\.$/],
  ]),
];

test("board resolver: a refused value is never passed to gh", async () => {
  for (const [evidence, message] of REFUSED_EVIDENCE) {
    const { calls, run } = recordingRun();
    const resolve = createEvidenceResolver({ run });
    await assert.rejects(resolve(evidence), (error) => message.test(error.message), JSON.stringify(evidence));
    assert.deepEqual(calls, [], JSON.stringify(evidence));
  }
});

test("board resolver: valid values produce exactly the expected gh arguments", async () => {
  const cases = [
    [PR, ["pr", "view", "851", "--repo", REPO, "--json", "state,mergedAt"]],
    [{ ...PR, number: "17" }, ["pr", "view", "17", "--repo", REPO, "--json", "state,mergedAt"]],
    [SHA, ["api", "repos/mrrCarter/x/compare/feature%2Fboard...a6bb012", "--jq", ".status"]],
    [{ ...SHA, branch: "main", sha: "0123456789abcdef0123456789abcdef01234567" }, ["api", "repos/mrrCarter/x/compare/main...0123456789abcdef0123456789abcdef01234567", "--jq", ".status"]],
    [{ ...SHA, repo: "octo-org/.github", branch: "fix#12" }, ["api", "repos/octo-org/.github/compare/fix%2312...a6bb012", "--jq", ".status"]],
    [CHK, ["api", "repos/mrrCarter/x/commits/release%2Fv1.2/check-runs", "--jq", ".check_runs"]],
    [{ ...CHK, ref: "a6bb012" }, ["api", "repos/mrrCarter/x/commits/a6bb012/check-runs", "--jq", ".check_runs"]],
    [{ ...CHK, ref: "x{owner}" }, ["api", "repos/mrrCarter/x/commits/x%7Bowner%7D/check-runs", "--jq", ".check_runs"]],
  ];
  for (const [evidence, argv] of cases) {
    const { calls, run } = recordingRun();
    assert.equal(await createEvidenceResolver({ run })(evidence), null, "a failed lookup is unknown");
    assert.deepEqual(calls, [argv], JSON.stringify(evidence));
  }
});

test("board resolver through the gh runner: a refused value spawns nothing, a valid one spawns gh once", async () => {
  const spawned = [];
  const run = createGhRunner({
    spawn: async (cmd, argv) => {
      spawned.push([cmd, ...argv]);
      return { code: 1, stdout: "", stderr: "" };
    },
  });
  const resolve = createEvidenceResolver({ run });

  const refused = await checkDone({ ...SHA, branch: "../main" }, { resolve });
  assert.equal(refused.verdict, VERDICTS.CANNOT_VERIFY);
  assert.equal(refused.reason, "resolver failed: branch must be a valid git branch, tag or ref name.");
  const refusedRepo = await checkDone({ ...CHK, repo: "me/.." }, { resolve });
  assert.equal(refusedRepo.verdict, VERDICTS.CANNOT_VERIFY);
  assert.equal(refusedRepo.reason, "resolver failed: repo must be a GitHub repository in owner/repo form.");
  assert.deepEqual(spawned, []);

  const valid = await checkDone(SHA, { resolve });
  assert.equal(valid.verdict, VERDICTS.CANNOT_VERIFY, "gh failed: unknown");
  assert.deepEqual(spawned, [["gh", "api", "repos/mrrCarter/x/compare/feature%2Fboard...a6bb012", "--jq", ".status"]]);
});

// --------------------------------------------------------------- call sites: scan setup-secrets

async function withEnv(vars, fn) {
  const saved = {};
  for (const [key, value] of Object.entries(vars)) {
    saved[key] = process.env[key];
    process.env[key] = value;
  }
  try {
    return await fn();
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

test("setupSecrets: a refused repo starts no gh process; a valid one reaches gh exactly", async () => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "sl-gh-paths-secrets-"));
  try {
    const spy = createGhSpy(path.join(root, "gh"));
    await withEnv(spy.env, async () => {
      for (const repoSlug of ["me/..", "../..", "me/.", "me/x/y", "-me/x", "me/x?y", "../repo.git"]) {
        const result = setupSecrets({ repoSlug, secretName: "SENTINELAYER_TOKEN", secretValue: "v", dryRun: false });
        assert.deepEqual(result, { ok: false, reason: "Invalid repo format. Use owner/repo." }, repoSlug);
      }
      assert.deepEqual(spy.calls(), []);

      const result = setupSecrets({ repoSlug: "me/own-repo.git", secretName: "SENTINELAYER_TOKEN", secretValue: "v", dryRun: false });
      assert.equal(result.ok, true, result.reason);
      assert.deepEqual(
        spy.calls().map((call) => call.args.join(" ")),
        ["secret set SENTINELAYER_TOKEN --repo me/own-repo", "secret list --repo me/own-repo"],
      );
    });
    // With no gh at all, a refused repo still reports the repo, not a missing gh: nothing was started.
    await withEnv({ SENTINELAYER_GH_BIN: path.join(root, "missing", "gh.exe") }, async () => {
      const result = setupSecrets({ repoSlug: "me/..", secretName: "SENTINELAYER_TOKEN", secretValue: "v", dryRun: false });
      assert.equal(result.reason, "Invalid repo format. Use owner/repo.");
    });
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});

// ------------------------------------------------------------------------- the real CLI

function runCli(args, { cwd, env }) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [CLI, ...args], { cwd, env, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

/** `env` with `dir` first on PATH, under whatever case the platform spells PATH. */
function withPathFirst(env, dir) {
  const key = Object.keys(env).find((name) => name.toUpperCase() === "PATH") ?? "PATH";
  return { ...env, [key]: `${dir}${path.delimiter}${env[key] ?? ""}` };
}

async function cliFixture(prefix) {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), prefix));
  const ws = path.join(root, "workspace");
  await fsp.mkdir(ws, { recursive: true });
  const ghDir = path.join(root, "gh");
  const gh = createGhSpy(ghDir);
  const env = withPathFirst({ ...process.env, ...gh.env, GH_TOKEN: "not-a-real-token" }, ghDir);
  delete env.SENTINELAYER_SECRET_SINK_FILE;
  return { root, ws, gh, env, close: () => fsp.rm(root, { recursive: true, force: true }) };
}

const commands = (fx) => fx.gh.calls().map((call) => call.args.join(" "));

test("CLI sl board check: refused evidence values never reach gh; valid ones reach it exactly", async () => {
  const fx = await cliFixture("sl-gh-paths-board-");
  const env = { ...fx.env, SENTINELAYER_TOKEN: "sl-test-token-0000" }; // signed in; nothing is sent
  try {
    const ticket = path.join(fx.ws, "refused.json");
    await fsp.writeFile(
      ticket,
      JSON.stringify({
        id: "T-1",
        evidence: [
          { kind: "pr-merged", repo: "me/..", number: 7 },
          { kind: "pr-merged", repo: "me/own-repo", number: "7 --web" },
          { kind: "sha-on-branch", repo: "../..", sha: "a6bb012", branch: "main" },
          { kind: "sha-on-branch", repo: "me/own-repo", sha: "a6bb012/..", branch: "main" },
          { kind: "sha-on-branch", repo: "me/own-repo", sha: "a6bb012", branch: "../main" },
          { kind: "check-conclusive", repo: "me/own-repo", ref: "main/../..", check: "CI" },
        ],
      }),
    );
    const refused = await runCli(["board", "check", "--file", ticket], { cwd: fx.ws, env });
    assert.equal(refused.code, 2, refused.stderr || refused.stdout);
    assert.deepEqual(
      refused.stdout.split(/\r?\n/).filter((line) => line.startsWith("  - ")),
      [
        "  - pr-merged: cannot-verify (resolver failed: repo must be a GitHub repository in owner/repo form.)",
        "  - pr-merged: cannot-verify (resolver failed: number must be a pull request number.)",
        "  - sha-on-branch: cannot-verify (resolver failed: repo must be a GitHub repository in owner/repo form.)",
        "  - sha-on-branch: cannot-verify (resolver failed: sha must be a commit SHA of 7 to 40 hexadecimal characters.)",
        "  - sha-on-branch: cannot-verify (resolver failed: branch must be a valid git branch, tag or ref name.)",
        "  - check-conclusive: cannot-verify (resolver failed: ref must be a valid git branch, tag or ref name.)",
      ],
    );
    assert.deepEqual(commands(fx), [], "no gh process");

    const validTicket = path.join(fx.ws, "valid.json");
    await fsp.writeFile(
      validTicket,
      JSON.stringify({
        id: "T-2",
        evidence: [
          { kind: "pr-merged", repo: "me/own-repo", number: 7 },
          { kind: "sha-on-branch", repo: "me/own-repo", sha: "a6bb012", branch: "feature/board" },
          { kind: "check-conclusive", repo: "me/own-repo", ref: "feature/board", check: "CI" },
        ],
      }),
    );
    const valid = await runCli(["board", "check", "--file", validTicket], { cwd: fx.ws, env });
    assert.equal(valid.code, 2, valid.stderr || "the stand-in answers nothing GitHub would, so: cannot-verify");
    assert.deepEqual(commands(fx), [
      "pr view 7 --repo me/own-repo --json state,mergedAt",
      "api repos/me/own-repo/compare/feature%2Fboard...a6bb012 --jq .status",
      "api repos/me/own-repo/commits/feature%2Fboard/check-runs --jq .check_runs",
    ]);
  } finally {
    await fx.close();
  }
});

test("CLI sl scan setup-secrets: a refused --repo never reaches gh; a valid one reaches it exactly", async () => {
  const fx = await cliFixture("sl-gh-paths-scan-");
  try {
    const env = { ...fx.env, SENTINELAYER_TOKEN: "sl-test-token-0000" };
    for (const repo of ["me/..", "../..", "me/x/y"]) {
      const run = await runCli(["scan", "setup-secrets", "--repo", repo, "--json"], { cwd: fx.ws, env });
      const out = JSON.parse(run.stdout);
      assert.equal(out.ok, false);
      assert.equal(out.reason, "Invalid repo format. Use owner/repo.");
    }
    assert.deepEqual(commands(fx), [], "no gh process");

    const run = await runCli(["scan", "setup-secrets", "--repo", "me/own-repo", "--json"], { cwd: fx.ws, env });
    assert.equal(run.code, 0, run.stderr || run.stdout);
    assert.equal(JSON.parse(run.stdout).ok, true, run.stdout);
    assert.deepEqual(commands(fx), ["secret set SENTINELAYER_TOKEN --repo me/own-repo", "secret list --repo me/own-repo"]);
  } finally {
    await fx.close();
  }
});

// sl init --inject-openai-key confirms this directory's own git remote with `gh api repos/<slug>`.
async function initInRemote(remote) {
  const fx = await cliFixture("sl-gh-paths-init-");
  const home = path.join(fx.root, "home");
  await fsp.mkdir(home, { recursive: true });
  const api = createServer(async (req, res) => {
    for await (const _chunk of req) {
      // drain
    }
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end("{}");
  });
  api.listen(0, "127.0.0.1");
  await once(api, "listening");
  const apiUrl = `http://127.0.0.1:${api.address().port}`;
  try {
    await writeStoredSession(
      { apiUrl, token: "init-user-token-0000", tokenExpiresAt: new Date(Date.now() + 30 * 86400_000).toISOString() },
      { homeDir: home },
    );
    spawnSync("git", ["init", "-q"], { cwd: fx.ws });
    spawnSync("git", ["remote", "add", "origin", remote], { cwd: fx.ws });
    const env = {
      ...fx.env,
      OPENAI_API_KEY: "init-openai-key-0000",
      HOME: home,
      USERPROFILE: home,
      APPDATA: path.join(home, "AppData", "Roaming"),
      LOCALAPPDATA: path.join(home, "AppData", "Local"),
      XDG_CONFIG_HOME: path.join(home, ".config"),
      SENTINELAYER_CIRCUIT_STATE_DIR: path.join(home, ".sentinelayer"),
      SENTINELAYER_API_URL: apiUrl,
      SENTINELAYER_CLI_NON_INTERACTIVE: "1",
      SENTINELAYER_CLI_SKIP_BROWSER_OPEN: "1",
      SENTINELAYER_CLI_INTERVIEW_JSON: JSON.stringify({
        projectName: "demo-app",
        projectDescription: "Build an autonomous secure code review orchestrator.",
        aiProvider: "openai",
        authMode: "byok",
        generationMode: "detailed",
        audienceLevel: "developer",
        projectType: "greenfield",
        codingAgent: "generic",
        techStack: ["TypeScript"],
        features: ["auth"],
        connectRepo: false,
        repoSlug: "",
        buildFromExistingRepo: false,
        injectSecret: false,
      }),
    };
    delete env.SENTINELAYER_MCP_BRIDGE;
    delete env.SENTINELAYER_TOKEN;
    const run = await runCli(["init", "demo-app", "--non-interactive", "--inject-openai-key"], { cwd: fx.ws, env });
    return { run, commands: commands(fx) };
  } finally {
    await new Promise((resolve) => api.close(resolve));
    await fx.close();
  }
}

test("CLI sl init: a git remote that is not owner/repo never reaches gh; a valid one does", async () => {
  for (const remote of ["https://github.com/me/..", "https://github.com/../..", "git@github.com:me/..git"]) {
    const { run, commands: calls } = await initInRemote(remote);
    assert.equal(run.code, 0, run.stderr || run.stdout);
    assert.match(run.stdout, /GitHub Actions secrets not set: Invalid repo format\. Use owner\/repo\./, remote);
    assert.deepEqual(calls, [], remote);
  }
  const { run, commands: calls } = await initInRemote("https://github.com/me/own-repo.git");
  assert.equal(run.code, 0, run.stderr || run.stdout);
  assert.deepEqual(calls, [
    "api repos/me/own-repo",
    "secret set OPENAI_API_KEY --repo me/own-repo",
    "secret list --repo me/own-repo",
  ]);
});
