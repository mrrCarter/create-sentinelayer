import test from "node:test";
import assert from "node:assert/strict";
import { execFile as execFileCallback } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

import { Command } from "commander";

import { registerSessionCommand } from "../src/commands/session.js";
import {
  CLAUDE_HOOK_MATCHER,
  VSCODE_GUARD_TASK_LABEL,
  VSCODE_RENEW_TASK_LABEL,
  installFileLeaseIntegrations,
  runFileLeaseGuardHook,
  uninstallFileLeaseIntegrations,
} from "../src/session/file-lease-integrations.js";

const execFile = promisify(execFileCallback);

function captureStream() {
  const chunks = [];
  return {
    write(value) {
      chunks.push(String(value));
    },
    text() {
      return chunks.join("");
    },
  };
}

test("Unit file-lease integrations: installer merges Claude and VS Code preflights idempotently", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "sentinelayer-lease-integrations-"));
  try {
    await mkdir(path.join(tempRoot, ".claude"), { recursive: true });
    await mkdir(path.join(tempRoot, ".vscode"), { recursive: true });
    await writeFile(
      path.join(tempRoot, ".claude", "settings.local.json"),
      `${JSON.stringify({
        permissions: { allow: ["Read"] },
        hooks: {
          PreToolUse: [
            {
              matcher: "Bash",
              hooks: [{ type: "command", command: "echo existing-hook" }],
            },
          ],
        },
      }, null, 2)}\n`,
      "utf-8",
    );
    await writeFile(
      path.join(tempRoot, ".vscode", "tasks.json"),
      `{
        // Existing user task must survive JSONC normalization.
        "version": "2.0.0",
        "tasks": [
          {
            "label": "Existing build",
            "type": "shell",
            "command": "npm test",
          },
        ],
      }\n`,
      "utf-8",
    );

    const first = await installFileLeaseIntegrations(
      "sess-editor-guard",
      "codex",
      { targetPath: tempRoot, listLeases: async () => [] },
    );
    const second = await installFileLeaseIntegrations(
      "sess-editor-guard",
      "codex",
      { targetPath: tempRoot, listLeases: async () => [] },
    );

    const claudeSettings = JSON.parse(
      await readFile(first.files.claudeSettingsPath, "utf-8"),
    );
    const vscodeTasks = JSON.parse(
      await readFile(first.files.vscodeTasksPath, "utf-8"),
    );
    const enforcement = JSON.parse(
      await readFile(first.files.enforcementConfigPath, "utf-8"),
    );
    const posixScript = await readFile(first.files.posixScriptPath, "utf-8");
    const powershellScript = await readFile(
      first.files.powershellScriptPath,
      "utf-8",
    );
    const posixExecScript = await readFile(
      first.files.posixExecScriptPath,
      "utf-8",
    );
    const powershellExecScript = await readFile(
      first.files.powershellExecScriptPath,
      "utf-8",
    );

    assert.deepEqual(claudeSettings.permissions, { allow: ["Read"] });
    assert.equal(
      claudeSettings.hooks.PreToolUse.some(
        (group) =>
          group.matcher === "Bash" &&
          group.hooks.some((hook) => hook.command === "echo existing-hook"),
      ),
      true,
    );
    const guardGroups = claudeSettings.hooks.PreToolUse.filter(
      (group) => group.matcher === CLAUDE_HOOK_MATCHER,
    );
    assert.equal(guardGroups.length, 1);
    assert.equal(
      guardGroups[0].hooks.filter((hook) =>
        hook.command.includes("sl session guard-hook"),
      ).length,
      1,
    );
    assert.equal(
      guardGroups[0].hooks[0].command,
      "sl session guard-hook sess-editor-guard --agent codex --path .",
    );

    const labels = vscodeTasks.tasks.map((task) => task.label);
    assert.equal(labels.includes("Existing build"), true);
    assert.equal(
      labels.filter((label) => label === VSCODE_GUARD_TASK_LABEL).length,
      1,
    );
    assert.equal(
      labels.filter((label) => label === VSCODE_RENEW_TASK_LABEL).length,
      1,
    );
    const guardTask = vscodeTasks.tasks.find(
      (task) => task.label === VSCODE_GUARD_TASK_LABEL,
    );
    assert.equal(guardTask.type, "process");
    assert.deepEqual(guardTask.args.slice(0, 3), [
      "session",
      "guard",
      "sess-editor-guard",
    ]);
    assert.equal(guardTask.args.includes("${workspaceFolder}"), true);
    assert.deepEqual(guardTask.args.slice(-2), ["--", "${file}"]);

    assert.equal(enforcement.authority, "sentinelayer-api");
    assert.equal(enforcement.localConfigIsAuthority, false);
    assert.equal(enforcement.integrations.claudePreToolUse, true);
    assert.equal(enforcement.integrations.vscodeNativeSaveBlocking, false);
    assert.equal(enforcement.securityBoundary.rawShellCanBypass, true);
    assert.match(posixScript, /exec sl session guard sess-editor-guard/u);
    assert.match(powershellScript, /\$SlCommand session guard sess-editor-guard/u);
    assert.match(posixExecScript, /sl session guard sess-editor-guard/u);
    assert.match(posixExecScript, /exec "\$@"/u);
    assert.match(powershellExecScript, /\$SlCommand session guard sess-editor-guard/u);
    assert.match(powershellExecScript, /& \$Command @CommandArgs/u);
    assert.equal(second.enforcement.vscodeNativeSaveBlocking, false);
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("Unit file-lease integrations: installer rejects shell metacharacters in hook identity", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "sentinelayer-lease-injection-"));
  try {
    await assert.rejects(
      installFileLeaseIntegrations("sess-ok;whoami", "codex", {
        targetPath: tempRoot,
      }),
      /safe for editor hook commands/u,
    );
    await assert.rejects(
      installFileLeaseIntegrations("sess-ok", "codex && whoami", {
        targetPath: tempRoot,
      }),
      /safe for editor hook commands/u,
    );
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("Unit file-lease integrations: uninstall removes only fingerprinted artifacts and is idempotent", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "sentinelayer-lease-uninstall-"));
  const release = {
    releasedCount: 0,
    released: [],
    failures: [],
    unresolved: [],
    unresolvedKnown: true,
    authority: { ok: true, authoritative: true, code: null },
    events: [],
    expiredEvents: [],
  };
  try {
    await mkdir(path.join(tempRoot, ".claude"), { recursive: true });
    await mkdir(path.join(tempRoot, ".vscode"), { recursive: true });
    await writeFile(
      path.join(tempRoot, ".claude", "settings.local.json"),
      `${JSON.stringify({
        permissions: { allow: ["Read"] },
        hooks: {
          PreToolUse: [
            {
              matcher: "Bash",
              hooks: [{ type: "command", command: "echo keep-me" }],
            },
          ],
        },
      }, null, 2)}\n`,
      "utf-8",
    );
    await writeFile(
      path.join(tempRoot, ".vscode", "tasks.json"),
      `${JSON.stringify({
        version: "2.0.0",
        tasks: [{ label: "Keep me", type: "shell", command: "npm test" }],
      }, null, 2)}\n`,
      "utf-8",
    );
    const installed = await installFileLeaseIntegrations(
      "sess-uninstall",
      "codex",
      { targetPath: tempRoot, listLeases: async () => [] },
    );
    const options = {
      targetPath: tempRoot,
      listLeases: async () => [],
      releaseAgentLeases: async () => release,
    };
    const first = await uninstallFileLeaseIntegrations(
      "sess-uninstall",
      "codex",
      options,
    );
    const second = await uninstallFileLeaseIntegrations(
      "sess-uninstall",
      "codex",
      options,
    );

    assert.equal(first.ok, true);
    assert.equal(first.uninstalled, true);
    assert.equal(second.ok, true);
    const claude = JSON.parse(
      await readFile(installed.files.claudeSettingsPath, "utf-8"),
    );
    const tasks = JSON.parse(
      await readFile(installed.files.vscodeTasksPath, "utf-8"),
    );
    assert.deepEqual(claude.permissions, { allow: ["Read"] });
    assert.equal(
      claude.hooks.PreToolUse.some((group) =>
        group.hooks?.some((hook) => hook.command === "echo keep-me")),
      true,
    );
    assert.equal(
      claude.hooks.PreToolUse.some((group) =>
        group.hooks?.some((hook) => /sl session guard-hook/u.test(hook.command))),
      false,
    );
    assert.deepEqual(tasks.tasks, [
      { label: "Keep me", type: "shell", command: "npm test" },
    ]);
    await assert.rejects(readFile(installed.files.posixScriptPath, "utf-8"), {
      code: "ENOENT",
    });
    const manifest = JSON.parse(
      await readFile(installed.files.enforcementConfigPath, "utf-8"),
    );
    assert.equal(manifest.state, "uninstalled");
    assert.equal(manifest.managedBy, "sentinelayer-cli");
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("Unit file-lease integrations: install authority failure and active-lease uninstall are non-mutating", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "sentinelayer-lease-safe-rollback-"));
  const claudePath = path.join(tempRoot, ".claude", "settings.local.json");
  const vscodePath = path.join(tempRoot, ".vscode", "tasks.json");
  try {
    await mkdir(path.dirname(claudePath), { recursive: true });
    await mkdir(path.dirname(vscodePath), { recursive: true });
    await writeFile(claudePath, "{\"permissions\":{\"allow\":[\"Read\"]}}\n", "utf-8");
    await writeFile(vscodePath, "{\"version\":\"2.0.0\",\"tasks\":[]}\n", "utf-8");
    const originalClaude = await readFile(claudePath, "utf-8");
    const originalVsCode = await readFile(vscodePath, "utf-8");
    await assert.rejects(
      installFileLeaseIntegrations("sess-safe", "codex", {
        targetPath: tempRoot,
        listLeases: async () => {
          throw new Error("file-lease route unavailable");
        },
      }),
      /route unavailable/u,
    );
    assert.equal(await readFile(claudePath, "utf-8"), originalClaude);
    assert.equal(await readFile(vscodePath, "utf-8"), originalVsCode);

    await installFileLeaseIntegrations("sess-safe", "codex", {
      targetPath: tempRoot,
      listLeases: async () => [],
    });
    const installedClaude = await readFile(claudePath, "utf-8");
    const installedVsCode = await readFile(vscodePath, "utf-8");
    const expiresAt = "2026-07-31T12:34:56Z";
    const blocked = await uninstallFileLeaseIntegrations(
      "sess-safe",
      "codex",
      {
        targetPath: tempRoot,
        releaseAgentLeases: async () => ({
          releasedCount: 0,
          released: [],
          failures: [],
          unresolved: [],
          unresolvedKnown: true,
          authority: { ok: true, authoritative: true, code: null },
        }),
        listLeases: async () => [{
          file: "src/auth.js",
          agentId: "warden",
          expiresAt,
        }],
      },
    );
    assert.equal(blocked.ok, false);
    assert.equal(blocked.reason, "active_session_leases");
    assert.equal(blocked.activeLeases[0].agentId, "warden");
    assert.equal(blocked.activeLeases[0].expiresAt, expiresAt);
    assert.equal(await readFile(claudePath, "utf-8"), installedClaude);
    assert.equal(await readFile(vscodePath, "utf-8"), installedVsCode);
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("Unit file-lease integrations: install collisions cannot partially activate editor guards", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "sentinelayer-lease-install-collision-"));
  try {
    const claudePath = path.join(tempRoot, ".claude", "settings.local.json");
    const vscodePath = path.join(tempRoot, ".vscode", "tasks.json");
    await mkdir(path.dirname(claudePath), { recursive: true });
    await mkdir(path.dirname(vscodePath), { recursive: true });
    await mkdir(path.join(tempRoot, ".sentinelayer"), { recursive: true });
    await writeFile(claudePath, "{\"keep\":\"claude\"}\n", "utf-8");
    await writeFile(vscodePath, "{\"version\":\"2.0.0\",\"tasks\":[]}\n", "utf-8");
    await writeFile(
      path.join(tempRoot, ".sentinelayer", "hooks"),
      "user-owned path collision\n",
      "utf-8",
    );
    const beforeClaude = await readFile(claudePath, "utf-8");
    const beforeVsCode = await readFile(vscodePath, "utf-8");

    await assert.rejects(
      installFileLeaseIntegrations("sess-parent-collision", "codex", {
        targetPath: tempRoot,
        listLeases: async () => [],
      }),
      /ancestor is not a directory|parent path is not a directory/u,
    );
    assert.equal(await readFile(claudePath, "utf-8"), beforeClaude);
    assert.equal(await readFile(vscodePath, "utf-8"), beforeVsCode);
    await assert.rejects(
      readFile(
        path.join(tempRoot, ".sentinelayer", "file-lease-enforcement.json"),
        "utf-8",
      ),
      { code: "ENOENT" },
    );
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("Unit file-lease integrations: unowned script target is never overwritten", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "sentinelayer-lease-script-collision-"));
  try {
    const hooksPath = path.join(tempRoot, ".sentinelayer", "hooks");
    const scriptPath = path.join(hooksPath, "file-lease-guard.sh");
    await mkdir(hooksPath, { recursive: true });
    await writeFile(scriptPath, "#!/bin/sh\necho user-owned\n", "utf-8");
    await assert.rejects(
      installFileLeaseIntegrations("sess-script-collision", "codex", {
        targetPath: tempRoot,
        listLeases: async () => [],
      }),
      /unowned generated script target/u,
    );
    assert.equal(
      await readFile(scriptPath, "utf-8"),
      "#!/bin/sh\necho user-owned\n",
    );
    await assert.rejects(
      readFile(path.join(tempRoot, ".claude", "settings.local.json"), "utf-8"),
      { code: "ENOENT" },
    );
    await assert.rejects(
      readFile(path.join(tempRoot, ".vscode", "tasks.json"), "utf-8"),
      { code: "ENOENT" },
    );
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("Unit file-lease integrations: unowned enforcement manifest is never overwritten", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "sentinelayer-lease-manifest-collision-"));
  const manifestPath = path.join(
    tempRoot,
    ".sentinelayer",
    "file-lease-enforcement.json",
  );
  try {
    await mkdir(path.dirname(manifestPath), { recursive: true });
    await writeFile(
      manifestPath,
      "{\"managedBy\":\"someone-else\",\"keep\":true}\n",
      "utf-8",
    );
    await assert.rejects(
      installFileLeaseIntegrations("sess-manifest-collision", "codex", {
        targetPath: tempRoot,
        listLeases: async () => [],
      }),
      /unowned or invalid file-lease enforcement manifest/u,
    );
    assert.equal(
      await readFile(manifestPath, "utf-8"),
      "{\"managedBy\":\"someone-else\",\"keep\":true}\n",
    );
    await assert.rejects(
      readFile(path.join(tempRoot, ".claude", "settings.local.json"), "utf-8"),
      { code: "ENOENT" },
    );
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("Unit file-lease integrations: hook-directory junction cannot escape workspace", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "sentinelayer-lease-junction-root-"));
  const outsideRoot = await mkdtemp(path.join(os.tmpdir(), "sentinelayer-lease-junction-outside-"));
  try {
    const sentinelayerPath = path.join(tempRoot, ".sentinelayer");
    const hooksPath = path.join(sentinelayerPath, "hooks");
    await mkdir(sentinelayerPath, { recursive: true });
    await symlink(
      outsideRoot,
      hooksPath,
      process.platform === "win32" ? "junction" : "dir",
    );
    await assert.rejects(
      installFileLeaseIntegrations("sess-junction", "codex", {
        targetPath: tempRoot,
        listLeases: async () => [],
      }),
      /symbolic-link or junction indirection/u,
    );
    await assert.rejects(
      readFile(path.join(outsideRoot, "file-lease-guard.sh"), "utf-8"),
      { code: "ENOENT" },
    );
    await assert.rejects(
      readFile(
        path.join(outsideRoot, "file-lease-integration.lock"),
        "utf-8",
      ),
      { code: "ENOENT" },
    );
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
    await rm(outsideRoot, { recursive: true, force: true });
  }
});

