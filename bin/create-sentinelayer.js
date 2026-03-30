#!/usr/bin/env node

import crypto from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { spawnSync } from "node:child_process";
import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";

import open from "open";
import pc from "picocolors";
import prompts from "prompts";

const DEFAULT_API_URL = process.env.SENTINELAYER_API_URL || "https://api.sentinelayer.com";
const DEFAULT_WEB_URL = process.env.SENTINELAYER_WEB_URL || "https://sentinelayer.com";
const DEFAULT_AUTH_TIMEOUT_MS = 10 * 60 * 1000;
const DEFAULT_REQUEST_TIMEOUT_MS = 20_000;

const DEFAULT_MODEL_BY_PROVIDER = {
  openai: "gpt-5.3-codex",
  anthropic: "claude-sonnet-4-6",
  google: "gemini-2.5-flash",
};

class SentinelayerApiError extends Error {
  constructor(message, { code = "API_ERROR", status = 500, requestId = null } = {}) {
    super(message);
    this.name = "SentinelayerApiError";
    this.code = code;
    this.status = status;
    this.requestId = requestId;
  }
}

function nowIso() {
  return new Date().toISOString();
}

function parseCommaList(value) {
  return String(value || "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function sanitizeProjectName(value) {
  const raw = String(value || "").trim();
  if (!raw) return "";
  return raw
    .toLowerCase()
    .replace(/[^a-z0-9-_ ]+/g, "")
    .trim()
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
}

async function waitForEnter(message) {
  const rl = createInterface({ input, output });
  try {
    await rl.question(`${message}\n`);
  } finally {
    rl.close();
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function requestJson(url, { method = "GET", headers = {}, body, timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS } = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      method,
      headers: {
        "Content-Type": "application/json",
        ...headers,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: controller.signal,
    });

    const text = await response.text();
    let payload = null;
    if (text.trim().length > 0) {
      try {
        payload = JSON.parse(text);
      } catch {
        payload = null;
      }
    }

    if (!response.ok) {
      const errorEnvelope = payload && typeof payload === "object" ? payload.error || null : null;
      const code = errorEnvelope?.code || `HTTP_${response.status}`;
      const message = errorEnvelope?.message || `Request failed (${response.status})`;
      const requestId = errorEnvelope?.request_id || null;
      throw new SentinelayerApiError(message, {
        code,
        status: response.status,
        requestId,
      });
    }

    if (payload === null) {
      return {};
    }
    return payload;
  } catch (error) {
    if (error instanceof SentinelayerApiError) {
      throw error;
    }
    if (error instanceof Error && error.name === "AbortError") {
      throw new SentinelayerApiError("Sentinelayer request timed out", {
        code: "NETWORK_TIMEOUT",
        status: 504,
      });
    }
    throw new SentinelayerApiError("Unable to reach Sentinelayer API", {
      code: "NETWORK_ERROR",
      status: 503,
    });
  } finally {
    clearTimeout(timeout);
  }
}

function detectIde() {
  if (process.env.TERM_PROGRAM?.toLowerCase().includes("vscode")) return "vscode";
  if (process.env.JETBRAINS_IDE) return "jetbrains";
  return "terminal";
}

async function startCliSession({ apiUrl, challenge, cliVersion }) {
  return requestJson(`${apiUrl}/api/v1/auth/cli/sessions/start`, {
    method: "POST",
    body: {
      challenge,
      ide: detectIde(),
      cli_version: cliVersion,
    },
  });
}

async function pollCliSession({
  apiUrl,
  sessionId,
  challenge,
  pollIntervalSeconds,
  timeoutMs = DEFAULT_AUTH_TIMEOUT_MS,
}) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const response = await requestJson(`${apiUrl}/api/v1/auth/cli/sessions/poll`, {
      method: "POST",
      body: {
        session_id: sessionId,
        challenge,
      },
    });
    if (response.status === "approved" && response.auth_token) {
      return response;
    }
    await sleep(Math.max(1, Number(pollIntervalSeconds) || 2) * 1000);
  }
  throw new SentinelayerApiError("CLI authentication timed out. Restart and try again.", {
    code: "CLI_AUTH_TIMEOUT",
    status: 408,
  });
}

