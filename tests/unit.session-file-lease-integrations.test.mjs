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
      { targetPath: tempRoot },
    );
    const second = await installFileLeaseIntegrations(
      "sess-editor-guard",
      "codex",
      { targetPath: tempRoot },
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

test("Unit file-lease integrations: guarded terminal exec blocks mutation on denied preflight", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "sentinelayer-lease-terminal-"));
  try {
    const installed = await installFileLeaseIntegrations(
      "sess-editor-guard",
      "codex",
      { targetPath: tempRoot },
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
        "@echo off\r\n> \"%SL_ARGS_LOG%\" echo %*\r\nexit /b %SL_FAKE_EXIT%\r\n",
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
        "#!/usr/bin/env sh\nprintf '%s\\n' \"$*\" > \"$SL_ARGS_LOG\"\nexit \"$SL_FAKE_EXIT\"\n",
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
    await assert.rejects(
      execFile(executable, args, { cwd: tempRoot, env: environment }),
      (error) => Number(error?.code) === 2,
    );
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
          lease: { holderId: "claude" },
        },
      ],
    }),
  });
  assert.equal(denied.exitCode, 2);
  assert.match(deniedErrors.text(), /Edit blocked/u);
  assert.match(deniedErrors.text(), /held by claude/u);

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
  ]) {
    assert.equal(names.has(required), true, `missing session ${required}`);
  }
});
