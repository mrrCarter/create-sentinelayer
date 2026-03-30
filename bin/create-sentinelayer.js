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
const DEFAULT_GITHUB_CLONE_BASE_URL =
  process.env.SENTINELAYER_GITHUB_CLONE_BASE_URL || "https://github.com";
const DEFAULT_AUTH_TIMEOUT_MS = 10 * 60 * 1000;
const DEFAULT_REQUEST_TIMEOUT_MS = 20_000;
const CLI_VERSION = "0.1.0";

const DEFAULT_MODEL_BY_PROVIDER = {
  openai: "gpt-5.3-codex",
  anthropic: "claude-sonnet-4-6",
  google: "gemini-2.5-flash",
};

const VALID_AI_PROVIDERS = new Set(["openai", "anthropic", "google"]);
const VALID_GENERATION_MODES = new Set(["detailed", "quick", "enterprise"]);
const VALID_AUDIENCE_LEVELS = new Set(["developer", "intermediate", "beginner"]);
const VALID_PROJECT_TYPES = new Set(["greenfield", "add_feature", "bugfix"]);

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

function normalizeRepoSlug(value) {
  return String(value || "").trim().replace(/\.git$/i, "");
}

function isValidRepoSlug(value) {
  return /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(normalizeRepoSlug(value));
}

function getRepoNameFromSlug(value) {
  const normalized = normalizeRepoSlug(value);
  const parts = normalized.split("/");
  if (parts.length !== 2) return "";
  return sanitizeProjectName(parts[1]);
}

function isValidSecretName(value) {
  return /^[A-Z][A-Z0-9_]{1,127}$/.test(String(value || "").trim());
}

function boolFromEnv(value) {
  const normalized = String(value || "").trim().toLowerCase();
  return normalized === "1" || normalized === "true" || normalized === "yes" || normalized === "on";
}

function normalizeListInput(value) {
  if (Array.isArray(value)) {
    return value.map((item) => String(item || "").trim()).filter(Boolean);
  }
  return parseCommaList(value);
}

function parseCliArgs(argv) {
  let projectName = "";
  let interviewFile = "";
  let nonInteractive = boolFromEnv(process.env.SENTINELAYER_CLI_NON_INTERACTIVE);
  let skipBrowserOpen = boolFromEnv(process.env.SENTINELAYER_CLI_SKIP_BROWSER_OPEN);
  let showHelp = false;
  let showVersion = false;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = String(argv[i] || "").trim();
    if (!arg) continue;
    if (arg === "--help" || arg === "-h") {
      showHelp = true;
      continue;
    }
    if (arg === "--version" || arg === "-v") {
      showVersion = true;
      continue;
    }
    if (arg === "--non-interactive") {
      nonInteractive = true;
      continue;
    }
    if (arg === "--skip-browser-open") {
      skipBrowserOpen = true;
      continue;
    }
    if (arg === "--interview-file") {
      const next = String(argv[i + 1] || "").trim();
      if (!next) {
        throw new Error("Missing value for --interview-file");
      }
      interviewFile = next;
      i += 1;
      continue;
    }
    if (arg.startsWith("-")) {
      throw new Error(`Unknown argument: ${arg}`);
    }
    if (!projectName) {
      projectName = arg;
    } else {
      throw new Error(`Unexpected extra argument: ${arg}`);
    }
  }

  return {
    projectName,
    interviewFile,
    nonInteractive,
    skipBrowserOpen,
    showHelp,
    showVersion,
  };
}

function printUsage() {
  console.log(`create-sentinelayer v${CLI_VERSION}`);
  console.log("");
  console.log("Usage:");
  console.log("  create-sentinelayer [project-name] [options]");
  console.log("");
  console.log("Options:");
  console.log("  -h, --help             Show help");
  console.log("  -v, --version          Show CLI version");
  console.log("  --non-interactive      Disable prompts and require interview payload");
  console.log("  --interview-file PATH  Load interview JSON from file");
  console.log("  --skip-browser-open    Do not auto-open browser during auth");
  console.log("");
  console.log("Environment:");
  console.log("  SENTINELAYER_CLI_NON_INTERACTIVE=1");
  console.log("  SENTINELAYER_CLI_SKIP_BROWSER_OPEN=1");
  console.log("  SENTINELAYER_CLI_INTERVIEW_JSON='{\"projectName\":\"my-app\",...}'");
  console.log("  SENTINELAYER_GITHUB_CLONE_BASE_URL=https://github.com");
}

