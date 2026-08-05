import { createHash, randomUUID } from "node:crypto";
import fsp from "node:fs/promises";
import path from "node:path";
import process from "node:process";

import {
  guardFileLeases,
  listFileLocks,
  releaseFileLocksForAgent,
} from "./file-locks.js";

const FILE_LEASE_ENFORCEMENT_SCHEMA_VERSION = "2.0.0";
const FILE_LEASE_ENFORCEMENT_MANAGER = "sentinelayer-cli";
const FILE_LEASE_ENFORCEMENT_FEATURE = "session-file-lease-guard";
const MANAGED_SCRIPT_PATHS = Object.freeze([
  ".sentinelayer/hooks/file-lease-guard.sh",
  ".sentinelayer/hooks/file-lease-guard.ps1",
  ".sentinelayer/hooks/file-lease-exec.sh",
  ".sentinelayer/hooks/file-lease-exec.ps1",
]);
const CLAUDE_HOOK_MATCHER = "Edit|Write|NotebookEdit";
const VSCODE_GUARD_TASK_LABEL = "SentinelLayer: Guard current file lease";
const VSCODE_RENEW_TASK_LABEL = "SentinelLayer: Renew current file lease";
const MAX_HOOK_INPUT_BYTES = 1_048_576;
const SAFE_SESSION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const SAFE_AGENT_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,31}$/;

function normalizeString(value) {
  return String(value || "").trim();
}

