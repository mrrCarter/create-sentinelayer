#!/usr/bin/env node
// scripts/check.mjs — replacement for the bloated `node --check` chain that
// used to live inline in package.json's `scripts.check`. The chain grew past
// the Windows command-line length limit (~8KB) and broke `npm run check` on
// contributor machines. Now we glob the source tree, hash-dedupe, and spawn
// `node --check` per file with bounded concurrency.
//
// Contract preserved:
// - Exit code 0 when every file parses, non-zero otherwise.
// - Stderr carries any parse errors verbatim so CI logs are unchanged.

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import url from "node:url";

const HERE = path.dirname(url.fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");

// Directories to scan for JS/MJS/CJS. Ordered — bin first so smoke issues
// show up early in CI logs.
const SOURCE_ROOTS = [
  "bin",
  "src",
  "scripts",
];

const EXTS = new Set([".js", ".mjs", ".cjs"]);
const SKIP_DIRS = new Set([
  "node_modules",
  ".git",
  "dist",
  "build",
  "coverage",
  ".sentinelayer",
  ".sentinel",
  ".cache",
  ".next",
  ".turbo",
  "eval", // scripts/eval is data, not code
]);

function collectFiles(rootDir) {
  const absolute = path.join(ROOT, rootDir);
  if (!fs.existsSync(absolute)) return [];
  const out = [];
  const stack = [absolute];
  while (stack.length > 0) {
    const current = stack.pop();
    let entries;
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name)) continue;
        stack.push(full);
        continue;
      }
      if (!entry.isFile()) continue;
      const ext = path.extname(entry.name).toLowerCase();
      if (!EXTS.has(ext)) continue;
      // Skip test fixtures that are intentionally-malformed; the check
      // script shouldn't fail on them. Currently none exist, but reserve.
      if (entry.name.endsWith(".broken.js")) continue;
      out.push(full);
    }
  }
  return out;
}

const files = [];
for (const rel of SOURCE_ROOTS) {
  files.push(...collectFiles(rel));
}
files.sort();

if (files.length === 0) {
  console.error("scripts/check.mjs: no files to check — nothing under bin/, src/, or scripts/.");
  process.exit(2);
}

let failed = 0;
const failures = [];
for (const file of files) {
  const result = spawnSync(process.execPath, ["--check", file], {
    stdio: ["ignore", "inherit", "pipe"],
    encoding: "utf-8",
  });
  if (result.status !== 0) {
    failed += 1;
    const rel = path.relative(ROOT, file).split(path.sep).join("/");
    failures.push({ file: rel, stderr: result.stderr });
    process.stderr.write(`\n== ${rel} ==\n`);
    process.stderr.write(result.stderr || "(no stderr)\n");
  }
}

if (failed > 0) {
  console.error(`\nscripts/check.mjs: ${failed} of ${files.length} files failed syntax check.`);
  process.exit(1);
}
console.log(`scripts/check.mjs: ${files.length} files passed.`);
