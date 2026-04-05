import assert from "node:assert/strict";
import test from "node:test";

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