function canonicalJson(value) {
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
  }
  if (value && typeof value === "object") {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function sha256(value) {
  return createHash("sha256").update(String(value), "utf-8").digest("hex");
}

function valueFingerprint(value) {
  return sha256(canonicalJson(value));
}

function workspaceRelative(workspaceRoot, filePath) {
  return path.relative(workspaceRoot, filePath).replaceAll("\\", "/");
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

async function lstatIfPresent(filePath) {
  try {
    return await fsp.lstat(filePath);
  } catch (error) {
    if (error && typeof error === "object" && error.code === "ENOENT") {
      return null;
    }
    throw error;
  }
}

async function assertManagedPathContained(workspaceRoot, targetPath) {
  const relativePath = path.relative(workspaceRoot, targetPath);
  if (
    !relativePath
    || relativePath === ".."
    || relativePath.startsWith(`..${path.sep}`)
    || path.isAbsolute(relativePath)
  ) {
    throw new Error(
      `Managed integration path is outside the workspace: ${targetPath}.`,
    );
  }
  const segments = relativePath.split(path.sep).filter(Boolean);
  let currentPath = workspaceRoot;
  for (let index = 0; index < segments.length; index += 1) {
    currentPath = path.join(currentPath, segments[index]);
    const stat = await lstatIfPresent(currentPath);
    if (!stat) break;
    if (stat.isSymbolicLink()) {
      throw new Error(
        `Managed integration path uses symbolic-link or junction indirection: ${currentPath}; no integration files were changed.`,
      );
    }
    if (index < segments.length - 1 && !stat.isDirectory()) {
      throw new Error(
        `Managed integration ancestor is not a directory: ${currentPath}; no integration files were changed.`,
      );
    }
  }
}

async function acquireIntegrationMutex(workspaceRoot) {
  const mutexPath = path.join(
    workspaceRoot,
    ".sentinelayer",
    "file-lease-integration.lock",
  );
  const mutexDirectory = path.dirname(mutexPath);
  await assertManagedPathContained(workspaceRoot, mutexPath);
  const mutexDirectoryExisted = (await lstatIfPresent(mutexDirectory)) !== null;
  await fsp.mkdir(mutexDirectory, { recursive: true });
  let handle;
  try {
    handle = await fsp.open(mutexPath, "wx", 0o600);
    await handle.writeFile(
      `${JSON.stringify({
        pid: process.pid,
        acquiredAt: new Date().toISOString(),
      })}\n`,
      "utf-8",
    );
  } catch (error) {
    await handle?.close().catch(() => {});
    if (error && typeof error === "object" && error.code === "EEXIST") {
      throw new Error(
        "Another SentinelLayer file-lease integration change is in progress; no integration files were changed.",
      );
    }
    throw error;
  }
  return async () => {
    await handle.close().catch(() => {});
    await fsp.rm(mutexPath, { force: true }).catch(() => {});
    if (!mutexDirectoryExisted) {
      await fsp.rmdir(mutexDirectory).catch(() => {});
    }
  };
}

async function statIfPresent(filePath) {
  try {
    return await fsp.stat(filePath);
  } catch (error) {
    if (error && typeof error === "object" && error.code === "ENOENT") {
      return null;
    }
    throw error;
  }
}

async function snapshotFile(filePath) {
  const stat = await statIfPresent(filePath);
  if (!stat) return { exists: false, contents: null, mode: null };
  if (!stat.isFile()) {
    throw new Error(
      `Managed integration target is not a regular file: ${filePath}; no integration files were changed.`,
    );
  }
  return {
    exists: true,
    contents: await fsp.readFile(filePath),
    mode: stat.mode & 0o777,
  };
}

async function restoreSnapshots(snapshots) {
  for (const [filePath, snapshot] of [...snapshots.entries()].reverse()) {
    if (snapshot.exists) {
      await writeFileAtomic(filePath, snapshot.contents, {
        mode: snapshot.mode || 0o600,
      });
    } else {
      await fsp.rm(filePath, { force: true });
    }
  }
}

function isSentinelayerClaudeGuardHook(hook) {
  const command = normalizeString(hook?.command);
  return (
    hook?.type === "command" &&
    /(?:^|\s)sl\s+session\s+guard-hook(?:\s|$)/u.test(command)
  );
}

function managedClaudeHookDefinition(command) {
  return {
    type: "command",
    command,
    timeout: 30,
  };
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
  const hookDefinition = managedClaudeHookDefinition(command);
  for (const group of existing) {
    for (const hook of Array.isArray(group?.hooks) ? group.hooks : []) {
      if (
        isSentinelayerClaudeGuardHook(hook)
        && canonicalJson(hook) !== canonicalJson(hookDefinition)
      ) {
        throw new Error(
          "An unowned SentinelLayer Claude guard hook already exists; no integration files were changed.",
        );
      }
    }
  }
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
  const managedTasks = managedVsCodeTaskDefinitions({ sessionId, agentId });
  const existingTasks = Array.isArray(next.tasks) ? next.tasks : [];
  for (const task of existingTasks) {
    const desired = managedTasks.find(
      (candidate) => candidate.label === normalizeString(task?.label),
    );
    if (desired && canonicalJson(task) !== canonicalJson(desired)) {
      throw new Error(
        `An unowned VS Code task named "${desired.label}" already exists; no integration files were changed.`,
      );
    }
  }
  const retainedTasks = existingTasks.filter(
    (task) => !managedTasks.some(
      (candidate) => canonicalJson(task) === canonicalJson(candidate),
    ),
  );
  retainedTasks.push(...managedTasks);
  next.tasks = retainedTasks;
  return next;
}

function managedVsCodeTaskDefinitions({ sessionId, agentId }) {
  return [
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
  ];
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
GUARD_STATUS=0
GUARD_OUTPUT=$(sl session guard ${sessionId} --agent ${agentId} --path "$WORKSPACE_ROOT" --json -- "$TARGET_FILE" 2>&1) || GUARD_STATUS=$?
if [ "$GUARD_STATUS" -ne 0 ]; then
  printf '%s\\n' "$GUARD_OUTPUT" >&2
  exit "$GUARD_STATUS"
fi
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
$GuardOutput = @(& $SlCommand session guard ${sessionId} --agent ${agentId} --path $WorkspaceRoot --json -- $TargetFile 2>&1)
$GuardStatus = $LASTEXITCODE
if ($GuardStatus -ne 0) {
  foreach ($Line in $GuardOutput) {
    [Console]::Error.WriteLine([string]$Line)
  }
  exit $GuardStatus
}
& $Command @CommandArgs
exit $LASTEXITCODE
`;
}

export async function installFileLeaseIntegrations(
  sessionId,
  agentId,
  {
    targetPath = process.cwd(),
    listLeases = listFileLocks,
  } = {},
) {
  const normalizedSessionId = normalizeInstallSessionId(sessionId);
  const normalizedAgentId = normalizeInstallAgentId(agentId);
  const workspaceRoot = await fsp.realpath(path.resolve(String(targetPath || ".")));
  for (const relativePath of [
    ".claude/settings.local.json",
    ".vscode/tasks.json",
    ".sentinelayer/file-lease-enforcement.json",
    ...MANAGED_SCRIPT_PATHS,
  ]) {
    await assertManagedPathContained(
      workspaceRoot,
      path.resolve(workspaceRoot, relativePath),
    );
  }
  const releaseMutex = await acquireIntegrationMutex(workspaceRoot);
  try {
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
  const previousEnforcementConfig = await readJsonObject(enforcementConfigPath);
  const previousEnforcementExists =
    (await statIfPresent(enforcementConfigPath)) !== null;
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
  const posixScript = posixGuardScript({
    sessionId: normalizedSessionId,
    agentId: normalizedAgentId,
  });
  const powershellScript = powershellGuardScript({
    sessionId: normalizedSessionId,
    agentId: normalizedAgentId,
  });
  const posixExecScript = posixGuardedExecScript({
    sessionId: normalizedSessionId,
    agentId: normalizedAgentId,
  });
  const powershellExecScript = powershellGuardedExecScript({
    sessionId: normalizedSessionId,
    agentId: normalizedAgentId,
  });
  const scriptTargets = new Map([
    [posixScriptPath, posixScript],
    [powershellScriptPath, powershellScript],
    [posixExecScriptPath, posixExecScript],
    [powershellExecScriptPath, powershellExecScript],
  ]);
  for (const parentPath of new Set([
    path.dirname(claudeSettingsPath),
    path.dirname(vscodeTasksPath),
    path.dirname(enforcementConfigPath),
    path.dirname(posixScriptPath),
  ])) {
    const parentStat = await statIfPresent(parentPath);
    if (parentStat && !parentStat.isDirectory()) {
      throw new Error(
        `Integration parent path is not a directory: ${parentPath}; no integration files were changed.`,
      );
    }
  }
  const previousManifestOwned =
    previousEnforcementConfig?.schemaVersion === FILE_LEASE_ENFORCEMENT_SCHEMA_VERSION
    && previousEnforcementConfig?.managedBy === FILE_LEASE_ENFORCEMENT_MANAGER
    && previousEnforcementConfig?.feature === FILE_LEASE_ENFORCEMENT_FEATURE
    && previousEnforcementConfig?.sessionId === normalizedSessionId
    && previousEnforcementConfig?.holderId === normalizedAgentId;
  const previousManagedFileArtifacts = Array.isArray(
    previousEnforcementConfig?.managedArtifacts?.files,
  )
    ? previousEnforcementConfig.managedArtifacts.files
    : [];
  const previousManagedFiles = new Map(
    previousManagedFileArtifacts.map((artifact) => [
        normalizeString(artifact?.path).replaceAll("\\", "/"),
        normalizeString(artifact?.sha256),
      ]),
  );
  if (previousEnforcementExists) {
    const previousManagedFilePaths = [...previousManagedFiles.keys()];
    const exactPreviousFileSet =
      previousManifestOwned
      && previousManagedFileArtifacts.length === MANAGED_SCRIPT_PATHS.length
      && previousManagedFilePaths.length === MANAGED_SCRIPT_PATHS.length
      && MANAGED_SCRIPT_PATHS.every((expectedPath) =>
        previousManagedFiles.has(expectedPath))
      && [...previousManagedFiles.values()].every((digest) =>
        /^[a-f0-9]{64}$/u.test(digest));
    const previousHook = previousEnforcementConfig?.managedArtifacts?.claudeHook;
    const expectedHook = managedClaudeHookDefinition(hookCommand);
    const exactPreviousHook =
      normalizeString(previousHook?.command) === hookCommand
      && normalizeString(previousHook?.sha256) === valueFingerprint(expectedHook);
    const expectedTasks = managedVsCodeTaskDefinitions({
      sessionId: normalizedSessionId,
      agentId: normalizedAgentId,
    });
    const previousTasks = Array.isArray(
      previousEnforcementConfig?.managedArtifacts?.vscodeTasks,
    )
      ? previousEnforcementConfig.managedArtifacts.vscodeTasks
      : [];
    const previousTaskMap = new Map(
      previousTasks.map((artifact) => [
        normalizeString(artifact?.label),
        normalizeString(artifact?.sha256),
      ]),
    );
    const exactPreviousTasks =
      previousTasks.length === expectedTasks.length
      && previousTaskMap.size === expectedTasks.length
      && expectedTasks.every((task) =>
        previousTaskMap.get(task.label) === valueFingerprint(task));
    if (
      !exactPreviousFileSet
      || !exactPreviousHook
      || !exactPreviousTasks
      || !["installed", "uninstalled"].includes(
        normalizeString(previousEnforcementConfig?.state),
      )
    ) {
      throw new Error(
        "An unowned or invalid file-lease enforcement manifest already exists; no integration files were changed.",
      );
    }
  }
  for (const [scriptPath] of scriptTargets) {
    const existingContents = await readTextIfPresent(scriptPath);
    if (existingContents === null) continue;
    const relativePath = workspaceRelative(workspaceRoot, scriptPath);
    if (
      !previousManifestOwned
      || previousManagedFiles.get(relativePath) !== sha256(existingContents)
    ) {
      throw new Error(
        `An unowned generated script target already exists at ${relativePath}; no integration files were changed.`,
      );
    }
  }
  // Fail before touching editor configuration when the API-backed authority is
  // not actually live. A local hook without its server authority would block
  // edits while providing no valid coordination guarantee.
  await listLeases(normalizedSessionId, { targetPath: workspaceRoot });
  const managedClaudeHook = mergedClaudeSettings.hooks.PreToolUse
    .flatMap((group) => Array.isArray(group?.hooks) ? group.hooks : [])
    .find((hook) => normalizeString(hook?.command) === hookCommand);
  const managedVsCodeTasks = mergedVsCodeTasks.tasks.filter((task) =>
    [VSCODE_GUARD_TASK_LABEL, VSCODE_RENEW_TASK_LABEL].includes(
      normalizeString(task?.label),
    ));
  const reusableInstallId =
    previousEnforcementConfig?.managedBy === FILE_LEASE_ENFORCEMENT_MANAGER
    && previousEnforcementConfig?.feature === FILE_LEASE_ENFORCEMENT_FEATURE
    && previousEnforcementConfig?.sessionId === normalizedSessionId
    && previousEnforcementConfig?.holderId === normalizedAgentId
      ? normalizeString(previousEnforcementConfig.installId)
      : "";
  const enforcementConfig = {
    schemaVersion: FILE_LEASE_ENFORCEMENT_SCHEMA_VERSION,
    managedBy: FILE_LEASE_ENFORCEMENT_MANAGER,
    feature: FILE_LEASE_ENFORCEMENT_FEATURE,
    installId: reusableInstallId || randomUUID(),
    state: "installed",
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
    managedArtifacts: {
      claudeHook: {
        command: hookCommand,
        sha256: valueFingerprint(managedClaudeHook),
      },
      vscodeTasks: managedVsCodeTasks.map((task) => ({
        label: normalizeString(task.label),
        sha256: valueFingerprint(task),
      })),
      files: [
        { path: workspaceRelative(workspaceRoot, posixScriptPath), sha256: sha256(posixScript) },
        { path: workspaceRelative(workspaceRoot, powershellScriptPath), sha256: sha256(powershellScript) },
        { path: workspaceRelative(workspaceRoot, posixExecScriptPath), sha256: sha256(posixExecScript) },
        { path: workspaceRelative(workspaceRoot, powershellExecScriptPath), sha256: sha256(powershellExecScript) },
      ],
    },
  };

  const mutationTargets = [
    ...scriptTargets.keys(),
    claudeSettingsPath,
    vscodeTasksPath,
    enforcementConfigPath,
  ];
  const snapshots = new Map();
  for (const filePath of mutationTargets) {
    snapshots.set(filePath, await snapshotFile(filePath));
  }
  try {
    // Scripts become available before editor activation; the ownership
    // manifest is committed last. Any failure restores every exact prior byte.
    for (const [scriptPath, contents] of scriptTargets) {
      await writeFileAtomic(scriptPath, contents, { mode: 0o700 });
    }
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
  } catch (error) {
    await restoreSnapshots(snapshots);
    throw error;
  }

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
  } finally {
    await releaseMutex();
  }
}

function removeManagedClaudeHook(settings, artifact) {
  const next = structuredClone(settings);
  const groups = Array.isArray(next?.hooks?.PreToolUse)
    ? next.hooks.PreToolUse
    : [];
  let removed = false;
  let residual = false;
  for (const group of groups) {
    if (!Array.isArray(group?.hooks)) continue;
    group.hooks = group.hooks.filter((hook) => {
      if (normalizeString(hook?.command) !== normalizeString(artifact?.command)) {
        return true;
      }
      if (valueFingerprint(hook) !== normalizeString(artifact?.sha256)) {
        residual = true;
        return true;
      }
      removed = true;
      return false;
    });
  }
  return { next, removed, residual };
}

function removeManagedVsCodeTasks(tasksDocument, artifacts) {
  const next = structuredClone(tasksDocument);
  const expected = new Map(
    (Array.isArray(artifacts) ? artifacts : []).map((artifact) => [
      normalizeString(artifact?.label),
      normalizeString(artifact?.sha256),
    ]),
  );
  let removed = 0;
  const residuals = [];
  next.tasks = (Array.isArray(next.tasks) ? next.tasks : []).filter((task) => {
    const label = normalizeString(task?.label);
    if (!expected.has(label)) return true;
    if (valueFingerprint(task) !== expected.get(label)) {
      residuals.push(label);
      return true;
    }
    removed += 1;
    return false;
  });
  return { next, removed, residuals };
}

async function readTextIfPresent(filePath) {
  try {
    return await fsp.readFile(filePath, "utf-8");
  } catch (error) {
    if (error && typeof error === "object" && error.code === "ENOENT") {
      return null;
    }
    throw error;
  }
}

export async function uninstallFileLeaseIntegrations(
  sessionId,
  agentId,
  {
    targetPath = process.cwd(),
    listLeases = listFileLocks,
    releaseAgentLeases = releaseFileLocksForAgent,
  } = {},
) {
  const normalizedSessionId = normalizeInstallSessionId(sessionId);
  const normalizedAgentId = normalizeInstallAgentId(agentId);
  const workspaceRoot = await fsp.realpath(path.resolve(String(targetPath || ".")));
  for (const relativePath of [
    ".claude/settings.local.json",
    ".vscode/tasks.json",
    ".sentinelayer/file-lease-enforcement.json",
    ...MANAGED_SCRIPT_PATHS,
  ]) {
    await assertManagedPathContained(
      workspaceRoot,
      path.resolve(workspaceRoot, relativePath),
    );
  }
  const releaseMutex = await acquireIntegrationMutex(workspaceRoot);
  try {
  const enforcementConfigPath = path.join(
    workspaceRoot,
    ".sentinelayer",
    "file-lease-enforcement.json",
  );
  const manifest = await readJsonObject(enforcementConfigPath);
  if (
    manifest?.schemaVersion !== FILE_LEASE_ENFORCEMENT_SCHEMA_VERSION
    || manifest?.managedBy !== FILE_LEASE_ENFORCEMENT_MANAGER
    || manifest?.feature !== FILE_LEASE_ENFORCEMENT_FEATURE
    || manifest?.sessionId !== normalizedSessionId
    || manifest?.holderId !== normalizedAgentId
    || !normalizeString(manifest?.installId)
  ) {
    throw new Error(
      "A matching SentinelLayer file-lease ownership manifest is required; no integration files were changed.",
    );
  }
  const managedFiles = Array.isArray(manifest?.managedArtifacts?.files)
    ? manifest.managedArtifacts.files
    : [];
  const managedFilePaths = managedFiles.map((artifact) =>
    normalizeString(artifact?.path).replaceAll("\\", "/"));
  const exactManagedPathSet =
    managedFilePaths.length === MANAGED_SCRIPT_PATHS.length
    && new Set(managedFilePaths).size === MANAGED_SCRIPT_PATHS.length
    && MANAGED_SCRIPT_PATHS.every((expectedPath) =>
      managedFilePaths.includes(expectedPath))
    && managedFiles.every((artifact) =>
      /^[a-f0-9]{64}$/u.test(normalizeString(artifact?.sha256)));
  if (!exactManagedPathSet) {
    throw new Error(
      "The SentinelLayer file-lease ownership manifest has an invalid managed-script set; no integration files were changed.",
    );
  }
  const expectedHookCommand =
    `sl session guard-hook ${normalizedSessionId} ` +
    `--agent ${normalizedAgentId} --path .`;
  const expectedHook = managedClaudeHookDefinition(expectedHookCommand);
  const manifestHook = manifest?.managedArtifacts?.claudeHook;
  if (
    normalizeString(manifestHook?.command) !== expectedHookCommand
    || normalizeString(manifestHook?.sha256) !== valueFingerprint(expectedHook)
  ) {
    throw new Error(
      "The SentinelLayer file-lease ownership manifest has an invalid Claude hook fingerprint; no integration files were changed.",
    );
  }
  const expectedTasks = managedVsCodeTaskDefinitions({
    sessionId: normalizedSessionId,
    agentId: normalizedAgentId,
  });
  const manifestTasks = Array.isArray(manifest?.managedArtifacts?.vscodeTasks)
    ? manifest.managedArtifacts.vscodeTasks
    : [];
  const manifestTaskMap = new Map(
    manifestTasks.map((artifact) => [
      normalizeString(artifact?.label),
      normalizeString(artifact?.sha256),
    ]),
  );
  const exactManagedTaskSet =
    manifestTasks.length === expectedTasks.length
    && manifestTaskMap.size === expectedTasks.length
    && expectedTasks.every((task) =>
      manifestTaskMap.get(task.label) === valueFingerprint(task));
  if (!exactManagedTaskSet) {
    throw new Error(
      "The SentinelLayer file-lease ownership manifest has an invalid VS Code task set; no integration files were changed.",
    );
  }

  const release = await releaseAgentLeases(
    normalizedSessionId,
    normalizedAgentId,
    {
      reason: "guard_uninstall",
      targetPath: workspaceRoot,
    },
  );
  if (
    release?.authority?.authoritative !== true
    || release?.failures?.length > 0
    || release?.unresolvedKnown !== true
    || release?.unresolved?.length > 0
  ) {
    return {
      ok: false,
      uninstalled: false,
      reason: "lease_release_incomplete",
      sessionId: normalizedSessionId,
      agentId: normalizedAgentId,
      release,
      activeLeases: release?.unresolved || [],
      residuals: [],
    };
  }
  const activeLeases = await listLeases(normalizedSessionId, {
    targetPath: workspaceRoot,
  });
  if (activeLeases.length > 0) {
    return {
      ok: false,
      uninstalled: false,
      reason: "active_session_leases",
      sessionId: normalizedSessionId,
      agentId: normalizedAgentId,
      release,
      activeLeases,
      residuals: [],
    };
  }

  const claudeSettingsPath = path.join(
    workspaceRoot,
    ".claude",
    "settings.local.json",
  );
  const vscodeTasksPath = path.join(workspaceRoot, ".vscode", "tasks.json");
  const claudeSettings = await readJsonObject(claudeSettingsPath);
  const vscodeTasks = await readJsonObject(vscodeTasksPath);
  const claudeRemoval = removeManagedClaudeHook(
    claudeSettings,
    manifest?.managedArtifacts?.claudeHook,
  );
  const vscodeRemoval = removeManagedVsCodeTasks(
    vscodeTasks,
    manifest?.managedArtifacts?.vscodeTasks,
  );
  const residuals = [];
  if (claudeRemoval.residual) {
    residuals.push({
      artifact: "claudeHook",
      reason: "fingerprint_mismatch",
    });
  }
  for (const label of vscodeRemoval.residuals) {
    residuals.push({
      artifact: "vscodeTask",
      label,
      reason: "fingerprint_mismatch",
    });
  }

  const removableFiles = [];
  for (const artifact of managedFiles) {
    const relativePath = normalizeString(artifact?.path).replaceAll("\\", "/");
    const resolvedPath = path.resolve(workspaceRoot, relativePath);
    await assertManagedPathContained(workspaceRoot, resolvedPath);
    if (
      !relativePath
      || (
        resolvedPath !== workspaceRoot
        && !resolvedPath.startsWith(`${workspaceRoot}${path.sep}`)
      )
    ) {
      residuals.push({
        artifact: "file",
        path: relativePath,
        reason: "path_outside_workspace",
      });
      continue;
    }
    const contents = await readTextIfPresent(resolvedPath);
    if (contents === null) continue;
    if (sha256(contents) !== normalizeString(artifact?.sha256)) {
      residuals.push({
        artifact: "file",
        path: relativePath,
        reason: "fingerprint_mismatch",
      });
      continue;
    }
    removableFiles.push(resolvedPath);
  }

  if (claudeRemoval.removed) {
    await writeFileAtomic(
      claudeSettingsPath,
      `${JSON.stringify(claudeRemoval.next, null, 2)}\n`,
      { mode: 0o600 },
    );
  }
  if (vscodeRemoval.removed > 0) {
    await writeFileAtomic(
      vscodeTasksPath,
      `${JSON.stringify(vscodeRemoval.next, null, 2)}\n`,
      { mode: 0o644 },
    );
  }
  for (const removablePath of removableFiles) {
    await assertManagedPathContained(workspaceRoot, removablePath);
    await fsp.rm(removablePath, { force: true });
  }

  const state = residuals.length > 0 ? "residual" : "uninstalled";
  const completedAt = new Date().toISOString();
  const nextManifest = {
    ...manifest,
    state,
    uninstalledAt: completedAt,
    uninstallResult: {
      removedClaudeHook: claudeRemoval.removed,
      removedVsCodeTasks: vscodeRemoval.removed,
      removedFiles: removableFiles.map((filePath) =>
        workspaceRelative(workspaceRoot, filePath)),
      residuals,
    },
  };
  await writeFileAtomic(
    enforcementConfigPath,
    `${JSON.stringify(nextManifest, null, 2)}\n`,
    { mode: 0o600 },
  );
    return {
    ok: residuals.length === 0,
    uninstalled: residuals.length === 0,
    reason: residuals.length === 0 ? "uninstalled" : "residual_artifacts",
    sessionId: normalizedSessionId,
    agentId: normalizedAgentId,
    release,
    activeLeases: [],
    residuals,
    files: nextManifest.uninstallResult,
    };
  } finally {
    await releaseMutex();
  }
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

export function formatFileLeaseDenialSummary(result) {
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
      const intent = normalizeString(
        denial?.lease?.intent || denial?.lease?.purpose || denial?.lease?.note,
      );
      const expiresAt = normalizeString(
        denial?.lease?.expiresAt
          || denial?.lease?.validUntil
          || denial?.lease?.expires_at
          || denial?.lease?.valid_until,
      );
      const details = [
        holder ? `held by ${holder}` : "",
        intent ? `intent: ${intent}` : "",
        expiresAt ? `expires ${expiresAt}` : "",
      ].filter(Boolean);
      return `${file}: ${reason}${details.length > 0 ? ` (${details.join(", ")})` : ""}`;
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
      const message = formatFileLeaseDenialSummary(result);
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
