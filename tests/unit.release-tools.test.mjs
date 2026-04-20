// Unit tests for Omar's release domain tools (#A19).

import test from "node:test";
import assert from "node:assert/strict";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  RELEASE_TOOLS,
  RELEASE_TOOL_IDS,
  dispatchReleaseTool,
  runAllReleaseTools,
  runChangelogDiff,
  runFeatureFlagAudit,
  runRollbackVerify,
  runSemverCheck,
} from "../src/agents/release/index.js";

async function makeTempRepo() {
  return fsp.mkdtemp(path.join(os.tmpdir(), "senti-release-"));
}

async function writeFile(root, relativePath, content) {
  const full = path.join(root, relativePath);
  await fsp.mkdir(path.dirname(full), { recursive: true });
  await fsp.writeFile(full, content, "utf-8");
}

test("RELEASE_TOOL_IDS surfaces the 4 spec'd tools", () => {
  assert.deepEqual([...RELEASE_TOOL_IDS].sort(), [
    "changelog-diff",
    "feature-flag-audit",
    "rollback-verify",
    "semver-check",
  ]);
});

test("semver-check: flags invalid version", async () => {
  const root = await makeTempRepo();
  try {
    await writeFile(
      root,
      "package.json",
      JSON.stringify({ name: "p", version: "1.0.beta" })
    );
    await writeFile(root, "CHANGELOG.md", "## [1.0.beta]\n");
    const findings = await runSemverCheck({ rootPath: root });
    assert.ok(findings.some((f) => f.kind === "release.invalid-semver"));
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});

test("semver-check: advises when changelog missing", async () => {
  const root = await makeTempRepo();
  try {
    await writeFile(
      root,
      "package.json",
      JSON.stringify({ name: "p", version: "1.0.0" })
    );
    const findings = await runSemverCheck({ rootPath: root });
    assert.ok(findings.some((f) => f.kind === "release.no-changelog"));
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});

test("semver-check: ignores private packages", async () => {
  const root = await makeTempRepo();
  try {
    await writeFile(
      root,
      "package.json",
      JSON.stringify({ name: "p", private: true, version: "not-semver" })
    );
    const findings = await runSemverCheck({ rootPath: root });
    assert.equal(findings.length, 0);
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});

test("changelog-diff: flags version not present in changelog", async () => {
  const root = await makeTempRepo();
  try {
    await writeFile(
      root,
      "package.json",
      JSON.stringify({ name: "p", version: "2.0.0" })
    );
    await writeFile(
      root,
      "CHANGELOG.md",
      "## [1.9.0] - 2025-01-01\n- old change\n"
    );
    const findings = await runChangelogDiff({ rootPath: root });
    assert.ok(findings.some((f) => f.kind === "release.version-not-in-changelog"));
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});

test("changelog-diff: suppresses when version is present", async () => {
  const root = await makeTempRepo();
  try {
    await writeFile(
      root,
      "package.json",
      JSON.stringify({ name: "p", version: "2.0.0" })
    );
    await writeFile(
      root,
      "CHANGELOG.md",
      "## [2.0.0] - 2026-04-01\n- ship it\n"
    );
    const findings = await runChangelogDiff({ rootPath: root });
    assert.equal(findings.length, 0);
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});

test("rollback-verify: flags Alembic file with empty downgrade", async () => {
  const root = await makeTempRepo();
  try {
    await writeFile(
      root,
      "alembic/versions/001_add_x.py",
      "def upgrade():\n    op.add_column('users', 'x')\n\ndef downgrade():\n    pass\n"
    );
    const findings = await runRollbackVerify({ rootPath: root });
    assert.ok(findings.some((f) => f.kind === "release.empty-downgrade"));
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});

test("rollback-verify: flags Rails migration without down/change", async () => {
  const root = await makeTempRepo();
  try {
    await writeFile(
      root,
      "db/migrate/20260101_add.rb",
      "class AddX < ActiveRecord::Migration[7.0]\n  def up\n    add_column :users, :x, :string\n  end\nend\n"
    );
    const findings = await runRollbackVerify({ rootPath: root });
    assert.ok(findings.some((f) => f.kind === "release.no-rails-down"));
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});

test("rollback-verify: suppresses Rails migration with def change", async () => {
  const root = await makeTempRepo();
  try {
    await writeFile(
      root,
      "db/migrate/20260101_add.rb",
      "class AddX < ActiveRecord::Migration[7.0]\n  def change\n    add_column :users, :x, :string\n  end\nend\n"
    );
    const findings = await runRollbackVerify({ rootPath: root });
    assert.equal(findings.length, 0);
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});

test("feature-flag-audit: flags stale useFlag call", async () => {
  const root = await makeTempRepo();
  try {
    const filePath = path.join(root, "app.js");
    await fsp.mkdir(path.dirname(filePath), { recursive: true });
    await fsp.writeFile(filePath, `const enabled = useFlag('new-ui');\n`, "utf-8");
    const old = Date.now() - 200 * 24 * 60 * 60 * 1000;
    await fsp.utimes(filePath, old / 1000, old / 1000);
    const findings = await runFeatureFlagAudit({ rootPath: root });
    assert.ok(findings.some((f) => f.kind === "release.stale-flag"));
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});

test("feature-flag-audit: suppresses when cleanup-by annotation present", async () => {
  const root = await makeTempRepo();
  try {
    const filePath = path.join(root, "app.js");
    await fsp.mkdir(path.dirname(filePath), { recursive: true });
    await fsp.writeFile(
      filePath,
      `// cleanup-by: 2026-12-01\nconst enabled = useFlag('new-ui');\n`,
      "utf-8"
    );
    const old = Date.now() - 200 * 24 * 60 * 60 * 1000;
    await fsp.utimes(filePath, old / 1000, old / 1000);
    const findings = await runFeatureFlagAudit({ rootPath: root });
    assert.equal(findings.length, 0);
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});

test("runAllReleaseTools: aggregates across tools", async () => {
  const root = await makeTempRepo();
  try {
    await writeFile(
      root,
      "package.json",
      JSON.stringify({ name: "p", version: "2.0.0" })
    );
    const findings = await runAllReleaseTools({ rootPath: root });
    const tools = new Set(findings.map((f) => f.tool));
    assert.ok(tools.has("semver-check"));
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});

test("RELEASE_TOOLS: each entry has id, description, schema, handler", () => {
  for (const toolId of RELEASE_TOOL_IDS) {
    const tool = RELEASE_TOOLS[toolId];
    assert.equal(tool.id, toolId);
    assert.ok(tool.description.length > 20);
    assert.equal(typeof tool.handler, "function");
    assert.equal(tool.schema.type, "object");
  }
});
