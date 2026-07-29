import fsp from "node:fs/promises";
import path from "node:path";
import process from "node:process";

import { guardFileLeases } from "./file-locks.js";

const FILE_LEASE_ENFORCEMENT_SCHEMA_VERSION = "1.0.0";
const CLAUDE_HOOK_MATCHER = "Edit|Write|NotebookEdit";
const VSCODE_GUARD_TASK_LABEL = "SentinelLayer: Guard current file lease";
const VSCODE_RENEW_TASK_LABEL = "SentinelLayer: Renew current file lease";
const VSCODE_GUARD_INPUT_ID = "sentinelayerLeasePath";
const MAX_HOOK_INPUT_BYTES = 1_048_576;
const SAFE_SESSION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const SAFE_AGENT_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,31}$/;

function normalizeString(value) {
  return String(value || "").trim();
}

function normalizeInstallSessionId(value) {
  const normalized = normalizeString(value);
  if (!SAFE_SESSION_ID_PATTERN.test(normalized)) {
    throw new Error(
      "sessionId must be safe for editor hook commands and match ^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$.",
    );
  }
  return normalized;
}

function normalizeInstallAgentId(value) {
  const normalized = normalizeString(value).toLowerCase();
  if (!SAFE_AGENT_ID_PATTERN.test(normalized)) {
    throw new Error(
      "agentId must be safe for editor hook commands and match ^[A-Za-z0-9][A-Za-z0-9._:-]{0,31}$.",
    );
  }
  return normalized;
}

function stripJsonComments(source) {
  let output = "";
  let inString = false;
  let escaped = false;
  let lineComment = false;
  let blockComment = false;
  for (let index = 0; index < source.length; index += 1) {
    const character = source[index];
    const next = source[index + 1];
    if (lineComment) {
      if (character === "\n" || character === "\r") {
        lineComment = false;
        output += character;
      } else {
        output += " ";
      }
      continue;
    }
    if (blockComment) {
      if (character === "*" && next === "/") {
        output += "  ";
        blockComment = false;
        index += 1;
      } else {
        output += character === "\n" || character === "\r" ? character : " ";
      }
      continue;
    }
    if (inString) {
      output += character;
      if (escaped) {
        escaped = false;
      } else if (character === "\\") {
        escaped = true;
      } else if (character === "\"") {
        inString = false;
      }
      continue;
    }
    if (character === "\"") {
      inString = true;
      output += character;
      continue;
    }
    if (character === "/" && next === "/") {
      output += "  ";
      lineComment = true;
      index += 1;
      continue;
    }
    if (character === "/" && next === "*") {
      output += "  ";
      blockComment = true;
      index += 1;
      continue;
    }
    output += character;
  }
  if (inString || blockComment) {
    throw new Error("JSON/JSONC integration file is truncated.");
  }
  return output;
}

function stripTrailingJsonCommas(source) {
  let output = "";
  let inString = false;
  let escaped = false;
  for (let index = 0; index < source.length; index += 1) {
    const character = source[index];
    if (inString) {
      output += character;
      if (escaped) {
        escaped = false;
      } else if (character === "\\") {
        escaped = true;
      } else if (character === "\"") {
        inString = false;
      }
      continue;
    }
    if (character === "\"") {
      inString = true;
      output += character;
      continue;
    }
    if (character === ",") {
      let lookahead = index + 1;
      while (lookahead < source.length && /\s/u.test(source[lookahead])) {
        lookahead += 1;
      }
      if (source[lookahead] === "}" || source[lookahead] === "]") {
        continue;
      }
    }
    output += character;
  }
  return output;
}

function parseJsonDocument(source, filePath) {
  try {
    return JSON.parse(stripTrailingJsonCommas(stripJsonComments(source)));
  } catch (error) {
    throw new Error(`Unable to safely parse integration JSON at ${filePath}.`, {
      cause: error,
    });
  }
}

