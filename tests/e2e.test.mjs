import test from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createServer } from "node:http";
import { once } from "node:events";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CLI_PATH = path.resolve(__dirname, "..", "bin", "create-sentinelayer.js");

function jsonResponse(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Content-Length": Buffer.byteLength(body),
  });
  res.end(body);
}

async function readJsonBody(req) {
  const chunks = [];
  for await (const chunk of req) {
    chunks.push(Buffer.from(chunk));
  }
  const raw = Buffer.concat(chunks).toString("utf-8");
  if (!raw.trim()) return {};
  return JSON.parse(raw);
}

async function startMockApi({
  includeBootstrapInGenerate = true,
  includeOmarWorkflowInGenerate = true,
  requiredSecretName = "SENTINELAYER_TOKEN",
} = {}) {
  const state = {
    pollCalls: 0,
    bootstrapCalls: 0,
    generatePayload: null,
    generateAuthHeader: "",
  };

  const server = createServer(async (req, res) => {
    try {
      if (req.method === "POST" && req.url === "/api/v1/auth/cli/sessions/start") {
        await readJsonBody(req);
        return jsonResponse(res, 200, {
          session_id: "sess_123",
          authorize_url: "http://127.0.0.1/cli-auth?session_id=sess_123",
          poll_interval_seconds: 0,
        });
      }

      if (req.method === "POST" && req.url === "/api/v1/auth/cli/sessions/poll") {
        await readJsonBody(req);
        state.pollCalls += 1;
        if (state.pollCalls === 1) {
          return jsonResponse(res, 200, { status: "pending" });
        }
        return jsonResponse(res, 200, {
          status: "approved",
          auth_token: "web_auth_token_abc",
          user: { github_username: "demo-user" },
        });
      }

      if (req.method === "POST" && req.url === "/api/v1/builder/generate") {
        state.generateAuthHeader = String(req.headers.authorization || "");
        state.generatePayload = await readJsonBody(req);
        const payload = {
          project_name: "demo-app",
          spec_sheet: "# Spec\n\nShip it.",
          playbook: "# Build Guide\n\nDo this.",
          builder_prompt: "Follow the generated docs.",
        };
        if (includeOmarWorkflowInGenerate) {
          payload.omar_gate_yaml =
            "name: Omar Gate\non:\n  pull_request:\n    types: [opened, synchronize, reopened]\n";
        }
        if (includeBootstrapInGenerate) {
          payload.bootstrap_token = {
            token: "sl_boot_from_generate_123",
            required_secret_name: requiredSecretName,
          };
        }
        return jsonResponse(res, 200, payload);
      }

      if (req.method === "POST" && req.url === "/api/v1/builder/bootstrap-token") {
        state.bootstrapCalls += 1;
        await readJsonBody(req);
        return jsonResponse(res, 200, {
          token: "sl_boot_from_bootstrap_endpoint_456",
          required_secret_name: "SENTINELAYER_TOKEN",
        });
      }

      return jsonResponse(res, 404, {
        error: { code: "NOT_FOUND", message: "Route not found" },
      });
    } catch (error) {
      return jsonResponse(res, 500, {
        error: {
          code: "TEST_SERVER_ERROR",
          message: error instanceof Error ? error.message : String(error),
        },
      });
    }
  });

  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Unable to resolve mock API address");
  }

  const apiUrl = `http://127.0.0.1:${address.port}`;
  return {
    apiUrl,
    state,
    async close() {
      server.close();
      await once(server, "close");
    },
  };
}

async function runCli({ cwd, env, args = [] }) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CLI_PATH, ...args], {
      cwd,
      env,
      stdio: ["pipe", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (chunk) => {
      stdout += String(chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });

    child.on("error", (error) => reject(error));
    child.on("close", (code) => {
      resolve({ code: Number(code || 0), stdout, stderr });
    });
  });
}

function runCommand({ cwd, command, args }) {
  const result = spawnSync(command, args, { cwd, encoding: "utf-8" });
  assert.equal(
    result.status,
    0,
    `${command} ${args.join(" ")} failed:\n${result.stderr || result.stdout || "(no output)"}`
  );
  return result;
}

async function createGithubRepoFixture(tempRoot, { owner = "acme", repo = "feature-app" } = {}) {
  const seedDir = path.join(tempRoot, "seed-repo");
  const gitRoot = path.join(tempRoot, "github");
  const bareRepoDir = path.join(gitRoot, owner, `${repo}.git`);

  await mkdir(seedDir, { recursive: true });
  await mkdir(path.dirname(bareRepoDir), { recursive: true });

  runCommand({ cwd: seedDir, command: "git", args: ["init"] });
  runCommand({ cwd: seedDir, command: "git", args: ["config", "user.name", "Sentinelayer E2E"] });
  runCommand({ cwd: seedDir, command: "git", args: ["config", "user.email", "e2e@sentinelayer.local"] });

  await writeFile(
    path.join(seedDir, "package.json"),
    `${JSON.stringify({ name: repo, version: "0.0.1", private: true, scripts: { test: "echo test" } }, null, 2)}\n`,
    "utf-8"
  );
  await writeFile(path.join(seedDir, "README.md"), "# Existing Codebase\n", "utf-8");

  runCommand({ cwd: seedDir, command: "git", args: ["add", "."] });
  runCommand({ cwd: seedDir, command: "git", args: ["commit", "-m", "seed"] });

  runCommand({ cwd: tempRoot, command: "git", args: ["init", "--bare", bareRepoDir] });
  runCommand({ cwd: seedDir, command: "git", args: ["branch", "-M", "main"] });
  runCommand({ cwd: seedDir, command: "git", args: ["remote", "add", "origin", bareRepoDir] });
  runCommand({ cwd: seedDir, command: "git", args: ["push", "-u", "origin", "main"] });
  runCommand({
    cwd: tempRoot,
    command: "git",
    args: [`--git-dir=${bareRepoDir}`, "symbolic-ref", "HEAD", "refs/heads/main"],
  });

  return {
    repoSlug: `${owner}/${repo}`,
    cloneBaseUrl: pathToFileURL(gitRoot).href.replace(/\/$/, ""),
  };
}

