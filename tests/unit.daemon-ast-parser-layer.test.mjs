import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";

import { parseAstModuleSpecifiers } from "../src/daemon/ast-parser-layer.js";

test("Unit daemon AST parser layer: parses JS/TS imports with AST", async () => {
  const content = [
    "import { x } from './alpha.js';",
    "export { y } from './beta.js';",
    "const z = require('./gamma.js');",
    "const lazy = import('./delta.js');",
  ].join("\n");
  const parsed = await parseAstModuleSpecifiers({
    absolutePath: "/tmp/example.ts",
    content,
    language: "TypeScript",
  });
  assert.equal(parsed.parserMode, "babel_ast");
  assert.equal(parsed.parseError, "");
  assert.deepEqual(parsed.specifiers.sort(), [
    "./alpha.js",
    "./beta.js",
    "./delta.js",
    "./gamma.js",
  ]);
});

test("Unit daemon AST parser layer: falls back to regex when AST parsing fails", async () => {
  const parsed = await parseAstModuleSpecifiers({
    absolutePath: "/tmp/broken.ts",
    content: "const x = require('./alpha.js'\n",
    language: "TypeScript",
  });
  assert.equal(parsed.parserMode, "regex_fallback");
  assert.equal(parsed.parseError.length > 0, true);
  assert.equal(parsed.specifiers.includes("./alpha.js"), true);
});

test("Unit daemon AST parser layer: uses python fallback parsing when python AST fails", async () => {
  const parsed = await parseAstModuleSpecifiers({
    absolutePath: "/path/does/not/exist/example.py",
    content: "from services.runtime import run_scan\nimport util.tokens",
    language: "Python",
  });
  assert.equal(parsed.parserMode, "regex_fallback_python");
  assert.equal(parsed.specifiers.includes("services.runtime"), true);
  assert.equal(parsed.specifiers.includes("util.tokens"), true);
});

test("Unit daemon AST parser layer: parses python imports with AST success path", async (t) => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "create-sentinelayer-ast-py-"));
  try {
    const filePath = path.join(tempRoot, "worker.py");
    const content = [
      "import json",
      "from services.runtime import run_scan",
      "from pkg.subpkg import module as feature_module",
      "",
      "def run_job():",
      "    return run_scan()",
      "",
    ].join("\n");
    await writeFile(filePath, content, "utf-8");

    const parsed = await parseAstModuleSpecifiers({
      absolutePath: filePath,
      content,
      language: "Python",
    });

    if (parsed.parserMode !== "python_ast") {
      t.skip(`python_ast parser unavailable in this environment (mode=${parsed.parserMode})`);
      return;
    }

    assert.equal(parsed.parseError, "");
    assert.deepEqual(parsed.specifiers.sort(), [
      "json",
      "pkg.subpkg",
      "services.runtime",
    ]);
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("Unit daemon AST parser layer: handles import edge cases and deduplicates specifiers", async () => {
  const content = [
    "import data from './config.json' with { type: 'json' };",
    "export * from './shared.js';",
    "const a = require('./legacy.cjs');",
    "const b = await import('./lazy.mjs');",
    "import another from './shared.js';",
    "",
  ].join("\n");

  const parsed = await parseAstModuleSpecifiers({
    absolutePath: "/tmp/edge-case.mts",
    content,
    language: "TypeScript",
  });

  assert.equal(parsed.parserMode, "babel_ast");
  assert.equal(parsed.parseError, "");
  assert.deepEqual(parsed.specifiers.sort(), [
    "./config.json",
    "./lazy.mjs",
    "./legacy.cjs",
    "./shared.js",
  ]);
});