test("Unit file-lease integrations: uninstall rejects manifest-injected file paths", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "sentinelayer-lease-manifest-injection-"));
  const victimPath = path.join(tempRoot, "src", "important.js");
  try {
    await mkdir(path.dirname(victimPath), { recursive: true });
    await writeFile(victimPath, "do-not-delete\n", "utf-8");
    const installed = await installFileLeaseIntegrations(
      "sess-manifest-injection",
      "codex",
      { targetPath: tempRoot, listLeases: async () => [] },
    );
    const manifest = JSON.parse(
      await readFile(installed.files.enforcementConfigPath, "utf-8"),
    );
    manifest.managedArtifacts.files.push({
      path: "src/important.js",
      sha256: "0".repeat(64),
    });
    await writeFile(
      installed.files.enforcementConfigPath,
      `${JSON.stringify(manifest, null, 2)}\n`,
      "utf-8",
    );

    await assert.rejects(
      uninstallFileLeaseIntegrations(
        "sess-manifest-injection",
        "codex",
        {
          targetPath: tempRoot,
          listLeases: async () => [],
          releaseAgentLeases: async () => {
            assert.fail("manifest validation must happen before lease mutation");
          },
        },
      ),
      /invalid managed-script set/u,
    );
    assert.equal(await readFile(victimPath, "utf-8"), "do-not-delete\n");
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("Unit file-lease integrations: uninstall rejects injected hook and task ownership", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "sentinelayer-lease-config-injection-"));
  try {
    const installed = await installFileLeaseIntegrations(
      "sess-config-injection",
      "codex",
      { targetPath: tempRoot, listLeases: async () => [] },
    );
    const originalManifest = JSON.parse(
      await readFile(installed.files.enforcementConfigPath, "utf-8"),
    );
    const noRelease = async () => {
      assert.fail("manifest validation must happen before lease mutation");
    };

    const hookInjection = structuredClone(originalManifest);
    hookInjection.managedArtifacts.claudeHook = {
      command: "echo user-owned-hook",
      sha256: "0".repeat(64),
    };
    await writeFile(
      installed.files.enforcementConfigPath,
      `${JSON.stringify(hookInjection, null, 2)}\n`,
      "utf-8",
    );
    await assert.rejects(
      uninstallFileLeaseIntegrations(
        "sess-config-injection",
        "codex",
        {
          targetPath: tempRoot,
          listLeases: async () => [],
          releaseAgentLeases: noRelease,
        },
      ),
      /invalid Claude hook fingerprint/u,
    );

    const taskInjection = structuredClone(originalManifest);
    taskInjection.managedArtifacts.vscodeTasks = [
      { label: "User build", sha256: "0".repeat(64) },
      taskInjection.managedArtifacts.vscodeTasks[1],
    ];
    await writeFile(
      installed.files.enforcementConfigPath,
      `${JSON.stringify(taskInjection, null, 2)}\n`,
      "utf-8",
    );
    await assert.rejects(
      uninstallFileLeaseIntegrations(
        "sess-config-injection",
        "codex",
        {
          targetPath: tempRoot,
          listLeases: async () => [],
          releaseAgentLeases: noRelease,
        },
      ),
      /invalid VS Code task set/u,
    );

    const claude = JSON.parse(
      await readFile(installed.files.claudeSettingsPath, "utf-8"),
    );
    const tasks = JSON.parse(
      await readFile(installed.files.vscodeTasksPath, "utf-8"),
    );
    assert.equal(
      claude.hooks.PreToolUse.some((group) =>
        group.hooks?.some((hook) => /sl session guard-hook/u.test(hook.command))),
      true,
    );
    assert.equal(
      tasks.tasks.filter((task) =>
        [VSCODE_GUARD_TASK_LABEL, VSCODE_RENEW_TASK_LABEL].includes(task.label)).length,
      2,
    );
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("Unit file-lease integrations: guarded terminal exec blocks mutation on denied preflight", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "sentinelayer-lease-terminal-"));
  try {
    const installed = await installFileLeaseIntegrations(
      "sess-editor-guard",
      "codex",
      { targetPath: tempRoot, listLeases: async () => [] },
    );
    const fakeBin = path.join(tempRoot, "fake-bin");
    const markerPath = path.join(tempRoot, "mutation-marker.txt");
    const guardArgsPath = path.join(tempRoot, "guard-args.txt");
    await mkdir(fakeBin, { recursive: true });

    let executable;
    let args;
    if (process.platform === "win32") {
      await writeFile(
        path.join(fakeBin, "sl.cmd"),
        "@echo off\r\n> \"%SL_ARGS_LOG%\" echo %*\r\nif not \"%SL_FAKE_EXIT%\"==\"0\" echo Blocked src/auth.js held by warden expires 2026-07-31T12:34:56Z\r\nexit /b %SL_FAKE_EXIT%\r\n",
        "utf-8",
      );
      executable = "powershell.exe";
      args = [
        "-NoProfile",
        "-NonInteractive",
        "-ExecutionPolicy",
        "Bypass",
        "-File",
        installed.files.powershellExecScriptPath,
        "src/auth.js",
        "--",
        process.execPath,
        "-e",
        "require('node:fs').writeFileSync(process.argv[1], 'mutated')",
        markerPath,
      ];
    } else {
      const fakeSlPath = path.join(fakeBin, "sl");
      await writeFile(
        fakeSlPath,
        "#!/usr/bin/env sh\nprintf '%s\\n' \"$*\" > \"$SL_ARGS_LOG\"\nif [ \"$SL_FAKE_EXIT\" -ne 0 ]; then printf '%s\\n' 'Blocked src/auth.js held by warden expires 2026-07-31T12:34:56Z' >&2; fi\nexit \"$SL_FAKE_EXIT\"\n",
        "utf-8",
      );
      await chmod(fakeSlPath, 0o700);
      executable = "sh";
      args = [
        installed.files.posixExecScriptPath,
        "src/auth.js",
        "--",
        process.execPath,
        "-e",
        "require('node:fs').writeFileSync(process.argv[1], 'mutated')",
        markerPath,
      ];
    }

    const environment = {
      ...process.env,
      PATH: `${fakeBin}${path.delimiter}${process.env.PATH || ""}`,
      SL_ARGS_LOG: guardArgsPath,
      SL_FAKE_EXIT: "2",
    };
    let denied;
    try {
      await execFile(executable, args, { cwd: tempRoot, env: environment });
      assert.fail("denied guard must block the wrapped mutation");
    } catch (error) {
      denied = error;
    }
    assert.equal(Number(denied?.code), 2);
    assert.match(String(denied?.stderr || ""), /src\/auth\.js/u);
    assert.match(String(denied?.stderr || ""), /warden/u);
    assert.match(String(denied?.stderr || ""), /2026-07-31T12:34:56Z/u);
    await assert.rejects(readFile(markerPath, "utf-8"), { code: "ENOENT" });
    assert.match(
      await readFile(guardArgsPath, "utf-8"),
      /session guard sess-editor-guard --agent codex .* --json -- src\/auth\.js/u,
    );

    environment.SL_FAKE_EXIT = "0";
    await execFile(executable, args, { cwd: tempRoot, env: environment });
    assert.equal(await readFile(markerPath, "utf-8"), "mutated");
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("Unit file-lease integrations: CLI guard turns non-authoritative allow into exit-2 JSON denial", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "sentinelayer-lease-cli-guard-"));
  const guardToken = ["guard", "test", "auth", "token"].join("-");
  const requests = [];
  const server = createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) {
      chunks.push(Buffer.from(chunk));
    }
    requests.push({
      method: request.method,
      url: request.url,
      authorization: request.headers.authorization,
      body: JSON.parse(Buffer.concat(chunks).toString("utf-8")),
    });
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end(JSON.stringify({
      ok: true,
      authoritative: false,
      allowed: true,
      sessionId: "sess-cli-guard",
      holderId: "codex",
      guarded: [{ path: "src/auth.js" }],
      denials: [],
    }));
  });
  try {
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    assert.ok(address && typeof address === "object");
    const cliPath = fileURLToPath(new URL("../bin/sl.js", import.meta.url));
    let failure;
    try {
      await execFile(
        process.execPath,
        [
          cliPath,
          "session",
          "guard",
          "sess-cli-guard",
          "--agent",
          "codex",
          "--path",
          tempRoot,
          "--json",
          "--",
          "src/auth.js",
        ],
        {
          cwd: tempRoot,
          env: {
            ...process.env,
            SENTINELAYER_API_URL: `http://127.0.0.1:${address.port}`,
            SENTINELAYER_CIRCUIT_STATE_DIR: tempRoot,
            SENTINELAYER_TOKEN: guardToken,
          },
        },
      );
      assert.fail("non-authoritative guard response must exit non-zero");
    } catch (error) {
      failure = error;
    }

    assert.equal(Number(failure?.code), 2);
    const payload = JSON.parse(String(failure?.stdout || ""));
    assert.equal(payload.command, "session guard");
    assert.equal(payload.allowed, false);
    assert.equal(payload.authoritative, false);
    assert.equal(payload.error.code, "FILE_LEASE_GUARD_FAILED");
    assert.equal(requests.length, 1);
    assert.equal(requests[0].method, "POST");
    assert.equal(
      requests[0].url,
      "/api/v1/sessions/sess-cli-guard/file-leases/guard",
    );
    assert.equal(requests[0].authorization, `Bearer ${guardToken}`);
    assert.equal(requests[0].body.holderId, "codex");
    await assert.rejects(
      readFile(
        path.join(
          tempRoot,
          ".sentinelayer",
          "sessions",
          "sess-cli-guard",
          "stream.ndjson",
        ),
        "utf-8",
      ),
      { code: "ENOENT" },
    );
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("Unit file-lease integrations: CLI lock conflict emits machine-readable holder and expiry", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "sentinelayer-lease-cli-conflict-"));
  const authToken = ["lease", "conflict", "auth", "token"].join("-");
  const requests = [];
  const expiresAt = "2026-07-31T12:34:56Z";
  const server = createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) {
      chunks.push(Buffer.from(chunk));
    }
    requests.push({
      method: request.method,
      url: request.url,
      body: chunks.length > 0
        ? JSON.parse(Buffer.concat(chunks).toString("utf-8"))
        : null,
    });
    if (request.method === "POST") {
      response.writeHead(409, { "Content-Type": "application/json" });
      response.end(JSON.stringify({
        error: {
          code: "FILE_LEASE_CONFLICT",
          message: "Path conflicts with an active file lease.",
        },
      }));
      return;
    }
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end(JSON.stringify({
      ok: true,
      authoritative: true,
      count: 1,
      leases: [
        {
          leaseId: "00000000-0000-4000-8000-000000000001",
          sessionId: "sess-cli-conflict",
          path: "src/auth.js",
          holderId: "warden",
          status: "active",
          ttlSeconds: 300,
          revision: 1,
          acquiredAt: "2026-07-31T12:29:56Z",
          expiresAt,
        },
      ],
    }));
  });
  try {
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    assert.ok(address && typeof address === "object");
    const cliPath = fileURLToPath(new URL("../bin/sl.js", import.meta.url));
    let failure;
    try {
      await execFile(
        process.execPath,
        [
          cliPath,
          "session",
          "lock",
          "sess-cli-conflict",
          "src/auth.js",
          "--agent",
          "codex",
          "--path",
          tempRoot,
          "--json",
        ],
        {
          cwd: tempRoot,
          env: {
            ...process.env,
            SENTINELAYER_API_URL: `http://127.0.0.1:${address.port}`,
            SENTINELAYER_CIRCUIT_STATE_DIR: tempRoot,
            SENTINELAYER_TOKEN: authToken,
          },
        },
      );
      assert.fail("conflicting lock must exit non-zero");
    } catch (error) {
      failure = error;
    }

    assert.equal(Number(failure?.code), 2);
    assert.equal(String(failure?.stderr || ""), "");
    const payload = JSON.parse(String(failure?.stdout || ""));
    assert.equal(payload.command, "session lock");
    assert.equal(payload.failed.length, 1);
    assert.equal(payload.failed[0].file, "src/auth.js");
    assert.equal(payload.failed[0].heldBy, "warden");
    assert.equal(payload.failed[0].expiresAt, expiresAt);
    assert.equal(requests.some((item) => item.method === "POST"), true);
    assert.equal(requests.some((item) => item.method === "GET"), true);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("Unit file-lease integrations: Claude hook allows only authoritative allow", async () => {
  const errors = captureStream();
  const calls = [];
  const allowed = await runFileLeaseGuardHook({
    sessionId: "sess-hook",
    agentId: "codex",
    targetPath: "C:\\workspace",
    inputPayload: {
      tool_name: "Edit",
      tool_input: { file_path: "src/auth.js" },
    },
    errorStream: errors,
    guard: async (...args) => {
      calls.push(args);
      return {
        authoritative: true,
        allowed: true,
        guarded: [{ path: "src/auth.js" }],
        denials: [],
      };
    },
  });

  assert.equal(allowed.exitCode, 0);
  assert.equal(allowed.allowed, true);
  assert.equal(errors.text(), "");
  assert.equal(calls[0][0], "sess-hook");
  assert.equal(calls[0][1], "codex");
  assert.deepEqual(calls[0][2], ["src/auth.js"]);
});

test("Unit file-lease integrations: Claude hook exits 2 for denial, outage, or missing path", async () => {
  const deniedErrors = captureStream();
  const denied = await runFileLeaseGuardHook({
    sessionId: "sess-hook",
    agentId: "codex",
    inputPayload: {
      tool_name: "Write",
      tool_input: { file_path: "src/auth.js" },
    },
    errorStream: deniedErrors,
    guard: async () => ({
      authoritative: true,
      allowed: false,
      guarded: [],
      denials: [
        {
          path: "src/auth.js",
          reason: "holder_capability_mismatch",
          lease: {
            holderId: "claude",
            expiresAt: "2026-07-31T12:34:56Z",
          },
        },
      ],
    }),
  });
  assert.equal(denied.exitCode, 2);
  assert.match(deniedErrors.text(), /Edit blocked/u);
  assert.match(deniedErrors.text(), /held by claude/u);
  assert.match(deniedErrors.text(), /expires 2026-07-31T12:34:56Z/u);

  const outageErrors = captureStream();
  const outage = await runFileLeaseGuardHook({
    sessionId: "sess-hook",
    agentId: "codex",
    inputPayload: {
      tool_name: "NotebookEdit",
      tool_input: { notebook_path: "analysis.ipynb" },
    },
    errorStream: outageErrors,
    guard: async () => {
      const error = new Error(
        "token=super-secret-value authority unavailable",
      );
      error.code = "FILE_LEASE_STORAGE_UNAVAILABLE";
      throw error;
    },
  });
  assert.equal(outage.exitCode, 2);
  assert.doesNotMatch(outageErrors.text(), /super-secret-value/u);
  assert.match(outageErrors.text(), /credential=\[REDACTED\]/u);

  const missingErrors = captureStream();
  const missing = await runFileLeaseGuardHook({
    sessionId: "sess-hook",
    agentId: "codex",
    inputPayload: { tool_name: "Edit", tool_input: {} },
    errorStream: missingErrors,
    guard: async () => {
      throw new Error("must not run");
    },
  });
  assert.equal(missing.exitCode, 2);
  assert.match(missingErrors.text(), /did not include a target file path/u);

  const nonAuthoritativeErrors = captureStream();
  const nonAuthoritative = await runFileLeaseGuardHook({
    sessionId: "sess-hook",
    agentId: "codex",
    inputPayload: {
      tool_name: "Edit",
      tool_input: { file_path: "src/auth.js" },
    },
    errorStream: nonAuthoritativeErrors,
    guard: async () => ({
      authoritative: false,
      allowed: true,
      guarded: [{ path: "src/auth.js" }],
      denials: [],
    }),
  });
  assert.equal(nonAuthoritative.exitCode, 2);
  assert.match(nonAuthoritativeErrors.text(), /did not return an authoritative/u);
});

test("Unit file-lease integrations: session CLI registers lock lifecycle and guard commands", () => {
  const program = new Command();
  program.name("sl").exitOverride();
  registerSessionCommand(program);
  const sessionCommand = program.commands.find(
    (command) => command.name() === "session",
  );
  assert.ok(sessionCommand);
  const names = new Set(sessionCommand.commands.map((command) => command.name()));

  for (const required of [
    "lock",
    "renew",
    "unlock",
    "locks",
    "guard",
    "guard-hook",
    "guard-install",
    "guard-uninstall",
  ]) {
    assert.equal(names.has(required), true, `missing session ${required}`);
  }
});
