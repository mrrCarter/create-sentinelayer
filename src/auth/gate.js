import process from "node:process";
import pc from "picocolors";
import { readStoredSession } from "./session-store.js";

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

function hasTrustedBypassContext() {
  return (
    process.env.NODE_ENV === "test" ||
    process.env.SENTINELAYER_CLI_TEST_MODE === "1"
  );
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
  if (tokenPrefix && !token.startsWith(tokenPrefix)) {
    return false;
  }
  return true;
}

function isSessionUnexpired(tokenExpiresAt) {
  if (!tokenExpiresAt) {
    return true;
  }
  const expiresAt = new Date(tokenExpiresAt).getTime();
  if (!Number.isFinite(expiresAt)) {
    return false;
  }
  return expiresAt >= Date.now();
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

  // Bypass commands
  if (!first || AUTH_BYPASS_COMMANDS.has(first)) {
    return { authenticated: true, session: null, bypassReason: "auth_bypass_command" };
  }

  if (NO_AUTH_REQUIRED.has(first)) {
    return { authenticated: true, session: null, bypassReason: "no_auth_required" };
  }

  // Explicit bypass is gated to trusted test contexts only.
  if (process.env.SENTINELAYER_CLI_SKIP_AUTH === "1" && hasTrustedBypassContext()) {
    return { authenticated: true, session: null, bypassReason: "env_bypass_guarded" };
  }

  // Check for stored session
  try {
    const session = await readStoredSession();
    if (session && isValidSessionToken(session) && isSessionUnexpired(session.tokenExpiresAt)) {
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
  console.error("    " + pc.cyan("sl auth login"));
  console.error("");
  console.error("  This opens your browser to authenticate via GitHub or Google.");
  console.error("  Your session is encrypted and stored locally.");
  console.error("");
  console.error("  " + pc.gray("Why? All CLI operations sync to your SentinelLayer account —"));
  console.error("  " + pc.gray("audit reports, findings, cost tracking, and run history."));
  console.error("");
  process.exitCode = 1;
}