function normalizeInterviewInput(raw, { argProjectName = "", detectedRepo = "" } = {}) {
  const obj = raw && typeof raw === "object" ? raw : {};
  const aiProvider = String(obj.aiProvider || "openai").trim().toLowerCase();
  const generationMode = String(obj.generationMode || "detailed").trim().toLowerCase();
  const audienceLevel = String(obj.audienceLevel || "developer").trim().toLowerCase();
  const projectType = String(obj.projectType || "greenfield").trim().toLowerCase();
  const connectRepo = Boolean(obj.connectRepo);
  const repoSlug = normalizeRepoSlug(obj.repoSlug || detectedRepo || "");
  const buildFromExistingRepo = connectRepo ? Boolean(obj.buildFromExistingRepo) : false;
  const derivedProjectName = sanitizeProjectName(obj.projectName || argProjectName) || getRepoNameFromSlug(repoSlug);

  const normalized = {
    projectName: derivedProjectName,
    projectDescription: String(obj.projectDescription || "").trim(),
    aiProvider: VALID_AI_PROVIDERS.has(aiProvider) ? aiProvider : "openai",
    generationMode: VALID_GENERATION_MODES.has(generationMode) ? generationMode : "detailed",
    audienceLevel: VALID_AUDIENCE_LEVELS.has(audienceLevel) ? audienceLevel : "developer",
    projectType: VALID_PROJECT_TYPES.has(projectType) ? projectType : "greenfield",
    techStack: normalizeListInput(obj.techStack),
    features: normalizeListInput(obj.features),
    connectRepo,
    repoSlug: connectRepo ? repoSlug : "",
    buildFromExistingRepo,
    injectSecret: connectRepo ? Boolean(obj.injectSecret) : false,
  };

  return normalized;
}

function validateInterviewInput(interview) {
  if (!interview.projectName) {
    throw new Error("Project name is required.");
  }
  if (String(interview.projectDescription || "").trim().length < 15) {
    throw new Error("Project description must be at least 15 characters.");
  }
  if (!VALID_AI_PROVIDERS.has(interview.aiProvider)) {
    throw new Error("Invalid aiProvider. Use openai, anthropic, or google.");
  }
  if (!VALID_GENERATION_MODES.has(interview.generationMode)) {
    throw new Error("Invalid generationMode. Use detailed, quick, or enterprise.");
  }
  if (!VALID_AUDIENCE_LEVELS.has(interview.audienceLevel)) {
    throw new Error("Invalid audienceLevel. Use developer, intermediate, or beginner.");
  }
  if (!VALID_PROJECT_TYPES.has(interview.projectType)) {
    throw new Error("Invalid projectType. Use greenfield, add_feature, or bugfix.");
  }
  if (interview.connectRepo && !isValidRepoSlug(interview.repoSlug)) {
    throw new Error("Invalid repo slug. Expected owner/repo.");
  }
  if (interview.buildFromExistingRepo && !interview.connectRepo) {
    throw new Error("buildFromExistingRepo requires connectRepo=true.");
  }
}

