import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const PR_HEAD_EXPRESSION =
  "${{ github.event_name == 'pull_request' && github.event.pull_request.head.sha || github.sha }}";

function jobBlock(workflow, jobName, nextJobName) {
  const start = workflow.indexOf(`\n  ${jobName}:`);
  assert.notEqual(start, -1, `missing ${jobName} job`);
  const end = nextJobName
    ? workflow.indexOf(`\n  ${nextJobName}:`, start + 1)
    : workflow.length;
  assert.notEqual(end, -1, `missing ${nextJobName} job boundary`);
  return workflow.slice(start, end);
}

test("package provenance builds and attestation rebuild use the immutable PR head", async () => {
  const quality = await readFile(".github/workflows/quality-gates.yml", "utf8");
  const attestations = await readFile(".github/workflows/attestations.yml", "utf8");

  const reproducibleBuild = jobBlock(
    quality,
    "reproducible-build",
    "build-package"
  );
  const buildPackage = jobBlock(
    quality,
    "build-package",
    "deploy-readiness"
  );
  const trustedAttestation = jobBlock(attestations, "attest-build", "attest-untrusted");

  for (const [name, block] of [
    ["reproducible-build", reproducibleBuild],
    ["build-package", buildPackage],
    ["attest-build", trustedAttestation],
  ]) {
    assert.match(
      block,
      new RegExp(`ref: ${PR_HEAD_EXPRESSION.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`),
      `${name} must check out the canonical PR-head source`
    );
  }

  assert.match(
    buildPackage,
    new RegExp(
      `TARGET_COMMIT_SHA: ${PR_HEAD_EXPRESSION.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`
    ),
    "the package manifest must name the same canonical source commit"
  );
});