async function generateArtifacts({ apiUrl, authToken, payload }) {
  return requestJson(`${apiUrl}/api/v1/builder/generate`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${authToken}`,
    },
    body: payload,
    timeoutMs: 180_000,
  });
}

async function issueBootstrapToken({ apiUrl, authToken }) {
  return requestJson(`${apiUrl}/api/v1/builder/bootstrap-token`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${authToken}`,
    },
  });
}

function detectRepoSlug(cwd) {
  const gitRemote = spawnSync("git", ["config", "--get", "remote.origin.url"], {
    cwd,
    encoding: "utf-8",
  });
  if (gitRemote.status !== 0) return null;
  const remote = String(gitRemote.stdout || "").trim();
  if (!remote) return null;

  const sshMatch = remote.match(/^git@github\.com:([^/]+)\/(.+?)(?:\.git)?$/i);
  if (sshMatch) {
    return `${sshMatch[1]}/${sshMatch[2]}`;
  }

  const httpsMatch = remote.match(/^https?:\/\/github\.com\/([^/]+)\/(.+?)(?:\.git)?$/i);
  if (httpsMatch) {
    return `${httpsMatch[1]}/${httpsMatch[2]}`;
  }

  const sshUrlMatch = remote.match(/^ssh:\/\/git@github\.com\/([^/]+)\/(.+?)(?:\.git)?$/i);
  if (sshUrlMatch) {
    return `${sshUrlMatch[1]}/${sshUrlMatch[2]}`;
  }

  return null;
}

async function ensureDirectory(targetPath) {
  await fsp.mkdir(targetPath, { recursive: true });
}

async function writeTextFile(filePath, content) {
  await ensureDirectory(path.dirname(filePath));
  await fsp.writeFile(filePath, content, "utf-8");
}

async function upsertEnvVariable(filePath, key, value) {
  let existing = "";
  if (fs.existsSync(filePath)) {
    existing = await fsp.readFile(filePath, "utf-8");
  }
  const line = `${key}=${value}`;
  const regex = new RegExp(`^${key}=.*$`, "m");
  let next;
  if (regex.test(existing)) {
    next = existing.replace(regex, line);
  } else if (existing.trim().length === 0) {
    next = `${line}\n`;
  } else if (existing.endsWith("\n")) {
    next = `${existing}${line}\n`;
  } else {
    next = `${existing}\n${line}\n`;
  }
  await writeTextFile(filePath, next);
}

async function ensureSentinelStartScript(projectDir, projectName) {
  const packagePath = path.join(projectDir, "package.json");
  const fallback = {
    name: sanitizeProjectName(projectName) || "sentinelayer-project",
    version: "0.1.0",
    private: true,
    scripts: {},
  };
  let payload = fallback;
  if (fs.existsSync(packagePath)) {
    try {
      const parsed = JSON.parse(await fsp.readFile(packagePath, "utf-8"));
      if (parsed && typeof parsed === "object") {
        payload = parsed;
      }
    } catch {
      payload = fallback;
    }
  }
  payload.scripts = payload.scripts && typeof payload.scripts === "object" ? payload.scripts : {};
  payload.scripts["sentinel:start"] =
    payload.scripts["sentinel:start"] ||
    "echo \"Sentinelayer artifacts are ready. Open AGENT_HANDOFF_PROMPT.md and start your coding agent.\"";
  await writeTextFile(packagePath, `${JSON.stringify(payload, null, 2)}\n`);
}

function buildTodoContent({
  projectName,
  aiProvider,
  repoSlug,
  generationMode,
  audienceLevel,
  projectType,
}) {
  return `# Sentinelayer Autonomous Build Plan

Generated: ${nowIso()}
Project: ${projectName}

## Inputs
- AI provider: \`${aiProvider}\`
- Generation mode: \`${generationMode}\`
- Audience level: \`${audienceLevel}\`
- Project type: \`${projectType}\`
- Repo: \`${repoSlug || "not connected"}\`

## Execution Checklist
- [ ] PR 1: foundation and architecture skeleton
- [ ] PR 2: core backend and data model
- [ ] PR 3: integrations + auth + policy controls
- [ ] PR 4: scale, observability, and production hardening
- [ ] PR 5: docs and release readiness

## Omar Loop Contract (Per PR)
- [ ] Run Omar Gate for the PR.
- [ ] Fix all P0 and P1 findings.
- [ ] Fix P2 findings before merge when feasible.
- [ ] Re-run gate and confirm clean status.
- [ ] Merge only after quality gates are green.

## Required Read Order
1. \`docs/spec.md\`
2. \`docs/build-guide.md\`
3. \`prompts/execution-prompt.md\`
4. \`.github/workflows/omar-gate.yml\`
5. \`AGENT_HANDOFF_PROMPT.md\`
`;
}

