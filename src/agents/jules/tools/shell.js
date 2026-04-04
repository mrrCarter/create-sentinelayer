import { execSync } from "node:child_process";
import path from "node:path";

const DEFAULT_TIMEOUT_MS = 120_000;
const MAX_OUTPUT_CHARS = 30_000;
const DEFAULT_ALLOWED_FETCH_HOSTS = [
  "github.com",
  "api.github.com",
  "raw.githubusercontent.com",
  "*.githubusercontent.com",
  "registry.npmjs.org",
  "registry.yarnpkg.com",
  "pypi.org",
  "files.pythonhosted.org",
  "rubygems.org",
  "crates.io",
  "static.crates.io",
];

/**
 * Patterns that are BLOCKED unconditionally.
 * Sourced from review/local-review.js security rules + src bash security patterns.
 */
const BLOCKED_PATTERNS = [
  { pattern: /rm\s+(-[rR]f?|--recursive)\s+\/($|\s)/, desc: "rm -rf /" },
  { pattern: /:\(\)\s*\{[^}]*\}\s*;?\s*:/, desc: "fork bomb" },
  { pattern: /\beval\s*\(/, desc: "eval injection" },
  { pattern: /curl[^|]*\|\s*(ba)?sh/, desc: "pipe to shell" },
  { pattern: /wget[^|]*\|\s*(ba)?sh/, desc: "wget pipe to shell" },
  { pattern: />\s*\/dev\/sd[a-z]/, desc: "write to raw device" },
  { pattern: /mkfs\./, desc: "filesystem format" },
  { pattern: /dd\s+.*of=\/dev\//, desc: "dd to device" },
  { pattern: /chmod\s+777\s+\//, desc: "chmod 777 root" },
  { pattern: />\s*\/etc\//, desc: "write to /etc" },
  { pattern: /rm\s+-rf?\s+~/, desc: "rm home directory" },
  { pattern: /git\s+push\s+.*--force\s+.*main/, desc: "force push to main" },
  { pattern: /git\s+reset\s+--hard/, desc: "git reset hard" },
  { pattern: /DROP\s+TABLE|DROP\s+DATABASE/i, desc: "SQL drop" },
  { pattern: /TRUNCATE\s+TABLE/i, desc: "SQL truncate" },
];

/**
 * Patterns that trigger a WARNING but are allowed.
 */
const WARN_PATTERNS = [
  { pattern: /npm\s+install|yarn\s+add|pnpm\s+add/, desc: "package install" },
  { pattern: /git\s+push/, desc: "git push" },
  { pattern: /curl\s|wget\s|fetch\(/, desc: "network request" },
  { pattern: /rm\s+-/, desc: "file deletion" },
  { pattern: /sudo\s/, desc: "elevated privileges" },
];

/**
 * Environment variables to strip from child process env.
 * Prevents credential leakage to spawned commands.
 */
const EXACT_ENV_KEYS_TO_STRIP = new Set([
  "ANTHROPIC_API_KEY",
  "OPENAI_API_KEY",
  "GOOGLE_API_KEY",
  "GEMINI_API_KEY",
  "SENTINELAYER_TOKEN",
  "AIDENID_API_KEY",
  "AIDENID_TOKEN",
  "AWS_ACCESS_KEY_ID",
  "AWS_SECRET_ACCESS_KEY",
  "AWS_SESSION_TOKEN",
  "AWS_WEB_IDENTITY_TOKEN_FILE",
  "AZURE_CLIENT_SECRET",
  "GOOGLE_APPLICATION_CREDENTIALS",
  "GITHUB_TOKEN",
  "GH_TOKEN",
  "GITLAB_TOKEN",
  "BITBUCKET_TOKEN",
  "NPM_TOKEN",
  "NODE_AUTH_TOKEN",
  "PYPI_API_TOKEN",
  "RUBYGEMS_API_KEY",
  "CARGO_REGISTRY_TOKEN",
  "ACTIONS_ID_TOKEN_REQUEST_TOKEN",
  "ACTIONS_RUNTIME_TOKEN",
  "CI_JOB_TOKEN",
  "CI_JOB_JWT",
  "STRIPE_SECRET_KEY",
  "SLACK_BOT_TOKEN",
  "TELEGRAM_BOT_TOKEN",
  "DISCORD_BOT_TOKEN",
  "TWILIO_AUTH_TOKEN",
  "SENDGRID_API_KEY",
  "RESEND_API_KEY",
  "DATABASE_URL",
  "REDIS_URL",
  "MONGODB_URI",
  "SSH_SIGNING_KEY",
  "SSH_PRIVATE_KEY",
  "KUBECONFIG",
  "KUBE_CONFIG_DATA",
]);

const ENV_KEY_PREFIX_PATTERNS = [
  /^AIDENID_/i,
  /^SENTINELAYER_/i,
  /^OPENAI_/i,
  /^ANTHROPIC_/i,
  /^GOOGLE_/i,
  /^GITHUB_/i,
  /^GH_/i,
  /^AWS_/i,
  /^AZURE_/i,
  /^SLACK_/i,
  /^STRIPE_/i,
  /^TELEGRAM_/i,
  /^DISCORD_/i,
  /^TWILIO_/i,
  /^SENDGRID_/i,
  /^RESEND_/i,
];

const ENV_KEY_SUFFIX_PATTERNS = [
  /_TOKEN$/i,
  /_API_KEY$/i,
  /_SECRET$/i,
  /_SECRET_KEY$/i,
  /_PASSWORD$/i,
  /_PRIVATE_KEY$/i,
  /_ACCESS_KEY$/i,
  /_AUTH_TOKEN$/i,
  /_SESSION_TOKEN$/i,
];

/**
 * Execute a shell command with security analysis, timeout, and env scrubbing.
 *
 * @param {object} input
 * @param {string} input.command - The shell command to execute.
 * @param {string} [input.cwd] - Working directory (default: process.cwd()).
 * @param {number} [input.timeout] - Timeout in ms (default: 120000).
 * @returns {{ stdout, stderr, exitCode, durationMs, command, security }}
 */
export function shell(input) {
  if (!input.command || typeof input.command !== "string") {
    throw new ShellError("command is required and must be a non-empty string.");
  }

  const command = input.command.trim();
  const cwd = input.cwd ? path.resolve(input.cwd) : process.cwd();
  const timeout = input.timeout ?? DEFAULT_TIMEOUT_MS;

  // Security analysis
  const security = analyzeCommand(command);
  if (security.risk === "blocked") {
    throw new ShellBlockedError(
      `Command blocked: ${security.patterns[0].desc}`,
      security,
    );
  }

  // Build scrubbed environment
  const env = buildScrubbedEnv();

  const startMs = Date.now();
  let stdout = "";
  let stderr = "";
  let exitCode = 0;

  try {
    stdout = execSync(command, {
      cwd,
      encoding: "utf-8",
      timeout,
      env,
      maxBuffer: 10 * 1024 * 1024,
      stdio: ["pipe", "pipe", "pipe"],
    });
  } catch (err) {
    exitCode = err.status ?? 1;
    stdout = err.stdout ?? "";
    stderr = err.stderr ?? "";
    if (err.killed) {
      stderr += `\n[Process killed: timeout after ${timeout}ms]`;
    }
  }

  const durationMs = Date.now() - startMs;

  // Truncate large outputs
  if (stdout.length > MAX_OUTPUT_CHARS) {
    stdout = stdout.slice(0, MAX_OUTPUT_CHARS) + "\n[... truncated]";
  }
  if (stderr.length > MAX_OUTPUT_CHARS) {
    stderr = stderr.slice(0, MAX_OUTPUT_CHARS) + "\n[... truncated]";
  }

  return { stdout, stderr, exitCode, durationMs, command, security };
}

/**
 * Analyze a command for security risks.
 * @param {object} [options]
 * @param {Record<string, string|undefined>} [options.env]
 * @returns {{ risk: "safe"|"warn"|"blocked", patterns: Array<{desc}>, networkPolicy?: object }}
 */
export function analyzeCommand(command, options = {}) {
  const networkPolicy = evaluateNetworkPolicy(command, options.env);
  if (networkPolicy.blocking) {
    return {
      risk: "blocked",
      patterns: [{ desc: networkPolicy.reason }],
      networkPolicy,
    };
  }

  for (const rule of BLOCKED_PATTERNS) {
    if (rule.pattern.test(command)) {
      return { risk: "blocked", patterns: [rule], networkPolicy };
    }
  }

  const warnings = [];
  for (const rule of WARN_PATTERNS) {
    if (rule.pattern.test(command)) {
      warnings.push(rule);
    }
  }

  if (warnings.length > 0) {
    return { risk: "warn", patterns: warnings, networkPolicy };
  }

  return { risk: "safe", patterns: [], networkPolicy };
}

export function buildScrubbedEnv(sourceEnv = process.env) {
  const env = { ...sourceEnv };
  for (const key of Object.keys(env)) {
    if (shouldStripEnvKey(key)) {
      delete env[key];
    }
  }
  return env;
}

function shouldStripEnvKey(key) {
  if (!key) {
    return false;
  }

  const upperKey = String(key).toUpperCase();
  if (EXACT_ENV_KEYS_TO_STRIP.has(upperKey)) {
    return true;
  }

  if (upperKey.startsWith("INPUT_")) {
    const baseKey = upperKey.slice("INPUT_".length);
    if (EXACT_ENV_KEYS_TO_STRIP.has(baseKey)) {
      return true;
    }
    if (ENV_KEY_PREFIX_PATTERNS.some((pattern) => pattern.test(baseKey))) {
      return true;
    }
    if (ENV_KEY_SUFFIX_PATTERNS.some((pattern) => pattern.test(baseKey))) {
      return true;
    }
  }

  if (ENV_KEY_PREFIX_PATTERNS.some((pattern) => pattern.test(upperKey))) {
    return true;
  }

  return ENV_KEY_SUFFIX_PATTERNS.some((pattern) => pattern.test(upperKey));
}

function evaluateNetworkPolicy(command, sourceEnv = process.env) {
  if (!/\b(curl|wget)\b/i.test(command)) {
    return {
      blocking: false,
      hosts: [],
      deniedHosts: [],
    };
  }

  const hosts = extractNetworkHosts(command);
  if (hosts.length === 0) {
    return {
      blocking: true,
      hosts: [],
      deniedHosts: [],
      reason: "network command requires explicit URL host",
    };
  }

  const allowlist = resolveAllowedFetchHosts(sourceEnv);
  const deniedHosts = hosts.filter((host) => !isAllowedHost(host, allowlist));
  if (deniedHosts.length > 0) {
    return {
      blocking: true,
      hosts,
      deniedHosts,
      reason: `network host not allowlisted: ${deniedHosts.join(", ")}`,
    };
  }

  return {
    blocking: false,
    hosts,
    deniedHosts: [],
  };
}

function resolveAllowedFetchHosts(sourceEnv = process.env) {
  const configured = String(sourceEnv.SENTINELAYER_ALLOWED_FETCH_HOSTS || "")
    .split(",")
    .map((item) => normalizeHostPattern(item))
    .filter(Boolean);

  const allPatterns = [...DEFAULT_ALLOWED_FETCH_HOSTS, ...configured]
    .map((item) => normalizeHostPattern(item))
    .filter(Boolean);
  return Array.from(new Set(allPatterns));
}

function extractNetworkHosts(command) {
  const matches = command.matchAll(/\bhttps?:\/\/([^\s"'`]+)/gi);
  const hosts = new Set();
  for (const match of matches) {
    const candidate = match?.[0];
    if (!candidate) {
      continue;
    }
    try {
      const parsed = new URL(candidate);
      const host = normalizeHostPattern(parsed.hostname);
      if (host) {
        hosts.add(host);
      }
    } catch {
      // Skip malformed URL segments.
    }
  }
  return Array.from(hosts);
}

function isAllowedHost(host, allowlist) {
  const normalizedHost = normalizeHostPattern(host);
  if (!normalizedHost) {
    return false;
  }

  return allowlist.some((pattern) => {
    if (!pattern) {
      return false;
    }

    if (pattern.startsWith("*.")) {
      const suffix = pattern.slice(2);
      return normalizedHost === suffix || normalizedHost.endsWith(`.${suffix}`);
    }

    return normalizedHost === pattern;
  });
}

function normalizeHostPattern(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/\.$/, "");
}

export class ShellError extends Error {
  constructor(message) {
    super(message);
    this.name = "ShellError";
  }
}

export class ShellBlockedError extends ShellError {
  constructor(message, security) {
    super(message);
    this.name = "ShellBlockedError";
    this.security = security;
  }
}