async function loadAutomatedInterview({ argProjectName, detectedRepo, interviewFile }) {
  const envPayload = String(process.env.SENTINELAYER_CLI_INTERVIEW_JSON || "").trim();
  let payload = null;
  let source = "";

  if (interviewFile) {
    const filePath = path.resolve(process.cwd(), interviewFile);
    const fileContents = await fsp.readFile(filePath, "utf-8");
    payload = JSON.parse(fileContents);
    source = `--interview-file (${filePath})`;
  } else if (envPayload) {
    payload = JSON.parse(envPayload);
    source = "SENTINELAYER_CLI_INTERVIEW_JSON";
  }

  if (payload === null) {
    return null;
  }

  const normalized = normalizeInterviewInput(payload, { argProjectName, detectedRepo });
  try {
    validateInterviewInput(normalized);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Invalid interview payload from ${source}: ${message}`);
  }
  return normalized;
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

function getGhCommand() {
  return String(process.env.SENTINELAYER_GH_BIN || "").trim() || "gh";
}

function getGitCommand() {
  return String(process.env.SENTINELAYER_GIT_BIN || "").trim() || "git";
}

function isGitRepo(cwd) {
  const gitCommand = getGitCommand();
  const probe = spawnSync(gitCommand, ["rev-parse", "--is-inside-work-tree"], {
    cwd,
    encoding: "utf-8",
  });
  return probe.status === 0;
}

function buildGithubCloneUrl(repoSlug) {
  const base = String(DEFAULT_GITHUB_CLONE_BASE_URL || "https://github.com").trim().replace(/\/+$/g, "");
  return `${base}/${normalizeRepoSlug(repoSlug)}.git`;
}

function ensureGhCliAvailable(ghCommand) {
  const ghVersion = spawnSync(ghCommand, ["--version"], { encoding: "utf-8" });
  if (ghVersion.status !== 0) {
    throw new Error("GitHub CLI (gh) is not installed or not in PATH.");
  }
}

function ensureGhAuthSession(ghCommand) {
  ensureGhCliAvailable(ghCommand);
  const status = spawnSync(ghCommand, ["auth", "status", "-h", "github.com"], {
    encoding: "utf-8",
  });
  if (status.status === 0) {
    return;
  }

  console.log("GitHub authorization required. Opening browser for gh auth login...");
  const login = spawnSync(ghCommand, ["auth", "login", "-h", "github.com", "-s", "repo", "-w"], {
    encoding: "utf-8",
    stdio: "inherit",
  });
  if (login.status !== 0) {
    throw new Error("GitHub authorization failed. Complete gh auth login and retry.");
  }
}

function listReposViaGh(ghCommand) {
  const apiResult = spawnSync(
    ghCommand,
    ["api", "/user/repos?per_page=100&sort=updated&affiliation=owner,collaborator,organization_member"],
    { encoding: "utf-8" }
  );
  if (apiResult.status !== 0) {
    throw new Error(
      String(apiResult.stderr || apiResult.stdout || "Unable to fetch repositories with gh api.").trim()
    );
  }

  let payload = [];
  try {
    payload = JSON.parse(String(apiResult.stdout || "[]"));
  } catch {
    throw new Error("GitHub repo list response was not valid JSON.");
  }
  if (!Array.isArray(payload)) {
    throw new Error("GitHub repo list response was not an array.");
  }

  const seen = new Set();
  const repos = [];
  for (const item of payload) {
    const slug = normalizeRepoSlug(item && typeof item.full_name === "string" ? item.full_name : "");
    if (!isValidRepoSlug(slug)) continue;
    const key = slug.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    repos.push({
      slug,
      privateRepo: Boolean(item.private),
      defaultBranch: String(item.default_branch || "").trim() || "main",
    });
  }
  return repos;
}

async function selectRepoSlugFromGithub() {
  const ghCommand = getGhCommand();
  ensureGhAuthSession(ghCommand);
  const repos = listReposViaGh(ghCommand);
  if (repos.length === 0) {
    throw new Error("No accessible GitHub repos found for this account.");
  }

  const result = await prompts(
    [
      {
        type: "select",
        name: "repoSlug",
        message: "Choose a GitHub repo",
        choices: repos.map((repo) => ({
          title: `${repo.slug}${repo.privateRepo ? " (private)" : ""} [${repo.defaultBranch}]`,
          value: repo.slug,
        })),
        initial: 0,
      },
    ],
    {
      onCancel: () => {
        throw new Error("GitHub repo selection cancelled.");
      },
    }
  );

  const selected = normalizeRepoSlug(result.repoSlug);
  if (!isValidRepoSlug(selected)) {
    throw new Error("GitHub repo selection returned an invalid repository slug.");
  }
  return selected;
}

async function cloneGithubRepo({ repoSlug, cwd }) {
  const normalizedRepo = normalizeRepoSlug(repoSlug);
  const repoName = getRepoNameFromSlug(normalizedRepo) || "repo";
  const targetDir = path.resolve(cwd, repoName);
  const gitCommand = getGitCommand();
  const cloneUrl = buildGithubCloneUrl(normalizedRepo);

  if (path.resolve(cwd) === path.resolve(targetDir)) {
    throw new Error("Target clone directory cannot match the current working directory.");
  }
  if (fs.existsSync(targetDir) && !isGitRepo(targetDir)) {
    const entries = await fsp.readdir(targetDir);
    if (entries.length > 0) {
      throw new Error(
        `Cannot clone ${normalizedRepo}: target directory '${repoName}' already exists and is not an empty git repo.`
      );
    }
  }
  if (isGitRepo(targetDir)) {
    const localSlug = normalizeRepoSlug(detectRepoSlug(targetDir) || "");
    if (localSlug && localSlug.toLowerCase() !== normalizedRepo.toLowerCase()) {
      throw new Error(
        `Directory '${repoName}' already contains a different repo (${localSlug}). Choose another project name or folder.`
      );
    }
    return {
      projectDir: targetDir,
      cloneUrl,
      cloned: false,
    };
  }

  const cloneResult = spawnSync(gitCommand, ["clone", "--depth", "1", cloneUrl, targetDir], {
    cwd,
    encoding: "utf-8",
  });
  if (cloneResult.status !== 0) {
    throw new Error(String(cloneResult.stderr || cloneResult.stdout || "git clone failed").trim());
  }
  return {
    projectDir: targetDir,
    cloneUrl,
    cloned: true,
  };
}

async function ensureGitRepositorySetup({ projectDir, repoSlug }) {
  const gitCommand = getGitCommand();
  if (!isGitRepo(projectDir)) {
    const initResult = spawnSync(gitCommand, ["init"], {
      cwd: projectDir,
      encoding: "utf-8",
    });
    if (initResult.status !== 0) {
      throw new Error(String(initResult.stderr || initResult.stdout || "git init failed").trim());
    }
  }

  const normalizedRepo = normalizeRepoSlug(repoSlug);
  if (!isValidRepoSlug(normalizedRepo)) return;

  const remoteGet = spawnSync(gitCommand, ["config", "--get", "remote.origin.url"], {
    cwd: projectDir,
    encoding: "utf-8",
  });
  const remote = String(remoteGet.stdout || "").trim();
  if (remote) return;

  const remoteUrl = buildGithubCloneUrl(normalizedRepo);
  const remoteAdd = spawnSync(gitCommand, ["remote", "add", "origin", remoteUrl], {
    cwd: projectDir,
    encoding: "utf-8",
  });
  if (remoteAdd.status !== 0) {
    throw new Error(String(remoteAdd.stderr || remoteAdd.stdout || "git remote add failed").trim());
  }
}

async function resolveProjectDirectory({ cwd, interview, detectedRepo }) {
  const normalizedTargetRepo = normalizeRepoSlug(interview.repoSlug);
  const normalizedDetected = normalizeRepoSlug(detectedRepo || "");

  if (interview.connectRepo && interview.buildFromExistingRepo && isValidRepoSlug(normalizedTargetRepo)) {
    if (normalizedDetected && normalizedDetected.toLowerCase() === normalizedTargetRepo.toLowerCase()) {
      return {
        projectDir: cwd,
        clonedRepo: false,
        reusedCurrentRepo: true,
      };
    }
    const cloned = await cloneGithubRepo({
      repoSlug: normalizedTargetRepo,
      cwd,
    });
    return {
      projectDir: cloned.projectDir,
      clonedRepo: cloned.cloned,
      reusedCurrentRepo: false,
      cloneUrl: cloned.cloneUrl,
    };
  }

  return {
    projectDir: path.resolve(cwd, interview.projectName),
    clonedRepo: false,
    reusedCurrentRepo: false,
  };
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
  buildFromExistingRepo,
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
- Workspace mode: \`${buildFromExistingRepo ? "existing repo clone" : "new scaffold"}\`

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

function buildHandoffPrompt({ projectName, repoSlug, secretName, buildFromExistingRepo }) {
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
- Workspace mode: ${buildFromExistingRepo ? "existing codebase" : "new scaffold"}

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
  const normalizedRepo = normalizeRepoSlug(repoSlug);
  const ghCommand = getGhCommand();
  const secretSinkFile = String(process.env.SENTINELAYER_SECRET_SINK_FILE || "").trim();
  if (!isValidRepoSlug(normalizedRepo)) {
    return {
      ok: false,
      reason: "Invalid repo format. Use owner/repo.",
    };
  }
  if (!isValidSecretName(secretName)) {
    return {
      ok: false,
      reason: "Invalid secret name from bootstrap response.",
    };
  }
  if (secretSinkFile) {
    try {
      fs.appendFileSync(secretSinkFile, `${normalizedRepo}|${secretName}|${secretValue}\n`, "utf-8");
      return { ok: true };
    } catch (error) {
      return {
        ok: false,
        reason: `Failed to write SENTINELAYER_SECRET_SINK_FILE: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  }
  try {
    ensureGhCliAvailable(ghCommand);
  } catch (error) {
    return {
      ok: false,
      reason: error instanceof Error ? error.message : String(error),
    };
  }

  const result = spawnSync(ghCommand, ["secret", "set", secretName, "--repo", normalizedRepo], {
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
    buildFromExistingRepo: false,
    injectSecret: false,
  };
  if (base.advanced) {
    const repoChoices = [];
    if (detectedRepo) {
      repoChoices.push({
        title: `Use current repo (${detectedRepo})`,
        value: "current",
      });
    }
    repoChoices.push({
      title: "Choose from GitHub account (browser auth)",
      value: "picker",
    });
    repoChoices.push({
      title: "Enter owner/repo manually",
      value: "manual",
    });

    const repoSetup = await prompts(
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
          type: (prev) => (prev ? "select" : null),
          name: "repoSource",
          message: "How should we choose the repo?",
          choices: repoChoices,
          initial: detectedRepo ? 0 : 1,
        },
      ],
      { onCancel }
    );

    advanced.connectRepo = Boolean(repoSetup.connectRepo);
    if (advanced.connectRepo) {
      let repoSlug = detectedRepo || "";
      const repoSource = String(repoSetup.repoSource || "").trim().toLowerCase();

      if (repoSource === "manual") {
        const manual = await prompts(
          [
            {
              type: "text",
              name: "repoSlug",
              message: "GitHub repo (owner/repo)",
              initial: detectedRepo || "",
              validate: (value) => (isValidRepoSlug(value) ? true : "Use owner/repo format."),
            },
          ],
          { onCancel }
        );
        repoSlug = normalizeRepoSlug(manual.repoSlug);
      } else if (repoSource === "picker") {
        repoSlug = await selectRepoSlugFromGithub();
      } else {
        repoSlug = normalizeRepoSlug(detectedRepo);
      }

      if (!isValidRepoSlug(repoSlug)) {
        throw new Error("GitHub repo selection did not produce a valid owner/repo value.");
      }

      const repoMode = await prompts(
        [
          {
            type: "toggle",
            name: "buildFromExistingRepo",
            message: "Clone this repo locally and build directly into it now?",
            initial: base.projectType === "add_feature" || base.projectType === "bugfix",
            active: "yes",
            inactive: "no",
          },
          {
            type: "toggle",
            name: "injectSecret",
            message: "Inject SENTINELAYER_TOKEN into GitHub Actions secrets now?",
            initial: true,
            active: "yes",
            inactive: "no",
          },
        ],
        { onCancel }
      );

      advanced.repoSlug = repoSlug;
      advanced.buildFromExistingRepo = Boolean(repoMode.buildFromExistingRepo);
      advanced.injectSecret = Boolean(repoMode.injectSecret);
    }
  }

  const projectName =
    sanitizeProjectName(initialProjectName || base.projectName) || getRepoNameFromSlug(advanced.repoSlug);

  return {
    projectName,
    projectDescription: String(base.projectDescription || "").trim(),
    aiProvider: base.aiProvider,
    generationMode: base.generationMode,
    audienceLevel: base.audienceLevel,
    projectType: base.projectType,
    techStack: parseCommaList(base.techStack),
    features: parseCommaList(base.features),
    connectRepo: Boolean(advanced.connectRepo),
    repoSlug: normalizeRepoSlug(advanced.repoSlug),
    buildFromExistingRepo: Boolean(advanced.buildFromExistingRepo),
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
  const args = parseCliArgs(process.argv.slice(2));
  if (args.showHelp) {
    printUsage();
    return;
  }
  if (args.showVersion) {
    console.log(CLI_VERSION);
    return;
  }
  const argProjectName = args.projectName;
  const detectedRepo = detectRepoSlug(process.cwd());

  printSection("Sentinelayer Scaffold");
  printInfo(`API: ${DEFAULT_API_URL}`);
  printInfo(`Web: ${DEFAULT_WEB_URL}`);
  if (detectedRepo) {
    printInfo(`Detected repo: ${detectedRepo}`);
  }

  const automatedInterview = await loadAutomatedInterview({
    argProjectName,
    detectedRepo,
    interviewFile: args.interviewFile,
  });

  const interview =
    automatedInterview ||
    (args.nonInteractive
      ? null
      : await collectInterview({
          initialProjectName: argProjectName,
          detectedRepo,
        }));

  if (!interview) {
    throw new Error(
      "Non-interactive mode requires SENTINELAYER_CLI_INTERVIEW_JSON or --interview-file."
    );
  }
  validateInterviewInput(interview);

  printSection("Authentication");
  if (args.nonInteractive) {
    console.log("Non-interactive mode: skipping Enter confirmation.");
  } else {
    await waitForEnter("Press Enter to authenticate with Sentinelayer in your browser...");
  }

  const challenge = crypto.randomBytes(32).toString("hex");
  const session = await startCliSession({
    apiUrl: DEFAULT_API_URL,
    challenge,
    cliVersion: CLI_VERSION,
  });

  if (args.skipBrowserOpen || args.nonInteractive) {
    console.log(`Browser open skipped. Authorize manually: ${session.authorize_url}`);
  } else {
    console.log(`Opening browser: ${session.authorize_url}`);
    try {
      await open(session.authorize_url);
    } catch {
      console.log(pc.yellow("Could not auto-open browser. Open this URL manually:"));
      console.log(pc.yellow(session.authorize_url));
    }
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

  const requestedSecretName = String(bootstrapToken.required_secret_name || "").trim();
  const secretName = isValidSecretName(requestedSecretName)
    ? requestedSecretName
    : "SENTINELAYER_TOKEN";
  if (requestedSecretName && requestedSecretName !== secretName) {
    console.log(
      pc.yellow(
        `Received invalid secret name '${requestedSecretName}' from API. Falling back to ${secretName}.`
      )
    );
  }

  const workspace = await resolveProjectDirectory({
    cwd: process.cwd(),
    interview,
    detectedRepo,
  });
  const projectDir = workspace.projectDir;
  if (workspace.reusedCurrentRepo) {
    printInfo(`Using current repo workspace: ${projectDir}`);
  } else if (workspace.clonedRepo) {
    printInfo(`Cloned repo workspace: ${projectDir}`);
    if (workspace.cloneUrl) {
      printInfo(`Clone URL: ${workspace.cloneUrl}`);
    }
  }

  const effectiveProjectName =
    sanitizeProjectName(generated.project_name || interview.projectName || path.basename(projectDir)) ||
    path.basename(projectDir);
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
      projectName: effectiveProjectName,
      aiProvider: interview.aiProvider,
      repoSlug: interview.repoSlug,
      buildFromExistingRepo: interview.buildFromExistingRepo,
      generationMode: interview.generationMode,
      audienceLevel: interview.audienceLevel,
      projectType: interview.projectType,
    })
  );
  await writeTextFile(
    path.join(projectDir, "AGENT_HANDOFF_PROMPT.md"),
    buildHandoffPrompt({
      projectName: effectiveProjectName,
      repoSlug: interview.repoSlug,
      secretName,
      buildFromExistingRepo: interview.buildFromExistingRepo,
    })
  );

  await ensureSentinelStartScript(projectDir, effectiveProjectName);
  await upsertEnvVariable(path.join(projectDir, ".env"), secretName, sentinelayerToken);
  await ensureGitRepositorySetup({
    projectDir,
    repoSlug: interview.connectRepo ? interview.repoSlug : "",
  });

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
  const nextCd = path.relative(process.cwd(), projectDir) || ".";
  console.log(`1. cd ${nextCd}`);
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
