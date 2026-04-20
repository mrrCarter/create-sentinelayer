// Unit tests for src/daemon/ast-drift.js (#A11 AST-based ingest drift detection).

import test from "node:test";
import assert from "node:assert/strict";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  astDiff,
  buildAstSnapshot,
  detectAstDrift,
  detectAstDriftFromDiff,
  extractFileAstSignature,
  writeAstSnapshot,
  AST_DRIFT_SCHEMA_VERSION,
  DEFAULT_AST_SNAPSHOT_RELATIVE_PATH,
} from "../src/daemon/ast-drift.js";

import { parse } from "@babel/parser";

async function makeTempRoot() {
  return fsp.mkdtemp(path.join(os.tmpdir(), "senti-ast-drift-"));
}

function parseFile(content, filename = "sample.ts") {
  return parse(content, {
    sourceType: "unambiguous",
    errorRecovery: true,
    plugins:
      filename.endsWith(".ts") || filename.endsWith(".tsx")
        ? ["typescript", "jsx"]
        : [],
  });
}

test("extractFileAstSignature: captures named exports", () => {
  const ast = parseFile(`
    export function addNumbers(a, b) { return a + b; }
    export class User {}
    export const VERSION = "1.0";
    export default function main() {}
  `);
  const sig = extractFileAstSignature(ast);
  assert.ok(sig.exports.includes("addNumbers"));
  assert.ok(sig.exports.includes("User"));
  assert.ok(sig.exports.includes("VERSION"));
  assert.ok(sig.exports.includes("default"));
  assert.equal(sig.signatures.addNumbers.kind, "function");
  assert.equal(sig.signatures.addNumbers.paramCount, 2);
  assert.equal(sig.signatures.User.kind, "class");
});

test("extractFileAstSignature: captures imports as specifier list", () => {
  const ast = parseFile(`
    import React from "react";
    import { useEffect } from "react";
    import type { Foo } from "./types";
  `);
  const sig = extractFileAstSignature(ast);
  assert.ok(sig.imports.includes("react"));
  assert.ok(sig.imports.includes("./types"));
});

test("extractFileAstSignature: empty module has empty signature", () => {
  const ast = parseFile("");
  const sig = extractFileAstSignature(ast);
  assert.deepEqual(sig.exports, []);
  assert.deepEqual(sig.imports, []);
});

test("astDiff: same snapshots → no diff", () => {
  const snapshot = {
    files: {
      "a.ts": { exports: ["foo"], imports: ["react"], signatures: { foo: { kind: "function", paramCount: 1 } } },
    },
  };
  const diff = astDiff(snapshot, snapshot);
  assert.deepEqual(diff.addedFiles, []);
  assert.deepEqual(diff.removedFiles, []);
  assert.deepEqual(diff.newExports, []);
  assert.deepEqual(diff.newImports, []);
  assert.deepEqual(diff.renamedSignatures, []);
});

test("astDiff: added file contributes new exports and imports", () => {
  const last = { files: {} };
  const current = {
    files: {
      "new.ts": {
        exports: ["alpha", "beta"],
        imports: ["zod"],
        signatures: {
          alpha: { kind: "function", paramCount: 0 },
          beta: { kind: "class", paramCount: 0 },
        },
      },
    },
  };
  const diff = astDiff(current, last);
  assert.deepEqual(diff.addedFiles, ["new.ts"]);
  assert.equal(diff.newExports.length, 2);
  assert.equal(diff.newImports.length, 1);
  assert.equal(diff.newImports[0].specifier, "zod");
});

test("astDiff: removed file registers in removedFiles", () => {
  const last = {
    files: { "old.ts": { exports: ["foo"], imports: [], signatures: {} } },
  };
  const current = { files: {} };
  const diff = astDiff(current, last);
  assert.deepEqual(diff.removedFiles, ["old.ts"]);
});

test("astDiff: signature change on same-name export is reported", () => {
  const last = {
    files: {
      "a.ts": {
        exports: ["sum"],
        imports: [],
        signatures: { sum: { kind: "function", paramCount: 2 } },
      },
    },
  };
  const current = {
    files: {
      "a.ts": {
        exports: ["sum"],
        imports: [],
        signatures: { sum: { kind: "function", paramCount: 3 } },
      },
    },
  };
  const diff = astDiff(current, last);
  assert.equal(diff.renamedSignatures.length, 1);
  assert.equal(diff.renamedSignatures[0].name, "sum");
  assert.equal(diff.renamedSignatures[0].before.paramCount, 2);
  assert.equal(diff.renamedSignatures[0].after.paramCount, 3);
});

test("astDiff: new import module shows up even when file pre-existed", () => {
  const last = {
    files: { "a.ts": { exports: [], imports: ["react"], signatures: {} } },
  };
  const current = {
    files: {
      "a.ts": { exports: [], imports: ["react", "zod"], signatures: {} },
    },
  };
  const diff = astDiff(current, last);
  assert.equal(diff.newImports.length, 1);
  assert.equal(diff.newImports[0].specifier, "zod");
});

test("detectAstDriftFromDiff: triggers on a single new export", () => {
  const verdict = detectAstDriftFromDiff({
    addedFiles: [],
    removedFiles: [],
    newExports: [{ file: "a.ts", name: "foo" }],
    newImports: [],
    renamedSignatures: [],
  });
  assert.equal(verdict.driftDetected, true);
});

