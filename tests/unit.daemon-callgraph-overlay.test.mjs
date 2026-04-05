import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";

import { buildCallgraphOverlay, parseFileCallgraph } from "../src/daemon/callgraph-overlay.js";

test("Unit daemon callgraph overlay: parses JS callgraph with AST mode", async () => {
  const parsed = await parseFileCallgraph({
    absolutePath: "/tmp/example.ts",
    language: "TypeScript",
    content: [
      "function alpha() {",
      "  return beta();",
      "}",
      "function beta() {",
      "  return 1;",
      "}",
      "alpha();",
      "",
    ].join("\n"),
  });
  assert.equal(parsed.parserMode, "babel_ast");
  assert.equal(parsed.parseError, "");
  assert.equal(parsed.symbols.includes("alpha"), true);
  assert.equal(parsed.symbols.includes("beta"), true);
  assert.equal(parsed.calls.some((entry) => entry.caller === "alpha" && entry.callee === "beta"), true);
});

test("Unit daemon callgraph overlay: falls back deterministically on parser failure", async () => {
  const parsed = await parseFileCallgraph({
    absolutePath: "/tmp/broken.ts",
    language: "TypeScript",
    content: "function alpha( { return beta();",
  });
  assert.equal(parsed.parserMode, "regex_fallback");
  assert.equal(parsed.parseError.length > 0, true);
  assert.equal(Array.isArray(parsed.calls), true);
});

test("Unit daemon callgraph overlay: builds overlay edges across scoped files", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "create-sentinelayer-callgraph-"));
  try {
    await mkdir(path.join(tempRoot, "src"), { recursive: true });
    await writeFile(
      path.join(tempRoot, "src", "a.js"),
      [
        "import { beta } from './b.js';",
        "export function alpha() {",
        "  return beta();",
        "}",
        "alpha();",
        "",
      ].join("\n"),
      "utf-8"
    );
    await writeFile(
      path.join(tempRoot, "src", "b.js"),
      [
        "export function beta() {",
        "  return 42;",
        "}",
        "",
      ].join("\n"),
      "utf-8"
    );

    const indexedFilesByPath = new Map([
      ["src/a.js", { path: "src/a.js", language: "JavaScript" }],
      ["src/b.js", { path: "src/b.js", language: "JavaScript" }],
    ]);
    const overlay = await buildCallgraphOverlay({
      rootPath: tempRoot,
      indexedFilesByPath,
      scopedPaths: ["src/a.js", "src/b.js"],
    });
    assert.equal(overlay.summary.nodeCount > 0, true);
    assert.equal(overlay.summary.edgeCount > 0, true);
    const hasCrossFileEdge = overlay.edges.some(
      (edge) => edge.from === "src/a.js#alpha" && edge.to === "src/b.js#beta"
    );
    assert.equal(hasCrossFileEdge, true);
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});
