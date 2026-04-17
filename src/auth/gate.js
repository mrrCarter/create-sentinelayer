import process from "node:process";
import crypto from "node:crypto";
import os from "node:os";
import fs from "node:fs";
import path from "node:path";
import pc from "picocolors";
import { resolveActiveAuthSession } from "./service.js";
import { authLoginHint } from "../ui/command-hints.js";

/**
 * Auth gate — ensures user is logged in before running any command.
 *
 * Commands that bypass auth:
 * - auth login, auth status, auth --help
 * - --help, --version, -h, -v
 * - config (read-only config inspection)
 *
 * All other commands require a valid session.
 * If not authenticated, prints instructions and exits.
 */

const AUTH_BYPASS_COMMANDS = new Set([
  "auth",      // auth subcommands handle their own auth
  "help",      // help must work without login so agents can discover commands
  "--help",
  "-h",
  "--version",
  "-v",
]);

// Commands that work without auth (read-only, no API calls)
const NO_AUTH_REQUIRED = new Set([
  "config",    // local config inspection
]);
const SESSION_NO_AUTH_SUBCOMMANDS = new Set([
  "read",
  "list",
  "status",
]);

const TEST_BYPASS_NONCE_ENV = "SENTINELAYER_CLI_TEST_BYPASS_NONCE";
const TEST_BYPASS_SECRET_ENV = "SENTINELAYER_CLI_TEST_BYPASS_SECRET";
const TEST_BYPASS_TOKEN_ENV = "SENTINELAYER_CLI_TEST_BYPASS_TOKEN";
const TEST_BYPASS_NONCE_FILENAME_PREFIX = "sentinelayer-cli-test-bypass";
const TEST_BYPASS_NONCE_MAX_AGE_MS = 5 * 60 * 1000;
const TEST_BYPASS_ALLOWED_EXECUTABLES = new Set([
  "create-sentinelayer.js",
  "sentinelayer-cli.js",
  "sl.js",
  "cli.js",
]);
const TEST_BYPASS_ALLOWED_COMMANDS = new Set([
  "audit",
  "chat",
  "config",
  "cost",
  "daemon",
  "guide",
  "ingest",
  "mcp",
  "plugin",
  "policy",
  "prompt",
  "review",
  "scan",
  "spec",
  "swarm",
  "telemetry",
  "watch",
]);
const TEST_BYPASS_BLOCKED_FLAGS = new Set([
  "--apply",
  "--delete",
  "--deploy",
  "--destroy",
  "--execute",
  "--fix",
  "--force",
  "--merge",
  "--promote",
  "--publish",
  "--push",
  "--regenerate",
  "--revoke",
]);

function isTruthy(value) {
  const normalized = String(value || "").trim().toLowerCase();
  return normalized === "1" || normalized === "true" || normalized === "yes";
}

function isPackagedBuild() {
  if (process.pkg) {
    return true;
  }
  const execPath = String(process.execPath || "");
  const execBase = path.basename(execPath).toLowerCase();
  return execBase !== "node" && execBase !== "node.exe";
}

function readNonceEnvelope(nonce) {
  const normalizedNonce = String(nonce || "").trim();
  if (!normalizedNonce) {
    return null;
  }
  const nonceFile = path.join(os.tmpdir(), `${TEST_BYPASS_NONCE_FILENAME_PREFIX}-${normalizedNonce}.nonce`);
  try {
    const stats = fs.statSync(nonceFile);
    if (!stats.isFile()) {
      return null;
    }
    if (typeof process.getuid === "function") {
      if (stats.uid !== process.getuid()) {
        return null;
      }
      if (stats.mode & 0o022) {
        return null;
      }
    }
    if (stats.size <= 0 || stats.size > 1024) {
      return null;
    }
    const payloadRaw = fs.readFileSync(nonceFile, "utf-8");
    const payload = JSON.parse(payloadRaw);
    const payloadNonce = String(payload?.nonce || "").trim();
    const payloadPid = Number(payload?.pid);
    const payloadTs = Number(payload?.ts);
    if (payloadNonce !== normalizedNonce) {
      return null;
    }
    if (!Number.isInteger(payloadPid) || payloadPid <= 0) {
      return null;
    }
    if (!Number.isFinite(payloadTs) || payloadTs <= 0) {
      return null;
    }
    if (Math.abs(Date.now() - payloadTs) > TEST_BYPASS_NONCE_MAX_AGE_MS) {
      return null;
    }
    return {
      nonce: payloadNonce,
      pid: payloadPid,
      ts: payloadTs,
      nonceFile,
    };
  } catch {
    return null;
  }
}