test("detectAstDriftFromDiff: does NOT trigger below the signature-rename threshold", () => {
  const verdict = detectAstDriftFromDiff({
    addedFiles: [],
    removedFiles: [],
    newExports: [],
    newImports: [],
    renamedSignatures: [
      { file: "a.ts", name: "x", before: {}, after: {} },
      { file: "b.ts", name: "y", before: {}, after: {} },
      { file: "c.ts", name: "z", before: {}, after: {} },
    ],
  });
  assert.equal(verdict.driftDetected, false);
});

test("detectAstDriftFromDiff: triggers when signature-rename threshold is exceeded", () => {
  const verdict = detectAstDriftFromDiff({
    addedFiles: [],
    removedFiles: [],
    newExports: [],
    newImports: [],
    renamedSignatures: Array.from({ length: 5 }, (_, idx) => ({
      file: `f${idx}.ts`,
      name: "x",
      before: {},
      after: {},
    })),
  });
  assert.equal(verdict.driftDetected, true);
});

test("detectAstDriftFromDiff: removedFiles alone triggers drift", () => {
  const verdict = detectAstDriftFromDiff({
    addedFiles: [],
    removedFiles: ["old.ts"],
    newExports: [],
    newImports: [],
    renamedSignatures: [],
  });
  assert.equal(verdict.driftDetected, true);
});

test("buildAstSnapshot: walks JS/TS files, indexes exports + imports", async () => {
  const root = await makeTempRoot();
  try {
    await fsp.writeFile(
      path.join(root, "a.ts"),
      `import React from "react";\nexport function foo(x, y) { return x + y; }\n`,
      "utf-8"
    );
    await fsp.writeFile(
      path.join(root, "b.js"),
      `export default function main() {}\n`,
      "utf-8"
    );
    await fsp.writeFile(path.join(root, "skip.txt"), "not code", "utf-8");
    const snapshot = await buildAstSnapshot({ rootPath: root });
    assert.equal(snapshot.schemaVersion, AST_DRIFT_SCHEMA_VERSION);
    assert.ok(snapshot.files["a.ts"]);
    assert.ok(snapshot.files["b.js"]);
    assert.ok(!snapshot.files["skip.txt"]);
    assert.ok(snapshot.files["a.ts"].imports.includes("react"));
    assert.ok(snapshot.files["a.ts"].exports.includes("foo"));
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});

test("buildAstSnapshot: respects .gitignore", async () => {
  const root = await makeTempRoot();
  try {
    await fsp.writeFile(path.join(root, ".gitignore"), "skip/\n", "utf-8");
    await fsp.mkdir(path.join(root, "skip"), { recursive: true });
    await fsp.writeFile(
      path.join(root, "skip", "ignored.ts"),
      "export const x = 1;\n",
      "utf-8"
    );
    await fsp.writeFile(
      path.join(root, "keep.ts"),
      "export const y = 2;\n",
      "utf-8"
    );
    const snapshot = await buildAstSnapshot({ rootPath: root });
    assert.ok(snapshot.files["keep.ts"]);
    assert.ok(!snapshot.files["skip/ignored.ts"]);
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});

test("detectAstDrift: missingSnapshot when no prior snapshot exists", async () => {
  const root = await makeTempRoot();
  try {
    await fsp.writeFile(
      path.join(root, "a.ts"),
      "export const x = 1;\n",
      "utf-8"
    );
    const verdict = await detectAstDrift({ rootPath: root });
    assert.equal(verdict.driftDetected, true);
    assert.equal(verdict.reason?.missingSnapshot, true);
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});

test("detectAstDrift: returns driftDetected:false when nothing changed between writeAstSnapshot calls", async () => {
  const root = await makeTempRoot();
  try {
    await fsp.writeFile(
      path.join(root, "a.ts"),
      "export const x = 1;\n",
      "utf-8"
    );
    const first = await buildAstSnapshot({ rootPath: root });
    await writeAstSnapshot({ rootPath: root, snapshot: first });
    const verdict = await detectAstDrift({ rootPath: root });
    assert.equal(verdict.driftDetected, false);
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});

test("detectAstDrift: triggers when a new export appears", async () => {
  const root = await makeTempRoot();
  try {
    await fsp.writeFile(
      path.join(root, "a.ts"),
      "export const x = 1;\n",
      "utf-8"
    );
    const first = await buildAstSnapshot({ rootPath: root });
    await writeAstSnapshot({ rootPath: root, snapshot: first });

    await fsp.writeFile(
      path.join(root, "a.ts"),
      "export const x = 1;\nexport const y = 2;\n",
      "utf-8"
    );
    const verdict = await detectAstDrift({ rootPath: root });
    assert.equal(verdict.driftDetected, true);
    assert.ok(verdict.reason.newExports.some((e) => e.name === "y"));
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});

test("writeAstSnapshot: persists JSON at default path", async () => {
  const root = await makeTempRoot();
  try {
    const snapshot = await buildAstSnapshot({ rootPath: root });
    const writtenPath = await writeAstSnapshot({ rootPath: root, snapshot });
    const expected = path.join(root, DEFAULT_AST_SNAPSHOT_RELATIVE_PATH);
    assert.equal(path.resolve(writtenPath), path.resolve(expected));
    const contents = await fsp.readFile(expected, "utf-8");
    const parsed = JSON.parse(contents);
    assert.equal(parsed.schemaVersion, AST_DRIFT_SCHEMA_VERSION);
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});
