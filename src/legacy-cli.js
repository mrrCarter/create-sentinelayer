#!/usr/bin/env node

import crypto from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { spawnSync } from "node:child_process";
import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { pathToFileURL } from "node:url";

import open from "open";
import pc from "picocolors";
import prompts from "prompts";
import {
  DEFAULT_CODING_AGENT_ID,
  detectCodingAgentFromEnv,
  detectIdeFromEnv,
  listSupportedCodingAgents,
  resolveCodingAgent,
} from "./config/agent-dictionary.js";
import { resolveOutputRoot } from "./config/service.js";
import { normalizeAgentEvent } from "./events/schema.js";
import { collectCodebaseIngest, formatIngestSummary } from "./ingest/engine.js";
import { getExpressTemplate, getPackageJsonTemplate, buildReadmeContent } from "./scaffold/templates.js";
import { generateScaffold } from "./scaffold/generator.js";
import {
  getCoordinationEtiquetteItems,
  renderCoordinationNumberedList,
} from "./session/coordination-guidance.js";

let DEFAULT_API_URL = process.env.SENTINELAYER_API_URL || "https://api.sentinelayer.com";
let DEFAULT_WEB_URL = process.env.SENTINELAYER_WEB_URL || "https://sentinelayer.com";
let DEFAULT_GITHUB_CLONE_BASE_URL =
  process.env.SENTINELAYER_GITHUB_CLONE_BASE_URL || "https://github.com";
const DEFAULT_AUTH_TIMEOUT_MS = 10 * 60 * 1000;
const DEFAULT_REQUEST_TIMEOUT_MS = 20_000;
const PACKAGE_JSON_PATH = new URL("../package.json", import.meta.url);

function refreshRuntimeDefaults() {
  DEFAULT_API_URL = process.env.SENTINELAYER_API_URL || "https://api.sentinelayer.com";
  DEFAULT_WEB_URL = process.env.SENTINELAYER_WEB_URL || "https://sentinelayer.com";
  DEFAULT_GITHUB_CLONE_BASE_URL =
    process.env.SENTINELAYER_GITHUB_CLONE_BASE_URL || "https://github.com";
}

function resolveCliVersion() {
  try {
    const raw = fs.readFileSync(PACKAGE_JSON_PATH, "utf-8");
    const pkg = JSON.parse(raw);
    const version = String(pkg && pkg.version ? pkg.version : "").trim();
    if (version) {
      return version;
    }
  } catch {
    // Ignore and fall through to static fallback.
  }
  return "0.1.0";
}

export const CLI_VERSION = resolveCliVersion();

const DEFAULT_MODEL_BY_PROVIDER = {
  openai: "gpt-5.3-codex",
  anthropic: "claude-sonnet-4-6",
  google: "gemini-2.5-flash",
};

const VALID_AI_PROVIDERS = new Set(["openai", "anthropic", "google"]);
const VALID_GENERATION_MODES = new Set(["detailed", "quick", "enterprise"]);
const VALID_AUDIENCE_LEVELS = new Set(["developer", "intermediate", "beginner"]);
const VALID_PROJECT_TYPES = new Set(["greenfield", "add_feature", "bugfix"]);
const VALID_AUTH_MODES = new Set(["sentinelayer", "byok"]);

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
    if (arg === "--help" || arg === "-h" || arg === "help") {
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
  console.log(`sentinelayer-cli v${CLI_VERSION}`);
  console.log("");
  console.log("Usage: sl <command> [options]");
  console.log("");
  console.log("Scaffold:");
  console.log("  sl [project-name]                  Create a new project with SentinelLayer scaffolding");
  console.log("  sl init [project-name]             Same as above (interactive or --non-interactive)");
  console.log("");
  console.log("Authentication:");
  console.log("  sl auth login                      Log in via browser (provisions SentinelLayer + AIdenID)");
  console.log("  sl auth status                     Show authentication and AIdenID provisioning status");
  console.log("  sl auth sessions                   List stored session metadata");
  console.log("  sl auth logout                     Clear local session");
  console.log("");
  console.log("Session Coordination:");
  console.log("  sl session start --json            Create an agent coordination session");
  console.log("  sl session start --template code-review  Start from quick-start preset + launch plan");
  console.log("  sl session templates --json        List available session quick-start templates");
  console.log("  sl session join <id> --name <n>    Join a session as an agent");
  console.log("  sl session say <id> \"msg\" --json  Append a message event to session stream");
  console.log("  sl session say <id> \"lock: <file> - <intent>\"  Request an exclusive file lock via Senti");
  console.log("  sl session say <id> \"assign: @agent <task>\"  Create task assignment + lease");
  console.log("  sl session say <id> \"assign: @*:reviewer <task>\"  Wildcard route to least-busy role");
  console.log("  sl session say <id> \"accepted: task <task-id>\" / \"done: task <task-id>\"  Task transitions");
  console.log("  sl session read <id> --tail 20     Read session stream events");
  console.log("  sl session status <id> --json      Show session health, agents, runs, leases");
  console.log("  sl session leave <id>              Leave a session");
  console.log("  sl session list --json             List active sessions");
  console.log("  sl session setup-guides <id> --json  Upsert AGENTS.md/CLAUDE.md coordination section");
  console.log("  sl session inject-guide <id> --json  Inject section into existing AGENTS.md/CLAUDE.md files");
  console.log("  sl session provision-emails <id> --count 5  Provision AIdenID emails for swarm testing");
  console.log("  sl session admin-kill <id> --reason <reason>  Admin kill one remote session");
  console.log("  sl session admin-kill-all --confirm  Admin kill ALL remote sessions");
  console.log("  sl session kill --session <id> --agent <id>  Kill agent + revoke active leases");
  console.log("");
  console.log("Security & Review:");
  console.log("  sl review scan --path . --json     Deterministic code review (full or --mode diff)");
  console.log("  sl /omargate deep --path . --json  Local Omar Gate security scan (P0/P1/P2 findings)");
  console.log("  sl scan init                       Generate .github/workflows/omar-gate.yml from spec");
  console.log("  sl scan setup-secrets --repo <slug> Inject SENTINELAYER_TOKEN into GitHub repo secrets");
  console.log("");
  console.log("Specification & Planning:");
  console.log("  sl spec list-templates             List available project templates");
  console.log("  sl spec generate                   Generate SPEC.md from template or AI");
  console.log("  sl prompt generate                 Generate agent execution prompt from spec");
  console.log("  sl guide generate                  Generate BUILD_GUIDE.md from spec");
  console.log("  sl ingest map --json               Codebase AST ingest with framework detection");
  console.log("");
  console.log("Audit & Quality:");
  console.log("  sl audit --path . --json           Full 15-agent audit swarm");
  console.log("  sl audit frontend --path . --json  Jules frontend audit (--stream for NDJSON, --url for runtime)");
  console.log("  sl audit security --path . --json  Security-focused audit");
  console.log("");
  console.log("AIdenID (Identity Testing):");
  console.log("  sl ai identity provision --execute  Provision ephemeral test email (auto-credentials after login)");
  console.log("  sl ai identity wait-for-otp <id>   Poll for OTP extraction from provisioned email");
  console.log("  sl ai identity list                List tracked identities");
  console.log("  sl ai identity lineage <id>        Show identity parent/child tree");
  console.log("  sl ai identity revoke <id>         Revoke a provisioned identity");
  console.log("");
  console.log("Cost & Policy:");
  console.log("  sl cost show --json                Show accumulated cost tracking");
  console.log("  sl policy list                     List available policy packs");
  console.log("  sl policy use <pack>               Switch active policy pack");
  console.log("");
  console.log("Advanced:");
  console.log("  sl swarm plan --path . --json      Multi-agent swarm planning");
  console.log("  sl mcp list --json                 List MCP registries and adapters");
  console.log("  sl telemetry show --json            Show run event ledger");
  console.log("  sl config list                     Show current configuration");
  console.log("");
  console.log("Options:");
  console.log("  -h, --help             Show this help");
  console.log("  -v, --version          Show CLI version");
  console.log("  --json                 Machine-readable JSON output");
  console.log("  --path PATH            Target workspace path");
  console.log("  --non-interactive      Disable prompts (require --interview-file)");
  console.log("");
  console.log("Quickstart:");
  console.log("  sl auth login && npx create-sentinelayer my-app && cd my-app");
  console.log("  # Then hand docs/spec.md to your coding agent");
  console.log("");
  console.log("Docs: https://sentinelayer.com/docs");
}

