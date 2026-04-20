// Unit tests for src/ingest/ownership.js (#A10 file → persona ownership router).

import test from "node:test";
import assert from "node:assert/strict";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  buildOwnershipMap,
  computeRoutingStats,
  loadScaffoldConfig,
  parseScaffoldYaml,
  routeFileHeuristic,
  routeFindingsToPersonas,
} from "../src/ingest/ownership.js";
// Also assert that engine.js re-exports the public surface (spec §5.7).
import {
  buildOwnershipMap as engineBuildOwnershipMap,
  routeFindingsToPersonas as engineRouteFindings,
} from "../src/ingest/engine.js";

async function makeTempRoot() {
  return fsp.mkdtemp(path.join(os.tmpdir(), "senti-ownership-"));
}

test("engine.js re-exports the ownership API", () => {
  assert.equal(typeof engineBuildOwnershipMap, "function");
  assert.equal(typeof engineRouteFindings, "function");
});

test("parseScaffoldYaml: empty / whitespace → no rules", () => {
  assert.deepEqual(parseScaffoldYaml(""), { ownershipRules: [] });
  assert.deepEqual(parseScaffoldYaml("   "), { ownershipRules: [] });
});

test("parseScaffoldYaml: valid YAML with rules is parsed in order", () => {
  const yaml = `
ownership_rules:
  - pattern: "**/*"
    persona: backend
  - pattern: "app/**/*.tsx"
    persona: frontend
  - pattern: "lib/auth/**"
    persona: security
`;
  const parsed = parseScaffoldYaml(yaml);
  assert.equal(parsed.ownershipRules.length, 3);
  assert.deepEqual(parsed.ownershipRules[0], { pattern: "**/*", persona: "backend" });
  assert.deepEqual(parsed.ownershipRules[2], {
    pattern: "lib/auth/**",
    persona: "security",
  });
});

test("parseScaffoldYaml: rejects unknown personas", () => {
  const yaml = `
ownership_rules:
  - pattern: "**/*"
    persona: nonexistent-persona
`;
  assert.throws(
    () => parseScaffoldYaml(yaml),
    /ownership_rules.persona must be one of/
  );
});

test("parseScaffoldYaml: rejects missing pattern", () => {
  const yaml = `
ownership_rules:
  - persona: backend
`;
  assert.throws(
    () => parseScaffoldYaml(yaml),
    /ownership_rules\[0\]\.pattern is required/
  );
});

test("parseScaffoldYaml: rejects non-list ownership_rules", () => {
  const yaml = `
ownership_rules:
  pattern: "**/*"
  persona: backend
`;
  assert.throws(() => parseScaffoldYaml(yaml), /ownership_rules must be a list/);
});

test("parseScaffoldYaml: rejects malformed YAML", () => {
  assert.throws(() => parseScaffoldYaml(":::: not: valid: [yaml"), /not valid YAML/);
});

test("loadScaffoldConfig: returns found:false when file missing", async () => {
  const targetPath = await makeTempRoot();
  try {
    const cfg = await loadScaffoldConfig({ targetPath });
    assert.equal(cfg.found, false);
    assert.deepEqual(cfg.ownershipRules, []);
  } finally {
    await fsp.rm(targetPath, { recursive: true, force: true });
  }
});

test("loadScaffoldConfig: reads and parses .sentinelayer/scaffold.yaml", async () => {
  const targetPath = await makeTempRoot();
  try {
    const dir = path.join(targetPath, ".sentinelayer");
    await fsp.mkdir(dir, { recursive: true });
    await fsp.writeFile(
      path.join(dir, "scaffold.yaml"),
      `ownership_rules:\n  - pattern: "app/**/*.tsx"\n    persona: frontend\n`,
      "utf-8"
    );
    const cfg = await loadScaffoldConfig({ targetPath });
    assert.equal(cfg.found, true);
    assert.equal(cfg.ownershipRules.length, 1);
    assert.equal(cfg.ownershipRules[0].persona, "frontend");
  } finally {
    await fsp.rm(targetPath, { recursive: true, force: true });
  }
});

test("buildOwnershipMap: last-match-wins applies", () => {
  const config = {
    ownershipRules: [
      { pattern: "**/*", persona: "backend" },
      { pattern: "app/**/*.tsx", persona: "frontend" },
      { pattern: "app/auth/**", persona: "security" },
    ],
  };
  const map = buildOwnershipMap(
    [
      "app/auth/login.tsx",
      "app/dashboard/page.tsx",
      "server/handlers/pay.ts",
    ],
    config
  );
  // app/auth/login.tsx matches all three; last rule wins → security
  assert.equal(map.get("app/auth/login.tsx"), "security");
  // app/dashboard/page.tsx matches rules 1 & 2; last wins → frontend
  assert.equal(map.get("app/dashboard/page.tsx"), "frontend");
  // server/handlers/pay.ts matches only rule 1 → backend
  assert.equal(map.get("server/handlers/pay.ts"), "backend");
});

test("buildOwnershipMap: no scaffold → heuristic fallback", () => {
  const map = buildOwnershipMap(
    [
      "app/dashboard/page.tsx",
      "tests/unit.foo.test.mjs",
      "migrations/001_init.sql",
      "docs/runbook.md",
      "package.json",
    ],
    null
  );
  assert.equal(map.get("app/dashboard/page.tsx"), "frontend");
  assert.equal(map.get("tests/unit.foo.test.mjs"), "testing");
  assert.equal(map.get("migrations/001_init.sql"), "data-layer");
  assert.equal(map.get("docs/runbook.md"), "documentation");
  assert.equal(map.get("package.json"), "supply-chain");
});