function buildHandoffPrompt({ projectName, repoSlug, secretName }) {
  return `# Sentinelayer Agent Handoff Prompt

You are executing "${projectName}" autonomously.

Read files in this exact order:
1. docs/spec.md
2. docs/build-guide.md
3. prompts/execution-prompt.md
4. tasks/todo.md
5. .github/workflows/omar-gate.yml

Execution mode:
- Work PR-by-PR from tasks/todo.md.
- For each PR run Omar loop until P0/P1 are zero and quality checks pass.
- Keep commits scoped and deterministic.
- Stop only for blocking secrets/permission gaps.

GitHub Action contract:
- Required secret name: ${secretName}
- Workflow input binding: sentinelayer_token: \${{ secrets.${secretName} }}
- Optional: OPENAI_API_KEY for runtime policy/BYOK scenarios.

Repo context:
- Target repo: ${repoSlug || "not provided"}

Start now and continue autonomously.
`;
}

function fallbackWorkflow() {
  return `name: Omar Gate

on:
  pull_request:
    types: [opened, synchronize, reopened]

permissions:
  contents: read
  pull-requests: write
  checks: write

jobs:
  quality-gates:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - name: Omar Gate
        uses: mrrCarter/sentinelayer-v1-action@v1
        with:
          sentinelayer_token: \${{ secrets.SENTINELAYER_TOKEN }}
          scan_mode: deep
          severity_gate: P1
`;
}

function runGhSecretSet({ repoSlug, secretName, secretValue }) {
  const ghVersion = spawnSync("gh", ["--version"], { encoding: "utf-8" });
  if (ghVersion.status !== 0) {
    return {
      ok: false,
      reason: "GitHub CLI (gh) is not installed or not in PATH.",
    };
  }

  const result = spawnSync("gh", ["secret", "set", secretName, "--repo", repoSlug], {
    encoding: "utf-8",
    input: `${secretValue}\n`,
  });
  if (result.status !== 0) {
    return {
      ok: false,
      reason: String(result.stderr || result.stdout || "gh secret set failed").trim(),
    };
  }
  return { ok: true };
}

