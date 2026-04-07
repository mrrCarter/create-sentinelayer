import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import {
  getExpressTemplate,
  getPackageJsonTemplate,
  buildReadmeContent,
  TEMPLATE_REGISTRY,
} from "../src/scaffold/templates.js";
import { generateScaffold } from "../src/scaffold/generator.js";

test("getExpressTemplate returns expected file map", () => {
  const files = getExpressTemplate({ projectName: "demo-app", description: "A demo" });
  assert.ok(files["src/index.js"], "Missing src/index.js");
  assert.ok(files["src/routes/health.js"], "Missing src/routes/health.js");
  assert.ok(files["tests/health.test.js"], "Missing tests/health.test.js");
  assert.ok(files[".gitignore"], "Missing .gitignore");
  assert.ok(files[".env.example"], "Missing .env.example");
  assert.ok(files["src/index.js"].includes("express"), "index.js should reference express");
  assert.ok(files["src/index.js"].includes("demo-app"), "index.js should include project name");
});

test("getPackageJsonTemplate returns valid package structure", () => {
  const pkg = getPackageJsonTemplate({ projectName: "test-app", description: "Test" });
  assert.equal(pkg.name, "test-app");
  assert.equal(pkg.type, "module");
  assert.ok(pkg.dependencies.express, "Missing express dependency");
  assert.ok(pkg.dependencies.jsonwebtoken, "Missing jsonwebtoken dependency");
  assert.ok(pkg.dependencies.bcrypt, "Missing bcrypt dependency");
  assert.ok(pkg.scripts.start, "Missing start script");
  assert.ok(pkg.scripts.test, "Missing test script");
});

test("buildReadmeContent includes project details", () => {
  const readme = buildReadmeContent({
    projectName: "my-project",
    description: "A great project",
    techStack: "Node.js + Express",
  });
  assert.ok(readme.includes("# my-project"), "Missing project name heading");
  assert.ok(readme.includes("A great project"), "Missing description");
  assert.ok(readme.includes("Node.js + Express"), "Missing tech stack");
  assert.ok(readme.includes("npm install"), "Missing install instructions");
  assert.ok(readme.includes("npm test"), "Missing test instructions");
});

test("TEMPLATE_REGISTRY has rest-api-express entry", () => {
  const entry = TEMPLATE_REGISTRY["rest-api-express"];
  assert.ok(entry, "Missing rest-api-express template");
  assert.equal(entry.name, "REST API (Express.js)");
  assert.equal(typeof entry.getFiles, "function");
  assert.equal(typeof entry.getPackageJson, "function");
});

test("generateScaffold writes files into empty directory", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "scaffold-test-"));
  try {
    const files = getExpressTemplate({ projectName: "test", description: "Test" });
    const pkg = getPackageJsonTemplate({ projectName: "test", description: "Test" });
    const readme = buildReadmeContent({ projectName: "test", description: "Test" });

    const result = await generateScaffold({
      projectDir: tempDir,
      templateFiles: files,
      packageJsonTemplate: pkg,
      readmeContent: readme,
      force: false,
    });

    assert.ok(result.written.length > 0, "Should have written files");
    assert.ok(result.written.includes("src/index.js"), "Should have written src/index.js");
    assert.ok(result.written.includes("README.md"), "Should have written README.md");
    assert.ok(result.written.some((f) => f.includes("package.json")), "Should have written package.json");
    assert.equal(result.skipped.length, 0, "Should not have skipped any files");

    const indexContent = await readFile(path.join(tempDir, "src", "index.js"), "utf-8");
    assert.ok(indexContent.includes("express"), "Generated index.js should use express");
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("generateScaffold skips existing files without force", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "scaffold-skip-"));
  try {
    const files = getExpressTemplate({ projectName: "test", description: "Test" });
    const pkg = getPackageJsonTemplate({ projectName: "test", description: "Test" });

    // First scaffold
    await generateScaffold({
      projectDir: tempDir,
      templateFiles: files,
      packageJsonTemplate: pkg,
      readmeContent: null,
      force: false,
    });

    // Second scaffold should skip existing files
    const result = await generateScaffold({
      projectDir: tempDir,
      templateFiles: files,
      packageJsonTemplate: pkg,
      readmeContent: null,
      force: false,
    });

    assert.ok(result.skipped.length > 0, "Should have skipped existing files");
    // package.json gets merged, so it's always in written
    const nonPkgWritten = result.written.filter((f) => !f.includes("package.json"));
    assert.equal(nonPkgWritten.length, 0, "Should not write non-package.json files on re-run");
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});
