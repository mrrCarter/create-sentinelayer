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
const BOOTSTRAP_VALUE_FROM_GENERATE = ["fixture", "boot", "gen", "value"].join("_");
const BOOTSTRAP_VALUE_FROM_ENDPOINT = ["fixture", "boot", "fallback", "value"].join("_");

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
            token: BOOTSTRAP_VALUE_FROM_GENERATE,
            required_secret_name: requiredSecretName,
          };
        }
        return jsonResponse(res, 200, payload);
      }

      if (req.method === "POST" && req.url === "/api/v1/builder/bootstrap-token") {
        state.bootstrapCalls += 1;
        await readJsonBody(req);
        return jsonResponse(res, 200, {
          token: BOOTSTRAP_VALUE_FROM_ENDPOINT,
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

async function startAidenIdMockApi() {
  const state = {
    requestCount: 0,
    lastHeaders: {},
    lastPayload: null,
  };

  const server = createServer(async (req, res) => {
    try {
      if (req.method === "POST" && req.url === "/v1/identities") {
        state.requestCount += 1;
        state.lastHeaders = { ...req.headers };
        state.lastPayload = await readJsonBody(req);
        return jsonResponse(res, 200, {
          id: "id_123",
          emailAddress: "scan@aidenid.com",
          status: "ACTIVE",
          expiresAt: "2026-05-01T00:00:00.000Z",
          projectId: "proj_test",
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
    throw new Error("Unable to resolve AIdenID mock API address");
  }

  return {
    apiUrl: `http://127.0.0.1:${address.port}`,
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

    assert.match(envText, new RegExp(`SENTINELAYER_TOKEN=${BOOTSTRAP_VALUE_FROM_GENERATE}`));
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
    assert.match(
      secretSink,
      new RegExp(`acme\\/demo-repo\\|SENTINELAYER_TOKEN\\|${BOOTSTRAP_VALUE_FROM_GENERATE}`)
    );

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
    assert.match(envText, new RegExp(`SENTINELAYER_TOKEN=${BOOTSTRAP_VALUE_FROM_ENDPOINT}`));
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

test("Package metadata exposes sentinel and sl binary aliases", async () => {
  const pkg = JSON.parse(await readFile(path.resolve(__dirname, "..", "package.json"), "utf-8"));
  assert.equal(pkg.bin["create-sentinelayer"], "bin/create-sentinelayer.js");
  assert.equal(pkg.bin.sentinel, "bin/create-sentinelayer.js");
  assert.equal(pkg.bin.sl, "bin/sl.js");
});

test("CLI local command: /omargate deep writes report and fails on P1 findings", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "create-sentinelayer-cmd-"));
  try {
    const srcDir = path.join(tempRoot, "src");
    await mkdir(srcDir, { recursive: true });
    await writeFile(
      path.join(srcDir, "secrets.ts"),
      "export const leaked = '" + "AKIA" + "ABCDEFGHIJKLMNOP" + "';\n",
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
      "export const leaked = '" + "AKIA" + "ABCDEFGHIJKLMNOP" + "';\n",
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

test("CLI spec regenerate preserves manual edits, supports dry-run, and emits deterministic diff summary", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "create-sentinelayer-spec-regenerate-"));
  try {
    await mkdir(path.join(tempRoot, "src"), { recursive: true });
    await writeFile(
      path.join(tempRoot, "package.json"),
      `${JSON.stringify(
        {
          name: "spec-regenerate-demo",
          version: "0.0.1",
          dependencies: { express: "^4.19.0" },
        },
        null,
        2
      )}\n`,
      "utf-8"
    );
    await writeFile(path.join(tempRoot, "src", "index.ts"), "export const v = 1;\n", "utf-8");

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
        "Initial generated goal.",
        "--json",
      ],
    });
    assert.equal(generateResult.code, 0, generateResult.stderr || generateResult.stdout);
    const generatePayload = JSON.parse(String(generateResult.stdout || "").trim());
    const specPath = String(generatePayload.outputPath || "");

    const generatedSpec = await readFile(specPath, "utf-8");
    const manualSpec = generatedSpec.replace(
      /## Goal[\s\S]*?(?=\n##\s)/,
      ["## Goal", "Manual operator goal override for this sprint.", "", ""].join("\n")
    );
    await writeFile(specPath, manualSpec, "utf-8");

    const dryRunResult = await runCli({
      cwd: tempRoot,
      env: { ...process.env },
      args: ["spec", "regenerate", "--path", tempRoot, "--dry-run", "--json"],
    });
    assert.equal(dryRunResult.code, 0, dryRunResult.stderr || dryRunResult.stdout);
    const dryRunPayload = JSON.parse(String(dryRunResult.stdout || "").trim());
    assert.equal(dryRunPayload.command, "spec regenerate");
    assert.equal(dryRunPayload.dryRun, true);
    assert.equal(dryRunPayload.preserveManual, true);
    assert.equal(dryRunPayload.summary.preservedManualSections.includes("Goal"), true);
    assert.equal(dryRunPayload.diff.changed, true);

    const postDryRunSpec = await readFile(specPath, "utf-8");
    assert.match(postDryRunSpec, /Manual operator goal override for this sprint\./);

    const writeResult = await runCli({
      cwd: tempRoot,
      env: { ...process.env },
      args: ["spec", "regenerate", "--path", tempRoot, "--json"],
    });
    assert.equal(writeResult.code, 0, writeResult.stderr || writeResult.stdout);
    const writePayload = JSON.parse(String(writeResult.stdout || "").trim());
    assert.equal(writePayload.command, "spec regenerate");
    assert.equal(writePayload.wroteFile, true);

    const updatedSpec = await readFile(specPath, "utf-8");
    assert.match(updatedSpec, /Manual operator goal override for this sprint\./);

    const quietResult = await runCli({
      cwd: tempRoot,
      env: { ...process.env },
      args: ["spec", "regenerate", "--path", tempRoot, "--dry-run", "--quiet"],
    });
    assert.equal(quietResult.code, 0, quietResult.stderr || quietResult.stdout);
    assert.doesNotMatch(String(quietResult.stderr || ""), /\[progress /);
    assert.doesNotMatch(String(quietResult.stdout || ""), /\u001B\]9;/);
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

test("CLI markdown show commands load spec/prompt/guide artifacts deterministically", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "create-sentinelayer-markdown-show-"));
  try {
    await writeFile(
      path.join(tempRoot, "SPEC.md"),
      [
        "# SPEC - Markdown Demo",
        "",
        "## Endpoints",
        "| Path | Method |",
        "| --- | --- |",
        "| /health | GET |",
        "",
        "```ts",
        "export const status = 'ok';",
        "```",
      ].join("\n"),
      "utf-8"
    );
    await writeFile(
      path.join(tempRoot, "PROMPT_generic.md"),
      "# Prompt\n\nUse **deterministic** review with `sl review --diff`.\n",
      "utf-8"
    );
    await writeFile(
      path.join(tempRoot, "BUILD_GUIDE.md"),
      "# Build Guide\n\n- [ ] Wire auth\n- [ ] Add coverage\n",
      "utf-8"
    );

    const specShow = await runCli({
      cwd: tempRoot,
      env: { ...process.env },
      args: ["spec", "show", "--path", tempRoot, "--json"],
    });
    assert.equal(specShow.code, 0, specShow.stderr || specShow.stdout);
    const specPayload = JSON.parse(String(specShow.stdout || "").trim());
    assert.equal(specPayload.command, "spec show");
    assert.match(String(specPayload.preview || ""), /# SPEC - Markdown Demo/);
    assert.match(String(specPayload.preview || ""), /\| \/health \| GET \|/);

    const promptShow = await runCli({
      cwd: tempRoot,
      env: { ...process.env },
      args: [
        "prompt",
        "show",
        "--path",
        tempRoot,
        "--file",
        "PROMPT_generic.md",
        "--json",
      ],
    });
    assert.equal(promptShow.code, 0, promptShow.stderr || promptShow.stdout);
    const promptPayload = JSON.parse(String(promptShow.stdout || "").trim());
    assert.equal(promptPayload.command, "prompt show");
    assert.match(String(promptPayload.preview || ""), /Use \*\*deterministic\*\* review/);

    const guideShow = await runCli({
      cwd: tempRoot,
      env: { ...process.env },
      args: ["guide", "show", "--path", tempRoot, "--json"],
    });
    assert.equal(guideShow.code, 0, guideShow.stderr || guideShow.stdout);
    const guidePayload = JSON.parse(String(guideShow.stdout || "").trim());
    assert.equal(guidePayload.command, "guide show");
    assert.match(String(guidePayload.preview || ""), /# Build Guide/);
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("CLI scan init generates security-review workflow from spec profile", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "create-sentinelayer-scan-"));
  try {
    await writeFile(
      path.join(tempRoot, "SPEC.md"),
      [
        "# SPEC - Scan Demo",
        "",
        "## Goal",
        "Harden auth, token, payment, and compliance flows for production rollout.",
        "",
        "## Security Checklist",
        "1. Prevent secrets leakage",
        "2. Enforce supply_chain controls",
        "3. Add dependency monitoring",
        "",
        "## Acceptance Criteria",
        "1. Add E2E coverage for login and payment journeys.",
      ].join("\n"),
      "utf-8"
    );

    const initResult = await runCli({
      cwd: tempRoot,
      env: { ...process.env },
      args: [
        "scan",
        "init",
        "--path",
        tempRoot,
        "--non-interactive",
        "--has-e2e-tests",
        "yes",
        "--json",
      ],
    });
    assert.equal(initResult.code, 0, initResult.stderr || initResult.stdout);

    const initPayload = JSON.parse(String(initResult.stdout || "").trim());
    assert.equal(initPayload.command, "scan init");
    assert.equal(initPayload.profile.scanMode, "deep");
    assert.equal(initPayload.profile.severityGate, "P2");
    assert.equal(initPayload.profile.playwrightMode, "audit");
    assert.equal(initPayload.profile.sbomMode, "audit");
    assert.match(String(initPayload.workflowPath || ""), /[\\/]security-review\.yml$/);

    const workflowText = await readFile(initPayload.workflowPath, "utf-8");
    assert.match(workflowText, /name: Security Review/);
    assert.match(workflowText, /scan_mode: deep/);
    assert.match(workflowText, /severity_gate: P2/);
    assert.match(workflowText, /playwright_mode: audit/);
    assert.match(workflowText, /sbom_mode: audit/);
    assert.match(workflowText, /sentinelayer_token:\s*\$\{\{\s*secrets\.SENTINELAYER_TOKEN\s*\}\}/);

    const validateResult = await runCli({
      cwd: tempRoot,
      env: { ...process.env },
      args: [
        "scan",
        "validate",
        "--path",
        tempRoot,
        "--has-e2e-tests",
        "yes",
        "--json",
      ],
    });
    assert.equal(validateResult.code, 0, validateResult.stderr || validateResult.stdout);

    const validatePayload = JSON.parse(String(validateResult.stdout || "").trim());
    assert.equal(validatePayload.command, "scan validate");
    assert.equal(validatePayload.aligned, true);
    assert.equal(Array.isArray(validatePayload.mismatches), true);
    assert.equal(validatePayload.mismatches.length, 0);
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("CLI scan validate detects workflow drift against current spec profile", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "create-sentinelayer-scan-"));
  try {
    await writeFile(
      path.join(tempRoot, "SPEC.md"),
      [
        "# SPEC - Scan Drift Demo",
        "",
        "## Goal",
        "Protect auth and tenant boundaries with supply chain hardening.",
        "",
        "## Security Checklist",
        "1. Add dependency controls",
      ].join("\n"),
      "utf-8"
    );

    const initResult = await runCli({
      cwd: tempRoot,
      env: { ...process.env },
      args: [
        "scan",
        "init",
        "--path",
        tempRoot,
        "--non-interactive",
        "--has-e2e-tests",
        "no",
        "--json",
      ],
    });
    assert.equal(initResult.code, 0, initResult.stderr || initResult.stdout);
    const initPayload = JSON.parse(String(initResult.stdout || "").trim());

    const originalWorkflow = await readFile(initPayload.workflowPath, "utf-8");
    const driftedWorkflow = originalWorkflow.replace("severity_gate: P2", "severity_gate: P1");
    await writeFile(initPayload.workflowPath, driftedWorkflow, "utf-8");

    const validateResult = await runCli({
      cwd: tempRoot,
      env: { ...process.env },
      args: [
        "scan",
        "validate",
        "--path",
        tempRoot,
        "--has-e2e-tests",
        "no",
        "--json",
      ],
    });
    assert.equal(validateResult.code, 2);

    const validatePayload = JSON.parse(String(validateResult.stdout || "").trim());
    assert.equal(validatePayload.aligned, false);
    assert.equal(
      validatePayload.mismatches.some((mismatch) => mismatch.field === "severity_gate"),
      true
    );
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("CLI guide generate creates BUILD_GUIDE.md with phases, dependencies, and acceptance criteria", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "create-sentinelayer-guide-"));
  try {
    await writeFile(
      path.join(tempRoot, "SPEC.md"),
      [
        "# SPEC - Guide Demo",
        "",
        "## Goal",
        "Ship deterministic autonomous review automation.",
        "",
        "## Acceptance Criteria",
        "1. Core flow is implemented and tested.",
        "2. Security controls are enforced.",
        "3. CI gates stay deterministic.",
        "",
        "## Phase Plan",
        "### Phase 1 - Foundation",
        "1. Define architecture boundaries.",
        "2. Establish baseline scaffolding.",
        "",
        "### Phase 2 - Core Delivery",
        "1. Implement primary workflow end-to-end.",
        "2. Add telemetry and error handling.",
        "",
        "### Phase 3 - Hardening",
        "1. Add security regression tests.",
        "2. Validate rollback plan.",
      ].join("\n"),
      "utf-8"
    );

    const generateResult = await runCli({
      cwd: tempRoot,
      env: { ...process.env },
      args: ["guide", "generate", "--path", tempRoot, "--json"],
    });
    assert.equal(generateResult.code, 0, generateResult.stderr || generateResult.stdout);

    const payload = JSON.parse(String(generateResult.stdout || "").trim());
    assert.equal(payload.command, "guide generate");
    assert.match(String(payload.outputPath || ""), /[\\/]BUILD_GUIDE\.md$/);
    assert.equal(Array.isArray(payload.phases), true);
    assert.equal(payload.phases.length, 3);

    const guideText = await readFile(payload.outputPath, "utf-8");
    assert.match(guideText, /# BUILD GUIDE - Guide Demo/);
    assert.match(guideText, /- Estimated effort: \d+-\d+ hours/);
    assert.match(guideText, /- Dependencies: none \(entry phase\)/);
    assert.match(guideText, /#### Acceptance Criteria/);
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("CLI guide export emits jira, linear, and github-issues formats", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "create-sentinelayer-guide-"));
  try {
    await writeFile(
      path.join(tempRoot, "SPEC.md"),
      [
        "# SPEC - Export Demo",
        "",
        "## Goal",
        "Export implementation phases to trackers.",
        "",
        "## Acceptance Criteria",
        "1. Tickets include dependencies.",
        "",
        "## Phase Plan",
        "### Phase 1 - Foundation",
        "1. Setup command scaffolding.",
        "",
        "### Phase 2 - Delivery",
        "1. Add guide generation command.",
      ].join("\n"),
      "utf-8"
    );

    const jiraResult = await runCli({
      cwd: tempRoot,
      env: { ...process.env },
      args: ["guide", "export", "--path", tempRoot, "--format", "jira", "--json"],
    });
    assert.equal(jiraResult.code, 0, jiraResult.stderr || jiraResult.stdout);
    const jiraPayload = JSON.parse(String(jiraResult.stdout || "").trim());
    assert.equal(jiraPayload.command, "guide export");
    assert.equal(jiraPayload.format, "jira");
    const jiraFile = JSON.parse(await readFile(jiraPayload.outputPath, "utf-8"));
    assert.equal(jiraFile.format, "jira");
    assert.equal(Array.isArray(jiraFile.issues), true);
    assert.equal(jiraFile.issues.length, 2);

    const linearResult = await runCli({
      cwd: tempRoot,
      env: { ...process.env },
      args: ["guide", "export", "--path", tempRoot, "--format", "linear", "--json"],
    });
    assert.equal(linearResult.code, 0, linearResult.stderr || linearResult.stdout);
    const linearPayload = JSON.parse(String(linearResult.stdout || "").trim());
    assert.equal(linearPayload.format, "linear");
    const linearFile = JSON.parse(await readFile(linearPayload.outputPath, "utf-8"));
    assert.equal(linearFile.format, "linear");
    assert.equal(Array.isArray(linearFile.issues), true);
    assert.equal(linearFile.issues.length, 2);

    const githubResult = await runCli({
      cwd: tempRoot,
      env: { ...process.env },
      args: ["guide", "export", "--path", tempRoot, "--format", "github-issues", "--json"],
    });
    assert.equal(githubResult.code, 0, githubResult.stderr || githubResult.stdout);
    const githubPayload = JSON.parse(String(githubResult.stdout || "").trim());
    assert.equal(githubPayload.format, "github-issues");
    const githubBody = await readFile(githubPayload.outputPath, "utf-8");
    assert.match(githubBody, /# GitHub Issues Export - Export Demo/);
    assert.match(githubBody, /## Issue 1: Phase 1 - Foundation/);
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("CLI cost record and cost show maintain deterministic per-project ledger", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "create-sentinelayer-cost-cmd-"));
  try {
    const recordResult = await runCli({
      cwd: tempRoot,
      env: { ...process.env },
      args: [
        "cost",
        "record",
        "--path",
        tempRoot,
        "--session-id",
        "session-1",
        "--provider",
        "openai",
        "--model",
        "gpt-5.3-codex",
        "--input-tokens",
        "1000",
        "--output-tokens",
        "500",
        "--duration-ms",
        "120",
        "--tool-calls",
        "2",
        "--progress-score",
        "1",
        "--json",
      ],
    });
    assert.equal(recordResult.code, 0, recordResult.stderr || recordResult.stdout);

    const recordPayload = JSON.parse(String(recordResult.stdout || "").trim());
    assert.equal(recordPayload.command, "cost record");
    assert.equal(recordPayload.budget.blocking, false);
    assert.match(String(recordPayload.filePath || ""), /cost-history\.json$/);
    assert.match(
      String(recordPayload.telemetry?.filePath || ""),
      /[\\/]observability[\\/]run-events\.jsonl$/
    );
    assert.ok(String(recordPayload.telemetry?.usageEventId || "").length > 0);
    assert.equal(recordPayload.telemetry?.stopEventId, null);

    const showResult = await runCli({
      cwd: tempRoot,
      env: { ...process.env },
      args: ["cost", "show", "--path", tempRoot, "--json"],
    });
    assert.equal(showResult.code, 0, showResult.stderr || showResult.stdout);
    const showPayload = JSON.parse(String(showResult.stdout || "").trim());
    assert.equal(showPayload.command, "cost show");
    assert.equal(showPayload.summary.sessionCount, 1);
    assert.equal(showPayload.summary.invocationCount, 1);
    assert.equal(showPayload.summary.sessions[0].sessionId, "session-1");
    assert.equal(showPayload.summary.sessions[0].durationMs, 120);
    assert.equal(showPayload.summary.sessions[0].toolCalls, 2);

    const telemetryShowResult = await runCli({
      cwd: tempRoot,
      env: { ...process.env },
      args: ["telemetry", "show", "--path", tempRoot, "--json"],
    });
    assert.equal(telemetryShowResult.code, 0, telemetryShowResult.stderr || telemetryShowResult.stdout);
    const telemetryShowPayload = JSON.parse(String(telemetryShowResult.stdout || "").trim());
    assert.equal(telemetryShowPayload.command, "telemetry show");
    assert.equal(telemetryShowPayload.summary.eventCount, 1);
    assert.equal(telemetryShowPayload.summary.eventTypeCounts.usage, 1);
    assert.equal(telemetryShowPayload.summary.usageTotals.durationMs, 120);
    assert.equal(telemetryShowPayload.summary.usageTotals.toolCalls, 2);
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("CLI cost record enforces max-cost and max-no-progress guardrails", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "create-sentinelayer-cost-cmd-"));
  try {
    const first = await runCli({
      cwd: tempRoot,
      env: { ...process.env },
      args: [
        "cost",
        "record",
        "--path",
        tempRoot,
        "--session-id",
        "session-guard",
        "--provider",
        "openai",
        "--model",
        "gpt-5.3-codex",
        "--input-tokens",
        "100000",
        "--output-tokens",
        "100000",
        "--progress-score",
        "0",
        "--max-cost",
        "0.01",
        "--max-no-progress",
        "2",
        "--json",
      ],
    });
    assert.equal(first.code, 2);
    const firstPayload = JSON.parse(String(first.stdout || "").trim());
    assert.equal(firstPayload.budget.blocking, true);
    assert.equal(
      firstPayload.budget.reasons.some((reason) => reason.code === "MAX_COST_EXCEEDED"),
      true
    );

    const second = await runCli({
      cwd: tempRoot,
      env: { ...process.env },
      args: [
        "cost",
        "record",
        "--path",
        tempRoot,
        "--session-id",
        "session-guard",
        "--provider",
        "openai",
        "--model",
        "gpt-5.3-codex",
        "--input-tokens",
        "1",
        "--output-tokens",
        "1",
        "--progress-score",
        "0",
        "--max-cost",
        "10",
        "--max-no-progress",
        "2",
        "--json",
      ],
    });
    assert.equal(second.code, 2);
    const secondPayload = JSON.parse(String(second.stdout || "").trim());
    assert.equal(
      secondPayload.budget.reasons.some((reason) => reason.code === "DIMINISHING_RETURNS"),
      true
    );

    const telemetryShowResult = await runCli({
      cwd: tempRoot,
      env: { ...process.env },
      args: ["telemetry", "show", "--path", tempRoot, "--json"],
    });
    assert.equal(telemetryShowResult.code, 0, telemetryShowResult.stderr || telemetryShowResult.stdout);
    const telemetryShowPayload = JSON.parse(String(telemetryShowResult.stdout || "").trim());
    assert.equal(telemetryShowPayload.summary.eventCount, 4);
    assert.equal(telemetryShowPayload.summary.eventTypeCounts.usage, 2);
    assert.equal(telemetryShowPayload.summary.eventTypeCounts.run_stop, 2);
    assert.equal(telemetryShowPayload.summary.stopClassCounts.MAX_COST_EXCEEDED, 1);
    assert.equal(telemetryShowPayload.summary.stopClassCounts.DIMINISHING_RETURNS, 1);
    assert.equal(telemetryShowPayload.summary.reasonCodeCounts.MAX_COST_EXCEEDED, 1);
    assert.equal(telemetryShowPayload.summary.reasonCodeCounts.DIMINISHING_RETURNS, 1);
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("CLI cost record enforces runtime/tool-call hard stops and warning thresholds", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "create-sentinelayer-cost-cmd-"));
  try {
    const warningRun = await runCli({
      cwd: tempRoot,
      env: { ...process.env },
      args: [
        "cost",
        "record",
        "--path",
        tempRoot,
        "--session-id",
        "session-runtime",
        "--provider",
        "openai",
        "--model",
        "gpt-5.3-codex",
        "--input-tokens",
        "10",
        "--output-tokens",
        "10",
        "--duration-ms",
        "850",
        "--tool-calls",
        "8",
        "--max-runtime-ms",
        "1000",
        "--max-tool-calls",
        "10",
        "--warn-at-percent",
        "80",
        "--json",
      ],
    });
    assert.equal(warningRun.code, 0, warningRun.stderr || warningRun.stdout);
    const warningPayload = JSON.parse(String(warningRun.stdout || "").trim());
    assert.equal(
      warningPayload.budget.warnings.some((warning) => warning.code === "RUNTIME_MS_NEAR_LIMIT"),
      true
    );
    assert.equal(
      warningPayload.budget.warnings.some((warning) => warning.code === "TOOL_CALLS_NEAR_LIMIT"),
      true
    );
    assert.equal(warningPayload.budget.blocking, false);

    const blockingRun = await runCli({
      cwd: tempRoot,
      env: { ...process.env },
      args: [
        "cost",
        "record",
        "--path",
        tempRoot,
        "--session-id",
        "session-runtime",
        "--provider",
        "openai",
        "--model",
        "gpt-5.3-codex",
        "--input-tokens",
        "10",
        "--output-tokens",
        "10",
        "--duration-ms",
        "200",
        "--tool-calls",
        "3",
        "--max-runtime-ms",
        "1000",
        "--max-tool-calls",
        "10",
        "--warn-at-percent",
        "80",
        "--json",
      ],
    });
    assert.equal(blockingRun.code, 2);
    const blockingPayload = JSON.parse(String(blockingRun.stdout || "").trim());
    assert.equal(
      blockingPayload.budget.reasons.some((reason) => reason.code === "MAX_RUNTIME_MS_EXCEEDED"),
      true
    );
    assert.equal(
      blockingPayload.budget.reasons.some((reason) => reason.code === "MAX_TOOL_CALLS_EXCEEDED"),
      true
    );

    const telemetryShowResult = await runCli({
      cwd: tempRoot,
      env: { ...process.env },
      args: ["telemetry", "show", "--path", tempRoot, "--json"],
    });
    assert.equal(telemetryShowResult.code, 0, telemetryShowResult.stderr || telemetryShowResult.stdout);
    const telemetryShowPayload = JSON.parse(String(telemetryShowResult.stdout || "").trim());
    assert.equal(telemetryShowPayload.summary.eventCount, 3);
    assert.equal(telemetryShowPayload.summary.eventTypeCounts.usage, 2);
    assert.equal(telemetryShowPayload.summary.eventTypeCounts.run_stop, 1);
    assert.equal(telemetryShowPayload.summary.stopClassCounts.MAX_RUNTIME_MS_EXCEEDED, 1);
    assert.equal(telemetryShowPayload.summary.reasonCodeCounts.MAX_RUNTIME_MS_EXCEEDED, 1);
    assert.equal(telemetryShowPayload.summary.reasonCodeCounts.MAX_TOOL_CALLS_EXCEEDED, 1);
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("CLI telemetry record/show writes structured run events and blocking stop classes", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "create-sentinelayer-telemetry-cmd-"));
  try {
    const usageRecord = await runCli({
      cwd: tempRoot,
      env: { ...process.env },
      args: [
        "telemetry",
        "record",
        "--path",
        tempRoot,
        "--session-id",
        "session-tel",
        "--run-id",
        "run-tel",
        "--event-type",
        "tool_call",
        "--tool-calls",
        "2",
        "--duration-ms",
        "120",
        "--metadata-json",
        "{\"tool\":\"bash\",\"status\":\"ok\"}",
        "--json",
      ],
    });
    assert.equal(usageRecord.code, 0, usageRecord.stderr || usageRecord.stdout);
    const usagePayload = JSON.parse(String(usageRecord.stdout || "").trim());
    assert.equal(usagePayload.command, "telemetry record");
    assert.equal(usagePayload.event.eventType, "tool_call");
    assert.equal(usagePayload.event.usage.toolCalls, 2);

    const stopRecord = await runCli({
      cwd: tempRoot,
      env: { ...process.env },
      args: [
        "telemetry",
        "record",
        "--path",
        tempRoot,
        "--session-id",
        "session-tel",
        "--run-id",
        "run-tel",
        "--event-type",
        "run_stop",
        "--stop-class",
        "MAX_RUNTIME_MS_EXCEEDED",
        "--reason-codes",
        "MAX_RUNTIME_MS_EXCEEDED",
        "--blocking",
        "--json",
      ],
    });
    assert.equal(stopRecord.code, 2);
    const stopPayload = JSON.parse(String(stopRecord.stdout || "").trim());
    assert.equal(stopPayload.event.stop.stopClass, "MAX_RUNTIME_MS_EXCEEDED");
    assert.equal(stopPayload.event.stop.blocking, true);

    const showResult = await runCli({
      cwd: tempRoot,
      env: { ...process.env },
      args: ["telemetry", "show", "--path", tempRoot, "--json"],
    });
    assert.equal(showResult.code, 0, showResult.stderr || showResult.stdout);
    const showPayload = JSON.parse(String(showResult.stdout || "").trim());
    assert.equal(showPayload.command, "telemetry show");
    assert.equal(showPayload.summary.eventCount, 2);
    assert.equal(showPayload.summary.eventTypeCounts.tool_call, 1);
    assert.equal(showPayload.summary.eventTypeCounts.run_stop, 1);
    assert.equal(showPayload.summary.stopClassCounts.MAX_RUNTIME_MS_EXCEEDED, 1);
    assert.equal(showPayload.summary.reasonCodeCounts.MAX_RUNTIME_MS_EXCEEDED, 1);
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("CLI watch history lists persisted runtime watch summaries deterministically", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "create-sentinelayer-watch-history-"));
  try {
    const run1Dir = path.join(
      tempRoot,
      ".sentinelayer",
      "observability",
      "runtime-watch",
      "run-1"
    );
    const run2Dir = path.join(
      tempRoot,
      ".sentinelayer",
      "observability",
      "runtime-watch",
      "run-2"
    );
    await mkdir(run1Dir, { recursive: true });
    await mkdir(run2Dir, { recursive: true });

    await writeFile(
      path.join(run1Dir, "summary-2026-04-01T00-00-00-000Z.json"),
      `${JSON.stringify({
        command: "watch run-events",
        runId: "run-1",
        status: "completed",
        stopReason: "terminal",
        startedAt: "2026-04-01T00:00:00.000Z",
        endedAt: "2026-04-01T00:00:10.000Z",
        durationMs: 10_000,
        eventCount: 7,
        artifacts: {
          watchDir: run1Dir,
          summaryPath: path.join(run1Dir, "summary-2026-04-01T00-00-00-000Z.json"),
          eventsPath: path.join(run1Dir, "events-2026-04-01T00-00-00-000Z.ndjson"),
        },
      })}\n`,
      "utf-8"
    );

    await writeFile(
      path.join(run2Dir, "summary-2026-04-01T01-00-00-000Z.json"),
      `${JSON.stringify({
        command: "watch run-events",
        runId: "run-2",
        status: "failed",
        stopReason: "terminal",
        startedAt: "2026-04-01T01:00:00.000Z",
        endedAt: "2026-04-01T01:00:05.000Z",
        durationMs: 5_000,
        eventCount: 3,
        artifacts: {
          watchDir: run2Dir,
          summaryPath: path.join(run2Dir, "summary-2026-04-01T01-00-00-000Z.json"),
          eventsPath: path.join(run2Dir, "events-2026-04-01T01-00-00-000Z.ndjson"),
        },
      })}\n`,
      "utf-8"
    );

    const listResult = await runCli({
      cwd: tempRoot,
      env: { ...process.env },
      args: ["watch", "history", "--path", tempRoot, "--json"],
    });
    assert.equal(listResult.code, 0, listResult.stderr || listResult.stdout);
    const payload = JSON.parse(String(listResult.stdout || "").trim());
    assert.equal(payload.command, "watch history");
    assert.equal(payload.entryCount, 2);
    assert.equal(payload.entries[0].runId, "run-2");
    assert.equal(payload.entries[1].runId, "run-1");

    const filterResult = await runCli({
      cwd: tempRoot,
      env: { ...process.env },
      args: ["watch", "history", "--path", tempRoot, "--run-id", "run-1", "--json"],
    });
    assert.equal(filterResult.code, 0, filterResult.stderr || filterResult.stdout);
    const filtered = JSON.parse(String(filterResult.stdout || "").trim());
    assert.equal(filtered.entryCount, 1);
    assert.equal(filtered.entries[0].runId, "run-1");
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("CLI mcp schema and registry commands scaffold and validate AIdenID template", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "create-sentinelayer-mcp-cmd-"));
  try {
    const schemaPath = path.join(tempRoot, "artifacts", "mcp-tool-registry.schema.json");
    const templatePath = path.join(tempRoot, "artifacts", "mcp-tool-registry.aidenid-template.json");
    const serverPath = path.join(tempRoot, "artifacts", "mcp-server.local-aidenid.json");
    const vscodeBridgePath = path.join(tempRoot, "artifacts", ".vscode", "mcp.json");

    const schemaWriteResult = await runCli({
      cwd: tempRoot,
      env: { ...process.env },
      args: ["mcp", "schema", "write", "--path", schemaPath, "--json"],
    });
    assert.equal(schemaWriteResult.code, 0, schemaWriteResult.stderr || schemaWriteResult.stdout);
    const schemaWritePayload = JSON.parse(String(schemaWriteResult.stdout || "").trim());
    assert.equal(schemaWritePayload.command, "mcp schema write");
    assert.equal(path.resolve(schemaWritePayload.outputPath), path.resolve(schemaPath));

    const schemaText = await readFile(schemaPath, "utf-8");
    assert.match(schemaText, /Sentinelayer MCP Tool Registry/);

    const templateWriteResult = await runCli({
      cwd: tempRoot,
      env: { ...process.env },
      args: ["mcp", "registry", "init-aidenid", "--path", templatePath, "--json"],
    });
    assert.equal(templateWriteResult.code, 0, templateWriteResult.stderr || templateWriteResult.stdout);
    const templateWritePayload = JSON.parse(String(templateWriteResult.stdout || "").trim());
    assert.equal(templateWritePayload.command, "mcp registry init-aidenid");
    assert.equal(templateWritePayload.toolCount, 1);

    const validateResult = await runCli({
      cwd: tempRoot,
      env: { ...process.env },
      args: ["mcp", "registry", "validate", "--file", templatePath, "--json"],
    });
    assert.equal(validateResult.code, 0, validateResult.stderr || validateResult.stdout);
    const validatePayload = JSON.parse(String(validateResult.stdout || "").trim());
    assert.equal(validatePayload.command, "mcp registry validate");
    assert.equal(validatePayload.valid, true);
    assert.equal(validatePayload.toolCount, 1);
    assert.equal(validatePayload.tools.includes("aidenid.provision_email"), true);

    const serverInitResult = await runCli({
      cwd: tempRoot,
      env: { ...process.env },
      args: [
        "mcp",
        "server",
        "init",
        "--id",
        "local-aidenid",
        "--registry-file",
        templatePath,
        "--path",
        serverPath,
        "--json",
      ],
    });
    assert.equal(serverInitResult.code, 0, serverInitResult.stderr || serverInitResult.stdout);
    const serverInitPayload = JSON.parse(String(serverInitResult.stdout || "").trim());
    assert.equal(serverInitPayload.command, "mcp server init");
    assert.equal(serverInitPayload.serverId, "local-aidenid");
    assert.equal(path.resolve(serverInitPayload.outputPath), path.resolve(serverPath));

    const serverValidateResult = await runCli({
      cwd: tempRoot,
      env: { ...process.env },
      args: ["mcp", "server", "validate", "--file", serverPath, "--json"],
    });
    assert.equal(serverValidateResult.code, 0, serverValidateResult.stderr || serverValidateResult.stdout);
    const serverValidatePayload = JSON.parse(String(serverValidateResult.stdout || "").trim());
    assert.equal(serverValidatePayload.command, "mcp server validate");
    assert.equal(serverValidatePayload.valid, true);
    assert.equal(serverValidatePayload.serverId, "local-aidenid");

    const bridgeInitResult = await runCli({
      cwd: tempRoot,
      env: { ...process.env },
      args: [
        "mcp",
        "bridge",
        "init-vscode",
        "--server-id",
        "local-aidenid",
        "--server-config",
        serverPath,
        "--path",
        vscodeBridgePath,
        "--json",
      ],
    });
    assert.equal(bridgeInitResult.code, 0, bridgeInitResult.stderr || bridgeInitResult.stdout);
    const bridgeInitPayload = JSON.parse(String(bridgeInitResult.stdout || "").trim());
    assert.equal(bridgeInitPayload.command, "mcp bridge init-vscode");
    assert.equal(path.resolve(bridgeInitPayload.outputPath), path.resolve(vscodeBridgePath));

    const bridgeConfig = JSON.parse(await readFile(vscodeBridgePath, "utf-8"));
    assert.equal(Boolean(bridgeConfig.mcpServers["local-aidenid"]), true);
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("CLI plugin commands scaffold, validate, and list manifests", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "create-sentinelayer-plugin-cmd-"));
  try {
    const policyManifestPath = path.join(
      tempRoot,
      ".sentinelayer",
      "plugins",
      "security-pack",
      "plugin.json"
    );
    const baseManifestPath = path.join(tempRoot, ".sentinelayer", "plugins", "base-pack", "plugin.json");

    const initResult = await runCli({
      cwd: tempRoot,
      env: { ...process.env },
      args: [
        "plugin",
        "init",
        "--id",
        "security-pack",
        "--pack-type",
        "policy_pack",
        "--stage",
        "scan",
        "--json",
      ],
    });
    assert.equal(initResult.code, 0, initResult.stderr || initResult.stdout);
    const initPayload = JSON.parse(String(initResult.stdout || "").trim());
    assert.equal(initPayload.command, "plugin init");
    assert.equal(initPayload.pluginId, "security-pack");
    assert.equal(initPayload.packType, "policy_pack");
    assert.equal(path.resolve(initPayload.outputPath), path.resolve(policyManifestPath));

    const baseInitResult = await runCli({
      cwd: tempRoot,
      env: { ...process.env },
      args: ["plugin", "init", "--id", "base-pack", "--json"],
    });
    assert.equal(baseInitResult.code, 0, baseInitResult.stderr || baseInitResult.stdout);

    const policyManifest = JSON.parse(await readFile(policyManifestPath, "utf-8"));
    policyManifest.load_order.after = ["base-pack"];
    await writeFile(policyManifestPath, `${JSON.stringify(policyManifest, null, 2)}\n`, "utf-8");

    const validateResult = await runCli({
      cwd: tempRoot,
      env: { ...process.env },
      args: ["plugin", "validate", "--file", policyManifestPath, "--json"],
    });
    assert.equal(validateResult.code, 0, validateResult.stderr || validateResult.stdout);
    const validatePayload = JSON.parse(String(validateResult.stdout || "").trim());
    assert.equal(validatePayload.command, "plugin validate");
    assert.equal(validatePayload.valid, true);
    assert.equal(validatePayload.pluginId, "security-pack");
    assert.equal(validatePayload.packType, "policy_pack");

    const baseValidateResult = await runCli({
      cwd: tempRoot,
      env: { ...process.env },
      args: ["plugin", "validate", "--file", baseManifestPath, "--json"],
    });
    assert.equal(baseValidateResult.code, 0, baseValidateResult.stderr || baseValidateResult.stdout);

    const listResult = await runCli({
      cwd: tempRoot,
      env: { ...process.env },
      args: ["plugin", "list", "--json"],
    });
    assert.equal(listResult.code, 0, listResult.stderr || listResult.stdout);
    const listPayload = JSON.parse(String(listResult.stdout || "").trim());
    assert.equal(listPayload.command, "plugin list");
    assert.equal(listPayload.pluginCount, 2);
    assert.equal(listPayload.plugins.some((plugin) => plugin.id === "security-pack"), true);
    assert.equal(
      listPayload.plugins.some(
        (plugin) => plugin.id === "security-pack" && plugin.packType === "policy_pack"
      ),
      true
    );
    assert.equal(listPayload.invalidCount, 0);

    const orderResult = await runCli({
      cwd: tempRoot,
      env: { ...process.env },
      args: ["plugin", "order", "--json"],
    });
    assert.equal(orderResult.code, 0, orderResult.stderr || orderResult.stdout);
    const orderPayload = JSON.parse(String(orderResult.stdout || "").trim());
    assert.equal(orderPayload.command, "plugin order");
    const scanStage = orderPayload.stages.find((stage) => stage.stage === "scan");
    assert.ok(scanStage);
    assert.equal(scanStage.cycleDetected, false);
    assert.deepEqual(scanStage.order, ["base-pack", "security-pack"]);
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("CLI policy commands manage active pack selection and include plugin policy packs", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "create-sentinelayer-policy-cmd-"));
  try {
    await writeFile(
      path.join(tempRoot, "SPEC.md"),
      "# SPEC - Policy Demo\n\n## Goal\nHarden release checks and scanning.\n",
      "utf-8"
    );

    const initialList = await runCli({
      cwd: tempRoot,
      env: { ...process.env },
      args: ["policy", "list", "--path", tempRoot, "--json"],
    });
    assert.equal(initialList.code, 0, initialList.stderr || initialList.stdout);
    const initialPayload = JSON.parse(String(initialList.stdout || "").trim());
    assert.equal(initialPayload.command, "policy list");
    assert.equal(initialPayload.activePolicyPack, "community");
    assert.equal(initialPayload.packs.some((pack) => pack.id === "strict"), true);

    const useStrict = await runCli({
      cwd: tempRoot,
      env: { ...process.env },
      args: ["policy", "use", "strict", "--path", tempRoot, "--scope", "project", "--json"],
    });
    assert.equal(useStrict.code, 0, useStrict.stderr || useStrict.stdout);
    const usePayload = JSON.parse(String(useStrict.stdout || "").trim());
    assert.equal(usePayload.command, "policy use");
    assert.equal(usePayload.selected, "strict");

    const scanInit = await runCli({
      cwd: tempRoot,
      env: { ...process.env },
      args: ["scan", "init", "--path", tempRoot, "--non-interactive", "--json"],
    });
    assert.equal(scanInit.code, 0, scanInit.stderr || scanInit.stdout);
    const scanPayload = JSON.parse(String(scanInit.stdout || "").trim());
    assert.equal(scanPayload.command, "scan init");
    assert.equal(scanPayload.policyPack.id, "strict");
    assert.equal(scanPayload.profile.severityGate, "P0");

    const pluginPolicy = await runCli({
      cwd: tempRoot,
      env: { ...process.env },
      args: ["plugin", "init", "--id", "custom-pack", "--pack-type", "policy_pack", "--json"],
    });
    assert.equal(pluginPolicy.code, 0, pluginPolicy.stderr || pluginPolicy.stdout);

    const listWithPlugin = await runCli({
      cwd: tempRoot,
      env: { ...process.env },
      args: ["policy", "list", "--path", tempRoot, "--json"],
    });
    assert.equal(listWithPlugin.code, 0, listWithPlugin.stderr || listWithPlugin.stdout);
    const pluginListPayload = JSON.parse(String(listWithPlugin.stdout || "").trim());
    assert.equal(
      pluginListPayload.packs.some((pack) => pack.id === "custom-pack" && pack.source === "plugin"),
      true
    );
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("CLI audit registry lists built-in orchestrator agents", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "create-sentinelayer-audit-registry-"));
  try {
    const result = await runCli({
      cwd: tempRoot,
      env: { ...process.env },
      args: ["audit", "registry", "--json"],
    });
    assert.equal(result.code, 0, result.stderr || result.stdout);
    const payload = JSON.parse(String(result.stdout || "").trim());
    assert.equal(payload.command, "audit registry");
    assert.equal(payload.agentCount >= 13, true);
    assert.equal(payload.agents.some((agent) => agent.id === "security"), true);
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("CLI audit dry-run orchestrates selected agents and writes report artifacts", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "create-sentinelayer-audit-run-"));
  try {
    await writeFile(path.join(tempRoot, "index.js"), "export const status = 'ok';\n", "utf-8");

    const result = await runCli({
      cwd: tempRoot,
      env: { ...process.env },
      args: [
        "audit",
        "--path",
        tempRoot,
        "--dry-run",
        "--agents",
        "security,architecture,testing",
        "--max-parallel",
        "2",
        "--json",
      ],
    });
    assert.equal(result.code, 0, result.stderr || result.stdout);
    const payload = JSON.parse(String(result.stdout || "").trim());
    assert.equal(payload.command, "audit");
    assert.equal(payload.dryRun, true);
    assert.deepEqual(payload.selectedAgents.sort(), ["architecture", "security", "testing"]);
    assert.match(String(payload.reportPath || ""), /[\\/]AUDIT_REPORT\.md$/);
    assert.match(String(payload.reportJsonPath || ""), /[\\/]AUDIT_REPORT\.json$/);

    const report = JSON.parse(await readFile(payload.reportJsonPath, "utf-8"));
    assert.equal(report.runId, payload.runId);
    assert.equal(report.dryRun, true);
    assert.equal(Array.isArray(report.agentResults), true);
    assert.equal(report.agentResults.length, 3);
    assert.equal(report.selectedAgents.includes("security"), true);
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("CLI audit security runs specialist agent and emits dedicated security report", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "create-sentinelayer-audit-security-"));
  try {
    await writeFile(
      path.join(tempRoot, "index.js"),
      "const token = 'sk-live-1234567890abcdef1234567890';\n",
      "utf-8"
    );

    const result = await runCli({
      cwd: tempRoot,
      env: { ...process.env },
      args: ["audit", "security", "--path", tempRoot, "--json"],
    });
    assert.equal(result.code, 0, result.stderr || result.stdout);
    const payload = JSON.parse(String(result.stdout || "").trim());
    assert.equal(payload.command, "audit security");
    assert.match(String(payload.securityAgentPath || ""), /[\\/]security\.json$/);
    assert.match(
      String(payload.securitySpecialistReportPath || ""),
      /[\\/]SECURITY_AGENT_REPORT\.md$/
    );

    const securityAgent = JSON.parse(await readFile(payload.securityAgentPath, "utf-8"));
    assert.equal(securityAgent.agentId, "security");
    assert.equal(Array.isArray(securityAgent.findings), true);

    const securityMarkdown = await readFile(payload.securitySpecialistReportPath, "utf-8");
    assert.match(securityMarkdown, /SECURITY_AGENT_REPORT/);
    assert.match(securityMarkdown, /Risk score:/);
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("CLI audit architecture runs specialist agent and emits dedicated architecture report", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "create-sentinelayer-audit-architecture-"));
  try {
    await mkdir(path.join(tempRoot, "src", "architecture"), { recursive: true });
    const largeModule = "export const line = 'architecture-hotspot';\n".repeat(420);
    await writeFile(path.join(tempRoot, "src", "architecture", "mega-module.js"), largeModule, "utf-8");

    const result = await runCli({
      cwd: tempRoot,
      env: { ...process.env },
      args: ["audit", "architecture", "--path", tempRoot, "--json"],
    });
    assert.equal(result.code, 0, result.stderr || result.stdout);
    const payload = JSON.parse(String(result.stdout || "").trim());
    assert.equal(payload.command, "audit architecture");
    assert.match(String(payload.architectureAgentPath || ""), /[\\/]architecture\.json$/);
    assert.match(
      String(payload.architectureSpecialistReportPath || ""),
      /[\\/]ARCHITECTURE_AGENT_REPORT\.md$/
    );

    const architectureAgent = JSON.parse(await readFile(payload.architectureAgentPath, "utf-8"));
    assert.equal(architectureAgent.agentId, "architecture");
    assert.equal(Array.isArray(architectureAgent.findings), true);

    const architectureMarkdown = await readFile(payload.architectureSpecialistReportPath, "utf-8");
    assert.match(architectureMarkdown, /ARCHITECTURE_AGENT_REPORT/);
    assert.match(architectureMarkdown, /Hotspots:/);
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("CLI audit testing runs specialist agent and emits dedicated testing report", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "create-sentinelayer-audit-testing-"));
  try {
    await mkdir(path.join(tempRoot, "src", "services"), { recursive: true });
    const largeModule = "export function run(){ return 'ok'; }\n".repeat(320);
    await writeFile(path.join(tempRoot, "src", "services", "checkout.js"), largeModule, "utf-8");

    const result = await runCli({
      cwd: tempRoot,
      env: { ...process.env },
      args: ["audit", "testing", "--path", tempRoot, "--json"],
    });
    assert.equal(result.code, 0, result.stderr || result.stdout);
    const payload = JSON.parse(String(result.stdout || "").trim());
    assert.equal(payload.command, "audit testing");
    assert.match(String(payload.testingAgentPath || ""), /[\\/]testing\.json$/);
    assert.match(String(payload.testingSpecialistReportPath || ""), /[\\/]TESTING_AGENT_REPORT\.md$/);

    const testingAgent = JSON.parse(await readFile(payload.testingAgentPath, "utf-8"));
    assert.equal(testingAgent.agentId, "testing");
    assert.equal(Array.isArray(testingAgent.findings), true);

    const testingMarkdown = await readFile(payload.testingSpecialistReportPath, "utf-8");
    assert.match(testingMarkdown, /TESTING_AGENT_REPORT/);
    assert.match(testingMarkdown, /Coverage inventory:/);
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("CLI audit performance runs specialist agent and emits dedicated performance report", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "create-sentinelayer-audit-performance-"));
  try {
    await mkdir(path.join(tempRoot, "src", "performance"), { recursive: true });
    const hotspotModule = "export function tick(){ return Date.now(); }\n".repeat(340);
    await writeFile(path.join(tempRoot, "src", "performance", "runtime.js"), hotspotModule, "utf-8");

    const result = await runCli({
      cwd: tempRoot,
      env: { ...process.env },
      args: ["audit", "performance", "--path", tempRoot, "--json"],
    });
    assert.equal(result.code, 0, result.stderr || result.stdout);
    const payload = JSON.parse(String(result.stdout || "").trim());
    assert.equal(payload.command, "audit performance");
    assert.match(String(payload.performanceAgentPath || ""), /[\\/]performance\.json$/);
    assert.match(
      String(payload.performanceSpecialistReportPath || ""),
      /[\\/]PERFORMANCE_AGENT_REPORT\.md$/
    );

    const performanceAgent = JSON.parse(await readFile(payload.performanceAgentPath, "utf-8"));
    assert.equal(performanceAgent.agentId, "performance");
    assert.equal(Array.isArray(performanceAgent.findings), true);

    const performanceMarkdown = await readFile(payload.performanceSpecialistReportPath, "utf-8");
    assert.match(performanceMarkdown, /PERFORMANCE_AGENT_REPORT/);
    assert.match(performanceMarkdown, /Runtime hotspots:/);
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("CLI audit compliance runs specialist agent and emits dedicated compliance report", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "create-sentinelayer-audit-compliance-"));
  try {
    await mkdir(path.join(tempRoot, "src", "compliance"), { recursive: true });
    await writeFile(
      path.join(tempRoot, "src", "compliance", "controls.js"),
      "export const policy = { retentionDays: 90, audit: true };\n",
      "utf-8"
    );

    const result = await runCli({
      cwd: tempRoot,
      env: { ...process.env },
      args: ["audit", "compliance", "--path", tempRoot, "--json"],
    });
    assert.equal(result.code, 0, result.stderr || result.stdout);
    const payload = JSON.parse(String(result.stdout || "").trim());
    assert.equal(payload.command, "audit compliance");
    assert.match(String(payload.complianceAgentPath || ""), /[\\/]compliance\.json$/);
    assert.match(
      String(payload.complianceSpecialistReportPath || ""),
      /[\\/]COMPLIANCE_AGENT_REPORT\.md$/
    );

    const complianceAgent = JSON.parse(await readFile(payload.complianceAgentPath, "utf-8"));
    assert.equal(complianceAgent.agentId, "compliance");
    assert.equal(Array.isArray(complianceAgent.findings), true);

    const complianceMarkdown = await readFile(payload.complianceSpecialistReportPath, "utf-8");
    assert.match(complianceMarkdown, /COMPLIANCE_AGENT_REPORT/);
    assert.match(complianceMarkdown, /Control mapping:/);
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("CLI audit documentation runs specialist agent and emits dedicated documentation report", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "create-sentinelayer-audit-documentation-"));
  try {
    await mkdir(path.join(tempRoot, "src", "docs"), { recursive: true });
    const largeModule = "export function task(){ return 'doc-gap'; }\n".repeat(340);
    await writeFile(path.join(tempRoot, "src", "docs", "runtime.js"), largeModule, "utf-8");
    await mkdir(path.join(tempRoot, "docs"), { recursive: true });
    await writeFile(path.join(tempRoot, "docs", "overview.md"), "# Overview\n", "utf-8");

    const result = await runCli({
      cwd: tempRoot,
      env: { ...process.env },
      args: ["audit", "documentation", "--path", tempRoot, "--json"],
    });
    assert.equal(result.code, 0, result.stderr || result.stdout);
    const payload = JSON.parse(String(result.stdout || "").trim());
    assert.equal(payload.command, "audit documentation");
    assert.match(String(payload.documentationAgentPath || ""), /[\\/]documentation\.json$/);
    assert.match(
      String(payload.documentationSpecialistReportPath || ""),
      /[\\/]DOCUMENTATION_AGENT_REPORT\.md$/
    );

    const documentationAgent = JSON.parse(await readFile(payload.documentationAgentPath, "utf-8"));
    assert.equal(documentationAgent.agentId, "documentation");
    assert.equal(Array.isArray(documentationAgent.findings), true);

    const documentationMarkdown = await readFile(payload.documentationSpecialistReportPath, "utf-8");
    assert.match(documentationMarkdown, /DOCUMENTATION_AGENT_REPORT/);
    assert.match(documentationMarkdown, /Documentation inventory:/);
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("CLI ai provision-email dry-run writes deterministic request artifact", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "create-sentinelayer-ai-cmd-"));
  try {
    const result = await runCli({
      cwd: tempRoot,
      env: { ...process.env },
      args: [
        "ai",
        "provision-email",
        "--alias-template",
        "nightly-scan",
        "--tags",
        "security,nightly",
        "--json",
      ],
    });
    assert.equal(result.code, 0, result.stderr || result.stdout);

    const payload = JSON.parse(String(result.stdout || "").trim());
    assert.equal(payload.command, "ai provision-email");
    assert.equal(payload.execute, false);
    assert.equal(Array.isArray(payload.credentialsMissing), true);
    assert.ok(String(payload.requestPath || "").includes("aidenid"));

    const requestArtifact = JSON.parse(await readFile(payload.requestPath, "utf-8"));
    assert.equal(requestArtifact.payload.aliasTemplate, "nightly-scan");
    assert.deepEqual(requestArtifact.payload.tags, ["security", "nightly"]);
    assert.equal(requestArtifact.payload.ttlHours, 24);
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("CLI ai provision-email execute mode posts to AIdenID API with scoped headers", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "create-sentinelayer-ai-cmd-"));
  const mock = await startAidenIdMockApi();
  try {
    const result = await runCli({
      cwd: tempRoot,
      env: { ...process.env },
      args: [
        "ai",
        "provision-email",
        "--api-url",
        mock.apiUrl,
        "--api-key",
        "k_test",
        "--org-id",
        "org_test",
        "--project-id",
        "proj_test",
        "--execute",
        "--json",
      ],
    });
    assert.equal(result.code, 0, result.stderr || result.stdout);
    const payload = JSON.parse(String(result.stdout || "").trim());
    assert.equal(payload.command, "ai provision-email");
    assert.equal(payload.execute, true);
    assert.equal(payload.identity.id, "id_123");
    assert.equal(payload.identity.emailAddress, "scan@aidenid.com");

    assert.equal(mock.state.requestCount, 1);
    assert.equal(mock.state.lastHeaders.authorization, "Bearer k_test");
    assert.equal(mock.state.lastHeaders["x-org-id"], "org_test");
    assert.equal(mock.state.lastHeaders["x-project-id"], "proj_test");
    assert.ok(String(mock.state.lastHeaders["idempotency-key"] || "").length > 0);
    assert.equal(mock.state.lastPayload.ttlHours, 24);
    assert.equal(mock.state.lastPayload.policy.receiveMode, "EDGE_ACCEPT");
  } finally {
    await mock.close();
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("CLI chat ask dry-run writes transcript artifact deterministically", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "create-sentinelayer-chat-cmd-"));
  try {
    const result = await runCli({
      cwd: tempRoot,
      env: { ...process.env },
      args: ["chat", "ask", "--prompt", "Summarize pending PR work.", "--dry-run", "--json"],
    });
    assert.equal(result.code, 0, result.stderr || result.stdout);

    const payload = JSON.parse(String(result.stdout || "").trim());
    assert.equal(payload.command, "chat ask");
    assert.equal(payload.dryRun, true);
    assert.match(payload.response, /DRY_RUN_RESPONSE/);
    assert.ok(String(payload.sessionId || "").length > 8);
    assert.match(String(payload.transcriptPath || ""), /[\\/]chat[\\/]sessions[\\/]/);

    const transcriptText = await readFile(payload.transcriptPath, "utf-8");
    const lines = transcriptText
      .split(/\r?\n/g)
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => JSON.parse(line));

    assert.equal(lines.length, 2);
    assert.equal(lines[0].role, "user");
    assert.equal(lines[1].role, "assistant");
    assert.equal(lines[1].dry_run, true);
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("CLI review scan full mode emits deterministic report and findings summary", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "create-sentinelayer-review-cmd-"));
  try {
    await writeFile(
      path.join(tempRoot, "index.js"),
      "const value = 1; // TODO: tighten validation logic\n",
      "utf-8"
    );

    const result = await runCli({
      cwd: tempRoot,
      env: { ...process.env },
      args: ["review", "scan", "--mode", "full", "--json"],
    });
    assert.equal(result.code, 0, result.stderr || result.stdout);
    const payload = JSON.parse(String(result.stdout || "").trim());
    assert.equal(payload.command, "review scan");
    assert.equal(payload.mode, "full");
    assert.equal(payload.scannedFiles >= 1, true);
    assert.equal(payload.p2 >= 1, true);
    const reportText = await readFile(payload.reportPath, "utf-8");
    assert.match(reportText, /Local Review Scan/);
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("CLI review scan diff mode scopes findings to changed git files", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "create-sentinelayer-review-cmd-"));
  try {
    runCommand({ cwd: tempRoot, command: "git", args: ["init"] });
    runCommand({ cwd: tempRoot, command: "git", args: ["config", "user.name", "Sentinelayer E2E"] });
    runCommand({
      cwd: tempRoot,
      command: "git",
      args: ["config", "user.email", "e2e@sentinelayer.local"],
    });

    const filePath = path.join(tempRoot, "app.js");
    await writeFile(filePath, "const value = 1;\n", "utf-8");
    runCommand({ cwd: tempRoot, command: "git", args: ["add", "app.js"] });
    runCommand({ cwd: tempRoot, command: "git", args: ["commit", "-m", "seed"] });

    await writeFile(filePath, "const value = 1; // TODO: add sanitizer\n", "utf-8");

    const result = await runCli({
      cwd: tempRoot,
      env: { ...process.env },
      args: ["review", "scan", "--mode", "diff", "--json"],
    });
    assert.equal(result.code, 0, result.stderr || result.stdout);
    const payload = JSON.parse(String(result.stdout || "").trim());
    assert.equal(payload.command, "review scan");
    assert.equal(payload.mode, "diff");
    assert.equal(payload.scannedFiles >= 1, true);
    assert.equal(payload.scopedFiles.includes("app.js"), true);
    assert.equal(payload.p2 >= 1, true);
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("CLI review deterministic command writes layered review artifacts", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "create-sentinelayer-review-pipeline-"));
  try {
    await writeFile(
      path.join(tempRoot, "index.js"),
      "const callback = 'http://localhost:3000/callback'; // TODO: harden before release\n",
      "utf-8"
    );

    const result = await runCli({
      cwd: tempRoot,
      env: { ...process.env },
      args: ["review", "--json"],
    });
    assert.equal(result.code, 0, result.stderr || result.stdout);
    const payload = JSON.parse(String(result.stdout || "").trim());
    assert.equal(payload.command, "review");
    assert.equal(payload.mode, "full");
    assert.equal(payload.scannedFiles >= 1, true);
    assert.equal(payload.p2 >= 1, true);
    assert.equal(String(payload.runId || "").startsWith("review-"), true);

    const reviewJson = JSON.parse(await readFile(payload.reportJsonPath, "utf-8"));
    assert.equal(reviewJson.schemaVersion, "1.0.0");
    assert.equal(Array.isArray(reviewJson.layers.ingest.frameworks), true);
    assert.equal(reviewJson.layers.structural.ruleCount >= 20, true);
    assert.equal(Array.isArray(reviewJson.findings), true);

    const reviewMarkdown = await readFile(payload.reportPath, "utf-8");
    assert.match(reviewMarkdown, /REVIEW_DETERMINISTIC/);
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("CLI review --ai --ai-dry-run writes AI artifacts and governed telemetry", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "create-sentinelayer-review-ai-"));
  try {
    await writeFile(
      path.join(tempRoot, "index.js"),
      "const callback = 'http://localhost:3000/callback'; // TODO: harden before release\n",
      "utf-8"
    );

    const result = await runCli({
      cwd: tempRoot,
      env: { ...process.env },
      args: ["review", "--ai", "--ai-dry-run", "--json"],
    });
    assert.equal(result.code, 0, result.stderr || result.stdout);

    const payload = JSON.parse(String(result.stdout || "").trim());
    assert.equal(payload.command, "review");
    assert.equal(payload.ai.enabled, true);
    assert.equal(payload.ai.dryRun, true);
    assert.equal(payload.ai.findingCount >= 1, true);
    assert.match(String(payload.reportUnifiedPath || ""), /[\\/]REVIEW_REPORT\.md$/);
    assert.match(String(payload.reportUnifiedJsonPath || ""), /[\\/]REVIEW_REPORT\.json$/);
    assert.match(String(payload.ai.reportPath || ""), /[\\/]REVIEW_AI\.md$/);
    assert.match(String(payload.ai.reportJsonPath || ""), /[\\/]REVIEW_AI\.json$/);
    assert.match(String(payload.ai.promptPath || ""), /[\\/]REVIEW_AI_PROMPT\.txt$/);
    assert.equal(payload.p2 >= payload.deterministicSummary.P2, true);

    const aiReportText = await readFile(payload.ai.reportPath, "utf-8");
    assert.match(aiReportText, /REVIEW_AI/);
    assert.match(aiReportText, /DRY_RUN_RESPONSE/);

    const aiReportJson = JSON.parse(await readFile(payload.ai.reportJsonPath, "utf-8"));
    assert.equal(aiReportJson.dryRun, true);
    assert.equal(aiReportJson.parser, "json");
    assert.equal(Array.isArray(aiReportJson.findings), true);

    const costHistoryText = await readFile(payload.ai.cost.filePath, "utf-8");
    assert.match(costHistoryText, /-ai\"/);

    const telemetryText = await readFile(payload.ai.telemetry.filePath, "utf-8");
    assert.match(telemetryText, /\"eventType\":\"usage\"/);
    assert.ok(String(payload.ai.telemetry.usageEventId || "").length > 8);
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("CLI review show/export and HITL verdict commands operate on unified report artifacts", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "create-sentinelayer-review-report-"));
  try {
    await writeFile(
      path.join(tempRoot, "index.js"),
      "const callback = 'http://localhost:3000/callback'; // TODO: harden before release\n",
      "utf-8"
    );

    const runResult = await runCli({
      cwd: tempRoot,
      env: { ...process.env },
      args: ["review", "--ai", "--ai-dry-run", "--json"],
    });
    assert.equal(runResult.code, 0, runResult.stderr || runResult.stdout);
    const runPayload = JSON.parse(String(runResult.stdout || "").trim());
    assert.ok(String(runPayload.runId || "").startsWith("review-"));

    const showResult = await runCli({
      cwd: tempRoot,
      env: { ...process.env },
      args: ["review", "show", "--run-id", runPayload.runId, "--json"],
    });
    assert.equal(showResult.code, 0, showResult.stderr || showResult.stdout);
    const showPayload = JSON.parse(String(showResult.stdout || "").trim());
    assert.equal(showPayload.command, "review show");
    assert.equal(Array.isArray(showPayload.report.findings), true);
    assert.equal(showPayload.report.findings.length >= 1, true);
    const firstFindingId = showPayload.report.findings[0].findingId;
    assert.ok(String(firstFindingId || "").startsWith("F-"));

    const acceptResult = await runCli({
      cwd: tempRoot,
      env: { ...process.env },
      args: [
        "review",
        "accept",
        firstFindingId,
        "--run-id",
        runPayload.runId,
        "--note",
        "accepted for remediation tracking",
        "--json",
      ],
    });
    assert.equal(acceptResult.code, 0, acceptResult.stderr || acceptResult.stdout);
    const acceptPayload = JSON.parse(String(acceptResult.stdout || "").trim());
    assert.equal(acceptPayload.command, "review accept");
    assert.equal(acceptPayload.decision.verdict, "accept");

    const showAfterDecision = await runCli({
      cwd: tempRoot,
      env: { ...process.env },
      args: ["review", "show", "--run-id", runPayload.runId, "--json"],
    });
    assert.equal(showAfterDecision.code, 0, showAfterDecision.stderr || showAfterDecision.stdout);
    const afterPayload = JSON.parse(String(showAfterDecision.stdout || "").trim());
    const updated = afterPayload.report.findings.find((finding) => finding.findingId === firstFindingId);
    assert.ok(updated);
    assert.equal(updated.adjudication.verdict, "accept");

    const exportResult = await runCli({
      cwd: tempRoot,
      env: { ...process.env },
      args: ["review", "export", "--run-id", runPayload.runId, "--format", "sarif", "--json"],
    });
    assert.equal(exportResult.code, 0, exportResult.stderr || exportResult.stdout);
    const exportPayload = JSON.parse(String(exportResult.stdout || "").trim());
    assert.equal(exportPayload.command, "review export");
    assert.equal(exportPayload.format, "sarif");

    const sarif = JSON.parse(await readFile(exportPayload.outputPath, "utf-8"));
    assert.equal(sarif.version, "2.1.0");
    assert.equal(Array.isArray(sarif.runs), true);
    assert.equal(Array.isArray(sarif.runs[0].results), true);
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("CLI review replay and review diff produce reproducibility comparison artifacts", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "create-sentinelayer-review-replay-"));
  try {
    await writeFile(
      path.join(tempRoot, "index.js"),
      "const callback = 'http://localhost:3000/callback'; // TODO: harden before release\n",
      "utf-8"
    );

    const initial = await runCli({
      cwd: tempRoot,
      env: { ...process.env },
      args: ["review", "--ai", "--ai-dry-run", "--json"],
    });
    assert.equal(initial.code, 0, initial.stderr || initial.stdout);
    const initialPayload = JSON.parse(String(initial.stdout || "").trim());
    assert.ok(String(initialPayload.runId || "").startsWith("review-"));

    const replay = await runCli({
      cwd: tempRoot,
      env: { ...process.env },
      args: ["review", "replay", initialPayload.runId, "--ai-dry-run", "--json"],
    });
    assert.equal(replay.code, 0, replay.stderr || replay.stdout);
    const replayPayload = JSON.parse(String(replay.stdout || "").trim());
    assert.equal(replayPayload.command, "review replay");
    assert.ok(String(replayPayload.replayRunId || "").startsWith("review-"));
    assert.ok(String(replayPayload.comparisonPath || "").includes("REVIEW_COMPARISON_"));
    const replayComparison = JSON.parse(await readFile(replayPayload.comparisonPath, "utf-8"));
    assert.equal(replayComparison.baseRunId, initialPayload.runId);
    assert.equal(replayComparison.candidateRunId, replayPayload.replayRunId);

    const diff = await runCli({
      cwd: tempRoot,
      env: { ...process.env },
      args: ["review", "diff", initialPayload.runId, replayPayload.replayRunId, "--json"],
    });
    assert.equal(diff.code, 0, diff.stderr || diff.stdout);
    const diffPayload = JSON.parse(String(diff.stdout || "").trim());
    assert.equal(diffPayload.command, "review diff");
    assert.equal(diffPayload.baseRunId, initialPayload.runId);
    assert.equal(diffPayload.candidateRunId, replayPayload.replayRunId);

    const diffArtifact = JSON.parse(await readFile(diffPayload.outputPath, "utf-8"));
    assert.equal(diffArtifact.baseRunId, initialPayload.runId);
    assert.equal(diffArtifact.candidateRunId, replayPayload.replayRunId);
    assert.equal(typeof diffPayload.deterministicEquivalent, "boolean");
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("CLI review deterministic staged mode scopes to staged files only", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "create-sentinelayer-review-pipeline-"));
  try {
    runCommand({ cwd: tempRoot, command: "git", args: ["init"] });
    runCommand({ cwd: tempRoot, command: "git", args: ["config", "user.name", "Sentinelayer E2E"] });
    runCommand({
      cwd: tempRoot,
      command: "git",
      args: ["config", "user.email", "e2e@sentinelayer.local"],
    });

    const stagedPath = path.join(tempRoot, "app.js");
    await writeFile(stagedPath, "const value = 1;\n", "utf-8");
    runCommand({ cwd: tempRoot, command: "git", args: ["add", "app.js"] });
    runCommand({ cwd: tempRoot, command: "git", args: ["commit", "-m", "seed"] });

    await writeFile(stagedPath, "const value = 2; // TODO: sanitize\n", "utf-8");
    runCommand({ cwd: tempRoot, command: "git", args: ["add", "app.js"] });
    await writeFile(path.join(tempRoot, "untracked.js"), "const leak = 'sk-test-12345678901234567890';\n", "utf-8");

    const result = await runCli({
      cwd: tempRoot,
      env: { ...process.env },
      args: ["review", "--staged", "--json"],
    });
    assert.equal(result.code, 0, result.stderr || result.stdout);

    const payload = JSON.parse(String(result.stdout || "").trim());
    assert.equal(payload.command, "review");
    assert.equal(payload.mode, "staged");
    assert.equal(payload.scannedFiles >= 1, true);
    assert.equal(payload.scopedFiles.includes("app.js"), true);
    assert.equal(payload.scopedFiles.includes("untracked.js"), false);
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
