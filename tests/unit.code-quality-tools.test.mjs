// Unit tests for Ethan's code-quality domain tools (#A16).

import test from "node:test";
import assert from "node:assert/strict";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  CODE_QUALITY_TOOLS,
  CODE_QUALITY_TOOL_IDS,
  dispatchCodeQualityTool,
  runAllCodeQualityTools,
  runComplexityMeasure,
  runCouplingAnalysis,
  runCycleDetect,
  runDepGraph,
} from "../src/agents/code-quality/index.js";
import {
  buildDependencyGraph,
  normalizeImportSpec,
} from "../src/agents/code-quality/tools/dep-graph.js";
import { estimateComplexity } from "../src/agents/code-quality/tools/complexity-measure.js";
import { parse } from "@babel/parser";

async function makeTempRepo() {
  return fsp.mkdtemp(path.join(os.tmpdir(), "senti-code-quality-"));
}

async function writeFile(root, relativePath, content) {
  const full = path.join(root, relativePath);
  await fsp.mkdir(path.dirname(full), { recursive: true });
  await fsp.writeFile(full, content, "utf-8");
}

test("CODE_QUALITY_TOOL_IDS surfaces the 4 spec'd tools", () => {
  assert.deepEqual([...CODE_QUALITY_TOOL_IDS].sort(), [
    "complexity-measure",
    "coupling-analysis",
    "cycle-detect",
    "dep-graph",
  ]);
});

test("dispatchCodeQualityTool: unknown id throws", async () => {
  await assert.rejects(
    () => dispatchCodeQualityTool("not-a-real-tool", {}),
    /Unknown code-quality tool/
  );
});

test("normalizeImportSpec: local, npm single, npm scoped", () => {
  const a = normalizeImportSpec("./foo/bar", "src/lib/x.js");
  assert.equal(a.kind, "local");
  assert.equal(a.key, "src/lib/foo/bar");

  const b = normalizeImportSpec("react", "x.js");
  assert.equal(b.kind, "npm");
  assert.equal(b.key, "npm:react");

  const c = normalizeImportSpec("@babel/parser", "x.js");
  assert.equal(c.kind, "npm");
  assert.equal(c.key, "npm:@babel/parser");
});

test("buildDependencyGraph: captures import edges", async () => {
  const root = await makeTempRepo();
  try {
    await writeFile(root, "a.js", "import { b } from './b.js';\nexport const x = b;\n");
    await writeFile(root, "b.js", "import z from 'react';\nexport const b = 1;\n");
    const graph = await buildDependencyGraph({ rootPath: root });
    assert.ok(graph["a.js"].some((e) => e.endsWith("b.js")));
    assert.ok(graph["b.js"].includes("npm:react"));
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});

test("runDepGraph: returns summary finding with graph attached", async () => {
  const root = await makeTempRepo();
  try {
    await writeFile(root, "a.js", "import b from './b.js';\nexport default b;\n");
    await writeFile(root, "b.js", "export default 1;\n");
    const findings = await runDepGraph({ rootPath: root });
    assert.equal(findings.length, 1);
    assert.equal(findings[0].kind, "code-quality.dep-graph-report");
    assert.ok(findings[0].graph);
    assert.ok(findings[0].graph["a.js"]);
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});

test("runCouplingAnalysis: flags high fan-out", async () => {
  const root = await makeTempRepo();
  try {
    // Generate 25 imports from one file
    let importBlock = "";
    for (let i = 0; i < 25; i += 1) {
      await writeFile(root, `lib/m${i}.js`, `export const v${i} = ${i};\n`);
      importBlock += `import { v${i} } from './lib/m${i}.js';\n`;
    }
    await writeFile(root, "hub.js", `${importBlock}export default [v0];\n`);
    const findings = await runCouplingAnalysis({ rootPath: root });
    const hit = findings.find(
      (f) => f.kind === "code-quality.high-fan-out" && f.file === "hub.js"
    );
    assert.ok(hit);
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});

test("runCouplingAnalysis: flags high fan-in", async () => {
  const root = await makeTempRepo();
  try {
    await writeFile(root, "god.js", "export const x = 1;\n");
    for (let i = 0; i < 16; i += 1) {
      await writeFile(
        root,
        `consumer${i}.js`,
        `import { x } from './god.js';\nexport default x + ${i};\n`
      );
    }
    const findings = await runCouplingAnalysis({ rootPath: root });
    const hit = findings.find((f) => f.kind === "code-quality.high-fan-in");
    assert.ok(hit);
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});

test("runCycleDetect: finds a 2-module cycle", async () => {
  const root = await makeTempRepo();
  try {
    await writeFile(root, "a.js", "import { b } from './b.js';\nexport const a = b + 1;\n");
    await writeFile(root, "b.js", "import { a } from './a.js';\nexport const b = a + 1;\n");
    const findings = await runCycleDetect({ rootPath: root });
    const hit = findings.find((f) => f.kind === "code-quality.import-cycle");
    assert.ok(hit);
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});

test("runCycleDetect: clean graph produces 0 findings", async () => {
  const root = await makeTempRepo();
  try {
    await writeFile(root, "a.js", "import { b } from './b.js';\nexport default b;\n");
    await writeFile(root, "b.js", "export const b = 1;\n");
    const findings = await runCycleDetect({ rootPath: root });
    assert.equal(findings.length, 0);
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});

test("estimateComplexity: counts branching nodes", () => {
  const ast = parse(
    `function foo(x) {
      if (x > 0) {
        for (let i = 0; i < x; i++) {
          if (i % 2 === 0) { console.log(i); }
        }
      } else if (x < 0) {
        while (x < 0) { x++; }
      }
      return x ? "pos" : "neg";
    }`,
    { sourceType: "module" }
  );
  // Grab the function body.
  const fnNode = ast.program.body[0];
  const cc = estimateComplexity(fnNode.body);
  assert.ok(cc >= 6, `expected CC >= 6, got ${cc}`);
});

test("runComplexityMeasure: flags a deliberately complex function", async () => {
  const root = await makeTempRepo();
  try {
    // Generate a function with ~20 branches
    let body = "function bad(x) {\n";
    for (let i = 0; i < 20; i += 1) {
      body += `  if (x === ${i}) { return ${i}; }\n`;
    }
    body += "  return 0;\n}\n";
    await writeFile(root, "complex.js", body);
    const findings = await runComplexityMeasure({
      rootPath: root,
      p2Threshold: 15,
    });
    const hit = findings.find((f) => f.kind === "code-quality.high-complexity");
    assert.ok(hit);
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});

test("runAllCodeQualityTools: aggregates across tools", async () => {
  const root = await makeTempRepo();
  try {
    await writeFile(root, "a.js", "import { b } from './b.js';\nexport const a = b + 1;\n");
    await writeFile(root, "b.js", "import { a } from './a.js';\nexport const b = a + 1;\n");
    const findings = await runAllCodeQualityTools({ rootPath: root });
    const tools = new Set(findings.map((f) => f.tool));
    assert.ok(tools.has("dep-graph"));
    assert.ok(tools.has("cycle-detect"));
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});

test("CODE_QUALITY_TOOLS: each entry has id, description, schema, handler", () => {
  for (const toolId of CODE_QUALITY_TOOL_IDS) {
    const tool = CODE_QUALITY_TOOLS[toolId];
    assert.equal(tool.id, toolId);
    assert.ok(tool.description.length > 20);
    assert.equal(typeof tool.handler, "function");
    assert.equal(tool.schema.type, "object");
  }
});