test("buildOwnershipMap: normalizes backslashes and ./ prefix", () => {
  const map = buildOwnershipMap(["./app\\page.tsx"], null);
  assert.equal(map.get("app/page.tsx"), "frontend");
});

test("routeFileHeuristic: recognizes the 13 persona anchors", () => {
  const samples = {
    "tests/unit.foo.test.mjs": "testing",
    "docs/architecture.md": "documentation",
    "package.json": "supply-chain",
    ".github/workflows/deploy.yml": "release",
    "infra/terraform/main.tf": "infrastructure",
    "telemetry/metrics.ts": "observability",
    "ai/prompts/system.md": "ai-governance",
    "migrations/001_init.sql": "data-layer",
    "auth/middleware.ts": "security",
    "components/Header.tsx": "frontend",
    "health/liveness.ts": "reliability",
    ".eslintrc.json": "code-quality",
    "api/handlers/user.py": "backend",
  };
  for (const [input, expected] of Object.entries(samples)) {
    assert.equal(
      routeFileHeuristic(input),
      expected,
      `expected ${input} → ${expected}, got ${routeFileHeuristic(input)}`
    );
  }
});

test("routeFileHeuristic: unknown path falls back to backend", () => {
  assert.equal(routeFileHeuristic("some/weird/thing.xyz"), "backend");
  assert.equal(routeFileHeuristic(""), "backend");
});

test("routeFileHeuristic: respects custom fallback", () => {
  assert.equal(
    routeFileHeuristic("weird.xyz", { fallback: "code-quality" }),
    "code-quality"
  );
});

test("routeFindingsToPersonas: bins findings by ownership", () => {
  const map = new Map([
    ["app/page.tsx", "frontend"],
    ["api/handler.ts", "backend"],
    ["auth/guard.ts", "security"],
  ]);
  const findings = [
    { file: "app/page.tsx", severity: "P2", message: "missing alt text" },
    { file: "api/handler.ts", severity: "P1", message: "unvalidated input" },
    { file: "auth/guard.ts", severity: "P0", message: "bypass path" },
    { file: "app/page.tsx", severity: "P3", message: "dead code" },
  ];
  const grouped = routeFindingsToPersonas(findings, map);
  assert.equal(grouped.frontend.length, 2);
  assert.equal(grouped.backend.length, 1);
  assert.equal(grouped.security.length, 1);
});

test("routeFindingsToPersonas: falls back to heuristic when file not in map", () => {
  const map = new Map();
  const findings = [
    { file: "docs/readme.md", message: "outdated" },
  ];
  const grouped = routeFindingsToPersonas(findings, map);
  assert.ok(grouped.documentation);
  assert.equal(grouped.documentation.length, 1);
});

test("routeFindingsToPersonas: accepts .path or .location instead of .file", () => {
  const map = new Map([["api/x.ts", "backend"]]);
  const grouped = routeFindingsToPersonas(
    [
      { path: "api/x.ts", message: "a" },
      { location: "api/x.ts", message: "b" },
    ],
    map
  );
  assert.equal(grouped.backend.length, 2);
});

test("routeFindingsToPersonas: rejects non-object findings silently", () => {
  const map = new Map();
  const grouped = routeFindingsToPersonas(
    [null, "string", 42, { file: "api/x.ts" }],
    map
  );
  // Only the object finding is kept; it routes to heuristic 'backend'.
  assert.equal(Object.values(grouped).flat().length, 1);
});

test("computeRoutingStats: reports per-persona coverage and reduction %", () => {
  const map = new Map([
    ["app/a.tsx", "frontend"],
    ["app/b.tsx", "frontend"],
    ["api/x.ts", "backend"],
    ["auth/y.ts", "security"],
  ]);
  const stats = computeRoutingStats(map);
  assert.equal(stats.totalFiles, 4);
  assert.deepEqual(stats.personaCoverage, {
    frontend: 2,
    backend: 1,
    security: 1,
  });
  // Unrouted: 4 files × 13 personas = 52. Routed: 4. Reduction ≥ 92%.
  assert.ok(stats.tokenReductionEstimatePct >= 92);
});

test("computeRoutingStats: empty map reports zeros", () => {
  const stats = computeRoutingStats(new Map());
  assert.equal(stats.totalFiles, 0);
  assert.equal(stats.tokenReductionEstimatePct, 0);
});

test("glob semantics: ** matches across segments, * does not", () => {
  const config = {
    ownershipRules: [
      { pattern: "lib/*/index.ts", persona: "backend" },
      { pattern: "lib/**/helpers.ts", persona: "code-quality" },
    ],
  };
  const map = buildOwnershipMap(
    [
      "lib/foo/index.ts",           // matches rule 1 only
      "lib/foo/bar/index.ts",       // matches NEITHER (star doesn't cross /)
      "lib/foo/bar/helpers.ts",     // matches rule 2
    ],
    config
  );
  assert.equal(map.get("lib/foo/index.ts"), "backend");
  // No match → heuristic fallback (backend default for .ts files).
  assert.equal(map.get("lib/foo/bar/index.ts"), "backend");
  assert.equal(map.get("lib/foo/bar/helpers.ts"), "code-quality");
});
