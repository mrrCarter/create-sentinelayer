import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";

import {
  collectRouteLiteralsFromSource,
  extractSpecContractSignals,
  runSpecBindingChecks,
} from "../src/review/spec-binding.js";

test("Unit spec binding: extracts endpoints and acceptance criteria from spec markdown", () => {
  const signals = extractSpecContractSignals(`
# SPEC - Demo

## Endpoints
| Path | Method |
| --- | --- |
| /health | GET |
| /users/{id} | GET |

## Acceptance Criteria
1. Health endpoint returns 200.
2. User endpoint requires auth.
`);

  assert.deepEqual(signals.endpoints.includes("/health"), true);
  assert.deepEqual(signals.endpoints.includes("/users/{id}"), true);
  assert.equal(signals.acceptanceCriteria.length, 2);
});

test("Unit spec binding: extracts route literals from source code deterministically", () => {
  const routes = collectRouteLiteralsFromSource(`
app.get("/health", handler);
router.post('/admin/reset', resetHandler);
const data = await fetch('/users/me');
`);

  assert.deepEqual(routes.includes("/health"), true);
  assert.deepEqual(routes.includes("/admin/reset"), true);
  assert.deepEqual(routes.includes("/users/me"), true);
});

test("Unit spec binding: flags endpoint gaps when code introduces routes not declared in spec", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "create-sentinelayer-spec-binding-"));
  try {
    await mkdir(path.join(tempRoot, "src"), { recursive: true });
    await writeFile(
      path.join(tempRoot, "SPEC.md"),
      [
        "# SPEC - Demo",
        "",
        "## Endpoints",
        "- GET /health",
        "",
        "## Acceptance Criteria",
        "1. Health endpoint returns 200.",
      ].join("\n"),
      "utf-8"
    );
    const routeFile = path.join(tempRoot, "src", "routes.js");
    await writeFile(routeFile, "router.post('/admin/reset', handler);\n", "utf-8");

    const checks = await runSpecBindingChecks({
      targetPath: tempRoot,
      mode: "full",
      scopedFilePaths: [routeFile],
      maxFindings: 20,
    });

    assert.equal(checks.metadata.enabled, true);
    assert.equal(String(checks.metadata.specHashSha256 || "").length, 64);
    assert.equal(checks.metadata.endpointCount >= 1, true);
    assert.equal(checks.findings.some((finding) => finding.ruleId === "SL-SPEC-002"), true);
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("Unit spec binding: missing spec disables spec-binding checks without findings", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "create-sentinelayer-spec-binding-"));
  try {
    const filePath = path.join(tempRoot, "index.js");
    await writeFile(filePath, "const value = 1;\n", "utf-8");

    const checks = await runSpecBindingChecks({
      targetPath: tempRoot,
      mode: "full",
      scopedFilePaths: [filePath],
      maxFindings: 20,
    });

    assert.equal(checks.metadata.enabled, false);
    assert.deepEqual(checks.findings, []);
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});
