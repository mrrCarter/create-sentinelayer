// Unit tests for Priya's testing-persona domain tools (#A15).

import test from "node:test";
import assert from "node:assert/strict";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  TESTING_TOOLS,
  TESTING_TOOL_IDS,
  dispatchTestingTool,
  runAllTestingTools,
  runCoverageGap,
  runFlakeDetect,
  runMutationTest,
  runSnapshotDiff,
} from "../src/agents/testing/index.js";

async function makeTempRepo() {
  return fsp.mkdtemp(path.join(os.tmpdir(), "senti-testing-"));
}

async function writeFile(root, relativePath, content) {
  const full = path.join(root, relativePath);
  await fsp.mkdir(path.dirname(full), { recursive: true });
  await fsp.writeFile(full, content, "utf-8");
}

test("TESTING_TOOL_IDS surfaces the 4 spec'd tools", () => {
  assert.deepEqual([...TESTING_TOOL_IDS].sort(), [
    "coverage-gap",
    "flake-detect",
    "mutation-test",
    "snapshot-diff",
  ]);
});

test("dispatchTestingTool: unknown id throws", async () => {
  await assert.rejects(
    () => dispatchTestingTool("definitely-not-real", {}),
    /Unknown testing tool/
  );
});

test("coverage-gap: flags source file without matching test", async () => {
  const root = await makeTempRepo();
  try {
    await writeFile(root, "src/lib/foo.js", "export const foo = 1;\n");
    const findings = await runCoverageGap({ rootPath: root });
    assert.ok(
      findings.some((f) => f.kind === "testing.coverage-gap" && f.file.endsWith("foo.js"))
    );
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});

test("coverage-gap: suppresses when test file exists", async () => {
  const root = await makeTempRepo();
  try {
    await writeFile(root, "src/lib/bar.js", "export const bar = 1;\n");
    await writeFile(root, "src/lib/bar.test.js", "test('x', () => {});\n");
    const findings = await runCoverageGap({ rootPath: root });
    const hit = findings.find((f) => f.file.endsWith("bar.js"));
    assert.equal(hit, undefined);
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});

test("coverage-gap: ignores index.js / config.js (entry and config)", async () => {
  const root = await makeTempRepo();
  try {
    await writeFile(root, "src/index.js", "export * from './lib/foo.js';\n");
    await writeFile(root, "src/config.js", "export const c = {};\n");
    const findings = await runCoverageGap({ rootPath: root });
    const hit = findings.find((f) => f.file === "src/index.js" || f.file === "src/config.js");
    assert.equal(hit, undefined);
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});

test("flake-detect: flags fixed-duration setTimeout in a test file", async () => {
  const root = await makeTempRepo();
  try {
    await writeFile(
      root,
      "foo.test.js",
      "await new Promise((r) => setTimeout(r, 500));\n"
    );
    const findings = await runFlakeDetect({ rootPath: root });
    const hit = findings.find((f) => f.kind === "flake.sleep-in-test");
    assert.ok(hit);
    assert.equal(hit.severity, "P2");
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});

test("flake-detect: flags fetch() in a test file", async () => {
  const root = await makeTempRepo();
  try {
    await writeFile(
      root,
      "network.test.js",
      "const r = await fetch('https://example.com');\n"
    );
    const findings = await runFlakeDetect({ rootPath: root });
    assert.ok(findings.some((f) => f.kind === "flake.unstubbed-network"));
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});

test("flake-detect: ignores non-test source files", async () => {
  const root = await makeTempRepo();
  try {
    await writeFile(root, "src/timer.js", "setTimeout(() => {}, 500);\n");
    const findings = await runFlakeDetect({ rootPath: root });
    assert.equal(findings.length, 0);
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});

test("snapshot-diff: flags stale snapshot file", async () => {
  const root = await makeTempRepo();
  try {
    await writeFile(root, "foo.test.js.snap", "// snapshot\n");
    const snapPath = path.join(root, "foo.test.js.snap");
    // Backdate mtime by 200 days
    const oldTime = Date.now() - 200 * 24 * 60 * 60 * 1000;
    await fsp.utimes(snapPath, oldTime / 1000, oldTime / 1000);
    const findings = await runSnapshotDiff({ rootPath: root });
    assert.ok(findings.some((f) => f.kind === "testing.snapshot-stale"));
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});

test("snapshot-diff: flags oversized snapshot", async () => {
  const root = await makeTempRepo();
  try {
    const huge = "x".repeat(128 * 1024); // 128 KiB > 64 KiB threshold
    await writeFile(root, "big.test.js.snap", huge);
    const findings = await runSnapshotDiff({ rootPath: root });
    assert.ok(findings.some((f) => f.kind === "testing.snapshot-oversized"));
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});

test("mutation-test: emits advisory when no config", async () => {
  const root = await makeTempRepo();
  try {
    const findings = await runMutationTest({ rootPath: root });
    assert.equal(findings.length, 1);
    assert.equal(findings[0].kind, "testing.no-mutation-config");
    assert.equal(findings[0].severity, "P3");
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});

test("mutation-test: no config finding when Stryker config present", async () => {
  const root = await makeTempRepo();
  try {
    await writeFile(root, "stryker.conf.js", "export default { mutate: ['src/**'] };\n");
    const findings = await runMutationTest({ rootPath: root });
    const hit = findings.find((f) => f.kind === "testing.no-mutation-config");
    assert.equal(hit, undefined);
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});

test("runAllTestingTools: aggregates findings across tools", async () => {
  const root = await makeTempRepo();
  try {
    await writeFile(root, "src/untested.js", "export const x = 1;\n");
    await writeFile(root, "huge.test.js.snap", "y".repeat(128 * 1024));
    const findings = await runAllTestingTools({ rootPath: root });
    const tools = new Set(findings.map((f) => f.tool));
    assert.ok(tools.has("coverage-gap"));
    assert.ok(tools.has("snapshot-diff"));
    assert.ok(tools.has("mutation-test"));
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});

test("TESTING_TOOLS: each entry has id, description, schema, handler", () => {
  for (const toolId of TESTING_TOOL_IDS) {
    const tool = TESTING_TOOLS[toolId];
    assert.equal(tool.id, toolId);
    assert.ok(tool.description.length > 20);
    assert.equal(typeof tool.handler, "function");
    assert.equal(tool.schema.type, "object");
  }
});
