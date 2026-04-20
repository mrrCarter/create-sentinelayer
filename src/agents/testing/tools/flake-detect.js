// flake-detect — flag flakiness smells in test files (#A15).
//
// The usual suspects: tests that sleep, rely on wall-clock arithmetic, hit
// the real network, or seed randomness without a fixed seed. We scan test
// files specifically (the coverage-gap heuristic for "is this a test") so
// the tool doesn't flag production code that legitimately uses setTimeout.

import fsp from "node:fs/promises";
import path from "node:path";

import { createFinding, findLineMatches, getLineContent, isTestFile, toPosix, walkRepoFiles } from "./base.js";

const TEST_EXTENSIONS = new Set([
  ".js",
  ".jsx",
  ".ts",
  ".tsx",
  ".mjs",
  ".cjs",
  ".py",
]);

const RULES = [
  {
    id: "flake.sleep-in-test",
    // setTimeout(fn, 500) or sleep(2) in a test file — schedule-based flake
    pattern: /\b(?:setTimeout|setInterval|sleep|time\.sleep|asyncio\.sleep)\s*\(\s*(?:\w+\s*,\s*)?\d{3,}\s*[,)]/,
    severity: "P2",
    rootCause:
      "Test sleeps for a fixed wall-clock duration — slow on CI, flaky on loaded machines.",
    recommendedFix:
      "Use fake timers (jest.useFakeTimers, vi.useFakeTimers, freezegun) or event-based waits (await page.waitForSelector / waitForResponse).",
    confidence: 0.7,
  },
  {
    id: "flake.wall-clock-assertion",
    pattern: /expect\s*\(\s*(?:Date\.now\(\)|new\s+Date\(\)\.getTime\(\))\s*\)/,
    severity: "P1",
    rootCause:
      "Assertion compares against the live wall clock — value drifts between runs.",
    recommendedFix:
      "Freeze time (jest.setSystemTime, vi.setSystemTime, freezegun) or pass a Date supplier the SUT reads from.",
    confidence: 0.8,
  },
  {
    id: "flake.unstubbed-network",
    // fetch / axios / requests in a test file — likely reaching out to real
    // network. Real-network hits are the #1 flake source.
    pattern: /\b(?:fetch|axios(?:\.[a-z]+)?|got(?:\.[a-z]+)?|requests\.(?:get|post|put|patch|delete|request))\s*\(/,
    severity: "P1",
    rootCause:
      "Test makes a live network call. Real-network tests flake on DNS / TLS / rate limits and make CI unreliable.",
    recommendedFix:
      "Mock the client with msw / nock / vcr-py, or inject an HTTP transport and pass a fake in tests.",
    confidence: 0.65,
  },
  {
    id: "flake.unseeded-random",
    pattern: /\b(?:Math\.random|random\.(?:random|uniform|shuffle|choice))\s*\(/,
    severity: "P2",
    rootCause:
      "Test uses unseeded randomness — two runs can take different branches and produce different results.",
    recommendedFix:
      "Seed the generator or pass a stub random() into the SUT via DI. For Jest / Vitest you can mock Math.random.",
    confidence: 0.55,
  },
];

export async function runFlakeDetect({ rootPath, files = null } = {}) {
  const resolvedRoot = path.resolve(String(rootPath || "."));
  const iterator =
    Array.isArray(files) && files.length > 0
      ? iterateExplicitFiles(resolvedRoot, files)
      : walkRepoFiles({ rootPath: resolvedRoot, extensions: TEST_EXTENSIONS });

  const findings = [];
  for await (const { fullPath, relativePath } of iterator) {
    const relPos = toPosix(relativePath);
    if (!isTestFile(relPos)) {
      continue;
    }
    let content;
    try {
      content = await fsp.readFile(fullPath, "utf-8");
    } catch {
      continue;
    }
    for (const rule of RULES) {
      for (const match of findLineMatches(content, rule.pattern)) {
        findings.push(
          createFinding({
            tool: "flake-detect",
            kind: rule.id,
            severity: rule.severity,
            file: relPos,
            line: match.line,
            evidence: getLineContent(content, match.line),
            rootCause: rule.rootCause,
            recommendedFix: rule.recommendedFix,
            confidence: rule.confidence,
          })
        );
      }
    }
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

export { RULES as FLAKE_RULES };
