import assert from "node:assert/strict";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import * as backendBase from "../src/agents/backend/tools/base.js";
import * as documentationBase from "../src/agents/documentation/tools/base.js";
import * as performanceBase from "../src/agents/performance/tools/base.js";
import * as securityBase from "../src/agents/security/tools/base.js";
import * as testingBase from "../src/agents/testing/tools/base.js";

async function collectFiles(walker) {
  const entries = [];
  for await (const entry of walker) {
    entries.push(entry);
  }
  return entries;
}

test("domain tool base wrappers preserve persona severity defaults", () => {
  assert.equal(backendBase.createFinding({ severity: "unknown" }).severity, "P2");
  assert.equal(
    documentationBase.createFinding({ severity: "unknown" }).severity,
    "P3"
  );
  assert.deepEqual(
    securityBase.createFinding({
      severity: "p1",
      file: "src\\app.js",
      line: "2.9",
      confidence: 2,
    }),
    {
      persona: "security",
      tool: "",
      kind: "security",
      severity: "P1",
      file: "src/app.js",
      line: 2,
      evidence: "",
      rootCause: "",
      recommendedFix: "",
      confidence: 1,
    }
  );
});

test("domain tool base wrappers preserve walker metadata shapes", async (t) => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "sl-domain-base-"));
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  await fsp.writeFile(path.join(root, "sample.js"), "console.log('ok');\n");

  const [backendEntry] = await collectFiles(
    backendBase.walkRepoFiles({ rootPath: root, extensions: new Set([".js"]) })
  );
  assert.deepEqual(Object.keys(backendEntry).sort(), ["fullPath", "relativePath"]);

  const [documentationEntry] = await collectFiles(
    documentationBase.walkRepoFiles({
      rootPath: root,
      extensions: new Set([".js"]),
    })
  );
  assert.ok(documentationEntry.stat);
  assert.equal(documentationEntry.stat.size, "console.log('ok');\n".length);

  const [performanceEntry] = await collectFiles(
    performanceBase.walkRepoFiles({
      rootPath: root,
      extensions: new Set([".js"]),
    })
  );
  assert.deepEqual(Object.keys(performanceEntry).sort(), [
    "fullPath",
    "relativePath",
    "sizeBytes",
  ]);
  assert.equal(performanceEntry.sizeBytes, "console.log('ok');\n".length);

  const [testingEntry] = await collectFiles(
    testingBase.walkRepoFiles({ rootPath: root, extensions: new Set([".js"]) })
  );
  assert.ok(testingEntry.stat);
});

test("persona-local helpers remain available from base wrappers", () => {
  assert.equal(securityBase.lineNumberOf("a\nunsafeEval()\n", /unsafeEval/), 2);
  assert.equal(securityBase.evidenceAroundMatch("a\nunsafeEval()\n", 2), "unsafeEval()");
  assert.equal(testingBase.isTestFile("src/button.test.tsx"), true);
  assert.equal(testingBase.isTestFile("src/button.tsx"), false);
});
