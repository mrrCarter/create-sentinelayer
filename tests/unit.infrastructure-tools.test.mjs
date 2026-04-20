// Unit tests for Kat's infrastructure domain tools (#A21).

import test from "node:test";
import assert from "node:assert/strict";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  INFRASTRUCTURE_TOOLS,
  INFRASTRUCTURE_TOOL_IDS,
  dispatchInfrastructureTool,
  runAllInfrastructureTools,
  runCheckovRun,
  runDriftDetect,
  runIamLeastPrivCheck,
  runTflintRun,
} from "../src/agents/infrastructure/index.js";

async function makeTempRepo() {
  return fsp.mkdtemp(path.join(os.tmpdir(), "senti-infra-"));
}

async function writeFile(root, rel, content) {
  const full = path.join(root, rel);
  await fsp.mkdir(path.dirname(full), { recursive: true });
  await fsp.writeFile(full, content, "utf-8");
}

test("INFRASTRUCTURE_TOOL_IDS surfaces the 4 spec'd tools", () => {
  assert.deepEqual([...INFRASTRUCTURE_TOOL_IDS].sort(), [
    "checkov-run",
    "drift-detect",
    "iam-least-priv-check",
    "tflint-run",
  ]);
});

test("tflint-run: advises when .tf is present but no .tflint.hcl", async () => {
  const root = await makeTempRepo();
  try {
    await writeFile(root, "infra/main.tf", `resource "aws_s3_bucket" "b" { bucket = "x" }\n`);
    const findings = await runTflintRun({ rootPath: root });
    assert.ok(findings.some((f) => f.kind === "infrastructure.no-tflint-config"));
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});

test("tflint-run: suppresses when .tflint.hcl exists", async () => {
  const root = await makeTempRepo();
  try {
    await writeFile(root, "infra/main.tf", "resource \"aws_s3_bucket\" \"b\" { bucket = \"x\" }\n");
    await writeFile(root, ".tflint.hcl", "plugin \"terraform\" { enabled = true }\n");
    const findings = await runTflintRun({ rootPath: root });
    assert.equal(findings.length, 0);
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});

test("checkov-run: advises when Terraform present but no .checkov.yaml", async () => {
  const root = await makeTempRepo();
  try {
    await writeFile(root, "infra/main.tf", "resource \"x\" \"y\" {}\n");
    const findings = await runCheckovRun({ rootPath: root });
    assert.ok(findings.some((f) => f.kind === "infrastructure.no-checkov-config"));
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});

test("drift-detect: flags committed .tfstate (P0)", async () => {
  const root = await makeTempRepo();
  try {
    await writeFile(root, "terraform.tfstate", "{}\n");
    const findings = await runDriftDetect({ rootPath: root });
    const hit = findings.find((f) => f.kind === "infrastructure.tfstate-committed");
    assert.ok(hit);
    assert.equal(hit.severity, "P0");
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});

test("drift-detect: suppresses no-drift-job when workflow has `terraform plan -detailed-exitcode`", async () => {
  const root = await makeTempRepo();
  try {
    await writeFile(root, "main.tf", "# tf code\n");
    await writeFile(
      root,
      ".github/workflows/drift.yml",
      "name: drift\non:\n  schedule:\n    - cron: '0 6 * * *'\njobs:\n  plan:\n    runs-on: ubuntu\n    steps:\n      - run: terraform plan -detailed-exitcode\n"
    );
    const findings = await runDriftDetect({ rootPath: root });
    assert.equal(findings.filter((f) => f.kind === "infrastructure.no-drift-job").length, 0);
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});

test("iam-least-priv-check: flags Action:* wildcard", async () => {
  const root = await makeTempRepo();
  try {
    await writeFile(
      root,
      "policy.json",
      JSON.stringify({ Statement: [{ Effect: "Allow", Action: "*", Resource: "arn:aws:s3:::b/*" }] })
    );
    const findings = await runIamLeastPrivCheck({ rootPath: root });
    assert.ok(findings.some((f) => f.kind === "infrastructure.iam-action-wildcard"));
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});

test("iam-least-priv-check: flags Resource:* wildcard", async () => {
  const root = await makeTempRepo();
  try {
    await writeFile(
      root,
      "policy.json",
      JSON.stringify({ Statement: [{ Effect: "Allow", Action: ["s3:GetObject"], Resource: "*" }] })
    );
    const findings = await runIamLeastPrivCheck({ rootPath: root });
    assert.ok(findings.some((f) => f.kind === "infrastructure.iam-resource-wildcard"));
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});

test("runAllInfrastructureTools: aggregates across tools", async () => {
  const root = await makeTempRepo();
  try {
    await writeFile(root, "infra/main.tf", "# tf\n");
    await writeFile(root, "terraform.tfstate", "{}\n");
    const findings = await runAllInfrastructureTools({ rootPath: root });
    const tools = new Set(findings.map((f) => f.tool));
    assert.ok(tools.has("tflint-run"));
    assert.ok(tools.has("drift-detect"));
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});

test("dispatchInfrastructureTool: unknown id throws", async () => {
  await assert.rejects(() => dispatchInfrastructureTool("x", {}), /Unknown infrastructure tool/);
});

test("INFRASTRUCTURE_TOOLS: each entry has id, description, schema, handler", () => {
  for (const toolId of INFRASTRUCTURE_TOOL_IDS) {
    const t = INFRASTRUCTURE_TOOLS[toolId];
    assert.equal(t.id, toolId);
    assert.ok(t.description.length > 10);
    assert.equal(typeof t.handler, "function");
  }
});
