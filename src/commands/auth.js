import process from "node:process";

import pc from "picocolors";

import { SentinelayerApiError } from "../auth/http.js";
import {
  DEFAULT_API_TOKEN_TTL_DAYS,
  DEFAULT_AUTH_TIMEOUT_MS,
  getAuthStatus,
  listStoredAuthSessions,
  loginAndPersistSession,
  logoutSession,
  revokeAuthToken,
} from "../auth/service.js";
import { resolveCredentialsFilePath } from "../auth/session-store.js";
import { CLI_VERSION } from "../legacy-cli.js";

function shouldEmitJson(options, command) {
  const local = Boolean(options && options.json);
  const globalFromCommand =
    command && command.optsWithGlobals ? Boolean(command.optsWithGlobals().json) : false;
  return local || globalFromCommand;
}

function shouldShowPaths(options, command) {
  const local = Boolean(options && options.showPaths);
  const globalFromCommand =
    command && command.optsWithGlobals ? Boolean(command.optsWithGlobals().showPaths) : false;
  return local || globalFromCommand;
}

function parsePositiveNumber(rawValue, field, fallbackValue) {
  if (rawValue === undefined || rawValue === null || String(rawValue).trim() === "") {
    return fallbackValue;
  }
  const normalized = Number(rawValue);
  if (!Number.isFinite(normalized) || normalized <= 0) {
    throw new Error(`${field} must be a positive number.`);
  }
  return normalized;
}

function normalizeUser(user = {}) {
  return {
    id: String(user.id || "").trim(),
    githubUsername: String(user.githubUsername || user.github_username || "").trim(),
    email: String(user.email || "").trim(),
    avatarUrl: String(user.avatarUrl || user.avatar_url || "").trim(),
    isAdmin: Boolean(user.isAdmin || user.is_admin),
  };
}

function renderUserSummary(user = {}) {
  const normalized = normalizeUser(user);
  const identity = normalized.githubUsername || normalized.email || normalized.id || "unknown";
  return `${identity}${normalized.isAdmin ? " (admin)" : ""}`;
}

function formatApiError(error) {
  if (!(error instanceof SentinelayerApiError)) {
    return error instanceof Error ? error.message : String(error || "Unknown error");
  }
  const requestId = error.requestId ? ` request_id=${error.requestId}` : "";
  return `${error.message} [${error.code}] status=${error.status}${requestId}`;
}

function printAuthHint() {
  console.log(pc.gray("Run `sl auth login` to create a persistent CLI session."));
}