function consumeNonceEnvelope(nonceFile) {
  const normalizedPath = String(nonceFile || "").trim();
  if (!normalizedPath) {
    return false;
  }
  const consumedPath = `${normalizedPath}.used.${process.pid}.${Date.now()}`;
  try {
    fs.renameSync(normalizedPath, consumedPath);
  } catch {
    return false;
  }
  try {
    fs.rmSync(consumedPath, { force: true });
  } catch {
    // Best effort cleanup only.
  }
  return true;
}

function isValidTestBypassToken({ nonce, pid, ts, secret, token }) {
  const normalizedNonce = String(nonce || "").trim();
  const normalizedPid = Number(pid);
  const normalizedTs = Number(ts);
  const normalizedSecret = String(secret || "").trim();
  const rawToken = String(token || "").trim();
  if (
    !normalizedNonce ||
    !Number.isInteger(normalizedPid) ||
    normalizedPid <= 0 ||
    !Number.isFinite(normalizedTs) ||
    normalizedTs <= 0 ||
    !normalizedSecret ||
    !rawToken
  ) {
    return false;
  }
  const normalizedToken = rawToken.replace(/^sha256:/i, "");
  if (!/^[a-f0-9]{64}$/i.test(normalizedToken)) {
    return false;
  }
  const message = `${normalizedNonce}|${normalizedPid}|${normalizedTs}`;
  const computed = crypto.createHmac("sha256", normalizedSecret).update(message).digest("hex");
  const expectedBuffer = Buffer.from(computed, "hex");
  const candidateBuffer = Buffer.from(normalizedToken.toLowerCase(), "hex");
  if (expectedBuffer.length !== candidateBuffer.length) {
    return false;
  }
  return crypto.timingSafeEqual(expectedBuffer, candidateBuffer);
}

function isBypassCommandAllowed(args = []) {
  const first = String(args[0] || "").trim().toLowerCase();
  if (!first) {
    return false;
  }
  if (first.startsWith("/")) {
    return true;
  }
  if (!TEST_BYPASS_ALLOWED_COMMANDS.has(first)) {
    return false;
  }
  for (const rawArg of args.slice(1)) {
    const arg = String(rawArg || "").trim().toLowerCase();
    if (!arg.startsWith("--")) {
      continue;
    }
    const normalizedFlag = arg.split("=")[0];
    if (TEST_BYPASS_BLOCKED_FLAGS.has(normalizedFlag)) {
      return false;
    }
  }
  return true;
}

function firstPositionalArg(args = [], startIndex = 0) {
  for (const rawArg of args.slice(startIndex)) {
    const normalized = String(rawArg || "").trim().toLowerCase();
    if (!normalized || normalized.startsWith("-")) {
      continue;
    }
    return normalized;
  }
  return "";
}

function isSessionNoAuthCommand(args = []) {
  const first = String(args[0] || "").trim().toLowerCase();
  if (first !== "session") {
    return false;
  }
  const subcommand = firstPositionalArg(args, 1);
  return SESSION_NO_AUTH_SUBCOMMANDS.has(subcommand);
}

function hasTrustedBypassExecutableContext() {
  const argvPath = String(process.argv[1] || "").trim();
  if (!argvPath) {
    return false;
  }
  const executableName = path.basename(argvPath).toLowerCase();
  if (!TEST_BYPASS_ALLOWED_EXECUTABLES.has(executableName)) {
    return false;
  }
  const normalizedPath = argvPath.replace(/\\/g, "/").toLowerCase();
  if (!normalizedPath.includes("/bin/") && !normalizedPath.endsWith("/src/cli.js")) {
    return false;
  }
  return true;
}

