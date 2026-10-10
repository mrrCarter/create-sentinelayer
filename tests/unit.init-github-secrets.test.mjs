import "./setup-env.mjs";
// `sl init` sets GitHub Actions secrets only when asked: the project token with --inject-secret
// (or injectSecret in the interview, outside the MCP bridge), OPENAI_API_KEY only with its own
// --inject-openai-key. The target is this directory's own git remote, confirmed with gh, never a
// slug from the interview. Every gh invocation is recorded by tests/gh-spy.mjs.
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
import { writeStoredSession } from "../src/auth/session-store.js";
import { buildCliCommandMcpTools, createCliCommandMcpToolHandlers } from "../src/mcp/cli-command-tools.js";

const CLI = fileURLToPath(new URL("../bin/sl.js", import.meta.url));
const OPENAI_KEY = "init-openai-key-0000";

const interview = (overrides = {}) => ({
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
  connectRepo: true,
  repoSlug: "someone-else/their-repo",
  buildFromExistingRepo: false,
  injectSecret: false,
  ...overrides,
});

// A directory whose own git remote is me/own-repo, a signed-in user (stored login, loopback API),
// and a gh spy.
async function fixture({ permissions } = {}) {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "sl-init-secrets-"));
  const home = path.join(root, "home");
  const ws = path.join(root, "workspace");
  await fsp.mkdir(ws, { recursive: true });
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
  await writeStoredSession(
    { apiUrl, token: "init-user-token-0000", tokenExpiresAt: new Date(Date.now() + 30 * 86400_000).toISOString() },
    { homeDir: home },
  );
  spawnSync("git", ["init", "-q"], { cwd: ws });
  spawnSync("git", ["remote", "add", "origin", "https://github.com/me/own-repo.git"], { cwd: ws });
  const gh = createGhSpy(path.join(root, "gh"), permissions ? { permissions } : undefined);
  const env = {
    ...process.env,
    ...gh.env,
    OPENAI_API_KEY: OPENAI_KEY,
    HOME: home,
    USERPROFILE: home,
    APPDATA: path.join(home, "AppData", "Roaming"),
    LOCALAPPDATA: path.join(home, "AppData", "Local"),
    XDG_CONFIG_HOME: path.join(home, ".config"),
    SENTINELAYER_CIRCUIT_STATE_DIR: path.join(home, ".sentinelayer"),
    SENTINELAYER_API_URL: apiUrl,
    SENTINELAYER_CLI_NON_INTERACTIVE: "1",
    SENTINELAYER_CLI_SKIP_BROWSER_OPEN: "1",
    SENTINELAYER_SKIP_SENTI_AUTOSTART: "1",
  };
  delete env.SENTINELAYER_MCP_BRIDGE;
  delete env.SENTINELAYER_SECRET_SINK_FILE;
  delete env.SENTINELAYER_TOKEN;
  return {
    root,
    ws,
    gh,
    env,
    close: async () => {
      await new Promise((resolve) => api.close(resolve));
      await fsp.rm(root, { recursive: true, force: true });
    },
  };
}

function init(fx, args, overrides) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [CLI, "init", "demo-app", "--non-interactive", ...args], {
      cwd: fx.ws,
      env: { ...fx.env, SENTINELAYER_CLI_INTERVIEW_JSON: JSON.stringify(interview(overrides)) },
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

const commands = (fx) => fx.gh.calls().map((call) => call.args.join(" "));

test("native init without an opt-in makes no gh call, even with OPENAI_API_KEY set and a repo in the interview", async () => {
  const fx = await fixture();
  try {
    const run = await init(fx, []);
    assert.equal(run.code, 0, run.stderr || run.stdout);
    assert.deepEqual(commands(fx), []);
  } finally {
    await fx.close();
  }
});

test("--inject-openai-key sets OPENAI_API_KEY on this directory's own remote only, after gh confirms access", async () => {
  const fx = await fixture();
  try {
    const run = await init(fx, ["--inject-openai-key"]);
    assert.equal(run.code, 0, run.stderr || run.stdout);
    assert.match(run.stdout, /GitHub Actions secrets target: me\/own-repo/);
    assert.deepEqual(commands(fx), [
      "api repos/me/own-repo",
      "secret set OPENAI_API_KEY --repo me/own-repo",
      "secret list --repo me/own-repo",
    ]);
    assert.equal(fx.gh.calls()[1].input, `${OPENAI_KEY}\n`);
    assert.equal(JSON.stringify(fx.gh.calls()).includes("someone-else"), false, "never the interview's repo");
  } finally {
    await fx.close();
  }
});

test("a remote the signed-in gh user cannot write to gets no secret", async () => {
  const fx = await fixture({ permissions: { admin: false, maintain: false, push: false, pull: true } });
  try {
    const run = await init(fx, ["--inject-openai-key"]);
    assert.equal(run.code, 0, run.stderr || run.stdout);
    assert.deepEqual(commands(fx), ["api repos/me/own-repo"]);
    assert.match(run.stdout, /cannot write to me\/own-repo/);
  } finally {
    await fx.close();
  }
});

test("the MCP bridge cannot opt in: init refuses an interview that asks for secrets, and the flags are not exposed", async () => {
  const fx = await fixture();
  try {
    await fsp.writeFile(
      path.join(fx.ws, "interview.json"),
      JSON.stringify(interview({ authMode: "sentinelayer", injectSecret: true })),
    );
    // past the approval gate (the MCP dispatcher refuses every CLI tool; unit.mcp-bridge-approval)
    const handlers = createCliCommandMcpToolHandlers(await buildCliCommandMcpTools(), {
      targetPath: fx.ws,
      env: fx.env,
      approve: () => true,
    });
    const refused = await handlers["sl.init"]({ projectName: "demo-app", nonInteractive: true, interviewFile: "interview.json", timeoutMs: 120_000 });
    assert.equal(refused.ok, false);
    assert.match(String(refused.stderr), /not set through the MCP bridge/);
    for (const flag of ["injectSecret", "injectOpenaiKey"]) {
      const result = await handlers["sl.init"]({ projectName: "demo-app", nonInteractive: true, [flag]: true });
      assert.equal(result.reason, "invalid_cli_tool_input", flag);
    }
    assert.deepEqual(commands(fx), [], "no gh call");
  } finally {
    await fx.close();
  }
});