export function registerAuthCommand(program) {
  const auth = program
    .command("auth")
    .description("Manage Sentinelayer CLI authentication and persistent sessions");

  auth
    .command("login")
    .description("Authenticate in browser and persist a long-lived API token")
    .option("--api-url <url>", "Override Sentinelayer API base URL")
    .option("--skip-browser-open", "Do not auto-open browser; print authorize URL instead")
    .option(
      "--timeout-ms <ms>",
      "Authentication timeout in milliseconds",
      String(DEFAULT_AUTH_TIMEOUT_MS)
    )
    .option("--token-label <label>", "Label to apply to the issued API token")
    .option(
      "--token-ttl-days <days>",
      "Issued API token lifetime in days",
      String(DEFAULT_API_TOKEN_TTL_DAYS)
    )
    .option(
      "--token-scope <scope>",
      "API token scope override (default: cli_session; elevated: github_app_bridge)"
    )
    .option("--show-paths", "Display local credential metadata paths in terminal output")
    .option("--json", "Emit machine-readable output")
    .action(async (options, command) => {
      const timeoutMs = parsePositiveNumber(options.timeoutMs, "timeoutMs", DEFAULT_AUTH_TIMEOUT_MS);
      const tokenTtlDays = parsePositiveNumber(
        options.tokenTtlDays,
        "tokenTtlDays",
        DEFAULT_API_TOKEN_TTL_DAYS
      );

      let result;
      try {
        result = await loginAndPersistSession({
          cwd: process.cwd(),
          env: process.env,
          explicitApiUrl: options.apiUrl,
          skipBrowserOpen: Boolean(options.skipBrowserOpen),
          timeoutMs,
          tokenLabel: options.tokenLabel,
          tokenTtlDays,
          tokenScope: options.tokenScope,
          cliVersion: CLI_VERSION,
        });
      } catch (error) {
        throw new Error(formatApiError(error));
      }

      const payload = {
        command: "auth login",
        authenticated: true,
        ...result,
      };

      if (shouldEmitJson(options, command)) {
        console.log(JSON.stringify(payload, null, 2));
        return;
      }
      const showPaths = shouldShowPaths(options, command);

      console.log(pc.bold("Authentication successful"));
      console.log(pc.gray(`API: ${result.apiUrl}`));
      console.log(pc.gray(`User: ${renderUserSummary(result.user)}`));
      console.log(pc.gray(`Storage: ${result.storage}`));
      if (result.tokenExpiresAt) {
        console.log(pc.gray(`Token expiry: ${result.tokenExpiresAt}`));
      }
      if (result.filePath && showPaths) {
        console.log(pc.gray(`Session metadata: ${result.filePath}`));
      } else if (result.filePath) {
        console.log(pc.gray("Session metadata saved locally (use --show-paths to display path)."));
      }
      if (!result.browserOpened && result.authorizeUrl) {
        console.log(pc.yellow("Open this URL to approve sign-in:"));
        console.log(result.authorizeUrl);
      }
    });

  auth
    .command("status")
    .description("Show current authentication/session status")
    .option("--api-url <url>", "Override Sentinelayer API base URL")
    .option("--offline", "Skip remote token validation (`/auth/me`)")
    .option("--no-auto-rotate", "Disable near-expiry auto-rotation for this command")
    .option("--show-paths", "Display local credential metadata paths in terminal output")
    .option("--json", "Emit machine-readable output")
    .action(async (options, command) => {
      let status;
      try {
        status = await getAuthStatus({
          cwd: process.cwd(),
          env: process.env,
          explicitApiUrl: options.apiUrl,
          checkRemote: !options.offline,
          autoRotate: Boolean(options.autoRotate),
        });
      } catch (error) {
        throw new Error(formatApiError(error));
      }

      const payload = {
        command: "auth status",
        ...status,
        defaultCredentialsPath: resolveCredentialsFilePath(),
      };

      if (shouldEmitJson(options, command)) {
        console.log(JSON.stringify(payload, null, 2));
        return;
      }
      const showPaths = shouldShowPaths(options, command);

      console.log(pc.bold("Authentication status"));
      console.log(pc.gray(`API: ${status.apiUrl}`));
      if (!status.source) {
        console.log(pc.yellow("No active session token found."));
        printAuthHint();
        return;
      }

      console.log(pc.gray(`Token source: ${status.source}`));
      if (status.source === "session") {
        console.log(pc.gray(`Session storage: ${status.storage || "unknown"}`));
        if (status.filePath && showPaths) {
          console.log(pc.gray(`Session metadata: ${status.filePath}`));
        } else if (status.filePath) {
          console.log(pc.gray("Session metadata present locally (use --show-paths to display path)."));
        }
      }
      if (status.tokenExpiresAt) {
        console.log(pc.gray(`Token expiry: ${status.tokenExpiresAt}`));
      }
      if (status.rotated) {
        console.log(pc.yellow("Token was rotated because it was close to expiry."));
      }

      if (status.authenticated) {
        const displayUser = status.remoteUser || status.user || {};
        console.log(pc.green(`Authenticated as ${renderUserSummary(displayUser)}`));
        return;
      }

      if (status.remoteError) {
        console.log(pc.red(`Remote validation failed: ${status.remoteError.message}`));
        console.log(
          pc.gray(
            `Error code: ${status.remoteError.code} status=${status.remoteError.status}${
              status.remoteError.requestId ? ` request_id=${status.remoteError.requestId}` : ""
            }`
          )
        );
      } else {
        console.log(pc.yellow("Remote validation was skipped (`--offline`)."));
      }
      printAuthHint();
    });

  auth
    .command("sessions")
    .alias("list")
    .description("List persisted local session metadata for resume and auditability")
    .option("--api-url <url>", "Override Sentinelayer API base URL")
    .option("--show-paths", "Display local credential metadata paths in terminal output")
    .option("--json", "Emit machine-readable output")
    .action(async (options, command) => {
      let result;
      try {
        result = await listStoredAuthSessions({
          cwd: process.cwd(),
          env: process.env,
          explicitApiUrl: options.apiUrl,
        });
      } catch (error) {
        throw new Error(formatApiError(error));
      }

      const payload = {
        command: "auth sessions",
        ...result,
        defaultCredentialsPath: resolveCredentialsFilePath(),
      };

      if (shouldEmitJson(options, command)) {
        console.log(JSON.stringify(payload, null, 2));
        return;
      }
      const showPaths = shouldShowPaths(options, command);
      let hiddenPathCount = 0;

      console.log(pc.bold("Stored sessions"));
      console.log(pc.gray(`API: ${result.apiUrl}`));
      if (!result.sessions.length) {
        console.log(pc.yellow("No persisted sessions found."));
        printAuthHint();
        return;
      }

      for (const session of result.sessions) {
        console.log(
          `${renderUserSummary(session.user)} | source=${session.source} | storage=${session.storage || "unknown"}`
        );
        if (session.tokenId) {
          console.log(pc.gray(`  token_id: ${session.tokenId}`));
        }
        if (session.tokenExpiresAt) {
          console.log(pc.gray(`  expires_at: ${session.tokenExpiresAt}`));
        }
        if (session.updatedAt) {
          console.log(pc.gray(`  updated_at: ${session.updatedAt}`));
        }
        if (session.filePath && showPaths) {
          console.log(pc.gray(`  metadata: ${session.filePath}`));
        } else if (session.filePath) {
          hiddenPathCount += 1;
        }
      }
      if (hiddenPathCount > 0) {
        console.log(pc.gray(`Metadata paths hidden for ${hiddenPathCount} session(s); use --show-paths to display.`));
      }
    });

  auth
    .command("revoke")
    .description("Revoke a remote API token and clear matching local session metadata")
    .option("--api-url <url>", "Override Sentinelayer API base URL")
    .option("--token-id <id>", "API token id to revoke (defaults to active session token id)")
    .option("--show-paths", "Display local credential metadata paths in terminal output")
    .option("--json", "Emit machine-readable output")
    .action(async (options, command) => {
      let result;
      try {
        result = await revokeAuthToken({
          cwd: process.cwd(),
          env: process.env,
          explicitApiUrl: options.apiUrl,
          tokenId: options.tokenId,
        });
      } catch (error) {
        throw new Error(formatApiError(error));
      }

      const payload = {
        command: "auth revoke",
        ...result,
      };

      if (shouldEmitJson(options, command)) {
        console.log(JSON.stringify(payload, null, 2));
        return;
      }
      const showPaths = shouldShowPaths(options, command);

      console.log(pc.green(`Revoked token: ${result.tokenId}`));
      console.log(pc.gray(`API: ${result.apiUrl}`));
      if (result.matchedStoredSession) {
        console.log(
          pc.gray(
            result.clearedLocal
              ? "Matching local session metadata was cleared."
              : "Matching local session metadata was detected but not cleared."
          )
        );
      } else {
        console.log(pc.gray("No local session metadata matched the revoked token id."));
      }
      if (result.filePath && showPaths) {
        console.log(pc.gray(`Session metadata path: ${result.filePath}`));
      } else if (result.filePath) {
        console.log(pc.gray("Session metadata was updated locally (use --show-paths to display path)."));
      }
    });

  auth
    .command("logout")
    .description("Clear local session and optionally revoke remote API token")
    .option("--api-url <url>", "Override Sentinelayer API base URL")
    .option("--local-only", "Clear local session only (skip remote revoke)")
    .option("--show-paths", "Display local credential metadata paths in terminal output")
    .option("--json", "Emit machine-readable output")
    .action(async (options, command) => {
      let result;
      try {
        result = await logoutSession({
          cwd: process.cwd(),
          env: process.env,
          explicitApiUrl: options.apiUrl,
          revokeRemote: !options.localOnly,
        });
      } catch (error) {
        throw new Error(formatApiError(error));
      }

      const payload = {
        command: "auth logout",
        ...result,
      };

      if (shouldEmitJson(options, command)) {
        console.log(JSON.stringify(payload, null, 2));
        return;
      }
      const showPaths = shouldShowPaths(options, command);

      if (!result.hadStoredSession) {
        console.log(pc.yellow("No stored session was found."));
        if (result.apiUrl) {
          console.log(pc.gray(`API: ${result.apiUrl}`));
        }
        return;
      }

      console.log(pc.green("Local session cleared."));
      if (!options.localOnly) {
        console.log(
          pc.gray(
            result.revokedRemote
              ? "Remote API token revoked."
              : "Remote API token revoke skipped or failed."
          )
        );
      }
      if (result.filePath && showPaths) {
        console.log(pc.gray(`Session metadata path: ${result.filePath}`));
      } else if (result.filePath) {
        console.log(pc.gray("Session metadata was cleared locally (use --show-paths to display path)."));
      }
    });
}
