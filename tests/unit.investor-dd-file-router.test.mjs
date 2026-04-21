// Unit tests for the per-persona deterministic file router (#investor-dd-3).

import test from "node:test";
import assert from "node:assert/strict";

import {
  INVESTOR_DD_PERSONA_RULES,
  matchesRule,
  scoreRiskSurface,
  toPosix,
  routeFilesToPersonas,
  summarizeRouting,
} from "../src/review/investor-dd-file-router.js";

test("toPosix normalizes Windows separators", () => {
  assert.equal(toPosix("src\\auth\\login.ts"), "src/auth/login.ts");
  assert.equal(toPosix("src/api/index.js"), "src/api/index.js");
  assert.equal(toPosix(null), "");
});

test("matchesRule requires include + extension + no exclude", () => {
  const rule = {
    include: ["/auth"],
    exclude: ["/__fixtures__/"],
    extensions: [".ts"],
  };
  assert.equal(matchesRule("src/auth/login.ts", rule), true);
  assert.equal(matchesRule("src/auth/login.py", rule), false, "extension mismatch");
  assert.equal(matchesRule("src/api/index.ts", rule), false, "include miss");
  assert.equal(
    matchesRule("src/__fixtures__/auth/x.ts", rule),
    false,
    "exclude hit",
  );
});

test("matchesRule with empty extensions matches any extension", () => {
  const rule = { include: ["package.json"], extensions: [], exclude: [] };
  assert.equal(matchesRule("package.json", rule), true);
  assert.equal(matchesRule("package-lock.json", rule), false);
});

test("security rule covers auth + session + crypto files", () => {
  const rule = INVESTOR_DD_PERSONA_RULES.security;
  assert.equal(matchesRule("src/auth/login.ts", rule), true);
  assert.equal(matchesRule("src/session/store.js", rule), true);
  assert.equal(matchesRule("src/crypto/hash.py", rule), true);
  assert.equal(matchesRule("src/ui/markdown.js", rule), false);
});

test("supply-chain rule covers lockfiles + manifests", () => {
  const rule = INVESTOR_DD_PERSONA_RULES["supply-chain"];
  assert.equal(matchesRule("package.json", rule), true);
  assert.equal(matchesRule("package-lock.json", rule), true);
  assert.equal(matchesRule("go.sum", rule), true);
  assert.equal(matchesRule("pyproject.toml", rule), true);
});

test("infrastructure rule catches terraform + Dockerfiles + workflows", () => {
  const rule = INVESTOR_DD_PERSONA_RULES.infrastructure;
  assert.equal(matchesRule("terraform/prod/main.tf", rule), true);
  assert.equal(matchesRule("ops/Dockerfile", rule), true);
  assert.equal(matchesRule(".github/workflows/deploy.yml", rule), true);
  assert.equal(matchesRule("src/api/server.ts", rule), false);
});

test("scoreRiskSurface ranks entry points highest", () => {
  const server = scoreRiskSurface("src/server/index.ts");
  const nested = scoreRiskSurface("src/deep/nested/path/util.ts");
  const readme = scoreRiskSurface("docs/guides/readme.md");
  assert.ok(server > nested, `server=${server} vs nested=${nested}`);
  assert.ok(server > readme, `server=${server} vs readme=${readme}`);
});

test("routeFilesToPersonas routes each persona independently", () => {
  const files = [
    "src/auth/login.ts",
    "src/api/server.ts",
    "src/frontend/ui/button.tsx",
    "src/db/schema.sql",
    "tests/unit.auth.test.mjs",
    "README.md",
    "package.json",
    "terraform/main.tf",
    ".github/workflows/ci.yml",
  ];
  const personas = [
    "security",
    "backend",
    "testing",
    "data-layer",
    "supply-chain",
    "infrastructure",
    "documentation",
  ];
  const routing = routeFilesToPersonas({ files, personas });

  assert.ok(routing.security.some((f) => f.includes("/auth/login.ts")));
  assert.ok(routing.backend.some((f) => f.includes("/api/server.ts")));
  assert.ok(routing.testing.some((f) => f.includes("unit.auth.test")));
  assert.ok(routing["data-layer"].some((f) => f.includes("schema.sql")));
  assert.ok(routing["supply-chain"].some((f) => f.includes("package.json")));
  assert.ok(routing.infrastructure.some((f) => f.includes("terraform/main.tf")));
  assert.ok(routing.infrastructure.some((f) => f.includes(".github/workflows/ci.yml")));
  assert.ok(routing.documentation.some((f) => f.includes("README.md")));
});

test("routeFilesToPersonas falls back to risk-surface when persona matches nothing", () => {
  const files = [
    "src/server/app.ts",
    "src/api/route.ts",
    "random/util.ts",
  ];
  // observability matches none of the files' substrings.
  const routing = routeFilesToPersonas({
    files,
    personas: ["observability"],
    fallbackCap: 3,
  });
  assert.equal(routing.observability.length, 3);
  // Should prefer entry-point-like files.
  assert.ok(routing.observability.some((f) => f.includes("/server/")) || routing.observability.some((f) => f.includes("/api/")));
});

test("routeFilesToPersonas unknown persona returns empty array", () => {
  const routing = routeFilesToPersonas({
    files: ["a.js"],
    personas: ["definitely-not-a-persona"],
  });
  assert.deepEqual(routing["definitely-not-a-persona"], []);
});

test("summarizeRouting counts overlap + unique files", () => {
  const routing = {
    security: ["src/auth/login.ts", "src/middleware/auth.ts"],
    backend: ["src/api/server.ts", "src/middleware/auth.ts"],
    testing: [],
  };
  const summary = summarizeRouting(routing);
  assert.equal(summary.totalFilesByPersona.security, 2);
  assert.equal(summary.totalFilesByPersona.backend, 2);
  assert.equal(summary.totalFilesByPersona.testing, 0);
  assert.equal(summary.uniqueFiles, 3);
  assert.deepEqual(summary.dedupIndex["src/middleware/auth.ts"].sort(), [
    "backend",
    "security",
  ]);
});

test("routeFilesToPersonas is deterministic across runs", () => {
  const files = [
    "src/auth/login.ts",
    "src/api/server.ts",
    "src/frontend/ui/button.tsx",
  ];
  const personas = ["security", "backend", "frontend"];
  const r1 = routeFilesToPersonas({ files, personas });
  const r2 = routeFilesToPersonas({ files, personas });
  assert.deepEqual(r1, r2);
});

test("INVESTOR_DD_PERSONA_RULES covers all 13 personas", () => {
  const required = [
    "security",
    "backend",
    "code-quality",
    "testing",
    "data-layer",
    "reliability",
    "release",
    "observability",
    "infrastructure",
    "supply-chain",
    "frontend",
    "documentation",
    "ai-governance",
  ];
  for (const id of required) {
    assert.ok(INVESTOR_DD_PERSONA_RULES[id], `missing rules for ${id}`);
  }
});
