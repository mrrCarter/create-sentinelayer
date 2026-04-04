import { test } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";

const hasBash = (() => {
  const probe = spawnSync("bash", ["--version"], { encoding: "utf8" });
  return !probe.error && probe.status === 0;
})();

function runShaVerifier({ allowlistPath, workflowPath }) {
  const scriptPath = path.resolve("scripts", "ci", "verify-action-shas.sh");
  return spawnSync("bash", [scriptPath, workflowPath], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      ACTION_SHA_ALLOWLIST_FILE: allowlistPath,
    },
    encoding: "utf8",
  });
}

test(
  "Unit action SHA verifier: duplicate YAML keys fail closed",
  { skip: !hasBash },
  async () => {
    const tempRoot = await mkdtemp(path.join(os.tmpdir(), "create-sentinelayer-sha-test-"));
    try {
      const allowlistPath = path.join(tempRoot, "allowlist.txt");
      const workflowPath = path.join(tempRoot, "workflow.yml");
      await writeFile(
        allowlistPath,
        [
          "actions/checkout=11bd71901bbe5b1630ceea73d27597364c9af683",
          "actions/setup-node=49933ea5288caeca8642d1e84afbd3f7d6820020",
        ].join("\n"),
        "utf8"
      );
      await writeFile(
        workflowPath,
        [
          "name: Duplicate Uses",
          "on: [push]",
          "jobs:",
          "  verify:",
          "    runs-on: ubuntu-latest",
          "    steps:",
          "      - name: duplicate mapping",
          "        uses: actions/checkout@11bd71901bbe5b1630ceea73d27597364c9af683",
          "        uses: actions/setup-node@49933ea5288caeca8642d1e84afbd3f7d6820020",
        ].join("\n"),
        "utf8"
      );
      const result = runShaVerifier({ allowlistPath, workflowPath });
      assert.notEqual(result.status, 0);
      const combinedOutput = `${result.stdout || ""}\n${result.stderr || ""}`;
      assert.match(combinedOutput, /Failed to parse workflow YAML/i);
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  }
);

test(
  "Unit action SHA verifier: valid pinned workflow passes",
  { skip: !hasBash },
  async () => {
    const tempRoot = await mkdtemp(path.join(os.tmpdir(), "create-sentinelayer-sha-test-"));
    try {
      const allowlistPath = path.join(tempRoot, "allowlist.txt");
      const workflowPath = path.join(tempRoot, "workflow.yml");
      await writeFile(
        allowlistPath,
        "actions/checkout=11bd71901bbe5b1630ceea73d27597364c9af683\n",
        "utf8"
      );
      await writeFile(
        workflowPath,
        [
          "name: Valid Uses",
          "on: [push]",
          "jobs:",
          "  verify:",
          "    runs-on: ubuntu-latest",
          "    steps:",
          "      - name: pinned",
          "        uses: actions/checkout@11bd71901bbe5b1630ceea73d27597364c9af683",
        ].join("\n"),
        "utf8"
      );
      const result = runShaVerifier({ allowlistPath, workflowPath });
      assert.equal(result.status, 0, result.stderr || result.stdout);
      assert.match(result.stdout || "", /Verified pinned workflow action SHAs/i);
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  }
);