async function createEmptyGithubRepoFixture(tempRoot, { owner = "acme", repo = "empty-repo" } = {}) {
  const gitRoot = path.join(tempRoot, "github-empty");
  const bareRepoDir = path.join(gitRoot, owner, `${repo}.git`);

  await mkdir(path.dirname(bareRepoDir), { recursive: true });
  runCommand({ cwd: tempRoot, command: "git", args: ["init", "--bare", bareRepoDir] });
  runCommand({
    cwd: tempRoot,
    command: "git",
    args: [`--git-dir=${bareRepoDir}`, "symbolic-ref", "HEAD", "refs/heads/main"],
  });

  return {
    repoSlug: `${owner}/${repo}`,
    cloneBaseUrl: pathToFileURL(gitRoot).href.replace(/\/$/, ""),
  };
}

function baseInterview(overrides = {}) {
  return {
    projectName: "demo-app",
    projectDescription: "Build an autonomous secure code review orchestrator.",
    aiProvider: "openai",
    authMode: "sentinelayer",
    generationMode: "detailed",
    audienceLevel: "developer",
    projectType: "greenfield",
    techStack: ["TypeScript", "Node.js", "PostgreSQL"],
    features: ["auth", "scanning", "reporting"],
    connectRepo: false,
    repoSlug: "",
    buildFromExistingRepo: false,
    injectSecret: false,
    ...overrides,
  };
}