function normalizeInterviewInput(
  raw,
  { argProjectName = "", detectedRepo = "", detectedCodingAgent = DEFAULT_CODING_AGENT_ID } = {}
) {
  const obj = raw && typeof raw === "object" ? raw : {};
  const aiProvider = String(obj.aiProvider || "openai").trim().toLowerCase();
  const generationMode = String(obj.generationMode || "detailed").trim().toLowerCase();
  const audienceLevel = String(obj.audienceLevel || "developer").trim().toLowerCase();
  const codingAgentCandidate = String(obj.codingAgent || detectedCodingAgent || DEFAULT_CODING_AGENT_ID)
    .trim()
    .toLowerCase();
  const authMode = String(obj.authMode || "sentinelayer").trim().toLowerCase();
  const explicitRepoSlug = normalizeRepoSlug(obj.repoSlug || "");
  const connectRepo = Boolean(obj.connectRepo) || isValidRepoSlug(explicitRepoSlug);
  const repoSlug = normalizeRepoSlug(obj.repoSlug || detectedRepo || "");
  const buildFromExistingRepo = connectRepo ? Boolean(obj.buildFromExistingRepo) : false;
  const rawProjectType = String(obj.projectType || "")
    .trim()
    .toLowerCase();
  const fallbackProjectType =
    buildFromExistingRepo || (connectRepo && isValidRepoSlug(repoSlug)) || isValidRepoSlug(detectedRepo)
      ? "add_feature"
      : "greenfield";
  const projectType = VALID_PROJECT_TYPES.has(rawProjectType) ? rawProjectType : fallbackProjectType;
  const normalizedAuthMode = VALID_AUTH_MODES.has(authMode) ? authMode : "sentinelayer";
  const derivedProjectName = sanitizeProjectName(obj.projectName || argProjectName) || getRepoNameFromSlug(repoSlug);
  let resolvedCodingAgent;
  try {
    resolvedCodingAgent = resolveCodingAgent(codingAgentCandidate).id;
  } catch {
    resolvedCodingAgent = DEFAULT_CODING_AGENT_ID;
  }

  const normalized = {
    projectName: derivedProjectName,
    projectDescription: String(obj.projectDescription || "").trim(),
    aiProvider: VALID_AI_PROVIDERS.has(aiProvider) ? aiProvider : "openai",
    generationMode: VALID_GENERATION_MODES.has(generationMode) ? generationMode : "detailed",
    audienceLevel: VALID_AUDIENCE_LEVELS.has(audienceLevel) ? audienceLevel : "developer",
    projectType,
    codingAgent: resolvedCodingAgent,
    techStack: normalizeListInput(obj.techStack),
    features: normalizeListInput(obj.features),
    authMode: normalizedAuthMode,
    connectRepo,
    repoSlug: connectRepo ? repoSlug : "",
    buildFromExistingRepo,
    injectSecret: connectRepo && normalizedAuthMode === "sentinelayer" ? Boolean(obj.injectSecret) : false,
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
  try {
    resolveCodingAgent(interview.codingAgent || DEFAULT_CODING_AGENT_ID);
  } catch {
    throw new Error(
      `Invalid codingAgent. Use one of: ${listSupportedCodingAgents()
        .map((agent) => agent.id)
        .join(", ")}.`
    );
  }
  if (!VALID_AUTH_MODES.has(interview.authMode)) {
    throw new Error("Invalid authMode. Use sentinelayer or byok.");
  }
  if (interview.connectRepo && !isValidRepoSlug(interview.repoSlug)) {
    throw new Error("Invalid repo slug. Expected owner/repo.");
  }
  if (interview.buildFromExistingRepo && !interview.connectRepo) {
    throw new Error("buildFromExistingRepo requires connectRepo=true.");
  }
  if (interview.injectSecret && interview.authMode !== "sentinelayer") {
    throw new Error("injectSecret requires authMode=sentinelayer.");
  }
}

async function loadAutomatedInterview({
  argProjectName,
  detectedRepo,
  detectedCodingAgent,
  interviewFile,
}) {
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

  const normalized = normalizeInterviewInput(payload, {
    argProjectName,
    detectedRepo,
    detectedCodingAgent,
  });
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
  return detectIdeFromEnv(process.env).id;
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
  const endpoint = "/user/repos?per_page=100&sort=updated&affiliation=owner,collaborator,organization_member";
  const apiResult = spawnSync(
    ghCommand,
    ["api", "--paginate", "--slurp", endpoint],
    { encoding: "utf-8" }
  );
  if (apiResult.status !== 0) {
    const fallback = spawnSync(ghCommand, ["api", endpoint], { encoding: "utf-8" });
    if (fallback.status !== 0) {
      throw new Error(
        String(
          fallback.stderr ||
            fallback.stdout ||
            apiResult.stderr ||
            apiResult.stdout ||
            "Unable to fetch repositories with gh api."
        ).trim()
      );
    }
    return parseGhRepoListPayload(String(fallback.stdout || "[]"));
  }
  return parseGhRepoListPayload(String(apiResult.stdout || "[]"));
}

function parseGhRepoListPayload(rawJson) {
  let payload = [];
  try {
    payload = JSON.parse(rawJson);
  } catch {
    throw new Error("GitHub repo list response was not valid JSON.");
  }
  if (!Array.isArray(payload)) {
    throw new Error("GitHub repo list response was not an array.");
  }

  const flattened = [];
  for (const entry of payload) {
    if (Array.isArray(entry)) {
      flattened.push(...entry);
    } else {
      flattened.push(entry);
    }
  }

  const seen = new Set();
  const repos = [];
  for (const item of flattened) {
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
    if (!localSlug) {
      throw new Error(
        `Directory '${repoName}' already contains a git repo without a detectable GitHub origin. Refusing to overwrite it.`
      );
    }
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

async function buildRepoIngestSummary(projectDir) {
  try {
    const ingest = await collectCodebaseIngest({ rootPath: projectDir });
    return formatIngestSummary(ingest);
  } catch {
    return "";
  }
}

function formatTimestampForFile() {
  const now = new Date();
  const pad = (value) => String(value).padStart(2, "0");
  return `${now.getUTCFullYear()}${pad(now.getUTCMonth() + 1)}${pad(now.getUTCDate())}-${pad(
    now.getUTCHours()
  )}${pad(now.getUTCMinutes())}${pad(now.getUTCSeconds())}`;
}

function getCommandOptionValue(args, optionName) {
  const index = args.findIndex((arg) => String(arg || "").trim() === optionName);
  if (index < 0) return "";
  const next = String(args[index + 1] || "").trim();
  if (!next || next.startsWith("-")) {
    throw new Error(`Missing value for ${optionName}`);
  }
  return next;
}

function hasCommandOption(args, optionName) {
  return args.some((arg) => String(arg || "").trim() === optionName);
}

async function collectScanFiles(rootPath) {
  const files = [];
  const stack = [rootPath];
  const ignoredDirs = new Set([".git", "node_modules", ".venv", ".next", "dist", "build", "out", "coverage", "__pycache__", ".turbo", ".cache", ".parcel-cache", ".svelte-kit", ".nuxt", ".output", ".vercel", ".sentinelayer"]);
  const maxFileSizeBytes = 512 * 1024;

  while (stack.length > 0) {
    const current = stack.pop();
    if (!current) continue;
    let entries = [];
    try {
      entries = await fsp.readdir(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const fullPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        if (ignoredDirs.has(entry.name)) continue;
        stack.push(fullPath);
        continue;
      }
      if (!entry.isFile()) continue;
      try {
        const stat = await fsp.stat(fullPath);
        if (stat.size > maxFileSizeBytes) continue;
      } catch {
        continue;
      }
      files.push(fullPath);
    }
  }
  return files;
}

async function runCredentialScan(targetPath) {
  const testOrFixturePathPattern = /(?:^|[\\/])(?:test|tests|__tests__|fixtures?)(?:[\\/]|$)/i;
  const localReviewSourcePathPattern = /(?:^|[\\/])src[\\/]review[\\/]local-review\.js$/i;
  const workItemExcludePathPattern = new RegExp(
    `${testOrFixturePathPattern.source}|${localReviewSourcePathPattern.source}`,
    "i"
  );
  const rules = [
    {
      severity: "P1",
      message: "Possible AWS access key detected.",
      regex: /AKIA[0-9A-Z]{16}/,
    },
    {
      severity: "P1",
      message: "Possible private key material detected.",
      regex: /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
    },
    {
      severity: "P1",
      message: "Possible provider API key detected.",
      regex: /\b(sk-[A-Za-z0-9]{20,}|ghp_[A-Za-z0-9]{20,})\b/,
    },
    {
      severity: "P2",
      message: "Possible hardcoded credential literal.",
      regex: /(api[_-]?key|secret|token)\s*[:=]\s*['"][^'"]{20,}['"]/i,
      excludePathPattern: testOrFixturePathPattern,
    },
    {
      severity: "P2",
      message: "Work-item marker found.",
      regex: /\b(?:\x54\x4f\x44\x4f|\x46\x49\x58\x4d\x45|\x48\x41\x43\x4b)\b/,
      excludePathPattern: workItemExcludePathPattern,
    },
  ];

  const files = await collectScanFiles(targetPath);
  const findings = [];
  const maxFindings = 200;

  for (const filePath of files) {
    const relativePath = path.relative(targetPath, filePath).replace(/\\/g, "/");
    let text = "";
    try {
      text = await fsp.readFile(filePath, "utf-8");
    } catch {
      continue;
    }
    const lines = text.split(/\r?\n/);
    for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
      const line = lines[lineIndex];
      if (!line) continue;
      if (line.includes("<your-token>") || line.includes("example")) continue;
      for (const rule of rules) {
        if (rule.excludePathPattern && rule.excludePathPattern.test(relativePath)) continue;
        if (!rule.regex.test(line)) continue;
        findings.push({
          severity: rule.severity,
          file: relativePath,
          line: lineIndex + 1,
          message: rule.message,
          excerpt: line.trim().slice(0, 180),
        });
        if (findings.length >= maxFindings) break;
      }
      if (findings.length >= maxFindings) break;
    }
    if (findings.length >= maxFindings) break;
  }

  const p1 = findings.filter((item) => item.severity === "P1").length;
  const p2 = findings.filter((item) => item.severity === "P2").length;

  return {
    scannedFiles: files.length,
    findings,
    p1,
    p2,
  };
}

async function writeLocalCommandReport(targetPath, prefix, body, { outputDir = "" } = {}) {
  const outputRoot = await resolveOutputRoot({
    cwd: targetPath,
    outputDirOverride: outputDir,
  });
  const reportDir = path.join(outputRoot, "reports");
  await ensureDirectory(reportDir);
  const reportPath = path.join(reportDir, `${prefix}-${formatTimestampForFile()}.md`);
  await writeTextFile(reportPath, `${body}\n`);
  return reportPath;
}

function formatFindingsMarkdown(findings) {
  if (!findings.length) return "- none";
  return findings
    .map((item, index) => `${index + 1}. [${item.severity}] ${item.file}:${item.line} - ${item.message}`)
    .join("\n");
}

const OMAR_SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const PERSONA_ICONS = {
  security: "🛡️",
  architecture: "🏗️",
  backend: "⚙️",
  testing: "🧪",
  performance: "⚡",
  compliance: "📋",
  reliability: "🔄",
  release: "🚀",
  observability: "📊",
  infrastructure: "☁️",
  "supply-chain": "📦",
  frontend: "🎨",
  documentation: "📝",
  "ai-governance": "🤖",
  "code-quality": "💎",
  data: "🗄️",
};

function formatElapsed(ms) {
  const seconds = Math.max(0, Math.round(ms / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const rem = seconds % 60;
  return `${minutes}m${String(rem).padStart(2, "0")}s`;
}

function labelForPersona(payload) {
  const identity = payload?.identity || {};
  const short = identity.shortName || identity.fullName || "";
  const id = payload?.personaId || "persona";
  return short ? `${short} (${id})` : id;
}

function buildOmarTerminalHandler({ startedAt = Date.now() } = {}) {
  let spinIdx = 0;
  let spinInterval = null;
  let currentMessage = "";

  function startSpinner(msg) {
    currentMessage = msg;
    if (spinInterval) clearInterval(spinInterval);
    spinInterval = setInterval(() => {
      const frame = OMAR_SPINNER[spinIdx % OMAR_SPINNER.length];
      process.stderr.write(`\r${pc.cyan(frame)} ${currentMessage}`);
      spinIdx++;
    }, 80);
  }

  function stopSpinner() {
    if (spinInterval) {
      clearInterval(spinInterval);
      spinInterval = null;
    }
    process.stderr.write("\r" + " ".repeat(80) + "\r");
  }

  return (evt) => {
    const normalizedEvent = normalizeAgentEvent(evt);
    const event = normalizedEvent?.event || evt?.event || "";
    const payload = normalizedEvent?.payload || evt?.payload || {};
    const elapsed = formatElapsed(Date.now() - startedAt);

    switch (event) {
      case "omargate_start": {
        const mode = payload.mode || "deep";
        const roster = Array.isArray(payload.roster) ? payload.roster : [];
        const count = roster.length || payload.personas?.length || 0;
        console.error("");
        console.error(pc.bold(pc.cyan(`  Omar Gate AI Analysis (${mode} — ${count} personas) ${pc.gray(`[${elapsed}]`)}`)));
        console.error(pc.gray(`  Budget: $${(payload.maxCostUsd || 5).toFixed(2)} | Parallel: ${payload.maxParallel || 4}`));
        if (roster.length) {
          console.error("");
          console.error(pc.bold("  Roster:"));
          for (const member of roster) {
            const icon = PERSONA_ICONS[member.id] || "🔍";
            console.error(`    ${icon}  ${pc.white(member.fullName || member.id)} ${pc.gray(`— ${member.domain || member.id}`)}`);
          }
        }
        console.error("");
        startSpinner("Dispatching personas...");
        break;
      }
      case "persona_start": {
        const icon = PERSONA_ICONS[payload.personaId] || "🔍";
        const label = labelForPersona(payload);
        console.error(`  ${icon}  ${pc.cyan("→")} Dispatching ${pc.bold(label)} ${pc.gray(`[${elapsed}]`)}`);
        startSpinner(`${icon}  ${label} analyzing...`);
        break;
      }
      case "persona_finding": {
        stopSpinner();
        const sev = payload.severity || "P3";
        const color = sev === "P0" ? pc.red : sev === "P1" ? pc.red : sev === "P2" ? pc.yellow : pc.gray;
        const icon = PERSONA_ICONS[payload.personaId] || "🔍";
        console.error(`  ${icon}  ${color(`[${sev}]`)} ${pc.white(payload.title || payload.message || "finding")} ${pc.gray(`(${payload.file || "?"}:${payload.line || "?"})`)}`);
        startSpinner(`${icon}  ${labelForPersona(payload)} analyzing...`);
        break;
      }
      case "persona_complete": {
        stopSpinner();
        const icon = PERSONA_ICONS[payload.personaId] || "🔍";
        const count = payload.findings || 0;
        const cost = payload.costUsd || 0;
        const dur = ((payload.durationMs || 0) / 1000).toFixed(1);
        const label = labelForPersona(payload);
        console.error(`  ${icon}  ${pc.green("✓")} ${label} — ${count} finding${count === 1 ? "" : "s"} ${pc.gray(`($${cost.toFixed(4)}, ${dur}s, elapsed ${elapsed})`)}`);
        break;
      }
      case "persona_skipped": {
        stopSpinner();
        const icon = PERSONA_ICONS[payload.personaId] || "🔍";
        console.error(`  ${icon}  ${pc.gray("○")} ${labelForPersona(payload)} — skipped (${payload.reason || "budget"})`);
        break;
      }
      case "persona_error": {
        stopSpinner();
        const icon = PERSONA_ICONS[payload.personaId] || "🔍";
        console.error(`  ${icon}  ${pc.red("✗")} ${labelForPersona(payload)} — error: ${payload.error || "unknown"}`);
        break;
      }
      case "omargate_complete": {
        stopSpinner();
        const s = payload.summary || {};
        const total = payload.findings || 0;
        const cost = (payload.totalCostUsd || 0).toFixed(4);
        const dur = ((payload.totalDurationMs || 0) / 1000).toFixed(1);
        const rec = payload.reconciliation || {};
        console.error("");
        console.error(pc.bold(`  AI Analysis Complete ${pc.gray(`[${elapsed}]`)}`));
        console.error(`  Findings: ${pc.red(`P0=${s.P0 || 0}`)} ${pc.red(`P1=${s.P1 || 0}`)} ${pc.yellow(`P2=${s.P2 || 0}`)} ${pc.gray(`P3=${s.P3 || 0}`)} (${total} total)`);
        if (rec.deterministicFindings !== undefined) {
          console.error(pc.gray(`  Reconciled: ${rec.deterministicFindings} deterministic + ${rec.aiFindings} AI → ${rec.reconciledFindings} unique (${rec.multiSourceFindings || 0} confirmed by multiple layers)`));
        }
        console.error(`  Cost: $${cost} | Duration: ${dur}s | Personas: ${payload.personaCount || 0}`);
        console.error("");
        break;
      }
    }
  };
}

async function runLocalOmarGateCommand(args) {
  const commandStartedAt = Date.now();
  const mode = String(args[0] || "").trim().toLowerCase();
  if (mode === "investor-dd") {
    const pathArg = getCommandOptionValue(args, "--path") || ".";
    const outputDirArg = getCommandOptionValue(args, "--output-dir") || "";
    const asJson = hasCommandOption(args, "--json");
    const dryRun = hasCommandOption(args, "--dry-run");
    const maxCostUsd = parseFloat(getCommandOptionValue(args, "--max-cost") || "25.0") || 25.0;
    const maxRuntimeMinutes =
      parseInt(getCommandOptionValue(args, "--max-runtime-minutes") || "45", 10) || 45;
    const maxParallel =
      parseInt(getCommandOptionValue(args, "--max-parallel") || "3", 10) || 3;
    const streamEnabled = hasCommandOption(args, "--stream");
    const devTestBotEnabled = !hasCommandOption(args, "--no-devtestbot");
    const devTestBotBaseUrl = getCommandOptionValue(args, "--devtestbot-base-url") || "";
    const devTestBotScope = getCommandOptionValue(args, "--devtestbot-scope") || "";
    const emailOnComplete = getCommandOptionValue(args, "--email-on-complete") || "";

    const targetPath = path.resolve(process.cwd(), pathArg);
    if (!fs.existsSync(targetPath) || !fs.statSync(targetPath).isDirectory()) {
      throw new Error(`Invalid --path target: ${targetPath}`);
    }

    const { runInvestorDd } = await import("./review/investor-dd-orchestrator.js");
    const reportEmailClient = emailOnComplete
      ? await import("./review/dd-report-email-client.js")
      : null;
    if (!asJson) {
      printSection("Investor-DD Audit");
      printInfo(`Target: ${targetPath}`);
      printInfo(
        `Budget: $${maxCostUsd.toFixed(2)} / ${maxRuntimeMinutes}min / ${maxParallel} parallel`,
      );
      if (dryRun) printInfo("Mode: dry-run (plan + stub report only)");
    }
    const result = await runInvestorDd({
      rootPath: targetPath,
      outputDir: outputDirArg,
      budgetOptions: { maxCostUsd, maxRuntimeMinutes, maxParallel },
      dryRun,
      devTestBot: {
        enabled: devTestBotEnabled,
        baseUrl: devTestBotBaseUrl,
        scope: devTestBotScope,
      },
      reportEmail: emailOnComplete
        ? {
            to: emailOnComplete,
            client: {
              send: ({ runId, to }) => reportEmailClient.sendDdReportEmail({
                runId,
                to,
                cwd: targetPath,
                env: process.env,
              }),
            },
          }
        : null,
      onEvent: streamEnabled
        ? (event) => process.stdout.write(`${JSON.stringify(event)}\n`)
        : () => {},
    });
    if (asJson) {
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    } else {
      printInfo(`Report: ${path.join(result.artifactDir, "report.md")}`);
      printInfo(`Artifacts: ${result.artifactDir}`);
      printInfo(`Status: ${result.summary.terminationReason}`);
      printInfo(`Findings: ${result.summary.totalFindings}`);
      printInfo(`Elapsed: ${result.summary.durationSeconds.toFixed(1)}s`);
    }
    return;
  }
  if (mode && mode !== "deep") {
    throw new Error(`Unsupported /omargate mode '${mode}'. Use: /omargate deep | /omargate investor-dd`);
  }
  const asJson = hasCommandOption(args, "--json");
  const pathArg = getCommandOptionValue(args, "--path") || ".";
  const outputDirArg = getCommandOptionValue(args, "--output-dir") || "";
  const aiEnabled = !hasCommandOption(args, "--no-ai");
  const aiDryRun = hasCommandOption(args, "--ai-dry-run");
  const maxCostUsd = parseFloat(getCommandOptionValue(args, "--max-cost") || "5.0") || 5.0;
  const modelOverride = getCommandOptionValue(args, "--model") || "";
  const providerOverride = getCommandOptionValue(args, "--provider") || "";
  const scanMode = getCommandOptionValue(args, "--scan-mode") || "deep";
  const maxParallel = parseInt(getCommandOptionValue(args, "--max-parallel") || "4", 10) || 4;
  const streamEnabled = hasCommandOption(args, "--stream");
  // Per-persona filter flags (A-CLI-1). --persona <csv> narrows the dispatch
  // roster to the listed IDs; --skip-persona <csv> removes listed IDs from
  // whatever the mode's baseline roster is. Both can be combined.
  const personaCsvFlag = getCommandOptionValue(args, "--persona") || "";
  const skipPersonaCsvFlag = getCommandOptionValue(args, "--skip-persona") || "";
  const { parsePersonaCsv } = await import("./review/scan-modes.js");
  const includeOnly = parsePersonaCsv(personaCsvFlag);
  const skipPersonas = parsePersonaCsv(skipPersonaCsvFlag);
  const targetPath = path.resolve(process.cwd(), pathArg);
  if (!fs.existsSync(targetPath) || !fs.statSync(targetPath).isDirectory()) {
    throw new Error(`Invalid --path target: ${targetPath}`);
  }

  if (!asJson) {
    printSection("Local Omar Gate Deep");
    printInfo(`Target: ${targetPath}`);
    printInfo(`Scan mode: ${scanMode} | AI: ${aiEnabled ? "enabled" : "disabled"}`);
    console.error("");
    console.error(pc.gray(`  [${formatElapsed(Date.now() - commandStartedAt)}] Phase 1: Deterministic analysis (22 rules)...`));
  }

  // Phase 1: Full 22-rule deterministic pipeline (replaces legacy 5-rule credential scan)
  const { runDeterministicReviewPipeline } = await import("./review/local-review.js");
  const deterministic = await runDeterministicReviewPipeline({
    targetPath,
    mode: "full",
    outputDir: outputDirArg,
  });

  const detFindings = deterministic.findings || [];
  const detSummary = deterministic.summary || { P0: 0, P1: 0, P2: 0, P3: 0, blocking: false };
  const scannedFiles = deterministic.metadata?.ingest?.filesScanned || deterministic.metadata?.scannedFiles || detFindings.length;

  if (!asJson) {
    console.error(`  ${pc.green("✓")} [${formatElapsed(Date.now() - commandStartedAt)}] Deterministic: ${scannedFiles} files → P1=${detSummary.P1} P2=${detSummary.P2} findings`);
    if (aiEnabled) {
      console.error("");
      console.error(pc.gray(`  [${formatElapsed(Date.now() - commandStartedAt)}] Phase 2: AI persona analysis via LLM...`));
    }
  }

  // Phase 2: AI review layer (optional, default enabled)
  let aiResult = null;
  let orchestratorResult = null;
  if (aiEnabled && scanMode) {
    // Multi-persona orchestrator mode
    try {
      const { runOmarGateOrchestrator } = await import("./review/omargate-orchestrator.js");
      const terminalHandler = (!asJson && !streamEnabled)
        ? buildOmarTerminalHandler({ startedAt: commandStartedAt })
        : null;
      const streamHandler = streamEnabled
        ? (evt) => console.log(JSON.stringify(evt))
        : terminalHandler;

      orchestratorResult = await runOmarGateOrchestrator({
        targetPath,
        scanMode,
        maxParallel,
        provider: providerOverride || undefined,
        model: modelOverride || undefined,
        maxCostUsd,
        dryRun: aiDryRun,
        outputDir: outputDirArg,
        deterministic: {
          summary: detSummary,
          findings: detFindings,
          scope: deterministic.scope || {},
          layers: deterministic.layers || {},
          metadata: deterministic.metadata || {},
          artifacts: deterministic.artifacts || {},
        },
        onEvent: streamHandler,
        includeOnly: includeOnly.length > 0 ? includeOnly : null,
        skipPersonas: skipPersonas.length > 0 ? skipPersonas : null,
      });

      // Use orchestrator results as the AI layer. aiResult represents ONLY
      // the AI contribution — reconciliation is a separate top-level view.
      const personaErrors = (orchestratorResult.personas || []).filter((p) => p.status === "error" || p.error);
      const aiOnlyFindings = (orchestratorResult.findings || []).filter(
        (f) => Array.isArray(f.sources) && f.sources.includes("ai")
      );
      const aiOnlySummary = {
        P0: aiOnlyFindings.filter((f) => f.severity === "P0").length,
        P1: aiOnlyFindings.filter((f) => f.severity === "P1").length,
        P2: aiOnlyFindings.filter((f) => f.severity === "P2").length,
        P3: aiOnlyFindings.filter((f) => f.severity === "P3").length,
      };
      aiResult = {
        findings: aiOnlyFindings,
        summary: aiOnlySummary,
        costUsd: orchestratorResult.totalCostUsd || 0,
        model: modelOverride || "multi-persona",
        provider: providerOverride || "sentinelayer",
        dryRun: aiDryRun,
        personas: (orchestratorResult.personas || []).map((p) => ({
          id: p.id || p.personaId,
          identity: p.identity || null,
          status: p.status,
          findings: p.findings || 0,
          costUsd: p.costUsd || 0,
          durationMs: p.durationMs || 0,
          error: p.error || null,
        })),
        errors: personaErrors.length > 0
          ? personaErrors.map((p) => `${p.id || p.personaId}: ${p.error}`).join("; ")
          : null,
      };
    } catch (aiError) {
      if (!asJson) {
        console.log(pc.yellow(`Orchestrator skipped: ${aiError.message}`));
      }
      aiResult = { skipped: true, reason: aiError.message, findings: [], summary: { P0: 0, P1: 0, P2: 0, P3: 0 } };
    }
  } else if (aiEnabled) {
    // Single AI review layer (legacy, no --scan-mode)
    try {
      const { runAiReviewLayer } = await import("./review/ai-review.js");
      aiResult = await runAiReviewLayer({
        targetPath,
        mode: "full",
        runId: deterministic.metadata?.runId || `omargate-${nowIso()}`,
        runDirectory: deterministic.artifacts?.runDirectory || targetPath,
        deterministic: {
          summary: detSummary,
          findings: detFindings,
          metadata: deterministic.metadata || {},
        },
        outputDir: outputDirArg,
        provider: providerOverride || undefined,
        model: modelOverride || undefined,
        maxCostUsd,
        dryRun: aiDryRun,
        env: process.env,
      });
    } catch (aiError) {
      if (!asJson) {
        console.log(pc.yellow(`AI review layer skipped: ${aiError.message}`));
      }
      aiResult = { skipped: true, reason: aiError.message, findings: [], summary: { P0: 0, P1: 0, P2: 0, P3: 0 } };
    }
  }

  // Reconciled findings: orchestrator already merges+dedupes deterministic+AI
  // via reconcileReviewFindings. Use its output directly to avoid double-counting.
  // Fallback path (legacy single ai-review): union of det + AI findings.
  const aiFindings = aiResult?.findings || [];
  const reconciledFromOrchestrator = orchestratorResult?.findings;
  const allFindings = reconciledFromOrchestrator && reconciledFromOrchestrator.length >= 0
    ? reconciledFromOrchestrator
    : [...detFindings, ...aiFindings];
  const combinedSummary = orchestratorResult?.summary || {
    P0: detSummary.P0 + (aiResult?.summary?.P0 || 0),
    P1: detSummary.P1 + (aiResult?.summary?.P1 || 0),
    P2: detSummary.P2 + (aiResult?.summary?.P2 || 0),
    P3: (detSummary.P3 || 0) + (aiResult?.summary?.P3 || 0),
    blocking: (detSummary.P0 + (aiResult?.summary?.P0 || 0)) > 0 ||
              (detSummary.P1 + (aiResult?.summary?.P1 || 0)) > 0,
  };
  const combinedP0 = combinedSummary.P0 || 0;
  const combinedP1 = combinedSummary.P1 || 0;
  const combinedP2 = combinedSummary.P2 || 0;
  const combinedP3 = combinedSummary.P3 || 0;
  const omargateRunId = orchestratorResult?.runId || deterministic.runId;

  // Write per-phase artifacts alongside REVIEW_DETERMINISTIC so post-mortems
  // can inspect exactly what each layer contributed.
  const reviewDir = deterministic?.artifacts?.runDirectory || "";
  const writeJsonArtifact = async (name, payload) => {
    if (!reviewDir) return null;
    try {
      const fp = path.join(reviewDir, name);
      await fsp.writeFile(fp, JSON.stringify(payload, null, 2), "utf-8");
      return fp;
    } catch {
      return null;
    }
  };
  const artifactPaths = {};
  if (orchestratorResult) {
    artifactPaths.ai = await writeJsonArtifact("REVIEW_AI.json", {
      runId: orchestratorResult.runId,
      mode: orchestratorResult.mode,
      roster: orchestratorResult.roster,
      findings: (orchestratorResult.personas || []).flatMap((p) => []),
      aiFindings: aiFindings,
      personaCount: (orchestratorResult.personas || []).length,
      totalCostUsd: orchestratorResult.totalCostUsd,
      totalDurationMs: orchestratorResult.totalDurationMs,
    });
    artifactPaths.personas = await writeJsonArtifact("REVIEW_PERSONAS.json", {
      runId: orchestratorResult.runId,
      personas: orchestratorResult.personas || [],
    });
    artifactPaths.reconciled = await writeJsonArtifact("REVIEW_RECONCILED.json", {
      runId: orchestratorResult.runId,
      findings: orchestratorResult.findings || [],
      summary: orchestratorResult.summary,
      reconciliation: orchestratorResult.reconciliation,
      findingsBySource: orchestratorResult.findingsBySource,
    });
  }

  const totalElapsedMs = Date.now() - commandStartedAt;
  const totalElapsed = formatElapsed(totalElapsedMs);

  const report = `# Local Omar Gate Deep Scan

Generated: ${nowIso()}
Run ID: ${omargateRunId}
Target: ${targetPath}
Elapsed: ${totalElapsed}

Summary:
- Files scanned: ${scannedFiles}
- Deterministic findings: P0=${detSummary.P0} P1=${detSummary.P1} P2=${detSummary.P2} P3=${detSummary.P3 || 0}
- AI findings (raw, pre-reconciliation): ${aiResult ? `P0=${aiResult.summary?.P0 || 0} P1=${aiResult.summary?.P1 || 0} P2=${aiResult.summary?.P2 || 0} P3=${aiResult.summary?.P3 || 0}` : "skipped"}
- Reconciled (deduped + confidence-boosted): P0=${combinedP0} P1=${combinedP1} P2=${combinedP2} P3=${combinedP3}
${orchestratorResult?.reconciliation
    ? `- Reconciliation: ${orchestratorResult.reconciliation.deterministicFindings} deterministic + ${orchestratorResult.reconciliation.aiFindings} AI → ${orchestratorResult.reconciliation.reconciledFindings} unique (${orchestratorResult.reconciliation.multiSourceFindings} multi-source confirmed, ${orchestratorResult.reconciliation.dedupedCount} deduped)`
    : ""}

Findings:
${formatFindingsMarkdown(allFindings)}
`;

  const reportPath = await writeLocalCommandReport(targetPath, "omargate-deep", report, {
    outputDir: outputDirArg,
  });
  const { writeOmarGateDeterministicCache } = await import("./review/omargate-cache.js");
  const deterministicCache = await writeOmarGateDeterministicCache({
    targetPath,
    outputDir: outputDirArg,
    runId: omargateRunId,
    deterministic,
    reportPath,
  });
  artifactPaths.deterministicCache = deterministicCache.artifactPath;
  artifactPaths.latestOmarGate = deterministicCache.latestPath;

  if (asJson) {
    console.log(
      JSON.stringify(
        {
          command: "/omargate deep",
          targetPath,
          runId: omargateRunId,
          reportPath,
          scannedFiles,
          p0: combinedP0,
          p1: combinedP1,
          p2: combinedP2,
          p3: combinedP3,
          blocking: combinedP0 > 0 || combinedP1 > 0,
          elapsedMs: totalElapsedMs,
          artifacts: artifactPaths,
          deterministic: {
            findings: detFindings.length,
            summary: detSummary,
          },
          ai: aiResult
            ? {
                findings: aiFindings.length,
                summary: aiResult.summary || {},
                model: aiResult.model || null,
                provider: aiResult.provider || null,
                costUsd: aiResult.costUsd || 0,
                dryRun: aiDryRun,
                personas: aiResult.personas || [],
              }
            : null,
          reconciliation: orchestratorResult?.reconciliation || null,
          roster: orchestratorResult?.roster || [],
        },
        null,
        2
      )
    );
  } else {
    console.log(pc.cyan(`Report: ${reportPath}`));
    console.log(`Deterministic: P1=${detSummary.P1} P2=${detSummary.P2}`);
    if (aiResult) {
      console.log(`AI layer: P1=${aiResult.summary?.P1 || 0} P2=${aiResult.summary?.P2 || 0} (model: ${aiResult.model || "default"}, cost: $${(aiResult.costUsd || 0).toFixed(4)})`);
    } else if (aiEnabled) {
      console.log(pc.gray("AI layer: skipped (no credentials or --no-ai)"));
    }
    console.log(pc.bold(`Reconciled: P0=${combinedP0} P1=${combinedP1} P2=${combinedP2} P3=${combinedP3}`));
    console.log(pc.gray(`Elapsed: ${totalElapsed}`));
  }

  if (combinedP0 > 0 || combinedP1 > 0) {
    if (!asJson) {
      console.log(pc.red(`Blocking findings detected (P0=${combinedP0}, P1=${combinedP1}) after reconciliation.`));
    }
    return 2;
  }
  return 0;
}

async function runLocalAuditCommand(args) {
  const asJson = hasCommandOption(args, "--json");
  const pathArg = getCommandOptionValue(args, "--path") || ".";
  const outputDirArg = getCommandOptionValue(args, "--output-dir") || "";
  const reuseOmarGate = getCommandOptionValue(args, "--reuse-omargate") || "";
  const targetPath = path.resolve(process.cwd(), pathArg);
  if (!fs.existsSync(targetPath) || !fs.statSync(targetPath).isDirectory()) {
    throw new Error(`Invalid --path target: ${targetPath}`);
  }

  if (!asJson) {
    printSection("Local Audit");
    printInfo(`Target: ${targetPath}`);
  }

  const buildScanFromOmarGateCache = (cache) => {
    const findings = Array.isArray(cache?.findings) ? cache.findings : [];
    return {
      scannedFiles: Number(cache?.scope?.scannedFiles || findings.length || 0),
      findings,
      p1: findings.filter((item) => item.severity === "P1").length,
      p2: findings.filter((item) => item.severity === "P2").length,
    };
  };

  const requiredChecks = [
    {
      key: ".github/workflows/omar-gate.yml",
      severity: "P1",
      ok: fs.existsSync(path.join(targetPath, ".github", "workflows", "omar-gate.yml")),
      message: "Omar workflow is present.",
    },
    {
      key: "docs/spec.md",
      severity: "P2",
      ok: fs.existsSync(path.join(targetPath, "docs", "spec.md")),
      message: "Spec doc is present.",
    },
    {
      key: "tasks/todo.md",
      severity: "P2",
      ok: fs.existsSync(path.join(targetPath, "tasks", "todo.md")),
      message: "Todo plan is present.",
    },
  ];

  let omargateReuse = {
    requested: reuseOmarGate || "",
    used: false,
    runId: "",
    artifactPath: "",
    reason: reuseOmarGate ? "not_found" : "not_requested",
  };
  let scan = null;
  if (reuseOmarGate) {
    const { loadOmarGateDeterministicCache } = await import("./review/omargate-cache.js");
    const reused = await loadOmarGateDeterministicCache({
      targetPath,
      outputDir: outputDirArg,
      runIdOrLatest: reuseOmarGate,
    });
    if (reused.found) {
      scan = buildScanFromOmarGateCache(reused.cache);
      omargateReuse = {
        requested: reuseOmarGate,
        used: true,
        runId: reused.runId,
        deterministicRunId: reused.cache?.deterministicRunId || "",
        artifactPath: reused.artifactPath,
        reason: "",
      };
    } else {
      omargateReuse = {
        requested: reuseOmarGate,
        used: false,
        runId: "",
        artifactPath: "",
        reason: reused.reason || "not_found",
      };
    }
  }
  if (!scan) {
    scan = await runCredentialScan(targetPath);
  }
  const failedP1Checks = requiredChecks.filter((item) => !item.ok && item.severity === "P1").length;
  const failedP2Checks = requiredChecks.filter((item) => !item.ok && item.severity === "P2").length;
  const totalP1 = scan.p1 + failedP1Checks;
  const totalP2 = scan.p2 + failedP2Checks;
  const overallStatus = totalP1 > 0 ? "FAIL" : "PASS";

  const checkText = requiredChecks
    .map(
      (item) =>
        `- [${item.ok ? "x" : " "}] (${item.severity}) ${item.key} :: ${item.message}${item.ok ? "" : " [missing]"}`
    )
    .join("\n");
  const report = `# Local Sentinelayer Audit

Generated: ${nowIso()}
Target: ${targetPath}
Overall status: ${overallStatus}
OmarGate reuse: ${omargateReuse.used ? `yes (${omargateReuse.runId})` : omargateReuse.requested ? `requested ${omargateReuse.requested} (${omargateReuse.reason})` : "no"}

Readiness checks:
${checkText}

Scan summary:
- Reused OmarGate run: ${omargateReuse.used ? omargateReuse.runId : "n/a"}
- Files scanned: ${scan.scannedFiles}
- P1 findings: ${scan.p1}
- P2 findings: ${scan.p2}

Findings:
${formatFindingsMarkdown(scan.findings)}
`;

  const reportPath = await writeLocalCommandReport(targetPath, "audit", report, {
    outputDir: outputDirArg,
  });
  if (asJson) {
    console.log(
      JSON.stringify(
        {
          command: "/audit",
          targetPath,
          reportPath,
          overallStatus,
          scannedFiles: scan.scannedFiles,
          p1: scan.p1,
          p2: scan.p2,
          p1Total: totalP1,
          p2Total: totalP2,
          blocking: totalP1 > 0,
          omargateReuse,
          reusedOmarGateRunId: omargateReuse.used ? omargateReuse.runId : "",
          reusedOmarGateDeterministicPath: omargateReuse.used ? omargateReuse.artifactPath : "",
        },
        null,
        2
      )
    );
  } else {
    console.log(pc.cyan(`Report: ${reportPath}`));
    if (omargateReuse.used) {
      console.log(pc.gray(`Reused OmarGate run: ${omargateReuse.runId}`));
    } else if (omargateReuse.requested) {
      console.log(pc.gray(`OmarGate reuse unavailable: ${omargateReuse.reason}`));
    }
    console.log(`Overall status: ${overallStatus}`);
    console.log(`P1 total: ${totalP1}`);
    console.log(`P2 total: ${totalP2}`);
  }

  if (totalP1 > 0) {
    if (!asJson) {
      console.log(pc.red("Audit failed due to blocking findings (P1 > 0)."));
    }
    return 2;
  }
  return 0;
}

async function runLocalPersonaCommand(args) {
  const subcommand = String(args[0] || "").trim().toLowerCase();
  const optionArgs = subcommand === "orchestrator" ? args.slice(1) : args;
  if (subcommand && subcommand !== "orchestrator") {
    throw new Error(`Unsupported /persona subcommand '${subcommand}'. Use: /persona orchestrator --mode <mode>`);
  }
  const asJson = hasCommandOption(optionArgs, "--json");

  const mode = String(getCommandOptionValue(optionArgs, "--mode") || "builder").trim().toLowerCase();
  const validModes = new Set(["builder", "reviewer", "hardener"]);
  if (!validModes.has(mode)) {
    throw new Error("Invalid --mode for /persona. Use builder, reviewer, or hardener.");
  }

  const pathArg = getCommandOptionValue(optionArgs, "--path") || ".";
  const outputDirArg = getCommandOptionValue(optionArgs, "--output-dir") || "";
  const targetPath = path.resolve(process.cwd(), pathArg);
  if (!fs.existsSync(targetPath) || !fs.statSync(targetPath).isDirectory()) {
    throw new Error(`Invalid --path target: ${targetPath}`);
  }

  if (!asJson) {
    printSection("Persona Orchestrator");
    printInfo(`Mode: ${mode}`);
    printInfo(`Target: ${targetPath}`);
  }

  const modeInstructions = {
    builder: [
      "Prioritize implementation throughput and deterministic delivery.",
      "Keep PR scope tight and finish one batch before opening the next.",
      "Use Omar loop after each PR and fix all P0/P1 before merge.",
    ],
    reviewer: [
      "Prioritize risk discovery, regressions, and missing tests.",
      "Focus findings-first output ordered by severity.",
      "Escalate architecture/security concerns before code changes.",
    ],
    hardener: [
      "Prioritize security posture, policy controls, and failure modes.",
      "Add guardrails for auth, secrets handling, and CI enforceability.",
      "Treat P2 debt as merge-blocking unless explicitly waived.",
    ],
  };

  const ingest = await buildRepoIngestSummary(targetPath);
  const report = `# Persona Orchestrator Plan

Generated: ${nowIso()}
Target: ${targetPath}
Mode: ${mode}

Instructions:
${modeInstructions[mode].map((line, index) => `${index + 1}. ${line}`).join("\n")}

Repo summary:
${ingest || "No repository summary available."}
`;

  const reportPath = await writeLocalCommandReport(targetPath, `persona-orchestrator-${mode}`, report, {
    outputDir: outputDirArg,
  });
  if (asJson) {
    console.log(
      JSON.stringify(
        {
          command: "/persona orchestrator",
          mode,
          targetPath,
          reportPath,
        },
        null,
        2
      )
    );
  } else {
    console.log(pc.cyan(`Report: ${reportPath}`));
  }
  return 0;
}

function parseTodoPlanTasks(content) {
  const tasks = [];
  const lines = String(content || "").split(/\r?\n/);
  for (const line of lines) {
    const unchecked = line.match(/^\s*-\s*\[\s\]\s+(.+)\s*$/);
    if (unchecked) {
      tasks.push(unchecked[1].trim());
      continue;
    }
    const ordered = line.match(/^\s*\d+\.\s+(.+)\s*$/);
    if (ordered) {
      tasks.push(ordered[1].trim());
    }
  }
  return tasks.filter(Boolean);
}

async function runLocalApplyCommand(args) {
  const asJson = hasCommandOption(args, "--json");
  const pathArg = getCommandOptionValue(args, "--path") || ".";
  const outputDirArg = getCommandOptionValue(args, "--output-dir") || "";
  const targetPath = path.resolve(process.cwd(), pathArg);
  if (!fs.existsSync(targetPath) || !fs.statSync(targetPath).isDirectory()) {
    throw new Error(`Invalid --path target: ${targetPath}`);
  }

  const planArg = getCommandOptionValue(args, "--plan") || "tasks/todo.md";
  const planPath = path.resolve(targetPath, planArg);
  if (!fs.existsSync(planPath)) {
    throw new Error(`Plan file not found: ${planPath}`);
  }

  if (!asJson) {
    printSection("Apply Plan");
    printInfo(`Target: ${targetPath}`);
    printInfo(`Plan: ${planPath}`);
  }

  const planText = await fsp.readFile(planPath, "utf-8");
  const tasks = parseTodoPlanTasks(planText);
  if (!tasks.length) {
    throw new Error("No executable checklist items were found in the plan file.");
  }

  const report = `# Apply Plan Preview

Generated: ${nowIso()}
Target: ${targetPath}
Plan: ${planPath}

Execution order:
${tasks.map((task, index) => `${index + 1}. ${task}`).join("\n")}

Next action:
- Execute each item PR-by-PR and run Omar loop before every merge.
`;

  const reportPath = await writeLocalCommandReport(targetPath, "apply-plan", report, {
    outputDir: outputDirArg,
  });
  if (asJson) {
    console.log(
      JSON.stringify(
        {
          command: "/apply",
          targetPath,
          planPath,
          reportPath,
          taskCount: tasks.length,
        },
        null,
        2
      )
    );
  } else {
    console.log(pc.cyan(`Report: ${reportPath}`));
    console.log(`Parsed tasks: ${tasks.length}`);
  }
  return 0;
}

async function tryRunLocalCommandMode(argv) {
  const command = String(argv[0] || "").trim().toLowerCase();
  if (command !== "/omargate" && command !== "/audit" && command !== "/persona" && command !== "/apply") {
    return null;
  }
  const args = argv.slice(1);
  if (command === "/omargate") {
    return runLocalOmarGateCommand(args);
  }
  if (command === "/audit") {
    return runLocalAuditCommand(args);
  }
  if (command === "/persona") {
    return runLocalPersonaCommand(args);
  }
  return runLocalApplyCommand(args);
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

async function ensureEnvFileIgnored(projectDir) {
  const gitignorePath = path.join(projectDir, ".gitignore");
  let existing = "";
  if (fs.existsSync(gitignorePath)) {
    existing = await fsp.readFile(gitignorePath, "utf-8");
  }

  const lines = existing.split(/\r?\n/);
  const hasEntry = lines.some((line) => {
    const normalized = String(line || "").trim();
    return normalized === ".env" || normalized === "/.env";
  });
  if (hasEntry) {
    return;
  }

  const envEntry = ".env";
  let next = "";
  if (existing.trim().length === 0) {
    next = `${envEntry}\n`;
  } else if (existing.endsWith("\n")) {
    next = `${existing}${envEntry}\n`;
  } else {
    next = `${existing}\n${envEntry}\n`;
  }
  await writeTextFile(gitignorePath, next);
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
  const scriptDefaults = {
    "sentinel:omargate": "npx sentinelayer-cli@latest /omargate deep --path .",
    "sentinel:omargate:json": "npx sentinelayer-cli@latest /omargate deep --path . --json",
    "sentinel:audit": "npx sentinelayer-cli@latest /audit --path .",
    "sentinel:audit:json": "npx sentinelayer-cli@latest /audit --path . --json",
    "sentinel:persona:builder":
      "npx sentinelayer-cli@latest /persona orchestrator --mode builder --path .",
    "sentinel:persona:reviewer":
      "npx sentinelayer-cli@latest /persona orchestrator --mode reviewer --path .",
    "sentinel:persona:hardener":
      "npx sentinelayer-cli@latest /persona orchestrator --mode hardener --path .",
    "sentinel:apply": "npx sentinelayer-cli@latest /apply --plan tasks/todo.md --path .",
  };
  for (const [name, command] of Object.entries(scriptDefaults)) {
    if (!payload.scripts[name]) {
      payload.scripts[name] = command;
    }
  }
  await writeTextFile(packagePath, `${JSON.stringify(payload, null, 2)}\n`);
}

function buildCodingAgentConfigTemplate({ agentProfile, projectName }) {
  const projectLabel = String(projectName || "sentinelayer-project").trim() || "sentinelayer-project";
  const commonChecklist = [
    "Read docs/spec.md, docs/build-guide.md, tasks/todo.md, and AGENT_HANDOFF_PROMPT.md in order.",
    "Work one PR scope at a time and keep changes deterministic.",
    "Run local checks before push: /omargate deep and /audit.",
    ...getCoordinationEtiquetteItems(),
  ];

  if (agentProfile.id === "aider") {
    return `model: gpt-5.3-codex
read:
  - docs/spec.md
  - docs/build-guide.md
  - tasks/todo.md
  - AGENT_HANDOFF_PROMPT.md
notes:
  - ${commonChecklist.map((item) => JSON.stringify(item)).join("\n  - ")}
`;
  }

  if (agentProfile.id === "continue" || agentProfile.id === "cody") {
    return `${JSON.stringify(
      {
        profile: "sentinelayer",
        project: projectLabel,
        promptTarget: agentProfile.promptTarget,
        instructions: commonChecklist,
      },
      null,
      2
    )}\n`;
  }

  const markdownBody = [
    `# Sentinelayer ${agentProfile.name} Profile`,
    "",
    `Project: ${projectLabel}`,
    `Prompt target: ${agentProfile.promptTarget}`,
    "",
    "Rules:",
    ...commonChecklist.map((item) => `- ${item}`),
    "",
  ].join("\n");

  return `${markdownBody}\n`;
}

async function ensureCodingAgentConfigFile({ projectDir, projectName, codingAgent }) {
  const agentProfile = resolveCodingAgent(codingAgent || DEFAULT_CODING_AGENT_ID);
  if (!agentProfile.configFile) {
    return {
      created: false,
      path: "",
      agent: agentProfile,
    };
  }

  const configPath = path.join(projectDir, agentProfile.configFile);
  if (fs.existsSync(configPath)) {
    return {
      created: false,
      path: configPath,
      agent: agentProfile,
    };
  }

  const configContent = buildCodingAgentConfigTemplate({
    agentProfile,
    projectName,
  });
  await writeTextFile(configPath, configContent);
  return {
    created: true,
    path: configPath,
    agent: agentProfile,
  };
}

export function buildTodoContent({
  projectName,
  aiProvider,
  codingAgent,
  authMode,
  repoSlug,
  buildFromExistingRepo,
  generationMode,
  audienceLevel,
  projectType,
}) {
  const codingAgentProfile = resolveCodingAgent(codingAgent || DEFAULT_CODING_AGENT_ID);
  return `# Sentinelayer Autonomous Build Plan

Generated: ${nowIso()}
Project: ${projectName}

## Inputs
- AI provider: \`${aiProvider}\`
- Coding agent: \`${codingAgentProfile.name} (${codingAgentProfile.id})\`
- Auth mode: \`${authMode}\`
- Generation mode: \`${generationMode}\`
- Audience level: \`${audienceLevel}\`
- Project type: \`${projectType}\`
- Repo: \`${repoSlug || "not connected"}\`
- Workspace mode: \`${buildFromExistingRepo ? "existing repo clone" : "new scaffold"}\`

## Execution Checklist
- [ ] PR 1: repository bootstrap, CI checks, and deterministic scaffolding baseline
- [ ] PR 2: domain model + migrations + persistence abstraction
- [ ] PR 3: API contracts + auth/session lifecycle hardening
- [ ] PR 4: existing-codebase ingest path and repo context extraction
- [ ] PR 5: build planner generation quality and prompt artifact validation
- [ ] PR 6: workflow orchestration integration with Omar Gate policy defaults
- [ ] PR 7: local scan command runner (\`sentinel /omargate deep\`) MVP
- [ ] PR 8: local audit command runner (\`sentinel /audit\`) MVP
- [ ] PR 9: persona orchestrator command router + policy templates
- [ ] PR 10: scale/performance tuning and caching strategy
- [ ] PR 11: observability, retries, timeout policies, and structured logs
- [ ] PR 12: docs, release, rollout safety checks, and production readiness
- [ ] If working with other agents, join the SentinelLayer session and emit status updates
- [ ] Update tasks/lessons.md with coordination patterns learned during this session

## Omar Loop Contract (Per PR)
- [ ] Run Omar Gate for the PR.
- [ ] Fix all P0 and P1 findings.
- [ ] Fix P2 findings before merge when feasible.
- [ ] Re-run gate and confirm clean status.
- [ ] Merge only after quality gates are green.

## Command Roadmap (Local Terminal)
- [ ] \`sentinel /omargate deep --path <repo>\`: local deep scan pipeline
- [ ] \`sentinel /audit --path <repo>\`: security + quality audit summary
- [ ] \`sentinel /persona orchestrator --mode <builder|reviewer|hardener>\`: agent persona routing
- [ ] \`sentinel /apply --plan tasks/todo.md\`: execute roadmap batches autonomously

## Required Read Order
1. \`docs/spec.md\`
2. \`docs/build-guide.md\`
3. \`prompts/execution-prompt.md\`
4. \`.github/workflows/omar-gate.yml\`
5. \`AGENT_HANDOFF_PROMPT.md\`
`;
}

function buildAgentPromptGuidance(promptTarget) {
  const normalized = String(promptTarget || "generic").trim().toLowerCase();
  if (normalized === "claude") {
    return `- Use explicit plan -> implement -> verify loops.
- Keep deterministic checks first, then optional AI steps.
- Capture concrete evidence per PR before handoff.`;
  }
  if (normalized === "cursor") {
    return `- Keep edits small and keep scope to one PR id.
- Run local verification before each push.
- Keep repository conventions and test style unchanged.`;
  }
  if (normalized === "copilot") {
    return `- Keep error handling explicit on all new paths.
- Avoid implicit behavior changes in existing modules.
- Add targeted tests for each new branch introduced.`;
  }
  if (normalized === "codex") {
    return `- Execute autonomously, one bounded PR at a time.
- Use deterministic ingest/spec context as primary source.
- Fail closed when scope or safety requirements are ambiguous.`;
  }
  return `- Follow the provided spec and todo list exactly.
- Implement incrementally with deterministic checkpoints.
- Document assumptions and unresolved risks clearly.`;
}

export function buildHandoffPrompt({
  projectName,
  repoSlug,
  secretName,
  buildFromExistingRepo,
  authMode,
  codingAgent,
}) {
  const codingAgentProfile = resolveCodingAgent(codingAgent || DEFAULT_CODING_AGENT_ID);
  const codingAgentConfigPath = codingAgentProfile.configFile || "none";
  const codingAgentGuidance = buildAgentPromptGuidance(codingAgentProfile.promptTarget);
  const tokenContract =
    authMode === "sentinelayer"
      ? `- Required secret name: ${secretName}
- Workflow input binding: sentinelayer_token: \${{ secrets.${secretName} }}
- Optional: OPENAI_API_KEY for runtime policy/BYOK scenarios.`
      : `- Sentinelayer token: not configured (BYOK mode).
- Keep provider credentials in your own environment (OPENAI_API_KEY / ANTHROPIC_API_KEY / GOOGLE_API_KEY).
- If you later adopt Omar Gate GitHub Action, set secrets.${secretName} and wire sentinelayer_token accordingly.`;
  const workflowTuning =
    authMode === "sentinelayer"
      ? `- scan_mode: baseline | deep (default) | audit | full-depth
- severity_gate: P0 | P1 (default) | P2 | none`
      : `- BYOK workflow is guidance-only and does not call the Sentinelayer action.
- To enable Omar Gate later, set ${secretName} and configure scan_mode/severity_gate in workflow inputs.`;

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

Coding agent profile:
- Selected agent: ${codingAgentProfile.name} (${codingAgentProfile.id})
- Prompt target: ${codingAgentProfile.promptTarget}
- Suggested config path: ${codingAgentConfigPath}

Agent-specific guidance:
${codingAgentGuidance}

GitHub Action contract:
${tokenContract}

Terminal command options:
- sentinel /omargate deep --path .
- sentinel /audit --path .
- sentinel /persona orchestrator --mode builder --path .
- sentinel /persona orchestrator --mode reviewer --path .
- sentinel /persona orchestrator --mode hardener --path .
- sentinel /apply --plan tasks/todo.md --path .
- Add --json to /omargate, /audit, /persona, or /apply for machine-readable CI output.

Workflow tuning options:
${workflowTuning}

Repo context:
- Target repo: ${repoSlug || "not provided"}
- Workspace mode: ${buildFromExistingRepo ? "existing codebase" : "new scaffold"}

## Multi-Agent Coordination (if session active)

${renderCoordinationNumberedList()}

Start now and continue autonomously.
`;
}

export function buildAgentsSessionGuideContent() {
  return `# SentinelLayer Session Guide for AI Agents

## Required Etiquette
${renderCoordinationNumberedList()}

## Why This Matters
- Other agents can see what you're working on and avoid file conflicts
- If you see an unexpected file change, ask in the session first
- Findings are shared immediately so other agents can act quickly
- The daemon can monitor health and alert when agents appear stuck

## What to Emit
- Status: \`sl session say <id> "status: implementing JWT middleware in src/middleware/auth.js"\`
- Finding: \`sl session say <id> "finding: [P2] missing rate limit on POST /api/auth/login"\`
- Help: \`sl session say <id> "help: unexpected change in package.json - who modified it?"\`
- Done: \`sl session say <id> "done: PR merged, auth hardening complete"\`
`;
}

function fallbackWorkflow({ secretName = "SENTINELAYER_TOKEN", authMode = "sentinelayer", specId = "" } = {}) {
  const normalizedSecret = isValidSecretName(secretName) ? secretName : "SENTINELAYER_TOKEN";
  const normalizedSpecId = String(specId || "").trim();
  const specIdBindingLine = normalizedSpecId ? `\n          sentinelayer_spec_id: ${normalizedSpecId}` : "";
  const workflowName = authMode === "byok" ? "Omar Gate (BYOK Mode)" : "Omar Gate";
  return `name: ${workflowName}

on:
  pull_request:
    types:
      - opened
      - synchronize
      - reopened
  workflow_dispatch:
    inputs:
      scan_mode:
        description: Sentinelayer scan profile
        required: false
        default: deep
        type: choice
        options:
          - baseline
          - deep
          - audit
          - full-depth
      severity_gate:
        description: Severity threshold that blocks merge
        required: false
        default: P1
        type: choice
        options:
          - P0
          - P1
          - P2
          - none
      p2_max_allowed:
        description: Maximum allowed P2 findings before Omar Gate blocks merge
        required: false
        default: "5"
        type: string

permissions:
  contents: read
  checks: write
  pull-requests: write
  id-token: write

env:
  FORCE_JAVASCRIPT_ACTIONS_TO_NODE24: "true"

jobs:
  omar_gate:
    name: Omar Gate
    runs-on: ubuntu-latest
    permissions:
      contents: read
      checks: write
      pull-requests: write
      id-token: write
    steps:
      - uses: actions/checkout@v4
      - name: Validate Sentinelayer token secret
        shell: bash
        env:
          SENTINELAYER_TOKEN: \${{ secrets.${normalizedSecret} }}
        run: |
          set -euo pipefail
          if [ -z "\${SENTINELAYER_TOKEN}" ]; then
            echo "::warning::SENTINELAYER_TOKEN not set. Set it with: gh secret set ${normalizedSecret} --body <your-token>"
            echo "Skipping Omar Gate scan — run locally with: npx sentinelayer-cli@latest /omargate deep --path ."
            exit 0
          fi
      - name: Run Omar Gate
        id: omar
        uses: mrrCarter/sentinelayer-v1-action@55a2c158f637d7d92e26ab0ef3ba81db791da4be
        with:
          sentinelayer_token: \${{ secrets.${normalizedSecret} }}${specIdBindingLine}
          scan_mode: \${{ github.event_name == 'workflow_dispatch' && inputs.scan_mode || 'deep' }}
          severity_gate: \${{ github.event_name == 'workflow_dispatch' && inputs.severity_gate || 'P1' }}
      - name: Enforce Omar reviewer merge thresholds
        shell: bash
        env:
          P0_COUNT: \${{ steps.omar.outputs.p0_count || '0' }}
          P1_COUNT: \${{ steps.omar.outputs.p1_count || '0' }}
          P2_COUNT: \${{ steps.omar.outputs.p2_count || '0' }}
          P2_MAX_ALLOWED: \${{ github.event_name == 'workflow_dispatch' && inputs.p2_max_allowed || '5' }}
        run: |
          set -euo pipefail
          p0="\$(echo "\${P0_COUNT}" | tr -d '\\r' | xargs || true)"
          p1="\$(echo "\${P1_COUNT}" | tr -d '\\r' | xargs || true)"
          p2="\$(echo "\${P2_COUNT}" | tr -d '\\r' | xargs || true)"
          p2_max="\$(echo "\${P2_MAX_ALLOWED}" | tr -d '\\r' | xargs || true)"
          case "\${p0}" in ''|*[!0-9]*) echo "::error::Invalid P0 count" ; exit 1 ;; esac
          case "\${p1}" in ''|*[!0-9]*) echo "::error::Invalid P1 count" ; exit 1 ;; esac
          case "\${p2}" in ''|*[!0-9]*) echo "::error::Invalid P2 count" ; exit 1 ;; esac
          case "\${p2_max}" in ''|*[!0-9]*) echo "::error::Invalid p2_max" ; exit 1 ;; esac
          if [ "\${p0}" -gt 0 ] || [ "\${p1}" -gt 0 ]; then
            echo "::error::Omar Gate blocked: P0=\${p0}, P1=\${p1}. Requires P0=0 and P1=0."
            exit 1
          fi
          if [ "\${p2}" -gt "\${p2_max}" ]; then
            echo "::error::Omar Gate blocked: P2=\${p2} exceeds max \${p2_max}."
            exit 1
          fi
      - name: Emit Omar run summary
        shell: bash
        run: |
          set -euo pipefail
          echo "## Omar Gate" >> "\$GITHUB_STEP_SUMMARY"
          echo "- run_id: \\\`\${{ steps.omar.outputs.run_id }}\\\`" >> "\$GITHUB_STEP_SUMMARY"
          echo "- gate_status: \\\`\${{ steps.omar.outputs.gate_status }}\\\`" >> "\$GITHUB_STEP_SUMMARY"
          echo "- findings: P0=\${{ steps.omar.outputs.p0_count }} P1=\${{ steps.omar.outputs.p1_count }} P2=\${{ steps.omar.outputs.p2_count }} P3=\${{ steps.omar.outputs.p3_count }}" >> "\$GITHUB_STEP_SUMMARY"
`;
}

function hasAuthKeywords(text) {
  const lower = String(text || "").toLowerCase();
  return ["login", "signup", "sign up", "register", "authentication", "auth flow", "otp", "verification", "password reset"].some((kw) => lower.includes(kw));
}

function buildByokArtifacts({ interview, description }) {
  const featureList =
    interview.features.length > 0
      ? interview.features.map((item, index) => `${index + 1}. ${item}`).join("\n")
      : "1. Implement the core workflow end-to-end.\n2. Add observability and hardening.\n3. Add tests and docs.";
  const techStack =
    interview.techStack.length > 0 ? interview.techStack.join(", ") : "Node.js, TypeScript, PostgreSQL";

  return {
    project_name: interview.projectName,
    spec_sheet: `# Spec

## Project
${interview.projectName}

## Goal
${description}

## Target audience
${interview.audienceLevel}

## Preferred provider
${interview.aiProvider}

## Project type
${interview.projectType}

## Suggested stack
${techStack}

## Key features
${featureList}
${hasAuthKeywords(description) ? `
## AIdenID E2E Verification
When authentication flows are implemented, use AIdenID to test them at scale:
1. Confirm AIdenID credentials via \`sl auth status\` (auto-provisioned at login).
2. Provision ephemeral test identity: \`sl ai provision-email --execute --json\`.
3. Run automated signup flow with provisioned email.
4. Extract OTP from inbound email: \`sl ai identity wait-for-otp <identityId> --timeout 30\`.
5. Complete login flow with extracted OTP and verify authenticated session.
6. Revoke test identity after verification: \`sl ai identity revoke <identityId>\`.
` : ""}`,
    playbook: `# Build Guide

## Scope
- Keep each PR bounded and shippable.
- Run tests and local scans before each handoff.
- Keep secrets out of source control.

## Implementation order
1. Establish repo baseline and CI checks.
2. Implement domain model and persistence boundaries.
3. Implement API/worker surface and auth/session policies.
4. Add observability, retries, and production hardening.
5. Finalize docs and operational runbooks.

## Review loop
- Run \`sentinel /omargate deep --path .\` and \`sentinel /audit --path .\`.
- Fix P0/P1 issues before merge.
- Fix P2 findings before merge when feasible.
`,
    builder_prompt: `You are operating in Sentinelayer BYOK mode.

Read files in order:
1. docs/spec.md
2. docs/build-guide.md
3. tasks/todo.md
4. AGENT_HANDOFF_PROMPT.md

Execute PR-by-PR from tasks/todo.md.
Run local scans after each PR:
- sentinel /omargate deep --path .
- sentinel /audit --path .

Continue autonomously unless blocked by missing credentials or permissions.`,
    omar_gate_yaml: fallbackWorkflow({ authMode: "byok" }),
  };
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

  const verifyResult = spawnSync(ghCommand, ["secret", "list", "--repo", normalizedRepo], {
    encoding: "utf-8",
  });
  if (verifyResult.status !== 0) {
    return {
      ok: false,
      reason: String(verifyResult.stderr || verifyResult.stdout || "gh secret list failed").trim(),
    };
  }

  const listedSecrets = String(verifyResult.stdout || "");
  const escapedSecretName = String(secretName || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const secretRegex = new RegExp(`(^|\\r?\\n)\\s*${escapedSecretName}(\\s|$)`, "m");
  if (!secretRegex.test(listedSecrets)) {
    return {
      ok: false,
      reason: `Secret '${secretName}' was not visible in gh secret list output after injection.`,
    };
  }

  return { ok: true };
}

function extractWorkflowSpecId(workflowMarkdown) {
  const normalized = String(workflowMarkdown || "");
  const match = normalized.match(/sentinelayer_spec_id:\s*([^\s#]+)/);
  return match ? String(match[1] || "").trim() : "";
}

function resolveGeneratedSpecId(generated) {
  const candidates = [
    generated?.spec_id,
    generated?.specId,
    generated?.spec_hash,
    generated?.specHash,
  ];
  for (const candidate of candidates) {
    const normalized = String(candidate || "").trim();
    if (normalized) return normalized;
  }
  return "";
}

async function writeInitConfigLockfile({
  projectDir,
  specId,
  sentinelayerToken,
  secretName,
  repoSlug,
  workflowPath,
}) {
  const lockDir = path.join(projectDir, ".sentinelayer");
  const configPath = path.join(lockDir, "config.json");
  const payload = {
    schema_version: 1,
    generated_at: new Date().toISOString(),
    spec_id: String(specId || "").trim(),
    sentinelayer_token: String(sentinelayerToken || "").trim(),
    required_secret_name: String(secretName || "SENTINELAYER_TOKEN").trim() || "SENTINELAYER_TOKEN",
    repo_slug: normalizeRepoSlug(repoSlug || ""),
    workflow_path: path.relative(projectDir, workflowPath).replace(/\\/g, "/"),
  };

  await fsp.mkdir(lockDir, { recursive: true });
  await fsp.writeFile(configPath, `${JSON.stringify(payload, null, 2)}\n`, "utf-8");
  return configPath;
}

async function validateWorkflowSpecBinding({ workflowPath, expectedSpecId }) {
  const expected = String(expectedSpecId || "").trim();
  if (!expected) {
    throw new Error("Missing spec_id/spec_hash in generated builder response. Cannot validate Omar spec binding.");
  }
  const workflowMarkdown = await fsp.readFile(workflowPath, "utf-8");
  const workflowSpecId = extractWorkflowSpecId(workflowMarkdown);
  if (!workflowSpecId) {
    throw new Error(
      `Generated workflow '${workflowPath}' is missing sentinelayer_spec_id. Regenerate the workflow before continuing.`
    );
  }
  if (workflowSpecId !== expected) {
    throw new Error(
      `Workflow spec binding mismatch: expected '${expected}' but workflow has '${workflowSpecId}'.`
    );
  }
  return workflowSpecId;
}

async function collectInterview({ initialProjectName, detectedRepo, detectedCodingAgent }) {
  const onCancel = () => {
    throw new Error("Prompt flow cancelled by user.");
  };
  const detectedAgentRecord = resolveCodingAgent(detectedCodingAgent || DEFAULT_CODING_AGENT_ID);
  const codingAgentChoices = listSupportedCodingAgents().map((agent) => ({
    title:
      agent.id === detectedAgentRecord.id
        ? `${agent.name} (${agent.id}, detected)`
        : `${agent.name} (${agent.id})`,
    value: agent.id,
  }));
  const defaultCodingAgentIndex = Math.max(
    0,
    codingAgentChoices.findIndex((choice) => choice.value === detectedAgentRecord.id)
  );
  const projectTypeChoices = [
    { title: "Greenfield", value: "greenfield" },
    { title: "Add feature", value: "add_feature" },
    { title: "Bugfix / hardening", value: "bugfix" },
  ];
  const inferredProjectType = isValidRepoSlug(detectedRepo || "") ? "add_feature" : "greenfield";
  const defaultProjectTypeIndex = Math.max(
    0,
    projectTypeChoices.findIndex((choice) => choice.value === inferredProjectType)
  );

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
        name: "codingAgent",
        message: "Which coding agent will you use?",
        choices: codingAgentChoices,
        initial: defaultCodingAgentIndex,
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
        choices: projectTypeChoices,
        initial: defaultProjectTypeIndex,
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
        type: "select",
        name: "authMode",
        message: "Auth mode",
        choices: [
          { title: "Sentinelayer managed token (recommended)", value: "sentinelayer" },
          { title: "BYOK only (skip Sentinelayer token)", value: "byok" },
        ],
        initial: 0,
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
      let repoSlug;
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
            type: base.authMode === "sentinelayer" ? "toggle" : null,
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
      advanced.injectSecret = base.authMode === "sentinelayer" ? Boolean(repoMode.injectSecret) : false;
    }
  }

  const projectName =
    sanitizeProjectName(initialProjectName || base.projectName) || getRepoNameFromSlug(advanced.repoSlug);

  const interviewResult = {
    projectName,
    projectDescription: String(base.projectDescription || "").trim(),
    aiProvider: base.aiProvider,
    generationMode: base.generationMode,
    audienceLevel: base.audienceLevel,
    projectType: base.projectType,
    codingAgent: resolveCodingAgent(base.codingAgent || detectedAgentRecord.id).id,
    techStack: parseCommaList(base.techStack),
    features: parseCommaList(base.features),
    authMode: base.authMode,
    connectRepo: Boolean(advanced.connectRepo),
    repoSlug: normalizeRepoSlug(advanced.repoSlug),
    buildFromExistingRepo: Boolean(advanced.buildFromExistingRepo),
    injectSecret: Boolean(advanced.injectSecret),
  };

  printSection("Interview Review");
  printInfo(`Project: ${interviewResult.projectName}`);
  printInfo(`Type: ${interviewResult.projectType}`);
  printInfo(`Provider: ${interviewResult.aiProvider}`);
  printInfo(`Coding agent: ${interviewResult.codingAgent}`);
  printInfo(`Auth mode: ${interviewResult.authMode}`);
  printInfo(`Repo: ${interviewResult.repoSlug || "not connected"}`);
  printInfo(
    `Existing repo mode: ${interviewResult.buildFromExistingRepo ? "enabled (clone/reuse)" : "disabled"}`
  );

  const review = await prompts(
    [
      {
        type: "toggle",
        name: "proceed",
        message: "Proceed with these selections?",
        initial: true,
        active: "yes",
        inactive: "no",
      },
    ],
    { onCancel }
  );

  if (!review.proceed) {
    const next = await prompts(
      [
        {
          type: "select",
          name: "action",
          message: "What do you want to do?",
          choices: [
            { title: "Restart interview", value: "restart" },
            { title: "Cancel", value: "cancel" },
          ],
          initial: 0,
        },
      ],
      { onCancel }
    );
    if (next.action === "restart") {
      return collectInterview({ initialProjectName, detectedRepo, detectedCodingAgent });
    }
    throw new Error("Prompt flow cancelled by user.");
  }

  return interviewResult;
}

function printSection(title) {
  console.log(`\n${pc.bold(pc.cyan(title))}`);
}

function printInfo(message) {
  console.log(pc.gray(`- ${message}`));
}

export async function runLegacyCli(rawArgs = process.argv.slice(2)) {
  refreshRuntimeDefaults();
  const commandExitCode = await tryRunLocalCommandMode(rawArgs);
  if (commandExitCode !== null) {
    if (commandExitCode !== 0) {
      process.exitCode = commandExitCode;
    }
    return;
  }

  const args = parseCliArgs(rawArgs);
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
  const detectedCodingAgent = detectCodingAgentFromEnv(process.env).id;

  printSection("Sentinelayer Scaffold");
  printInfo(`API: ${DEFAULT_API_URL}`);
  printInfo(`Web: ${DEFAULT_WEB_URL}`);
  if (detectedRepo) {
    printInfo(`Detected repo: ${detectedRepo}`);
  }

  const automatedInterview = await loadAutomatedInterview({
    argProjectName,
    detectedRepo,
    detectedCodingAgent,
    interviewFile: args.interviewFile,
  });

  const interview =
    automatedInterview ||
    (args.nonInteractive
      ? null
      : await collectInterview({
          initialProjectName: argProjectName,
          detectedRepo,
          detectedCodingAgent,
        }));

  if (!interview) {
    throw new Error(
      "Non-interactive mode requires SENTINELAYER_CLI_INTERVIEW_JSON or --interview-file."
    );
  }
  validateInterviewInput(interview);

  const workspace = await resolveProjectDirectory({
    cwd: process.cwd(),
    interview,
    detectedRepo,
  });
  const projectDir = workspace.projectDir;

  printSection("Workspace");
  if (workspace.reusedCurrentRepo) {
    printInfo(`Using current repo workspace: ${projectDir}`);
  } else if (workspace.clonedRepo) {
    printInfo(`Cloned repo workspace: ${projectDir}`);
    if (workspace.cloneUrl) {
      printInfo(`Clone URL: ${workspace.cloneUrl}`);
    }
  } else {
    printInfo(`Target scaffold workspace: ${projectDir}`);
  }

  const requestedAuthMode = interview.authMode === "byok" ? "byok" : "sentinelayer";
  let authToken = "";

  printSection("Authentication");
  if (requestedAuthMode === "byok") {
    printInfo("BYOK mode selected. Skipping Sentinelayer browser auth and token bootstrap.");
  } else {
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

    authToken = String(approval.auth_token || "").trim();
    if (!authToken) {
      throw new Error("Authentication completed but no auth token was returned.");
    }
  }

  printSection("Artifact Generation");
  let description = interview.projectDescription;
  if (interview.buildFromExistingRepo) {
    const repoSummary = await buildRepoIngestSummary(projectDir);
    if (repoSummary) {
      description = `${description}\n\nExisting repo context:\n${repoSummary}`;
      printInfo("Included existing repo ingest summary in generation payload.");
    } else {
      printInfo("No repo ingest summary was available. Continuing with base description.");
    }
  }
  const generatePayload = {
    description,
    tech_stack: interview.techStack,
    features: interview.features,
    generation_mode: interview.generationMode,
    audience_level: interview.audienceLevel,
    project_type: interview.projectType,
    model_provider: interview.aiProvider,
    model_id: DEFAULT_MODEL_BY_PROVIDER[interview.aiProvider] || undefined,
  };
  let generated = null;
  let sentinelayerToken = "";
  let secretName = "SENTINELAYER_TOKEN";

  if (requestedAuthMode === "byok") {
    generated = buildByokArtifacts({
      interview,
      description,
    });
  } else {
    generated = await generateArtifacts({
      apiUrl: DEFAULT_API_URL,
      authToken,
      payload: generatePayload,
    });

    let bootstrapToken = generated?.bootstrap_token || null;
    if (!bootstrapToken || !String(bootstrapToken.token || "").trim()) {
      try {
        bootstrapToken = await issueBootstrapToken({
          apiUrl: DEFAULT_API_URL,
          authToken,
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.log(
          pc.yellow(`Token bootstrap unavailable. Continuing in BYOK mode for this scaffold. (${message})`)
        );
      }
    }

    sentinelayerToken = String(bootstrapToken?.token || "").trim();
    if (sentinelayerToken) {
      const requestedSecretName = String(bootstrapToken.required_secret_name || "").trim();
      secretName = isValidSecretName(requestedSecretName) ? requestedSecretName : "SENTINELAYER_TOKEN";
      if (requestedSecretName && requestedSecretName !== secretName) {
        console.log(
          pc.yellow(
            `Received invalid secret name '${requestedSecretName}' from API. Falling back to ${secretName}.`
          )
        );
      }
    } else {
      console.log(pc.yellow("Sentinelayer token unavailable. Continuing in BYOK mode for this scaffold."));
    }
  }
  const effectiveAuthMode = sentinelayerToken ? "sentinelayer" : "byok";

  const effectiveProjectName =
    sanitizeProjectName(generated.project_name || interview.projectName || path.basename(projectDir)) ||
    path.basename(projectDir);
  const docsDir = path.join(projectDir, "docs");
  const promptsDir = path.join(projectDir, "prompts");
  const tasksDir = path.join(projectDir, "tasks");
  const workflowPath = path.join(projectDir, ".github", "workflows", "omar-gate.yml");

  await writeTextFile(path.join(docsDir, "spec.md"), String(generated.spec_sheet || "").trim() + "\n");
  await writeTextFile(
    path.join(docsDir, "build-guide.md"),
    String(generated.playbook || "").trim() + "\n"
  );
  await writeTextFile(
    path.join(promptsDir, "execution-prompt.md"),
    String(generated.builder_prompt || "").trim() + "\n"
  );
  const generatedSpecId = resolveGeneratedSpecId(generated);
  if (effectiveAuthMode === "sentinelayer" && !generatedSpecId) {
    throw new Error("Builder response is missing spec_id/spec_hash. Cannot generate a validated Omar Gate workflow.");
  }
  const workflowMarkdown =
    (
      (effectiveAuthMode === "sentinelayer" ? String(generated.omar_gate_yaml || "").trim() : "") ||
      fallbackWorkflow({ secretName, authMode: effectiveAuthMode, specId: generatedSpecId })
    ) + "\n";
  await writeTextFile(workflowPath, workflowMarkdown);

  const workflowSpecIdFromTemplate = extractWorkflowSpecId(workflowMarkdown);
  let workflowSpecId = "";
  if (generatedSpecId || workflowSpecIdFromTemplate) {
    workflowSpecId = await validateWorkflowSpecBinding({
      workflowPath,
      expectedSpecId: generatedSpecId || workflowSpecIdFromTemplate,
    });
  }
  const configLockfilePath = await writeInitConfigLockfile({
    projectDir,
    specId: workflowSpecId || generatedSpecId || workflowSpecIdFromTemplate,
    sentinelayerToken,
    secretName,
    repoSlug: interview.repoSlug || detectRepoSlug(projectDir) || "",
    workflowPath,
  });

  await writeTextFile(
    path.join(tasksDir, "todo.md"),
    buildTodoContent({
      projectName: effectiveProjectName,
      aiProvider: interview.aiProvider,
      codingAgent: interview.codingAgent,
      authMode: effectiveAuthMode,
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
      authMode: effectiveAuthMode,
      codingAgent: interview.codingAgent,
    })
  );
  await writeTextFile(
    path.join(projectDir, ".sentinelayer", "AGENTS_SESSION_GUIDE.md"),
    buildAgentsSessionGuideContent()
  );
  const codingAgentConfig = await ensureCodingAgentConfigFile({
    projectDir,
    projectName: effectiveProjectName,
    codingAgent: interview.codingAgent,
  });

  await ensureSentinelStartScript(projectDir, effectiveProjectName);

  // Code scaffold: write starter source files, skip existing
  const templateFiles = getExpressTemplate({
    projectName: effectiveProjectName,
    description: interview.description,
  });
  const packageJsonTemplate = getPackageJsonTemplate({
    projectName: effectiveProjectName,
    description: interview.description,
  });
  const readmeContent = buildReadmeContent({
    projectName: effectiveProjectName,
    description: interview.description,
    techStack: interview.projectType || "Node.js + Express",
  });
  const scaffoldResult = await generateScaffold({
    projectDir,
    templateFiles,
    packageJsonTemplate,
    readmeContent,
    force: false,
  });
  if (scaffoldResult.written.length > 0) {
    console.log(pc.green(`Scaffold: wrote ${scaffoldResult.written.length} starter files`));
    for (const f of scaffoldResult.written) {
      console.log(pc.gray(`  + ${f}`));
    }
  }
  if (scaffoldResult.skipped.length > 0) {
    for (const s of scaffoldResult.skipped) {
      console.log(pc.gray(`  ~ ${s.path} (${s.reason})`));
    }
  }

  if (sentinelayerToken) {
    await ensureEnvFileIgnored(projectDir);
    await upsertEnvVariable(path.join(projectDir, ".env"), secretName, sentinelayerToken);
  }
  await ensureGitRepositorySetup({
    projectDir,
    repoSlug: interview.connectRepo ? interview.repoSlug : "",
  });

  const repoSlugForSecrets = normalizeRepoSlug(interview.repoSlug || detectRepoSlug(projectDir) || "");
  const openAiApiKey = String(process.env.OPENAI_API_KEY || "").trim();
  const secretTargets = [];
  if (sentinelayerToken) {
    secretTargets.push({
      secretName,
      secretValue: sentinelayerToken,
      placeholder: "<sentinelayer-token>",
    });
  }
  secretTargets.push({
    secretName: "OPENAI_API_KEY",
    secretValue: openAiApiKey,
    placeholder: "<your-openai-api-key>",
  });

  const githubSecretResults = [];
  if (repoSlugForSecrets) {
    for (const target of secretTargets) {
      const value = String(target.secretValue || "").trim();
      if (!value) {
        githubSecretResults.push({
          secretName: target.secretName,
          ok: false,
          skipped: true,
          reason: `No value resolved for ${target.secretName} in current environment/config.`,
          placeholder: target.placeholder,
        });
        continue;
      }
      const result = runGhSecretSet({
        repoSlug: repoSlugForSecrets,
        secretName: target.secretName,
        secretValue: value,
      });
      githubSecretResults.push({
        secretName: target.secretName,
        ok: Boolean(result.ok),
        skipped: false,
        reason: String(result.reason || "").trim(),
        placeholder: target.placeholder,
      });
    }
  }

  printSection("Complete");
  console.log(pc.green(`✔ Sentinelayer orchestration initialized in ${projectDir}`));
  console.log(pc.green(`✔ Config lockfile written: ${configLockfilePath}`));
  if (workflowSpecId) {
    console.log(pc.green(`✔ Omar workflow spec binding validated: ${workflowSpecId}`));
  } else {
    console.log(pc.yellow("! Omar workflow did not expose sentinelayer_spec_id (BYOK/fallback mode)."));
  }
  if (sentinelayerToken) {
    console.log(pc.green(`✔ ${secretName} injected into ${path.join(projectDir, ".env")}`));
  } else {
    console.log(pc.yellow("! BYOK mode active: Sentinelayer token was not injected."));
  }
  if (codingAgentConfig.created) {
    console.log(
      pc.green(`✔ ${codingAgentConfig.agent.name} config scaffolded at ${codingAgentConfig.path}`)
    );
  }
  if (repoSlugForSecrets) {
    for (const result of githubSecretResults) {
      if (result.ok) {
        console.log(pc.green(`✔ ${result.secretName} injected into GitHub repo secret (${repoSlugForSecrets})`));
        continue;
      }
      const stateLabel = result.skipped ? "skipped" : "failed";
      console.log(pc.yellow(`! GitHub secret injection ${stateLabel} for ${result.secretName}: ${result.reason}`));
      console.log(
        pc.yellow(
          `  Run manually: gh secret set ${result.secretName} --repo ${repoSlugForSecrets} --body ${result.placeholder}`
        )
      );
    }
  } else if (secretTargets.length > 0) {
    console.log(
      pc.yellow(
        "! GitHub secret auto-injection skipped: no repo slug detected. Connect a repo or run manual secret commands."
      )
    );
    for (const target of secretTargets) {
      console.log(
        pc.yellow(
          `  Run manually: gh secret set ${target.secretName} --repo <owner/repo> --body ${target.placeholder}`
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

export function renderCliFailure(error) {
  const message = error instanceof Error ? error.message : String(error);
  const code = error instanceof SentinelayerApiError ? ` [${error.code}]` : "";
  const requestId =
    error instanceof SentinelayerApiError && error.requestId ? ` request_id=${error.requestId}` : "";
  console.error(pc.red(`\nSentinelayer scaffold failed${code}:${requestId}`));
  console.error(pc.red(message));
}

export async function runLegacyCliWithErrorHandling(rawArgs = process.argv.slice(2)) {
  try {
    await runLegacyCli(rawArgs);
  } catch (error) {
    renderCliFailure(error);
    process.exitCode = 1;
  }
}

const invokedAsEntrypoint =
  process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;

if (invokedAsEntrypoint) {
  runLegacyCliWithErrorHandling();
}

