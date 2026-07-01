import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { runDeterministicReviewPipeline, runLocalReviewScan } from "../src/review/local-review.js";

async function withTempWorkspace(prefix, fn) {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), prefix));
  try {
    return await fn(tempRoot);
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
}

test("deterministic review: GitHub Actions context expressions are not hardcoded credentials", async () => {
  await withTempWorkspace("create-sentinelayer-local-review-", async (tempRoot) => {
    await writeFile(
      path.join(tempRoot, "workflow-template.js"),
      [
        "export const workflow = {",
        "  with: {",
        '    github_token: "${{ github.token }}",',
        '    openai_api_key: "${{ secrets.OPENAI_API_KEY }}",',
        '    sentinelayer_token: "${{ secrets.SENTINELAYER_TOKEN }}",',
        "  },",
        "};",
        "",
      ].join("\n"),
      "utf-8"
    );

    const result = await runDeterministicReviewPipeline({
      targetPath: tempRoot,
      mode: "full",
    });

    assert.equal(
      result.findings.some((finding) => finding.ruleId === "SL-SEC-005"),
      false,
      JSON.stringify(result.findings, null, 2)
    );

    const localScan = await runLocalReviewScan({
      targetPath: tempRoot,
      mode: "full",
    });

    assert.equal(
      localScan.findings.some((finding) => finding.ruleId === "SL-SEC-005"),
      false,
      JSON.stringify(localScan.findings, null, 2)
    );
  });
});

test("deterministic review: real hardcoded token literals still trigger", async () => {
  await withTempWorkspace("create-sentinelayer-local-review-", async (tempRoot) => {
    await writeFile(
      path.join(tempRoot, "credentials.js"),
      'export const api_token = "literal-token-value-that-should-never-ship";\n',
      "utf-8"
    );

    const result = await runDeterministicReviewPipeline({
      targetPath: tempRoot,
      mode: "full",
    });

    assert.equal(
      result.findings.some((finding) => finding.ruleId === "SL-SEC-005"),
      true,
      JSON.stringify(result.findings, null, 2)
    );
  });
});