async function readJsonObject(filePath) {
  try {
    const source = await fsp.readFile(filePath, "utf-8");
    const parsed = parseJsonDocument(source, filePath);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error(`Integration JSON root must be an object at ${filePath}.`);
    }
    return parsed;
  } catch (error) {
    if (error && typeof error === "object" && error.code === "ENOENT") {
      return {};
    }
    throw error;
  }
}

async function writeFileAtomic(filePath, contents, { mode = 0o600 } = {}) {
  await fsp.mkdir(path.dirname(filePath), { recursive: true });
  const temporaryPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  try {
    await fsp.writeFile(temporaryPath, contents, {
      encoding: "utf-8",
      mode,
    });
    await fsp.chmod(temporaryPath, mode).catch(() => {});
    await fsp.rename(temporaryPath, filePath);
    await fsp.chmod(filePath, mode).catch(() => {});
  } catch (error) {
    await fsp.rm(temporaryPath, { force: true }).catch(() => {});
    throw error;
  }
}

function isSentinelayerClaudeGuardHook(hook) {
  const command = normalizeString(hook?.command);
  return (
    hook?.type === "command" &&
    /(?:^|\s)sl\s+session\s+guard-hook(?:\s|$)/u.test(command)
  );
}

function mergeClaudeHookSettings(settings, command) {
  const next = {
    ...(settings && typeof settings === "object" ? settings : {}),
  };
  const hooks =
    next.hooks && typeof next.hooks === "object" && !Array.isArray(next.hooks)
      ? { ...next.hooks }
      : {};
  const existing = Array.isArray(hooks.PreToolUse) ? hooks.PreToolUse : [];
  const hookDefinition = {
    type: "command",
    command,
    timeout: 30,
  };
  let inserted = false;
  const merged = [];
  for (const group of existing) {
    if (!group || typeof group !== "object" || Array.isArray(group)) {
      merged.push(group);
      continue;
    }
    const groupHooks = Array.isArray(group.hooks) ? group.hooks : [];
    const filteredHooks = groupHooks.filter(
      (hook) => !isSentinelayerClaudeGuardHook(hook),
    );
    if (normalizeString(group.matcher) === CLAUDE_HOOK_MATCHER && !inserted) {
      filteredHooks.push(hookDefinition);
      inserted = true;
    }
    if (filteredHooks.length > 0 || !groupHooks.some(isSentinelayerClaudeGuardHook)) {
      merged.push({
        ...group,
        hooks: filteredHooks,
      });
    }
  }
  if (!inserted) {
    merged.push({
      matcher: CLAUDE_HOOK_MATCHER,
      hooks: [hookDefinition],
    });
  }
  hooks.PreToolUse = merged;
  next.hooks = hooks;
  return next;
}

function mergeVsCodeTasks(tasksDocument, { sessionId, agentId }) {
  const next = {
    ...(tasksDocument && typeof tasksDocument === "object" ? tasksDocument : {}),
    version: normalizeString(tasksDocument?.version) || "2.0.0",
  };
  const existingTasks = Array.isArray(next.tasks) ? next.tasks : [];
  const retainedTasks = existingTasks.filter(
    (task) =>
      ![VSCODE_GUARD_TASK_LABEL, VSCODE_RENEW_TASK_LABEL].includes(
        normalizeString(task?.label),
      ),
  );
  retainedTasks.push(
    {
      label: VSCODE_GUARD_TASK_LABEL,
      type: "process",
      command: "sl",
      args: [
        "session",
        "guard",
        sessionId,
        "--agent",
        agentId,
        "--path",
        "${workspaceFolder}",
        "--json",
        "--",
        "${file}",
      ],
      problemMatcher: [],
      presentation: {
        reveal: "silent",
        close: true,
      },
    },
    {
      label: VSCODE_RENEW_TASK_LABEL,
      type: "process",
      command: "sl",
      args: [
        "session",
        "renew",
        sessionId,
        "--agent",
        agentId,
        "--path",
        "${workspaceFolder}",
        "--json",
        "--",
        "${file}",
      ],
      problemMatcher: [],
    },
  );
  next.tasks = retainedTasks;

  const existingInputs = Array.isArray(next.inputs) ? next.inputs : [];
  next.inputs = existingInputs.filter(
    (input) => normalizeString(input?.id) !== VSCODE_GUARD_INPUT_ID,
  );
  return next;
}

