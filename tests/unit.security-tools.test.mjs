// Unit tests for Nina's security-persona domain tools (#A13).

import test from "node:test";
import assert from "node:assert/strict";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  SECURITY_TOOLS,
  SECURITY_TOOL_IDS,
  dispatchSecurityTool,
  runAllSecurityTools,
  runAuthzAudit,
  runCryptoReview,
  runSastScan,
  runSecretsScan,
} from "../src/agents/security/index.js";

async function makeTempRepo() {
  return fsp.mkdtemp(path.join(os.tmpdir(), "senti-security-"));
}

async function writeFile(root, relativePath, content) {
  const fullPath = path.join(root, relativePath);
  await fsp.mkdir(path.dirname(fullPath), { recursive: true });
  await fsp.writeFile(fullPath, content, "utf-8");
}

test("SECURITY_TOOL_IDS surfaces the 4 spec'd tools", () => {
  assert.deepEqual([...SECURITY_TOOL_IDS].sort(), [
    "authz-audit",
    "crypto-review",
    "sast-scan",
    "secrets-scan",
  ]);
});

test("dispatchSecurityTool: unknown id throws", async () => {
  await assert.rejects(() => dispatchSecurityTool("definitely-not-a-tool", {}), /Unknown security tool/);
});

test("sast-scan: flags eval()", async () => {
  const root = await makeTempRepo();
  try {
    await writeFile(root, "app.js", "const run = (x) => eval(x);\n");
    const findings = await runSastScan({ rootPath: root });
    const hit = findings.find((f) => f.kind === "sast.eval");
    assert.ok(hit, "expected eval finding");
    assert.equal(hit.severity, "P0");
    assert.equal(hit.file, "app.js");
    assert.ok(hit.line >= 1);
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});

test("sast-scan: flags subprocess shell=True in Python", async () => {
  const root = await makeTempRepo();
  try {
    await writeFile(
      root,
      "tool.py",
      "import subprocess\nsubprocess.run(f'ls {user_input}', shell=True)\n"
    );
    const findings = await runSastScan({ rootPath: root });
    const hit = findings.find((f) => f.kind === "sast.python-subprocess-shell");
    assert.ok(hit);
    assert.equal(hit.severity, "P0");
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});

test("sast-scan: no false positive on eval-style but safe code", async () => {
  const root = await makeTempRepo();
  try {
    await writeFile(
      root,
      "safe.js",
      "// pretend this mentions 'eval' but doesn't call it\nconst note = 'do not eval this';\n"
    );
    const findings = await runSastScan({ rootPath: root });
    assert.equal(findings.length, 0);
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});

test("secrets-scan: detects GitHub PAT and redacts evidence", async () => {
  const root = await makeTempRepo();
  try {
    const token = `gh` + `p_` + "a".repeat(36);
    await writeFile(root, "config.js", `const TOKEN = "${token}";\n`);
    // Entropy of 'aaaaa...' is 0 which would normally fail the filter, so
    // construct a realistic token shape at runtime via concatenation — the
    // full literal never appears in source (avoids tripping other secret
    // scanners that would otherwise flag this test fixture).
    const realish = "gh" + "p_" + "aB3cD4eF5gH6iJ7kL8mN9oP0qR1sT2uV3w45";
    await writeFile(root, "config2.js", `const TOKEN = "${realish}";\n`);
    const findings = await runSecretsScan({ rootPath: root });
    const hit = findings.find((f) => f.kind === "secret.github-token");
    assert.ok(hit, "expected GitHub token finding");
    // Redacted evidence should not include the full token
    assert.ok(!hit.evidence.includes(realish));
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});

test("secrets-scan: entropy filter drops low-entropy placeholders", async () => {
  const root = await makeTempRepo();
  try {
    // Low-entropy "AAAA..." pattern that would match shape but fail entropy.
    const placeholder = `AKIA${"A".repeat(16)}`;
    await writeFile(root, "placeholder.env", `AWS_KEY=${placeholder}\n`);
    const findings = await runSecretsScan({ rootPath: root });
    const hit = findings.find((f) => f.kind === "secret.aws-access-key");
    // Entropy of all-A token is ~0, below minEntropy 3.0 → should be dropped.
    assert.equal(hit, undefined);
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});

test("secrets-scan: flags a PEM private key block", async () => {
  // Construct the PEM block at runtime so the literal pattern never
  // appears in this source file — otherwise self-scan flags this
  // fixture as a real P1 and breaks Quality Gates (pre-existing main
  // breakage from PR #375 fixed here). Same pattern established in
  // tests/unit.session-redact.test.mjs per .gitleaksignore policy.
  const pemHeader = ["-----BEGIN ", "RSA PRIVATE KEY", "-----"].join("");
  const pemFooter = ["-----END ", "RSA PRIVATE KEY", "-----"].join("");
  const pemBlock = `${pemHeader}\nabcdef\n${pemFooter}\n`;
  const root = await makeTempRepo();
  try {
    await writeFile(root, "keys/id_rsa", pemBlock);
    const findings = await runSecretsScan({ rootPath: root });
    const hit = findings.find((f) => f.kind === "secret.private-key-block");
    assert.ok(hit);
    assert.equal(hit.severity, "P0");
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});

test("authz-audit: flags unguarded POST handler", async () => {
  const root = await makeTempRepo();
  try {
    await writeFile(
      root,
      "server.js",
      `import express from "express";
const app = express();
app.post("/api/users", (req, res) => res.json({ ok: true }));
app.listen(3000);
`
    );
    const findings = await runAuthzAudit({ rootPath: root });
    const hit = findings.find((f) => f.kind === "authz.missing-guard");
    assert.ok(hit);
    assert.equal(hit.severity, "P1");
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});

test("authz-audit: does NOT flag guarded POST handler", async () => {
  const root = await makeTempRepo();
  try {
    await writeFile(
      root,
      "server.js",
      `import express from "express";
import { requireAuth } from "./auth.js";
const app = express();
app.post("/api/users", requireAuth, (req, res) => res.json({ ok: true }));
app.listen(3000);
`
    );
    const findings = await runAuthzAudit({ rootPath: root });
    assert.equal(findings.length, 0);
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});

test("authz-audit: flags unguarded FastAPI POST", async () => {
  const root = await makeTempRepo();
  try {
    await writeFile(
      root,
      "api.py",
      `from fastapi import APIRouter
router = APIRouter()

@router.post("/users")
def create_user(body: dict):
    return {"ok": True}
`
    );
    const findings = await runAuthzAudit({ rootPath: root });
    const hit = findings.find((f) => f.kind === "authz.missing-guard");
    assert.ok(hit);
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});

test("crypto-review: flags MD5 and Math.random for token", async () => {
  const root = await makeTempRepo();
  try {
    await writeFile(
      root,
      "hash.js",
      `const crypto = require("crypto");
const hash = crypto.createHash("md5").update("x").digest("hex");
const token = Math.random().toString(36);
`
    );
    const findings = await runCryptoReview({ rootPath: root });
    assert.ok(findings.some((f) => f.kind === "crypto.md5"));
    assert.ok(findings.some((f) => f.kind === "crypto.math-random-security"));
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});

test("crypto-review: flags rejectUnauthorized false and verify=False", async () => {
  const root = await makeTempRepo();
  try {
    await writeFile(
      root,
      "api.js",
      `https.request({ rejectUnauthorized: false });\n`
    );
    await writeFile(
      root,
      "client.py",
      `requests.get("https://example.com", verify=False)\n`
    );
    const findings = await runCryptoReview({ rootPath: root });
    assert.ok(findings.some((f) => f.kind === "crypto.tls-reject-off"));
    assert.ok(findings.some((f) => f.kind === "crypto.python-verify-off"));
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});

test("dispatchSecurityTool: runs each registered tool", async () => {
  const root = await makeTempRepo();
  try {
    await writeFile(root, "trigger.js", "const run = (x) => eval(x);\n");
    for (const toolId of SECURITY_TOOL_IDS) {
      const out = await dispatchSecurityTool(toolId, { rootPath: root });
      assert.ok(Array.isArray(out), `${toolId} should return an array`);
    }
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});

test("runAllSecurityTools: aggregates findings across tools", async () => {
  const root = await makeTempRepo();
  try {
    await writeFile(root, "app.js", `const run = (x) => eval(x);\n`);
    await writeFile(root, "server.js", `app.post("/api", (req, res) => res.json({}));\n`);
    const findings = await runAllSecurityTools({ rootPath: root });
    assert.ok(findings.length >= 2);
    const tools = new Set(findings.map((f) => f.tool));
    assert.ok(tools.has("sast-scan"));
    assert.ok(tools.has("authz-audit"));
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});

test("SECURITY_TOOLS: each entry has id, description, schema, handler", () => {
  for (const toolId of SECURITY_TOOL_IDS) {
    const tool = SECURITY_TOOLS[toolId];
    assert.equal(tool.id, toolId);
    assert.ok(tool.description.length > 20);
    assert.equal(typeof tool.handler, "function");
    assert.equal(tool.schema.type, "object");
  }
});