test("CLI end-to-end: generates artifacts and injects secret via gh", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "create-sentinelayer-e2e-"));
  const mock = await startMockApi({ includeBootstrapInGenerate: true, requiredSecretName: "bad-secret-name" });
  const secretSinkPath = path.join(tempRoot, "secret-sink.log");

  try {
    const env = {
      ...process.env,
      SENTINELAYER_API_URL: mock.apiUrl,
      SENTINELAYER_WEB_URL: "http://127.0.0.1",
      SENTINELAYER_CLI_NON_INTERACTIVE: "1",
      SENTINELAYER_CLI_SKIP_BROWSER_OPEN: "1",
      SENTINELAYER_SECRET_SINK_FILE: secretSinkPath,
      SENTINELAYER_CLI_INTERVIEW_JSON: JSON.stringify(
        baseInterview({
          connectRepo: true,
          repoSlug: "acme/demo-repo",
          injectSecret: true,
        })
      ),
    };

    const result = await runCli({ cwd: tempRoot, env, args: ["demo-app", "--non-interactive"] });
    assert.equal(result.code, 0, result.stderr || result.stdout);

    const projectDir = path.join(tempRoot, "demo-app");
    const envText = await readFile(path.join(projectDir, ".env"), "utf-8");
    const todoText = await readFile(path.join(projectDir, "tasks", "todo.md"), "utf-8");
    const handoffText = await readFile(path.join(projectDir, "AGENT_HANDOFF_PROMPT.md"), "utf-8");
    const packageJson = JSON.parse(await readFile(path.join(projectDir, "package.json"), "utf-8"));
    const secretSink = await readFile(secretSinkPath, "utf-8");

    assert.match(envText, /SENTINELAYER_TOKEN=sl_boot_from_generate_123/);
    assert.match(result.stdout, /Falling back to SENTINELAYER_TOKEN/);
    assert.match(todoText, /Repo: `acme\/demo-repo`/);
    assert.match(handoffText, /Required secret name: SENTINELAYER_TOKEN/);
    assert.match(handoffText, /Terminal command options:/);
    assert.match(handoffText, /sentinel \/omargate deep --path \./);
    assert.match(handoffText, /Workflow tuning options:/);
    assert.match(handoffText, /scan_mode: deep/);
    assert.equal(packageJson.scripts["sentinel:start"].includes("Sentinelayer artifacts are ready"), true);
    assert.match(String(packageJson.scripts["sentinel:omargate"] || ""), /\/omargate deep --path \./);
    assert.match(String(packageJson.scripts["sentinel:omargate:json"] || ""), /\/omargate deep --path \. --json/);
    assert.match(String(packageJson.scripts["sentinel:audit"] || ""), /\/audit --path \./);
    assert.match(String(packageJson.scripts["sentinel:audit:json"] || ""), /\/audit --path \. --json/);
    assert.match(String(packageJson.scripts["sentinel:persona:builder"] || ""), /--mode builder/);
    assert.match(String(packageJson.scripts["sentinel:apply"] || ""), /\/apply --plan tasks\/todo\.md/);
    assert.match(secretSink, /acme\/demo-repo\|SENTINELAYER_TOKEN\|sl_boot_from_generate_123/);

    assert.equal(mock.state.generateAuthHeader, "Bearer web_auth_token_abc");
    assert.equal(mock.state.generatePayload.model_provider, "openai");
    assert.equal(mock.state.generatePayload.model_id, "gpt-5.3-codex");
  } finally {
    await mock.close();
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("CLI fallback workflow binds dynamically to API-provided secret name", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "create-sentinelayer-e2e-"));
  const mock = await startMockApi({
    includeBootstrapInGenerate: true,
    includeOmarWorkflowInGenerate: false,
    requiredSecretName: "SENTINELAYER_BETA_TOKEN",
  });

  try {
    const env = {
      ...process.env,
      SENTINELAYER_API_URL: mock.apiUrl,
      SENTINELAYER_WEB_URL: "http://127.0.0.1",
      SENTINELAYER_CLI_NON_INTERACTIVE: "1",
      SENTINELAYER_CLI_SKIP_BROWSER_OPEN: "1",
      SENTINELAYER_CLI_INTERVIEW_JSON: JSON.stringify(baseInterview()),
    };

    const result = await runCli({ cwd: tempRoot, env, args: ["demo-app", "--non-interactive"] });
    assert.equal(result.code, 0, result.stderr || result.stdout);

    const workflowText = await readFile(
      path.join(tempRoot, "demo-app", ".github", "workflows", "omar-gate.yml"),
      "utf-8"
    );
    assert.match(workflowText, /sentinelayer_token:\s*\$\{\{\s*secrets\.SENTINELAYER_BETA_TOKEN\s*\}\}/);
  } finally {
    await mock.close();
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("CLI end-to-end: builds a feature into a cloned existing repo", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "create-sentinelayer-e2e-"));
  const mock = await startMockApi({ includeBootstrapInGenerate: true });

  try {
    const repoFixture = await createGithubRepoFixture(tempRoot, {
      owner: "acme",
      repo: "inventory-service",
    });

    const env = {
      ...process.env,
      SENTINELAYER_API_URL: mock.apiUrl,
      SENTINELAYER_WEB_URL: "http://127.0.0.1",
      SENTINELAYER_GITHUB_CLONE_BASE_URL: repoFixture.cloneBaseUrl,
      SENTINELAYER_CLI_NON_INTERACTIVE: "1",
      SENTINELAYER_CLI_SKIP_BROWSER_OPEN: "1",
      SENTINELAYER_CLI_INTERVIEW_JSON: JSON.stringify(
        baseInterview({
          projectName: "",
          projectDescription: "Build a feature into an existing codebase and preserve repository state.",
          projectType: "add_feature",
          connectRepo: true,
          repoSlug: repoFixture.repoSlug,
          buildFromExistingRepo: true,
          injectSecret: false,
        })
      ),
    };

    const result = await runCli({ cwd: tempRoot, env, args: ["--non-interactive"] });
    assert.equal(result.code, 0, result.stderr || result.stdout);
    assert.match(result.stdout, /Cloned repo workspace:/);
    assert.match(result.stdout, /Sentinelayer orchestration initialized/);

    const repoDir = path.join(tempRoot, "inventory-service");
    const pkg = JSON.parse(await readFile(path.join(repoDir, "package.json"), "utf-8"));
    const specText = await readFile(path.join(repoDir, "docs", "spec.md"), "utf-8");
    const todoText = await readFile(path.join(repoDir, "tasks", "todo.md"), "utf-8");

    assert.equal(pkg.scripts.test, "echo test");
    assert.ok(pkg.scripts["sentinel:start"]);
    assert.match(String(pkg.scripts["sentinel:omargate"] || ""), /\/omargate deep --path \./);
    assert.match(String(pkg.scripts["sentinel:omargate:json"] || ""), /\/omargate deep --path \. --json/);
    assert.match(String(pkg.scripts["sentinel:audit"] || ""), /\/audit --path \./);
    assert.match(String(pkg.scripts["sentinel:audit:json"] || ""), /\/audit --path \. --json/);
    assert.match(specText, /# Spec/);
    assert.match(todoText, /Workspace mode: `existing repo clone`/);
    assert.match(todoText, /Repo: `acme\/inventory-service`/);
    assert.match(String(mock.state.generatePayload?.description || ""), /Existing repo context:/);
    assert.match(String(mock.state.generatePayload?.description || ""), /Top-level files: .*README\.md/);
    assert.match(String(mock.state.generatePayload?.description || ""), /package scripts: test/);

    const remote = runCommand({
      cwd: repoDir,
      command: "git",
      args: ["config", "--get", "remote.origin.url"],
    });
    assert.equal(
      String(remote.stdout || "").trim(),
      `${repoFixture.cloneBaseUrl}/acme/inventory-service.git`
    );
  } finally {
    await mock.close();
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("CLI end-to-end: builds deterministically into a cloned empty GitHub repo", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "create-sentinelayer-e2e-"));
  const mock = await startMockApi({ includeBootstrapInGenerate: true });

  try {
    const repoFixture = await createEmptyGithubRepoFixture(tempRoot, {
      owner: "acme",
      repo: "greenfield-empty",
    });

    const env = {
      ...process.env,
      SENTINELAYER_API_URL: mock.apiUrl,
      SENTINELAYER_WEB_URL: "http://127.0.0.1",
      SENTINELAYER_GITHUB_CLONE_BASE_URL: repoFixture.cloneBaseUrl,
      SENTINELAYER_CLI_NON_INTERACTIVE: "1",
      SENTINELAYER_CLI_SKIP_BROWSER_OPEN: "1",
      SENTINELAYER_CLI_INTERVIEW_JSON: JSON.stringify(
        baseInterview({
          projectName: "",
          projectDescription: "Scaffold into an empty repository with deterministic outputs.",
          projectType: "add_feature",
          connectRepo: true,
          repoSlug: repoFixture.repoSlug,
          buildFromExistingRepo: true,
          injectSecret: false,
        })
      ),
    };

    const result = await runCli({ cwd: tempRoot, env, args: ["--non-interactive"] });
    assert.equal(result.code, 0, result.stderr || result.stdout);
    assert.match(result.stdout, /Cloned repo workspace:/);

    const repoDir = path.join(tempRoot, "greenfield-empty");
    const pkg = JSON.parse(await readFile(path.join(repoDir, "package.json"), "utf-8"));
    const specText = await readFile(path.join(repoDir, "docs", "spec.md"), "utf-8");
    const todoText = await readFile(path.join(repoDir, "tasks", "todo.md"), "utf-8");

    assert.match(String(pkg.scripts["sentinel:start"] || ""), /Sentinelayer artifacts are ready/);
    assert.match(String(pkg.scripts["sentinel:omargate"] || ""), /\/omargate deep --path \./);
    assert.match(String(pkg.scripts["sentinel:audit"] || ""), /\/audit --path \./);
    assert.match(specText, /# Spec/);
    assert.match(todoText, /Workspace mode: `existing repo clone`/);
    assert.match(todoText, /Repo: `acme\/greenfield-empty`/);
    assert.match(String(mock.state.generatePayload?.description || ""), /Top-level files: none/);
    assert.match(String(mock.state.generatePayload?.description || ""), /Top-level directories: none/);

    const remote = runCommand({
      cwd: repoDir,
      command: "git",
      args: ["config", "--get", "remote.origin.url"],
    });
    assert.equal(
      String(remote.stdout || "").trim(),
      `${repoFixture.cloneBaseUrl}/acme/greenfield-empty.git`
    );
  } finally {
    await mock.close();
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("CLI existing-repo mode fails when target folder is git repo without GitHub origin", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "create-sentinelayer-e2e-"));
  const mock = await startMockApi({ includeBootstrapInGenerate: true });

  try {
    const collidingRepoDir = path.join(tempRoot, "inventory-service");
    await mkdir(collidingRepoDir, { recursive: true });
    runCommand({ cwd: collidingRepoDir, command: "git", args: ["init"] });
    await writeFile(path.join(collidingRepoDir, "README.md"), "# Local Repo\n", "utf-8");
    runCommand({ cwd: collidingRepoDir, command: "git", args: ["add", "."] });
    runCommand({
      cwd: collidingRepoDir,
      command: "git",
      args: ["-c", "user.name=Sentinelayer E2E", "-c", "user.email=e2e@sentinelayer.local", "commit", "-m", "seed"],
    });

    const env = {
      ...process.env,
      SENTINELAYER_API_URL: mock.apiUrl,
      SENTINELAYER_WEB_URL: "http://127.0.0.1",
      SENTINELAYER_CLI_NON_INTERACTIVE: "1",
      SENTINELAYER_CLI_SKIP_BROWSER_OPEN: "1",
      SENTINELAYER_CLI_INTERVIEW_JSON: JSON.stringify(
        baseInterview({
          projectName: "",
          projectDescription: "Add audit feature into existing repo and preserve safety guarantees.",
          projectType: "add_feature",
          connectRepo: true,
          repoSlug: "acme/inventory-service",
          buildFromExistingRepo: true,
          injectSecret: false,
        })
      ),
    };

    const result = await runCli({ cwd: tempRoot, env, args: ["--non-interactive"] });
    assert.equal(result.code, 1);
    assert.match(result.stderr + result.stdout, /git repo without a detectable GitHub origin/i);
  } finally {
    await mock.close();
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("CLI end-to-end: falls back to /builder/bootstrap-token when generate omits bootstrap token", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "create-sentinelayer-e2e-"));
  const mock = await startMockApi({ includeBootstrapInGenerate: false });

  try {
    const env = {
      ...process.env,
      SENTINELAYER_API_URL: mock.apiUrl,
      SENTINELAYER_WEB_URL: "http://127.0.0.1",
      SENTINELAYER_CLI_NON_INTERACTIVE: "1",
      SENTINELAYER_CLI_SKIP_BROWSER_OPEN: "1",
      SENTINELAYER_CLI_INTERVIEW_JSON: JSON.stringify(baseInterview()),
    };

    const result = await runCli({ cwd: tempRoot, env, args: ["demo-app", "--non-interactive"] });
    assert.equal(result.code, 0, result.stderr || result.stdout);

    const envText = await readFile(path.join(tempRoot, "demo-app", ".env"), "utf-8");
    assert.match(envText, /SENTINELAYER_TOKEN=sl_boot_from_bootstrap_endpoint_456/);
    assert.equal(mock.state.bootstrapCalls, 1);
  } finally {
    await mock.close();
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("CLI non-interactive BYOK mode scaffolds without Sentinelayer auth/token", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "create-sentinelayer-e2e-"));
  const secretSinkPath = path.join(tempRoot, "secret-sink.log");
  try {
    const env = {
      ...process.env,
      SENTINELAYER_API_URL: "http://127.0.0.1:9",
      SENTINELAYER_WEB_URL: "http://127.0.0.1",
      SENTINELAYER_CLI_NON_INTERACTIVE: "1",
      SENTINELAYER_CLI_SKIP_BROWSER_OPEN: "1",
      SENTINELAYER_SECRET_SINK_FILE: secretSinkPath,
      SENTINELAYER_CLI_INTERVIEW_JSON: JSON.stringify(
        baseInterview({
          projectName: "byok-app",
          authMode: "byok",
          connectRepo: true,
          repoSlug: "acme/byok-app",
          injectSecret: true,
        })
      ),
    };

    const result = await runCli({ cwd: tempRoot, env, args: ["byok-app", "--non-interactive"] });
    assert.equal(result.code, 0, result.stderr || result.stdout);
    assert.match(result.stdout, /BYOK mode selected/i);
    assert.match(result.stdout, /BYOK mode active/i);

    const projectDir = path.join(tempRoot, "byok-app");
    const workflowText = await readFile(path.join(projectDir, ".github", "workflows", "omar-gate.yml"), "utf-8");
    const todoText = await readFile(path.join(projectDir, "tasks", "todo.md"), "utf-8");
    const handoffText = await readFile(path.join(projectDir, "AGENT_HANDOFF_PROMPT.md"), "utf-8");
    const specText = await readFile(path.join(projectDir, "docs", "spec.md"), "utf-8");

    assert.match(workflowText, /Omar Gate \(BYOK Mode\)/);
    assert.match(todoText, /Auth mode: `byok`/);
    assert.match(handoffText, /Sentinelayer token: not configured \(BYOK mode\)/);
    assert.match(handoffText, /sentinel \/apply --plan tasks\/todo\.md --path \./);
    assert.match(handoffText, /BYOK workflow is guidance-only/);
    assert.match(specText, /## Goal/);
    assert.match(specText, /autonomous secure code review orchestrator/i);

    await assert.rejects(readFile(path.join(projectDir, ".env"), "utf-8"));
    await assert.rejects(readFile(secretSinkPath, "utf-8"));
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("CLI subcommand: init supports command-tree scaffold invocation", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "create-sentinelayer-e2e-"));
  try {
    const env = {
      ...process.env,
      SENTINELAYER_API_URL: "http://127.0.0.1:9",
      SENTINELAYER_WEB_URL: "http://127.0.0.1",
      SENTINELAYER_CLI_NON_INTERACTIVE: "1",
      SENTINELAYER_CLI_SKIP_BROWSER_OPEN: "1",
      SENTINELAYER_CLI_INTERVIEW_JSON: JSON.stringify(
        baseInterview({
          projectName: "init-subcommand-app",
          authMode: "byok",
          connectRepo: false,
          injectSecret: false,
        })
      ),
    };

    const result = await runCli({
      cwd: tempRoot,
      env,
      args: ["init", "init-subcommand-app", "--non-interactive"],
    });
    assert.equal(result.code, 0, result.stderr || result.stdout);
    assert.match(result.stdout, /BYOK mode selected/i);

    const specText = await readFile(path.join(tempRoot, "init-subcommand-app", "docs", "spec.md"), "utf-8");
    assert.match(specText, /## Goal/);
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("CLI config commands: set/get/list project scope", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "create-sentinelayer-config-"));
  try {
    const setResult = await runCli({
      cwd: tempRoot,
      env: { ...process.env },
      args: [
        "config",
        "set",
        "defaultModelProvider",
        "anthropic",
        "--scope",
        "project",
        "--path",
        tempRoot,
        "--json",
      ],
    });
    assert.equal(setResult.code, 0, setResult.stderr || setResult.stdout);
    const setPayload = JSON.parse(String(setResult.stdout || "").trim());
    assert.equal(setPayload.scope, "project");
    assert.equal(setPayload.key, "defaultModelProvider");
    assert.equal(setPayload.value, "anthropic");

    const projectConfigText = await readFile(path.join(tempRoot, ".sentinelayer.yml"), "utf-8");
    assert.match(projectConfigText, /defaultModelProvider:\s*anthropic/);

    const getResult = await runCli({
      cwd: tempRoot,
      env: { ...process.env },
      args: ["config", "get", "defaultModelProvider", "--scope", "resolved", "--path", tempRoot, "--json"],
    });
    assert.equal(getResult.code, 0, getResult.stderr || getResult.stdout);
    const getPayload = JSON.parse(String(getResult.stdout || "").trim());
    assert.equal(getPayload.value, "anthropic");
    assert.equal(getPayload.source, "project");

    const listResult = await runCli({
      cwd: tempRoot,
      env: { ...process.env },
      args: ["config", "list", "--scope", "project", "--path", tempRoot, "--json"],
    });
    assert.equal(listResult.code, 0, listResult.stderr || listResult.stdout);
    const listPayload = JSON.parse(String(listResult.stdout || "").trim());
    assert.equal(listPayload.config.defaultModelProvider, "anthropic");
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("CLI config resolved scope gives precedence to environment overrides", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "create-sentinelayer-config-"));
  try {
    await writeFile(path.join(tempRoot, ".sentinelayer.yml"), "apiUrl: https://project.example\n", "utf-8");

    const result = await runCli({
      cwd: tempRoot,
      env: {
        ...process.env,
        SENTINELAYER_API_URL: "https://env.example",
      },
      args: ["config", "get", "apiUrl", "--scope", "resolved", "--path", tempRoot, "--json"],
    });
    assert.equal(result.code, 0, result.stderr || result.stdout);
    const payload = JSON.parse(String(result.stdout || "").trim());
    assert.equal(payload.value, "https://env.example");
    assert.equal(payload.source, "env");
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("CLI non-interactive mode fails fast when interview payload is missing", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "create-sentinelayer-e2e-"));
  try {
    const env = {
      ...process.env,
      SENTINELAYER_CLI_NON_INTERACTIVE: "1",
      SENTINELAYER_CLI_SKIP_BROWSER_OPEN: "1",
      SENTINELAYER_CLI_INTERVIEW_JSON: "",
    };

    const result = await runCli({ cwd: tempRoot, env, args: ["demo-app", "--non-interactive"] });
    assert.equal(result.code, 1);
    assert.match(result.stderr + result.stdout, /Non-interactive mode requires/);
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("CLI flags: --help and --version return successfully", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "create-sentinelayer-e2e-"));
  try {
    const helpResult = await runCli({
      cwd: tempRoot,
      env: { ...process.env },
      args: ["--help"],
    });
    assert.equal(helpResult.code, 0, helpResult.stderr || helpResult.stdout);
    assert.match(helpResult.stdout, /Usage:/);
    assert.match(helpResult.stdout, /--non-interactive/);

    const versionResult = await runCli({
      cwd: tempRoot,
      env: { ...process.env },
      args: ["--version"],
    });
    const pkg = JSON.parse(await readFile(path.resolve(__dirname, "..", "package.json"), "utf-8"));
    assert.equal(versionResult.code, 0, versionResult.stderr || versionResult.stdout);
    assert.equal(versionResult.stdout.trim(), pkg.version);
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("Package metadata exposes sentinel binary alias", async () => {
  const pkg = JSON.parse(await readFile(path.resolve(__dirname, "..", "package.json"), "utf-8"));
  assert.equal(pkg.bin["create-sentinelayer"], "bin/create-sentinelayer.js");
  assert.equal(pkg.bin.sentinel, "bin/create-sentinelayer.js");
});

test("CLI local command: /omargate deep writes report and fails on P1 findings", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "create-sentinelayer-cmd-"));
  try {
    const srcDir = path.join(tempRoot, "src");
    await mkdir(srcDir, { recursive: true });
    await writeFile(
      path.join(srcDir, "secrets.ts"),
      "export const leaked = 'AKIAABCDEFGHIJKLMNOP';\n",
      "utf-8"
    );

    const result = await runCli({
      cwd: tempRoot,
      env: { ...process.env },
      args: ["/omargate", "deep", "--path", tempRoot],
    });
    assert.equal(result.code, 2);
    assert.match(result.stdout + result.stderr, /Blocking findings detected/);

    const reportDir = path.join(tempRoot, ".sentinelayer", "reports");
    const files = await readdir(reportDir);
    const reportName = files.find((name) => name.startsWith("omargate-deep-") && name.endsWith(".md"));
    assert.ok(reportName, "Expected omargate report file");

    const reportText = await readFile(path.join(reportDir, reportName), "utf-8");
    assert.match(reportText, /P1 findings: 1/);
    assert.match(reportText, /\[P1\] src\/secrets\.ts:1/);
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("CLI subcommand: omargate deep maps to legacy local command implementation", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "create-sentinelayer-cmd-"));
  try {
    const srcDir = path.join(tempRoot, "src");
    await mkdir(srcDir, { recursive: true });
    await writeFile(
      path.join(srcDir, "secrets.ts"),
      "export const leaked = 'AKIAABCDEFGHIJKLMNOP';\n",
      "utf-8"
    );

    const result = await runCli({
      cwd: tempRoot,
      env: { ...process.env },
      args: ["omargate", "deep", "--path", tempRoot, "--json"],
    });
    assert.equal(result.code, 2);

    const payload = JSON.parse(String(result.stdout || "").trim());
    assert.equal(payload.command, "/omargate deep");
    assert.equal(payload.blocking, true);
    assert.match(String(payload.reportPath || ""), /[\\/]\.sentinelayer[\\/]reports[\\/]omargate-deep-/);
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("CLI local command: /audit writes pass report for prepared workspace", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "create-sentinelayer-cmd-"));
  try {
    await mkdir(path.join(tempRoot, ".github", "workflows"), { recursive: true });
    await mkdir(path.join(tempRoot, "docs"), { recursive: true });
    await mkdir(path.join(tempRoot, "tasks"), { recursive: true });
    await writeFile(path.join(tempRoot, ".github", "workflows", "omar-gate.yml"), "name: Omar Gate\n", "utf-8");
    await writeFile(path.join(tempRoot, "docs", "spec.md"), "# Spec\n", "utf-8");
    await writeFile(path.join(tempRoot, "tasks", "todo.md"), "# Todo\n", "utf-8");

    const result = await runCli({
      cwd: tempRoot,
      env: { ...process.env },
      args: ["/audit", "--path", tempRoot],
    });
    assert.equal(result.code, 0, result.stderr || result.stdout);
    assert.match(result.stdout, /Overall status: PASS/);

    const reportDir = path.join(tempRoot, ".sentinelayer", "reports");
    const files = await readdir(reportDir);
    const reportName = files.find((name) => name.startsWith("audit-") && name.endsWith(".md"));
    assert.ok(reportName, "Expected audit report file");

    const reportText = await readFile(path.join(reportDir, reportName), "utf-8");
    assert.match(reportText, /Overall status: PASS/);
    assert.match(reportText, /\[x\] \(P1\) \.github\/workflows\/omar-gate\.yml/);
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("CLI local command: /audit --json emits machine-readable summary", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "create-sentinelayer-cmd-"));
  try {
    await mkdir(path.join(tempRoot, ".github", "workflows"), { recursive: true });
    await mkdir(path.join(tempRoot, "docs"), { recursive: true });
    await mkdir(path.join(tempRoot, "tasks"), { recursive: true });
    await writeFile(path.join(tempRoot, ".github", "workflows", "omar-gate.yml"), "name: Omar Gate\n", "utf-8");
    await writeFile(path.join(tempRoot, "docs", "spec.md"), "# Spec\n", "utf-8");
    await writeFile(path.join(tempRoot, "tasks", "todo.md"), "# Todo\n", "utf-8");

    const result = await runCli({
      cwd: tempRoot,
      env: { ...process.env },
      args: ["/audit", "--path", tempRoot, "--json"],
    });
    assert.equal(result.code, 0, result.stderr || result.stdout);

    const payload = JSON.parse(String(result.stdout || "").trim());
    assert.equal(payload.command, "/audit");
    assert.equal(payload.overallStatus, "PASS");
    assert.equal(payload.blocking, false);
    assert.match(String(payload.reportPath || ""), /[\\/]\.sentinelayer[\\/]reports[\\/]audit-/);

    const reportText = await readFile(payload.reportPath, "utf-8");
    assert.match(reportText, /Overall status: PASS/);
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("CLI ingest command emits CODEBASE_INGEST artifact with framework and surface hints", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "create-sentinelayer-ingest-"));
  try {
    await mkdir(path.join(tempRoot, "src"), { recursive: true });
    await writeFile(
      path.join(tempRoot, "package.json"),
      `${JSON.stringify(
        {
          name: "ingest-demo",
          version: "0.0.1",
          dependencies: {
            next: "^15.0.0",
            react: "^19.0.0",
            express: "^4.19.0",
          },
        },
        null,
        2
      )}\n`,
      "utf-8"
    );
    await writeFile(path.join(tempRoot, "src", "index.ts"), "export const app = 1;\n", "utf-8");
    await writeFile(path.join(tempRoot, "README.md"), "# Demo\n", "utf-8");

    const result = await runCli({
      cwd: tempRoot,
      env: { ...process.env },
      args: ["ingest", "map", "--path", tempRoot, "--json"],
    });
    assert.equal(result.code, 0, result.stderr || result.stdout);

    const payload = JSON.parse(String(result.stdout || "").trim());
    assert.equal(payload.command, "ingest map");
    assert.match(String(payload.outputPath || ""), /[\\/]\.sentinelayer[\\/]CODEBASE_INGEST\.json$/);
    assert.ok(Array.isArray(payload.frameworks));
    assert.equal(payload.frameworks.includes("nextjs"), true);
    assert.equal(payload.frameworks.includes("express"), true);

    const ingest = JSON.parse(await readFile(payload.outputPath, "utf-8"));
    assert.equal(ingest.summary.filesScanned > 0, true);
    assert.equal(Array.isArray(ingest.entryPoints), true);
    assert.equal(ingest.entryPoints.includes("src/index.ts"), true);
    assert.equal(Array.isArray(ingest.riskSurfaces), true);
    assert.equal(ingest.riskSurfaces.some((item) => item.surface === "supply_chain"), true);
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("CLI ingest command respects .sentinelayerignore patterns", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "create-sentinelayer-ingest-"));
  try {
    await mkdir(path.join(tempRoot, "src"), { recursive: true });
    await writeFile(path.join(tempRoot, "src", "keep.ts"), "export const keep = true;\n", "utf-8");
    await writeFile(path.join(tempRoot, "src", "ignore.ts"), "export const ignored = true;\n", "utf-8");
    await writeFile(path.join(tempRoot, ".sentinelayerignore"), "src/ignore.ts\n", "utf-8");

    const result = await runCli({
      cwd: tempRoot,
      env: { ...process.env },
      args: ["ingest", "map", "--path", tempRoot, "--json"],
    });
    assert.equal(result.code, 0, result.stderr || result.stdout);

    const payload = JSON.parse(String(result.stdout || "").trim());
    const ingest = JSON.parse(await readFile(payload.outputPath, "utf-8"));
    const indexedPaths = ingest.indexedFiles.files.map((item) => item.path);
    assert.equal(indexedPaths.includes("src/keep.ts"), true);
    assert.equal(indexedPaths.includes("src/ignore.ts"), false);
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("CLI spec commands expose templates and generate SPEC.md offline", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "create-sentinelayer-spec-"));
  try {
    await mkdir(path.join(tempRoot, "src"), { recursive: true });
    await writeFile(
      path.join(tempRoot, "package.json"),
      `${JSON.stringify(
        {
          name: "spec-demo",
          version: "0.0.1",
          dependencies: { express: "^4.19.0" },
        },
        null,
        2
      )}\n`,
      "utf-8"
    );
    await writeFile(path.join(tempRoot, "src", "index.ts"), "export const v = 1;\n", "utf-8");

    const listResult = await runCli({
      cwd: tempRoot,
      env: { ...process.env },
      args: ["spec", "list-templates", "--json"],
    });
    assert.equal(listResult.code, 0, listResult.stderr || listResult.stdout);
    const listPayload = JSON.parse(String(listResult.stdout || "").trim());
    assert.equal(Array.isArray(listPayload.templates), true);
    assert.equal(listPayload.templates.some((template) => template.id === "api-service"), true);

    const generateResult = await runCli({
      cwd: tempRoot,
      env: { ...process.env },
      args: [
        "spec",
        "generate",
        "--path",
        tempRoot,
        "--template",
        "api-service",
        "--description",
        "Build hardened API review automation.",
        "--json",
      ],
    });
    assert.equal(generateResult.code, 0, generateResult.stderr || generateResult.stdout);
    const generatePayload = JSON.parse(String(generateResult.stdout || "").trim());
    assert.equal(generatePayload.command, "spec generate");
    assert.match(String(generatePayload.outputPath || ""), /[\\/]SPEC\.md$/);

    const specText = await readFile(generatePayload.outputPath, "utf-8");
    assert.match(specText, /# SPEC - spec-demo/);
    assert.match(specText, /Build hardened API review automation\./);
    assert.match(specText, /## Security Checklist/);
    assert.match(specText, /## Phase Plan/);
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("CLI prompt commands generate and preview agent-targeted prompts from spec", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "create-sentinelayer-prompt-"));
  try {
    await writeFile(
      path.join(tempRoot, "SPEC.md"),
      "# SPEC - Prompt Demo\\n\\n## Goal\\nBuild deterministic prompt generation.\\n",
      "utf-8"
    );

    const generateResult = await runCli({
      cwd: tempRoot,
      env: { ...process.env },
      args: ["prompt", "generate", "--path", tempRoot, "--agent", "codex", "--json"],
    });
    assert.equal(generateResult.code, 0, generateResult.stderr || generateResult.stdout);
    const generatePayload = JSON.parse(String(generateResult.stdout || "").trim());
    assert.equal(generatePayload.command, "prompt generate");
    assert.match(String(generatePayload.outputPath || ""), /[\\/]PROMPT_codex\.md$/);

    const promptText = await readFile(generatePayload.outputPath, "utf-8");
    assert.match(promptText, /Agent target: codex/);
    assert.match(promptText, /# SPEC - Prompt Demo/);

    const previewResult = await runCli({
      cwd: tempRoot,
      env: { ...process.env },
      args: ["prompt", "preview", "--path", tempRoot, "--agent", "claude", "--max-lines", "8", "--json"],
    });
    assert.equal(previewResult.code, 0, previewResult.stderr || previewResult.stdout);
    const previewPayload = JSON.parse(String(previewResult.stdout || "").trim());
    assert.equal(previewPayload.command, "prompt preview");
    assert.equal(previewPayload.agent, "claude");
    assert.equal(previewPayload.lineCount, 8);
    assert.match(String(previewPayload.preview || ""), /Claude Code execution prompt/);
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("CLI local command: /audit resolves report output dir from project config", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "create-sentinelayer-cmd-"));
  try {
    await mkdir(path.join(tempRoot, ".github", "workflows"), { recursive: true });
    await mkdir(path.join(tempRoot, "docs"), { recursive: true });
    await mkdir(path.join(tempRoot, "tasks"), { recursive: true });
    await writeFile(path.join(tempRoot, ".github", "workflows", "omar-gate.yml"), "name: Omar Gate\n", "utf-8");
    await writeFile(path.join(tempRoot, "docs", "spec.md"), "# Spec\n", "utf-8");
    await writeFile(path.join(tempRoot, "tasks", "todo.md"), "# Todo\n", "utf-8");
    await writeFile(path.join(tempRoot, ".sentinelayer.yml"), "outputDir: .sentinelayer-custom\n", "utf-8");

    const result = await runCli({
      cwd: tempRoot,
      env: { ...process.env },
      args: ["/audit", "--path", tempRoot, "--json"],
    });
    assert.equal(result.code, 0, result.stderr || result.stdout);

    const payload = JSON.parse(String(result.stdout || "").trim());
    assert.match(
      String(payload.reportPath || ""),
      /[\\/]\.sentinelayer-custom[\\/]reports[\\/]audit-/
    );

    const reportText = await readFile(payload.reportPath, "utf-8");
    assert.match(reportText, /Overall status: PASS/);
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("CLI local command: /persona orchestrator writes mode report", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "create-sentinelayer-cmd-"));
  try {
    await writeFile(path.join(tempRoot, "package.json"), '{"name":"demo","version":"0.0.1"}\n', "utf-8");

    const result = await runCli({
      cwd: tempRoot,
      env: { ...process.env },
      args: ["/persona", "orchestrator", "--mode", "reviewer", "--path", tempRoot],
    });
    assert.equal(result.code, 0, result.stderr || result.stdout);
    assert.match(result.stdout, /Mode: reviewer/);

    const reportDir = path.join(tempRoot, ".sentinelayer", "reports");
    const files = await readdir(reportDir);
    const reportName = files.find((name) => name.startsWith("persona-orchestrator-reviewer-") && name.endsWith(".md"));
    assert.ok(reportName, "Expected persona report file");

    const reportText = await readFile(path.join(reportDir, reportName), "utf-8");
    assert.match(reportText, /Mode: reviewer/);
    assert.match(reportText, /Prioritize risk discovery/);
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("CLI local command: /persona orchestrator --json emits machine-readable summary", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "create-sentinelayer-cmd-"));
  try {
    const result = await runCli({
      cwd: tempRoot,
      env: { ...process.env },
      args: ["/persona", "orchestrator", "--mode", "hardener", "--path", tempRoot, "--json"],
    });
    assert.equal(result.code, 0, result.stderr || result.stdout);

    const payload = JSON.parse(String(result.stdout || "").trim());
    assert.equal(payload.command, "/persona orchestrator");
    assert.equal(payload.mode, "hardener");
    assert.match(String(payload.reportPath || ""), /[\\/]\.sentinelayer[\\/]reports[\\/]persona-orchestrator-hardener-/);
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("CLI local command: /apply parses todo plan and writes execution preview", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "create-sentinelayer-cmd-"));
  try {
    await mkdir(path.join(tempRoot, "tasks"), { recursive: true });
    await writeFile(
      path.join(tempRoot, "tasks", "todo.md"),
      "# Plan\n- [ ] PR 1: foundation\n- [ ] PR 2: auth\n",
      "utf-8"
    );

    const result = await runCli({
      cwd: tempRoot,
      env: { ...process.env },
      args: ["/apply", "--plan", "tasks/todo.md", "--path", tempRoot],
    });
    assert.equal(result.code, 0, result.stderr || result.stdout);
    assert.match(result.stdout, /Parsed tasks: 2/);

    const reportDir = path.join(tempRoot, ".sentinelayer", "reports");
    const files = await readdir(reportDir);
    const reportName = files.find((name) => name.startsWith("apply-plan-") && name.endsWith(".md"));
    assert.ok(reportName, "Expected apply-plan report file");

    const reportText = await readFile(path.join(reportDir, reportName), "utf-8");
    assert.match(reportText, /1\. PR 1: foundation/);
    assert.match(reportText, /2\. PR 2: auth/);
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("CLI local command: /apply --json emits machine-readable summary", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "create-sentinelayer-cmd-"));
  try {
    await mkdir(path.join(tempRoot, "tasks"), { recursive: true });
    await writeFile(path.join(tempRoot, "tasks", "todo.md"), "- [ ] PR 1: baseline\n", "utf-8");

    const result = await runCli({
      cwd: tempRoot,
      env: { ...process.env },
      args: ["/apply", "--plan", "tasks/todo.md", "--path", tempRoot, "--json"],
    });
    assert.equal(result.code, 0, result.stderr || result.stdout);

    const payload = JSON.parse(String(result.stdout || "").trim());
    assert.equal(payload.command, "/apply");
    assert.equal(payload.taskCount, 1);
    assert.match(String(payload.reportPath || ""), /[\\/]\.sentinelayer[\\/]reports[\\/]apply-plan-/);
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});