function posixGuardScript({ sessionId, agentId }) {
  return `#!/usr/bin/env sh
set -eu
SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
WORKSPACE_ROOT=$(CDPATH= cd -- "$SCRIPT_DIR/../.." && pwd)
exec sl session guard ${sessionId} --agent ${agentId} --path "$WORKSPACE_ROOT" --json -- "$@"
`;
}

function powershellGuardScript({ sessionId, agentId }) {
  return `$ErrorActionPreference = "Stop"
$WorkspaceRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot "..\\..")).Path
$SlCommand = (Get-Command "sl" -CommandType Application -ErrorAction Stop | Select-Object -First 1).Source
& $SlCommand session guard ${sessionId} --agent ${agentId} --path $WorkspaceRoot --json -- @args
exit $LASTEXITCODE
`;
}

function posixGuardedExecScript({ sessionId, agentId }) {
  return `#!/usr/bin/env sh
set -eu
if [ "$#" -lt 3 ] || [ "$2" != "--" ]; then
  echo "usage: file-lease-exec.sh <target-file> -- <command> [args...]" >&2
  exit 64
fi
TARGET_FILE=$1
shift 2
SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
WORKSPACE_ROOT=$(CDPATH= cd -- "$SCRIPT_DIR/../.." && pwd)
sl session guard ${sessionId} --agent ${agentId} --path "$WORKSPACE_ROOT" --json -- "$TARGET_FILE" >/dev/null
exec "$@"
`;
}

function powershellGuardedExecScript({ sessionId, agentId }) {
  return `$ErrorActionPreference = "Stop"
if ($args.Count -lt 3 -or $args[1] -ne "--") {
  [Console]::Error.WriteLine("usage: file-lease-exec.ps1 <target-file> -- <command> [args...]")
  exit 64
}
$TargetFile = $args[0]
$Command = $args[2]
$CommandArgs = if ($args.Count -gt 3) { $args[3..($args.Count - 1)] } else { @() }
$WorkspaceRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot "..\\..")).Path
$SlCommand = (Get-Command "sl" -CommandType Application -ErrorAction Stop | Select-Object -First 1).Source
& $SlCommand session guard ${sessionId} --agent ${agentId} --path $WorkspaceRoot --json -- $TargetFile | Out-Null
if ($LASTEXITCODE -ne 0) {
  exit $LASTEXITCODE
}
& $Command @CommandArgs
exit $LASTEXITCODE
`;
}

