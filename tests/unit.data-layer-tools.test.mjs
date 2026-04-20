// Unit tests for Linh's data-layer domain tools (#A17).

import test from "node:test";
import assert from "node:assert/strict";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  DATA_LAYER_TOOLS,
  DATA_LAYER_TOOL_IDS,
  dispatchDataLayerTool,
  runAllDataLayerTools,
  runIndexAudit,
  runMigrationScan,
  runQueryExplain,
  runTenancyScan,
} from "../src/agents/data-layer/index.js";

async function makeTempRepo() {
  return fsp.mkdtemp(path.join(os.tmpdir(), "senti-data-layer-"));
}

async function writeFile(root, relativePath, content) {
  const full = path.join(root, relativePath);
  await fsp.mkdir(path.dirname(full), { recursive: true });
  await fsp.writeFile(full, content, "utf-8");
}

test("DATA_LAYER_TOOL_IDS surfaces the 4 spec'd tools", () => {
  assert.deepEqual([...DATA_LAYER_TOOL_IDS].sort(), [
    "index-audit",
    "migration-scan",
    "query-explain",
    "tenancy-scan",
  ]);
});

test("dispatchDataLayerTool: unknown id throws", async () => {
  await assert.rejects(
    () => dispatchDataLayerTool("not-real", {}),
    /Unknown data-layer tool/
  );
});

test("query-explain: flags SELECT * and string-concat SQL", async () => {
  const root = await makeTempRepo();
  try {
    await writeFile(
      root,
      "api.js",
      `const id = req.query.id;\nconst q = db.raw("SELECT * FROM users WHERE id = " + id);\n`
    );
    const findings = await runQueryExplain({ rootPath: root });
    assert.ok(findings.some((f) => f.kind === "data.select-star"));
    assert.ok(findings.some((f) => f.kind === "data.string-concat-sql"));
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});

test("query-explain: flags findAll inside for-loop as N+1", async () => {
  const root = await makeTempRepo();
  try {
    await writeFile(
      root,
      "service.js",
      `for (const user of users) {\n  const posts = await Post.findAll({ where: { userId: user.id } });\n}\n`
    );
    const findings = await runQueryExplain({ rootPath: root });
    assert.ok(
      findings.some((f) => f.kind === "data.n-plus-one-findall-in-loop")
    );
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});

test("migration-scan: flags DROP TABLE in migration file", async () => {
  const root = await makeTempRepo();
  try {
    await writeFile(
      root,
      "migrations/20260101_drop_users.sql",
      "DROP TABLE users;\n"
    );
    const findings = await runMigrationScan({ rootPath: root });
    assert.ok(findings.some((f) => f.kind === "migration.drop-table"));
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});

test("migration-scan: flags ADD COLUMN NOT NULL without DEFAULT", async () => {
  const root = await makeTempRepo();
  try {
    await writeFile(
      root,
      "migrations/20260102_add_col.sql",
      "ALTER TABLE users ADD COLUMN email TEXT NOT NULL;\n"
    );
    const findings = await runMigrationScan({ rootPath: root });
    assert.ok(
      findings.some((f) => f.kind === "migration.add-column-not-null-no-default")
    );
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});

test("migration-scan: ignores SQL outside migrations dir", async () => {
  const root = await makeTempRepo();
  try {
    // SQL in a random file — not a migration path, shouldn't fire.
    await writeFile(root, "docs/example.sql", "DROP TABLE users;\n");
    const findings = await runMigrationScan({ rootPath: root });
    assert.equal(findings.length, 0);
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});

test("index-audit: flags WHERE column without matching index declaration", async () => {
  const root = await makeTempRepo();
  try {
    await writeFile(
      root,
      "models/User.js",
      `// Schema — no index on email yet\nexport const User = { email: "string" };\n`
    );
    await writeFile(
      root,
      "api.js",
      `const r = db.query("SELECT id FROM users WHERE email = ?", [x]);\n`
    );
    const findings = await runIndexAudit({ rootPath: root });
    assert.ok(
      findings.some((f) => f.kind === "data.missing-index" && f.evidence.includes("email"))
    );
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});

test("index-audit: suppresses when CREATE INDEX is present", async () => {
  const root = await makeTempRepo();
  try {
    await writeFile(
      root,
      "migrations/20260101_idx.sql",
      "CREATE INDEX idx_users_email ON users (email);\n"
    );
    await writeFile(
      root,
      "api.js",
      `const r = db.query("SELECT id FROM users WHERE email = ?", [x]);\n`
    );
    const findings = await runIndexAudit({ rootPath: root });
    assert.equal(
      findings.filter((f) => f.evidence.includes("email")).length,
      0
    );
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});

test("tenancy-scan: flags query against tenant table missing tenant filter", async () => {
  const root = await makeTempRepo();
  try {
    await writeFile(
      root,
      "models/Project.js",
      `class Project {\n  tenant_id: string;\n  name: string;\n}\n`
    );
    await writeFile(
      root,
      "api.js",
      `const r = await db.query("SELECT id FROM projects WHERE name = ?", [name]);\n`
    );
    const findings = await runTenancyScan({ rootPath: root });
    assert.ok(findings.some((f) => f.kind === "data.missing-tenancy-filter"));
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});

test("tenancy-scan: suppresses when tenant_id is in the WHERE", async () => {
  const root = await makeTempRepo();
  try {
    await writeFile(
      root,
      "models/Project.js",
      `class Project { tenant_id: string; name: string; }\n`
    );
    await writeFile(
      root,
      "api.js",
      `const r = await db.query("SELECT id FROM projects WHERE tenant_id = ? AND name = ?", [t, name]);\n`
    );
    const findings = await runTenancyScan({ rootPath: root });
    assert.equal(findings.length, 0);
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});

test("runAllDataLayerTools: aggregates across tools", async () => {
  const root = await makeTempRepo();
  try {
    await writeFile(
      root,
      "migrations/20260101_init.sql",
      "DROP TABLE legacy;\nCREATE TABLE users (id INT, email TEXT);\n"
    );
    await writeFile(
      root,
      "api.js",
      `const users = db.raw("SELECT * FROM users WHERE id = " + uid);\n`
    );
    const findings = await runAllDataLayerTools({ rootPath: root });
    const tools = new Set(findings.map((f) => f.tool));
    assert.ok(tools.has("migration-scan"));
    assert.ok(tools.has("query-explain"));
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});

test("DATA_LAYER_TOOLS: each entry has id, description, schema, handler", () => {
  for (const toolId of DATA_LAYER_TOOL_IDS) {
    const tool = DATA_LAYER_TOOLS[toolId];
    assert.equal(tool.id, toolId);
    assert.ok(tool.description.length > 20);
    assert.equal(typeof tool.handler, "function");
    assert.equal(tool.schema.type, "object");
  }
});