async function collectInterview({ initialProjectName, detectedRepo }) {
  const onCancel = () => {
    throw new Error("Prompt flow cancelled by user.");
  };

  const base = await prompts(
    [
      {
        type: initialProjectName ? null : "text",
        name: "projectName",
        message: "Project folder name",
        initial: "my-agent-app",
        validate: (value) =>
          sanitizeProjectName(value).length > 0 ? true : "Enter a valid project folder name.",
      },
      {
        type: "text",
        name: "projectDescription",
        message: "What are you building?",
        validate: (value) =>
          String(value || "").trim().length >= 15
            ? true
            : "Describe your project in at least 15 characters.",
      },
      {
        type: "select",
        name: "aiProvider",
        message: "Select your AI provider",
        choices: [
          { title: "OpenAI (Codex)", value: "openai" },
          { title: "Anthropic (Claude)", value: "anthropic" },
          { title: "Google (Gemini)", value: "google" },
        ],
        initial: 0,
      },
      {
        type: "select",
        name: "generationMode",
        message: "Artifact depth",
        choices: [
          { title: "Detailed (recommended)", value: "detailed" },
          { title: "Quick", value: "quick" },
          { title: "Enterprise", value: "enterprise" },
        ],
        initial: 0,
      },
      {
        type: "select",
        name: "audienceLevel",
        message: "Primary audience",
        choices: [
          { title: "Developer", value: "developer" },
          { title: "Intermediate", value: "intermediate" },
          { title: "Beginner", value: "beginner" },
        ],
        initial: 0,
      },
      {
        type: "select",
        name: "projectType",
        message: "Project type",
        choices: [
          { title: "Greenfield", value: "greenfield" },
          { title: "Add feature", value: "add_feature" },
          { title: "Bugfix / hardening", value: "bugfix" },
        ],
        initial: 0,
      },
      {
        type: "text",
        name: "techStack",
        message: "Tech stack (comma-separated, optional)",
        initial: "TypeScript, Node.js, PostgreSQL",
      },
      {
        type: "text",
        name: "features",
        message: "Key features (comma-separated, optional)",
      },
      {
        type: "toggle",
        name: "advanced",
        message: "Advanced options?",
        initial: true,
        active: "yes",
        inactive: "no",
      },
    ],
    { onCancel }
  );

  let advanced = {
    connectRepo: false,
    repoSlug: detectedRepo || "",
    injectSecret: false,
  };
  if (base.advanced) {
    advanced = await prompts(
      [
        {
          type: "toggle",
          name: "connectRepo",
          message: "Connect a GitHub repo and inject Actions secret?",
          initial: Boolean(detectedRepo),
          active: "yes",
          inactive: "no",
        },
        {
          type: (prev) => (prev ? "text" : null),
          name: "repoSlug",
          message: "GitHub repo (owner/repo)",
          initial: detectedRepo || "",
          validate: (value) =>
            String(value || "").trim().match(/^[^/\s]+\/[^/\s]+$/)
              ? true
              : "Use owner/repo format.",
        },
        {
          type: (prev, values) => (values.connectRepo ? "toggle" : null),
          name: "injectSecret",
          message: "Inject SENTINELAYER_TOKEN into GitHub Actions secrets now?",
          initial: true,
          active: "yes",
          inactive: "no",
        },
      ],
      { onCancel }
    );
  }

  return {
    projectName: sanitizeProjectName(initialProjectName || base.projectName),
    projectDescription: String(base.projectDescription || "").trim(),
    aiProvider: base.aiProvider,
    generationMode: base.generationMode,
    audienceLevel: base.audienceLevel,
    projectType: base.projectType,
    techStack: parseCommaList(base.techStack),
    features: parseCommaList(base.features),
    connectRepo: Boolean(advanced.connectRepo),
    repoSlug: String(advanced.repoSlug || "").trim(),
    injectSecret: Boolean(advanced.injectSecret),
  };
}

function printSection(title) {
  console.log(`\n${pc.bold(pc.cyan(title))}`);
}

function printInfo(message) {
  console.log(pc.gray(`- ${message}`));
}