export async function installFileLeaseIntegrations(
  sessionId,
  agentId,
  { targetPath = process.cwd() } = {},
) {
  const normalizedSessionId = normalizeInstallSessionId(sessionId);
  const normalizedAgentId = normalizeInstallAgentId(agentId);
  const workspaceRoot = await fsp.realpath(path.resolve(String(targetPath || ".")));
  const claudeSettingsPath = path.join(
    workspaceRoot,
    ".claude",
    "settings.local.json",
  );
  const vscodeTasksPath = path.join(workspaceRoot, ".vscode", "tasks.json");
  const enforcementConfigPath = path.join(
    workspaceRoot,
    ".sentinelayer",
    "file-lease-enforcement.json",
  );
  const posixScriptPath = path.join(
    workspaceRoot,
    ".sentinelayer",
    "hooks",
    "file-lease-guard.sh",
  );
  const powershellScriptPath = path.join(
    workspaceRoot,
    ".sentinelayer",
    "hooks",
    "file-lease-guard.ps1",
  );
  const posixExecScriptPath = path.join(
    workspaceRoot,
    ".sentinelayer",
    "hooks",
    "file-lease-exec.sh",
  );
  const powershellExecScriptPath = path.join(
    workspaceRoot,
    ".sentinelayer",
    "hooks",
    "file-lease-exec.ps1",
  );

  const claudeSettings = await readJsonObject(claudeSettingsPath);
  const vscodeTasks = await readJsonObject(vscodeTasksPath);
  const hookCommand =
    `sl session guard-hook ${normalizedSessionId} ` +
    `--agent ${normalizedAgentId} --path .`;
  const mergedClaudeSettings = mergeClaudeHookSettings(
    claudeSettings,
    hookCommand,
  );
  const mergedVsCodeTasks = mergeVsCodeTasks(vscodeTasks, {
    sessionId: normalizedSessionId,
    agentId: normalizedAgentId,
  });
  const enforcementConfig = {
    schemaVersion: FILE_LEASE_ENFORCEMENT_SCHEMA_VERSION,
    authority: "sentinelayer-api",
    localConfigIsAuthority: false,
    sessionId: normalizedSessionId,
    holderId: normalizedAgentId,
    installedAt: new Date().toISOString(),
    integrations: {
      claudePreToolUse: true,
      terminalPreflightScripts: true,
      terminalGuardedExecScripts: true,
      vscodePreflightTasks: true,
      vscodeNativeSaveBlocking: false,
    },
    securityBoundary: {
      rawShellCanBypass: true,
      sameOsUserCanReadCapabilityCache: true,
      hardIsolationRequiresSeparateOsUsersOrContainers: true,
    },
  };

  await writeFileAtomic(
    claudeSettingsPath,
    `${JSON.stringify(mergedClaudeSettings, null, 2)}\n`,
    { mode: 0o600 },
  );
  await writeFileAtomic(
    vscodeTasksPath,
    `${JSON.stringify(mergedVsCodeTasks, null, 2)}\n`,
    { mode: 0o644 },
  );
  await writeFileAtomic(
    enforcementConfigPath,
    `${JSON.stringify(enforcementConfig, null, 2)}\n`,
    { mode: 0o600 },
  );
  await writeFileAtomic(
    posixScriptPath,
    posixGuardScript({
      sessionId: normalizedSessionId,
      agentId: normalizedAgentId,
    }),
    { mode: 0o700 },
  );
  await writeFileAtomic(
    posixExecScriptPath,
    posixGuardedExecScript({
      sessionId: normalizedSessionId,
      agentId: normalizedAgentId,
    }),
    { mode: 0o700 },
  );
  await writeFileAtomic(
    powershellExecScriptPath,
    powershellGuardedExecScript({
      sessionId: normalizedSessionId,
      agentId: normalizedAgentId,
    }),
    { mode: 0o700 },
  );
  await writeFileAtomic(
    powershellScriptPath,
    powershellGuardScript({
      sessionId: normalizedSessionId,
      agentId: normalizedAgentId,
    }),
    { mode: 0o700 },
  );

  return {
    ok: true,
    sessionId: normalizedSessionId,
    agentId: normalizedAgentId,
    workspaceRoot,
    files: {
      claudeSettingsPath,
      vscodeTasksPath,
      enforcementConfigPath,
      posixScriptPath,
      powershellScriptPath,
      posixExecScriptPath,
      powershellExecScriptPath,
    },
    enforcement: {
      claudeEditsBlockedPreToolUse: true,
      terminalScriptBlocksOnGuardExit: true,
      terminalGuardedExecChecksImmediatelyBeforeSpawn: true,
      vscodeTaskBlocksDependentTasks: true,
      vscodeNativeSaveBlocking: false,
    },
    limitations: [
      "VS Code does not expose a reliable native-save cancellation hook; use the guard task as a preflight or a guarded task dependency.",
      "Processes running as the same OS user can bypass hooks or read local capability material.",
      "Hard enforcement against raw-shell writes requires separate OS users, containers, or a mediated filesystem.",
    ],
  };
}