function hasTrustedBypassContext(args = []) {
  if (isTruthy(process.env.CI)) {
    return false;
  }
  if (process.env.NODE_ENV !== "test" || process.env.SENTINELAYER_CLI_TEST_MODE !== "1") {
    return false;
  }
  if (isPackagedBuild()) {
    return false;
  }
  if (!hasTrustedBypassExecutableContext()) {
    return false;
  }
  if (!isBypassCommandAllowed(args)) {
    return false;
  }
  const nonceEnvelope = readNonceEnvelope(process.env[TEST_BYPASS_NONCE_ENV]);
  if (!nonceEnvelope) {
    return false;
  }
  if (
    !isValidTestBypassToken({
      nonce: nonceEnvelope.nonce,
      pid: nonceEnvelope.pid,
      ts: nonceEnvelope.ts,
      secret: process.env[TEST_BYPASS_SECRET_ENV],
      token: process.env[TEST_BYPASS_TOKEN_ENV],
    })
  ) {
    return false;
  }
  return consumeNonceEnvelope(nonceEnvelope.nonceFile);
}

function isValidSessionToken(session) {
  const token = String(session?.token || "");
  if (!token || token !== token.trim()) {
    return false;
  }
  if (/\s/.test(token)) {
    return false;
  }
  // Require printable ASCII only for bearer token material in local metadata.
  if (/[^\x21-\x7E]/.test(token)) {
    return false;
  }
  const tokenPrefix = String(session?.tokenPrefix || "").trim();
  if (tokenPrefix && !token.includes(tokenPrefix)) {
    return false;
  }
  return true;
}

function isSessionUnexpired(tokenExpiresAt) {
  const normalized = String(tokenExpiresAt || "").trim();
  if (!normalized) {
    return false;
  }
  const expiresAt = new Date(normalized).getTime();
  if (!Number.isFinite(expiresAt)) {
    return false;
  }
  return expiresAt >= Date.now();
}

function isAuthenticatedSessionValid(session) {
  if (!isValidSessionToken(session)) {
    return false;
  }

  // Persisted sessions must include a valid expiry bound. Env/config tokens
  // are accepted as active auth sources and validated downstream by API calls.
  if (String(session?.source || "").trim() === "session") {
    return isSessionUnexpired(session?.tokenExpiresAt);
  }
  return true;
}

/**
 * Check if the current command requires authentication.
 * Returns true if auth is required but user is not logged in.
 *
 * @param {string[]} args - CLI arguments (after normalization)
 * @returns {Promise<{ authenticated: boolean, session: object|null, bypassReason: string|null }>}
 */
export async function checkAuthGate(args) {
  const first = String(args[0] || "").trim().toLowerCase();

  if (!first || AUTH_BYPASS_COMMANDS.has(first)) {
    return { authenticated: true, session: null, bypassReason: "auth_bypass_command" };
  }

  if (NO_AUTH_REQUIRED.has(first)) {
    return { authenticated: true, session: null, bypassReason: "no_auth_required" };
  }

  if (isSessionNoAuthCommand(args)) {
    return { authenticated: true, session: null, bypassReason: "session_no_auth_required" };
  }

  if (process.env.SENTINELAYER_CLI_SKIP_AUTH === "1" && hasTrustedBypassContext(args)) {
    return { authenticated: true, session: null, bypassReason: "env_bypass_guarded" };
  }

  // Check for active auth session across env -> config -> stored session.
  try {
    const session = await resolveActiveAuthSession({
      cwd: process.cwd(),
      env: process.env,
      autoRotate: false,
    });
    if (session && isAuthenticatedSessionValid(session)) {
      return { authenticated: true, session, bypassReason: null };
    }
  } catch {
    // Session read failed — treat as not authenticated
  }

  return { authenticated: false, session: null, bypassReason: null };
}

/**
 * Print auth required message and exit.
 */
export function printAuthRequired() {
  console.error("");
  console.error(pc.bold(pc.red("Authentication required.")));
  console.error("");
  console.error("  Log in to SentinelLayer to use CLI commands:");
  console.error("");
  console.error("    " + pc.cyan(authLoginHint()));
  console.error("");
  console.error("  This opens your browser to authenticate via GitHub or Google.");
  console.error("  Your session is encrypted and stored locally.");
  console.error("");
  console.error("  " + pc.gray("Why? All CLI operations sync to your SentinelLayer account —"));
  console.error("  " + pc.gray("audit reports, findings, cost tracking, and run history."));
  console.error("");
  process.exitCode = 1;
}
