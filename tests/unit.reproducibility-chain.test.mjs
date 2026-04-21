// Unit tests for the reproducibility chain (#investor-dd-17).

import test from "node:test";
import assert from "node:assert/strict";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  sha256File,
  buildReplayBlock,
  attachReproducibilityChain,
} from "../src/review/reproducibility-chain.js";

async function makeTempRepo() {
  return fsp.mkdtemp(path.join(os.tmpdir(), "senti-repro-"));
}

async function writeFile(root, relativePath, content) {
  const fullPath = path.join(root, relativePath);
  await fsp.mkdir(path.dirname(fullPath), { recursive: true });
  await fsp.writeFile(fullPath, content, "utf-8");
}

test("sha256File: stable hash for identical contents", async () => {
  const root = await makeTempRepo();
  try {
    await writeFile(root, "a.js", "const x = 1;\n");
    await writeFile(root, "b.js", "const x = 1;\n");
    const h1 = await sha256File(path.join(root, "a.js"));
    const h2 = await sha256File(path.join(root, "b.js"));
    assert.equal(h1, h2);
    assert.match(h1, /^[0-9a-f]{64}$/);
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});

test("sha256File: returns null for missing file", async () => {
  const root = await makeTempRepo();
  try {
    const h = await sha256File(path.join(root, "missing.js"));
    assert.equal(h, null);
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});

test("buildReplayBlock: emits cli replay command + file hash", async () => {
  const root = await makeTempRepo();
  try {
    await writeFile(root, "src/app.js", "const run = (x) => eval(x);\n");
    const finding = {
      personaId: "security",
      tool: "sast-scan",
      file: "src/app.js",
      kind: "sast.eval",
      line: 1,
    };
    const block = await buildReplayBlock({
      finding,
      rootPath: root,
      runId: "run-42",
    });
    assert.ok(block.replayCommand.includes("sl /review show --run run-42"));
    assert.ok(block.replayCommand.includes("--persona security"));
    assert.ok(block.replayCommand.includes("--tool sast-scan"));
    assert.ok(block.replayCommand.includes("--file src/app.js"));
    assert.ok(block.filesAtTime["src/app.js"]);
    assert.match(block.filesAtTime["src/app.js"], /^[0-9a-f]{64}$/);
    assert.equal(block.runId, "run-42");
    assert.ok(block.timestamp);
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});

test("buildReplayBlock: missing file → null hash, no throw", async () => {
  const root = await makeTempRepo();
  try {
    const finding = { personaId: "security", tool: "x", file: "missing.js" };
    const block = await buildReplayBlock({ finding, rootPath: root, runId: "x" });
    assert.equal(block.filesAtTime["missing.js"], null);
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});

test("buildReplayBlock: rejects missing params", async () => {
  await assert.rejects(() => buildReplayBlock({}), /finding/);
  await assert.rejects(() => buildReplayBlock({ finding: {} }), /rootPath/);
  await assert.rejects(
    () => buildReplayBlock({ finding: {}, rootPath: "." }),
    /runId/,
  );
});

test("attachReproducibilityChain: decorates many findings in parallel", async () => {
  const root = await makeTempRepo();
  try {
    await writeFile(root, "a.js", "// a\n");
    await writeFile(root, "b.js", "// b\n");
    await writeFile(root, "c.js", "// c\n");

    const findings = [
      { personaId: "security", tool: "x", file: "a.js", kind: "k" },
      { personaId: "security", tool: "x", file: "b.js", kind: "k" },
      { personaId: "security", tool: "x", file: "c.js", kind: "k" },
    ];
    const result = await attachReproducibilityChain({
      findings,
      rootPath: root,
      runId: "rrr",
    });
    assert.equal(result.length, 3);
    for (const f of result) {
      assert.ok(f.reproducibility);
      assert.ok(f.reproducibility.replayCommand);
      assert.equal(f.reproducibility.runId, "rrr");
    }
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});

test("attachReproducibilityChain: rejects bad inputs", async () => {
  await assert.rejects(
    () => attachReproducibilityChain({ findings: "not-array" }),
    /array/,
  );
  await assert.rejects(
    () => attachReproducibilityChain({ findings: [] }),
    /rootPath/,
  );
  await assert.rejects(
    () => attachReproducibilityChain({ findings: [], rootPath: "." }),
    /runId/,
  );
});
