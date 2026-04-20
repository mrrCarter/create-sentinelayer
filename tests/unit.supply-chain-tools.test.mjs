// Unit tests for Nora's supply-chain domain tools (#A22).

import test from "node:test";
import assert from "node:assert/strict";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  SUPPLY_CHAIN_TOOLS,
  SUPPLY_CHAIN_TOOL_IDS,
  dispatchSupplyChainTool,
  runAllSupplyChainTools,
  runAttestationCheck,
  runLockfileIntegrity,
  runPackageVerify,
  runSbomDiff,
} from "../src/agents/supply-chain/index.js";

async function makeTempRepo() {
  return fsp.mkdtemp(path.join(os.tmpdir(), "senti-supply-"));
}

async function writeFile(root, rel, content) {
  const full = path.join(root, rel);
  await fsp.mkdir(path.dirname(full), { recursive: true });
  await fsp.writeFile(full, content, "utf-8");
}

test("SUPPLY_CHAIN_TOOL_IDS surfaces the 4 spec'd tools", () => {
  assert.deepEqual([...SUPPLY_CHAIN_TOOL_IDS].sort(), [
    "attestation-check",
    "lockfile-integrity",
    "package-verify",
    "sbom-diff",
  ]);
});

test("sbom-diff: advises when manifest present but no SBOM", async () => {
  const root = await makeTempRepo();
  try {
    await writeFile(root, "package.json", JSON.stringify({ name: "x" }));
    const findings = await runSbomDiff({ rootPath: root });
    assert.ok(findings.some((f) => f.kind === "supply-chain.no-sbom"));
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});

test("sbom-diff: suppresses when SBOM exists", async () => {
  const root = await makeTempRepo();
  try {
    await writeFile(root, "package.json", JSON.stringify({ name: "x" }));
    await writeFile(root, "sbom.cdx.json", "{}\n");
    const findings = await runSbomDiff({ rootPath: root });
    assert.equal(findings.length, 0);
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});

test("package-verify: flags git-url and wildcard deps", async () => {
  const root = await makeTempRepo();
  try {
    await writeFile(
      root,
      "package.json",
      JSON.stringify({
        name: "x",
        dependencies: { foo: "github:a/b", bar: "*" },
      })
    );
    const findings = await runPackageVerify({ rootPath: root });
    assert.equal(findings.length, 2);
    assert.ok(findings.every((f) => f.kind === "supply-chain.unpinned-dep"));
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});

test("package-verify: clean version ranges produce no findings", async () => {
  const root = await makeTempRepo();
  try {
    await writeFile(
      root,
      "package.json",
      JSON.stringify({ name: "x", dependencies: { foo: "^1.2.3" } })
    );
    const findings = await runPackageVerify({ rootPath: root });
    assert.equal(findings.length, 0);
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});

test("attestation-check: advises when release workflow has no provenance", async () => {
  const root = await makeTempRepo();
  try {
    await writeFile(
      root,
      ".github/workflows/release.yml",
      "name: release\non: push\njobs:\n  publish:\n    runs-on: ubuntu\n    steps:\n      - run: npm publish\n"
    );
    const findings = await runAttestationCheck({ rootPath: root });
    assert.ok(findings.some((f) => f.kind === "supply-chain.no-attestation"));
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});

test("attestation-check: suppresses when attest-build-provenance is used", async () => {
  const root = await makeTempRepo();
  try {
    await writeFile(
      root,
      ".github/workflows/release.yml",
      "name: release\non: push\njobs:\n  publish:\n    runs-on: ubuntu\n    steps:\n      - uses: actions/attest-build-provenance@v1\n      - run: npm publish\n"
    );
    const findings = await runAttestationCheck({ rootPath: root });
    assert.equal(findings.length, 0);
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});

test("lockfile-integrity: flags non-private package.json without lockfile", async () => {
  const root = await makeTempRepo();
  try {
    await writeFile(root, "package.json", JSON.stringify({ name: "x", version: "1.0.0" }));
    const findings = await runLockfileIntegrity({ rootPath: root });
    assert.ok(findings.some((f) => f.kind === "supply-chain.no-lockfile"));
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});

test("lockfile-integrity: skips private packages", async () => {
  const root = await makeTempRepo();
  try {
    await writeFile(root, "package.json", JSON.stringify({ name: "x", private: true }));
    const findings = await runLockfileIntegrity({ rootPath: root });
    assert.equal(findings.length, 0);
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});

test("runAllSupplyChainTools: aggregates across tools", async () => {
  const root = await makeTempRepo();
  try {
    await writeFile(
      root,
      "package.json",
      JSON.stringify({ name: "x", version: "1.0.0", dependencies: { foo: "*" } })
    );
    const findings = await runAllSupplyChainTools({ rootPath: root });
    const tools = new Set(findings.map((f) => f.tool));
    assert.ok(tools.has("package-verify"));
    assert.ok(tools.has("sbom-diff"));
    assert.ok(tools.has("lockfile-integrity"));
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});

test("dispatchSupplyChainTool: unknown id throws", async () => {
  await assert.rejects(() => dispatchSupplyChainTool("x", {}), /Unknown supply-chain tool/);
});

test("SUPPLY_CHAIN_TOOLS: each entry has id, description, schema, handler", () => {
  for (const toolId of SUPPLY_CHAIN_TOOL_IDS) {
    const t = SUPPLY_CHAIN_TOOLS[toolId];
    assert.equal(t.id, toolId);
    assert.ok(t.description.length > 10);
    assert.equal(typeof t.handler, "function");
  }
});