async function run() {
  const pkgVersion = "0.1.0";
  const argProjectName = process.argv[2] && !process.argv[2].startsWith("-") ? process.argv[2] : "";
  const detectedRepo = detectRepoSlug(process.cwd());

  printSection("Sentinelayer Scaffold");
  printInfo(`API: ${DEFAULT_API_URL}`);
  printInfo(`Web: ${DEFAULT_WEB_URL}`);
  if (detectedRepo) {
    printInfo(`Detected repo: ${detectedRepo}`);
  }

  const interview = await collectInterview({
    initialProjectName: argProjectName,
    detectedRepo,
  });

  if (!interview.projectName) {
    throw new Error("Project name is required.");
  }

  printSection("Authentication");
  await waitForEnter("Press Enter to authenticate with Sentinelayer in your browser...");

  const challenge = crypto.randomBytes(32).toString("hex");
  const session = await startCliSession({
    apiUrl: DEFAULT_API_URL,
    challenge,
    cliVersion: pkgVersion,
  });

  console.log(`Opening browser: ${session.authorize_url}`);
  try {
    await open(session.authorize_url);
  } catch {
    console.log(pc.yellow("Could not auto-open browser. Open this URL manually:"));
    console.log(pc.yellow(session.authorize_url));
  }

  console.log("Waiting for browser approval...");
  const approval = await pollCliSession({
    apiUrl: DEFAULT_API_URL,
    sessionId: session.session_id,
    challenge,
    pollIntervalSeconds: session.poll_interval_seconds || 2,
    timeoutMs: DEFAULT_AUTH_TIMEOUT_MS,
  });

  const authToken = String(approval.auth_token || "").trim();
  if (!authToken) {
    throw new Error("Authentication completed but no auth token was returned.");
  }

  printSection("Artifact Generation");
  const generatePayload = {
    description: interview.projectDescription,
    tech_stack: interview.techStack,
    features: interview.features,
    generation_mode: interview.generationMode,
    audience_level: interview.audienceLevel,
    project_type: interview.projectType,
    model_provider: interview.aiProvider,
    model_id: DEFAULT_MODEL_BY_PROVIDER[interview.aiProvider] || undefined,
  };
  const generated = await generateArtifacts({
    apiUrl: DEFAULT_API_URL,
    authToken,
    payload: generatePayload,
  });

  let bootstrapToken = generated?.bootstrap_token || null;
  if (!bootstrapToken || !String(bootstrapToken.token || "").trim()) {
    bootstrapToken = await issueBootstrapToken({
      apiUrl: DEFAULT_API_URL,
      authToken,
    });
  }
  const sentinelayerToken = String(bootstrapToken.token || "").trim();
  if (!sentinelayerToken) {
    throw new Error("Sentinelayer token bootstrap failed.");
  }

  const secretName =
    String(bootstrapToken.required_secret_name || "").trim() || "SENTINELAYER_TOKEN";
  const projectDir = path.resolve(process.cwd(), interview.projectName);
  const docsDir = path.join(projectDir, "docs");
  const promptsDir = path.join(projectDir, "prompts");
  const tasksDir = path.join(projectDir, "tasks");

  await writeTextFile(path.join(docsDir, "spec.md"), String(generated.spec_sheet || "").trim() + "\n");
  await writeTextFile(
    path.join(docsDir, "build-guide.md"),
    String(generated.playbook || "").trim() + "\n"
  );
  await writeTextFile(
    path.join(promptsDir, "execution-prompt.md"),
    String(generated.builder_prompt || "").trim() + "\n"
  );
  await writeTextFile(
    path.join(projectDir, ".github", "workflows", "omar-gate.yml"),
    (String(generated.omar_gate_yaml || "").trim() || fallbackWorkflow()) + "\n"
  );
  await writeTextFile(
    path.join(tasksDir, "todo.md"),
    buildTodoContent({
      projectName: generated.project_name || interview.projectName,
      aiProvider: interview.aiProvider,
      repoSlug: interview.repoSlug,
      generationMode: interview.generationMode,
      audienceLevel: interview.audienceLevel,
      projectType: interview.projectType,
    })
  );
  await writeTextFile(
    path.join(projectDir, "AGENT_HANDOFF_PROMPT.md"),
    buildHandoffPrompt({
      projectName: generated.project_name || interview.projectName,
      repoSlug: interview.repoSlug,
      secretName,
    })
  );

  await ensureSentinelStartScript(projectDir, generated.project_name || interview.projectName);
  await upsertEnvVariable(path.join(projectDir, ".env"), secretName, sentinelayerToken);

  let secretInjection = { ok: false, reason: "Skipped." };
  if (interview.connectRepo && interview.injectSecret && interview.repoSlug) {
    secretInjection = runGhSecretSet({
      repoSlug: interview.repoSlug,
      secretName,
      secretValue: sentinelayerToken,
    });
  }

  printSection("Complete");
  console.log(pc.green(`✔ Sentinelayer orchestration initialized in ${projectDir}`));
  console.log(pc.green(`✔ ${secretName} injected into ${path.join(projectDir, ".env")}`));
  if (interview.connectRepo && interview.injectSecret) {
    if (secretInjection.ok) {
      console.log(pc.green(`✔ ${secretName} injected into GitHub repo secret (${interview.repoSlug})`));
    } else {
      console.log(pc.yellow(`! GitHub secret injection skipped/failed: ${secretInjection.reason}`));
      console.log(
        pc.yellow(
          `  Run manually: gh secret set ${secretName} --repo ${interview.repoSlug || "<owner/repo>"}`
        )
      );
    }
  }

  console.log("\nNext:");
  console.log(`1. cd ${interview.projectName}`);
  console.log("2. npm run sentinel:start");
  console.log("3. Copy/paste AGENT_HANDOFF_PROMPT.md into your coding agent and let it run autonomously.");
}

run().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  const code = error instanceof SentinelayerApiError ? ` [${error.code}]` : "";
  const requestId =
    error instanceof SentinelayerApiError && error.requestId ? ` request_id=${error.requestId}` : "";
  console.error(pc.red(`\nSentinelayer scaffold failed${code}:${requestId}`));
  console.error(pc.red(message));
  process.exitCode = 1;
});
