// Unit tests for the compliance pack (#investor-dd-20..24).

import test from "node:test";
import assert from "node:assert/strict";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  COMPLIANCE_PACK_CATALOG,
  COMPLIANCE_PACK_VERSION,
  runCompliancePack,
  runFullCompliancePack,
} from "../src/review/compliance-pack.js";

async function makeTempRepo() {
  return fsp.mkdtemp(path.join(os.tmpdir(), "senti-compliance-"));
}

async function writeFile(root, relativePath, content) {
  const fullPath = path.join(root, relativePath);
  await fsp.mkdir(path.dirname(fullPath), { recursive: true });
  await fsp.writeFile(fullPath, content, "utf-8");
}

test("catalog covers soc2, iso27001, gdpr, ccpa, hipaa, license, dr", () => {
  assert.deepEqual(
    [...COMPLIANCE_PACK_CATALOG].sort(),
    ["ccpa", "dr", "gdpr", "hipaa", "iso27001", "license", "soc2"],
  );
  assert.match(COMPLIANCE_PACK_VERSION, /^\d+\.\d+\.\d+$/);
});

test("runCompliancePack: soc2 reports gaps on empty repo", async () => {
  const root = await makeTempRepo();
  try {
    const result = await runCompliancePack("soc2", { rootPath: root });
    assert.equal(result.packId, "soc2");
    assert.ok(result.items.length >= 6);
    assert.ok(result.gaps > 0);
    assert.equal(result.covered, 0);
    assert.ok(result.items.every((i) => i.controlId && i.title));
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});

test("runCompliancePack: soc2 recognizes LICENSE + CHANGELOG + SECURITY", async () => {
  const root = await makeTempRepo();
  try {
    await writeFile(root, "LICENSE", "MIT License\n");
    await writeFile(root, "CHANGELOG.md", "# Changelog\n## 1.0.0\n");
    await writeFile(root, "SECURITY.md", "# Security Policy\n");
    await writeFile(
      root,
      "src/middleware/auth.js",
      "export function requireAuth(req, res, next) { next(); }\n",
    );
    await writeFile(
      root,
      "docs/dr-runbook.md",
      "# DR Runbook\nRTO: 4h, RPO: 1h\nBackup restore test evidence: quarterly\n",
    );
    await writeFile(root, "PRIVACY.md", "# Privacy Notice\n");

    const result = await runCompliancePack("soc2", { rootPath: root });
    const byId = new Map(result.items.map((i) => [i.controlId, i]));
    assert.equal(byId.get("CC6.1").status, "covered");
    assert.equal(byId.get("CC7.1").status, "covered");
    assert.equal(byId.get("CC7.3").status, "covered");
    assert.equal(byId.get("CC8.1").status, "covered");
    assert.equal(byId.get("A1.2").status, "covered");
    assert.equal(byId.get("P2.1").status, "covered");
    assert.ok(result.covered >= 6);
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});

test("runCompliancePack: iso27001 covers SBOM + workflow + LICENSE", async () => {
  const root = await makeTempRepo();
  try {
    await writeFile(root, "SECURITY.md", "# Policy\n");
    await writeFile(root, "package.json", '{"name":"t","version":"1.0.0","license":"MIT"}');
    await writeFile(root, ".github/workflows/ci.yml", "name: ci\n");
    await writeFile(root, "LICENSE", "MIT\n");

    const result = await runCompliancePack("iso27001", { rootPath: root });
    const byId = new Map(result.items.map((i) => [i.controlId, i]));
    assert.equal(byId.get("A.5.1").status, "covered");
    assert.equal(byId.get("A.8.1").status, "covered");
    assert.equal(byId.get("A.14.2").status, "covered");
    assert.equal(byId.get("A.18.1").status, "covered");
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});

test("runCompliancePack: gdpr recognizes delete + consent + lawful basis", async () => {
  const root = await makeTempRepo();
  try {
    await writeFile(
      root,
      "src/api/routes.js",
      `router.post('/delete_user', deleteUserHandler);\n`,
    );
    await writeFile(
      root,
      "src/consent/track.js",
      `function recordConsent() { /* consent captured */ }\n`,
    );
    await writeFile(
      root,
      "docs/privacy-policy.md",
      "## Lawful basis\nWe process data under legitimate interest.\n",
    );
    const result = await runCompliancePack("gdpr", { rootPath: root });
    const byId = new Map(result.items.map((i) => [i.controlId, i]));
    assert.equal(byId.get("GDPR.DS-Rights").status, "covered");
    assert.equal(byId.get("GDPR.Consent").status, "covered");
    assert.equal(byId.get("GDPR.LawfulBasis").status, "covered");
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});

test("runCompliancePack: hipaa recognizes PHI + BAA", async () => {
  const root = await makeTempRepo();
  try {
    await writeFile(
      root,
      "src/schema/patient.py",
      "# Patient record with PHI fields: ssn, dob, diagnosis\n",
    );
    await writeFile(
      root,
      "BAA.md",
      "# Business Associate Agreement template\n",
    );
    const result = await runCompliancePack("hipaa", { rootPath: root });
    const byId = new Map(result.items.map((i) => [i.controlId, i]));
    assert.equal(byId.get("HIPAA.PHI").status, "covered");
    assert.equal(byId.get("HIPAA.BAA").status, "covered");
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});

test("runCompliancePack: license pack recognizes LICENSE + SBOM", async () => {
  const root = await makeTempRepo();
  try {
    await writeFile(root, "LICENSE", "Apache 2.0\n");
    await writeFile(root, "package.json", '{"name":"t","license":"Apache-2.0"}');
    await writeFile(root, "sbom.spdx.json", '{"spdxVersion":"SPDX-2.3"}');
    const result = await runCompliancePack("license", { rootPath: root });
    assert.equal(result.covered, 3);
    assert.equal(result.gaps, 0);
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});

test("runCompliancePack: dr pack recognizes RTO / RPO / restore test", async () => {
  const root = await makeTempRepo();
  try {
    await writeFile(
      root,
      "docs/disaster-recovery.md",
      "RTO: 4h\nRPO: 1h\nBackup verified last quarter with restore test.\n",
    );
    const result = await runCompliancePack("dr", { rootPath: root });
    assert.equal(result.covered, 4);
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});

test("runFullCompliancePack: aggregates across all packs", async () => {
  const root = await makeTempRepo();
  try {
    await writeFile(root, "LICENSE", "MIT\n");
    await writeFile(root, "SECURITY.md", "# Security\n");
    await writeFile(root, "package.json", '{"license":"MIT"}');
    const result = await runFullCompliancePack({ rootPath: root });
    assert.ok(Object.keys(result.packs).length >= 6);
    assert.ok(result.totalCovered > 0);
    assert.ok(result.totalGaps > 0);
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});

test("runCompliancePack: unknown pack rejected", async () => {
  await assert.rejects(() => runCompliancePack("nope", { rootPath: "." }), /Unknown/);
});

test("runCompliancePack: missing rootPath rejected", async () => {
  await assert.rejects(() => runCompliancePack("soc2", {}), /rootPath/);
});

test("runFullCompliancePack: missing rootPath rejected", async () => {
  await assert.rejects(() => runFullCompliancePack({}), /rootPath/);
});
