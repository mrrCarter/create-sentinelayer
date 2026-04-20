// coverage-gap — find source files without a matching test file (#A15).
//
// Zero-dep static pass: we don't try to read c8 / istanbul coverage JSON
// (that lives in a later PR). Instead we use filename-convention matching —
// for every `src/foo/bar.ts`, check whether any of the standard test file
// names exists. Misses catches the most valuable 80% of coverage gaps while
// staying fast and self-contained.

import path from "node:path";

import { createFinding, isTestFile, toPosix, walkRepoFiles } from "./base.js";

const SOURCE_EXTENSIONS = new Set([
  ".js",
  ".jsx",
  ".ts",
  ".tsx",
  ".mjs",
  ".cjs",
  ".py",
]);

// Generate plausible test-file locations for a source file. For
// src/foo/bar.ts, try tests/foo/bar.test.ts, src/foo/bar.test.ts,
// __tests__/foo/bar.test.ts, tests/foo/test_bar.py (Python), …
function candidateTestPaths(sourceRelativePath) {
  const posix = toPosix(sourceRelativePath);
  const ext = path.extname(posix).toLowerCase();
  const base = posix.slice(0, posix.length - ext.length);
  const fileName = path.posix.basename(base);
  const dir = path.posix.dirname(base);
  const candidates = new Set();

  if (ext === ".py") {
    candidates.add(`${dir}/${fileName}_test.py`);
    candidates.add(`${dir}/test_${fileName}.py`);
    candidates.add(`tests/${dir}/${fileName}_test.py`);
    candidates.add(`tests/${dir}/test_${fileName}.py`);
  } else {
    const testExts = [ext, `.test${ext}`];
    for (const testExt of testExts) {
      candidates.add(`${base}.test${ext}`);
      candidates.add(`${base}.spec${ext}`);
      candidates.add(`${dir}/__tests__/${fileName}.test${ext}`);
      candidates.add(`${dir}/__tests__/${fileName}${ext}`);
      candidates.add(`tests/${base}.test${ext}`);
      candidates.add(`tests/${dir}/${fileName}.test${ext}`);
      candidates.add(`test/${dir}/${fileName}.test${ext}`);
      candidates.add(`test/${dir}/${fileName}.spec${ext}`);
      // mjs test convention: tests/unit.{name}.test.mjs
      candidates.add(`tests/unit.${fileName}.test.mjs`);
      candidates.add(`tests/unit.${fileName}.test.js`);
    }
  }
  return candidates;
}

function isLikelyEntryFile(relativePath) {
  const p = toPosix(relativePath);
  return (
    /(^|\/)(index|main)\.[jt]sx?$/.test(p) ||
    /(^|\/)(bin|scripts)\//.test(p) ||
    /(^|\/)cli\.[jt]s$/.test(p)
  );
}

function isLikelyConfig(relativePath) {
  const p = toPosix(relativePath);
  return (
    /(^|\/)(config|constants|types?|schema|\.d\.ts)(\.[jt]sx?)?$/.test(p) ||
    /\.d\.ts$/.test(p)
  );
}

export async function runCoverageGap({ rootPath, files = null } = {}) {
  const resolvedRoot = path.resolve(String(rootPath || "."));

  // Pass 1: walk the repo once, collect source + test file lists.
  const sourceFiles = [];
  const testFiles = new Set();
  const iterator =
    Array.isArray(files) && files.length > 0
      ? iterateExplicitFiles(resolvedRoot, files)
      : walkRepoFiles({ rootPath: resolvedRoot, extensions: SOURCE_EXTENSIONS });

  for await (const { relativePath } of iterator) {
    if (isTestFile(relativePath)) {
      testFiles.add(toPosix(relativePath));
      continue;
    }
    sourceFiles.push(toPosix(relativePath));
  }

  const findings = [];
  for (const source of sourceFiles) {
    if (isLikelyEntryFile(source) || isLikelyConfig(source)) {
      continue;
    }
    const candidates = candidateTestPaths(source);
    const covered = Array.from(testFiles).some((test) => {
      for (const candidate of candidates) {
        if (test === candidate || test.endsWith(`/${path.posix.basename(candidate)}`)) {
          return true;
        }
      }
      return false;
    });
    if (covered) {
      continue;
    }
    findings.push(
      createFinding({
        tool: "coverage-gap",
        kind: "testing.coverage-gap",
        severity: "P2",
        file: source,
        line: 1,
        evidence: `No test file found for source: ${source}`,
        rootCause:
          "Source file has no corresponding test under standard naming conventions (`*.test.*`, `*.spec.*`, `test_*.py`, `__tests__/…`).",
        recommendedFix:
          "Add a unit test covering the file's exports, or add an explicit `.notest` marker / coverage-ignore annotation if this file is intentionally untested.",
        confidence: 0.6,
      })
    );
  }
  return findings;
}

async function* iterateExplicitFiles(resolvedRoot, files) {
  for (const file of files) {
    const trimmed = String(file || "").trim();
    if (!trimmed) {
      continue;
    }
    const fullPath = path.isAbsolute(trimmed)
      ? trimmed
      : path.join(resolvedRoot, trimmed);
    const relativePath = path
      .relative(resolvedRoot, fullPath)
      .replace(/\\/g, "/");
    yield { fullPath, relativePath };
  }
}