async function readHookInput(stream = process.stdin) {
  let totalBytes = 0;
  const chunks = [];
  for await (const chunk of stream) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
    totalBytes += buffer.length;
    if (totalBytes > MAX_HOOK_INPUT_BYTES) {
      throw new Error("Claude hook input exceeded the 1 MiB safety limit.");
    }
    chunks.push(buffer);
  }
  const raw = Buffer.concat(chunks).toString("utf-8").trim();
  if (!raw) {
    throw new Error("Claude hook input is required.");
  }
  try {
    return JSON.parse(raw);
  } catch (error) {
    throw new Error("Claude hook input was not valid JSON.", { cause: error });
  }
}

function hookFilePath(payload) {
  const toolInput =
    payload?.tool_input && typeof payload.tool_input === "object"
      ? payload.tool_input
      : {};
  return normalizeString(
    toolInput.file_path ||
      toolInput.notebook_path ||
      toolInput.path,
  );
}

export function safeFileLeaseErrorMessage(error) {
  return (
    normalizeString(error?.message)
      .replace(/\bbearer\s+[A-Za-z0-9._~+/=-]+/giu, "bearer [REDACTED]")
      .replace(
        /\b(?:leaseToken|authorization|token|secret|password|api[_-]?key|access[_-]?token|refresh[_-]?token|id[_-]?token)\b["']?\s*[:=]\s*["']?[^"'\s,;}\]]+["']?/giu,
        "credential=[REDACTED]",
      )
      .replace(/\b[A-Za-z0-9_-]{43,128}\b/gu, "[REDACTED]")
      .slice(0, 500) || "authoritative file-lease guard failed"
  );
}

function denialSummary(result) {
  const denials = Array.isArray(result?.denials) ? result.denials : [];
  if (denials.length === 0) {
    return "authoritative guard did not grant the edit";
  }
  return denials
    .map((denial) => {
      const file = normalizeString(denial?.path) || "(unknown path)";
      const reason = normalizeString(denial?.reason) || "denied";
      const holder = normalizeString(
        denial?.lease?.holderId || denial?.lease?.agentId,
      );
      return `${file}: ${reason}${holder ? ` (held by ${holder})` : ""}`;
    })
    .join("; ");
}

export async function runFileLeaseGuardHook({
  sessionId,
  agentId,
  targetPath = process.cwd(),
  inputPayload = null,
  inputStream = process.stdin,
  errorStream = process.stderr,
  guard = guardFileLeases,
} = {}) {
  try {
    const payload = inputPayload || (await readHookInput(inputStream));
    const filePath = hookFilePath(payload);
    if (!filePath) {
      throw new Error("Claude edit hook did not include a target file path.");
    }
    const result = await guard(sessionId, agentId, [filePath], {
      targetPath,
    });
    if (result?.authoritative !== true) {
      throw new Error(
        "File-lease guard did not return an authoritative API decision.",
      );
    }
    if (!result?.allowed) {
      const message = denialSummary(result);
      errorStream.write(`[SentinelLayer] Edit blocked: ${message}\n`);
      return { exitCode: 2, allowed: false, result };
    }
    return { exitCode: 0, allowed: true, result };
  } catch (error) {
    const message = safeFileLeaseErrorMessage(error);
    errorStream.write(`[SentinelLayer] Edit blocked: ${message}\n`);
    return {
      exitCode: 2,
      allowed: false,
      error: {
        code: normalizeString(error?.code) || "FILE_LEASE_GUARD_FAILED",
        message,
      },
    };
  }
}

export {
  CLAUDE_HOOK_MATCHER,
  VSCODE_GUARD_TASK_LABEL,
  VSCODE_RENEW_TASK_LABEL,
  mergeClaudeHookSettings,
  mergeVsCodeTasks,
};
