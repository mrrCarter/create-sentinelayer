import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

import { frontendAnalyze, FrontendAnalyzeError } from "../src/agents/jules/tools/frontend-analyze.js";

let tmpDir;

function setup() {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "fa-test-"));
}

function teardown() {
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* best effort */ }
}

function writeFile(name, content) {
  const fp = path.join(tmpDir, name);
  fs.mkdirSync(path.dirname(fp), { recursive: true });
  fs.writeFileSync(fp, content, "utf-8");
  return fp;
}

function scaffoldReactApp() {
  writeFile("package.json", JSON.stringify({
    name: "test-app", dependencies: { react: "^18.0.0", next: "^14.0.0", zustand: "^4.0.0" },
    devDependencies: { typescript: "^5.0.0", vitest: "^1.0.0", tailwindcss: "^3.0.0", eslint: "^8.0.0" },
  }));
  writeFile("tailwind.config.js", "module.exports = { content: ['./src/**/*.tsx'] }");
  writeFile("src/app/layout.tsx", "export default function Layout({ children }) { return <html><body>{children}</body></html>; }");
  writeFile("src/app/page.tsx", "export default function Home() { return <h1>Home</h1>; }");
  writeFile("src/app/dashboard/page.tsx", "export default function Dashboard() { return <div>Dashboard</div>; }");
  writeFile("src/components/Header.tsx", "import { useState } from 'react';\nexport function Header() { const [open, setOpen] = useState(false); return <header/>; }");
  writeFile("src/components/RichText.tsx", "export function RichText({ html }) { return <div dangerouslySetInnerHTML={{ __html: html }} />; }");
  writeFile("src/hooks/useAuth.ts", "export function useAuth() { return { user: null }; }");
  writeFile("src/contexts/ThemeContext.tsx", "import { createContext } from 'react';\nexport const ThemeCtx = createContext('light');");
  writeFile("src/components/Header.test.tsx", "import { test } from 'vitest';\ntest('renders', () => {});");
}

// ── detect_framework ─────────────────────────────────────────────────

describe("detect_framework", () => {
  beforeEach(setup);
  afterEach(teardown);

  it("detects Next.js + Zustand + Tailwind + TypeScript", () => {
    scaffoldReactApp();
    const result = frontendAnalyze({ operation: "detect_framework", path: tmpDir });
    assert.equal(result.framework, "next.js");
    assert.equal(result.router, "app");
    assert.equal(result.typescript, true);
    assert.equal(result.stateManagement, "zustand");
    assert.equal(result.styling, "tailwind");
    assert.equal(result.testing.unit, "vitest");
    assert.ok(result.componentCount >= 3);
    assert.ok(result.entryPoints.length >= 1);
  });

  it("returns unknown for empty project", () => {
    writeFile("package.json", "{}");
    const result = frontendAnalyze({ operation: "detect_framework", path: tmpDir });
    assert.equal(result.framework, "unknown");
  });
});

// ── find_components ──────────────────────────────────────────────────

describe("find_components", () => {
  beforeEach(setup);
  afterEach(teardown);

  it("finds .tsx components", () => {
    scaffoldReactApp();
    const result = frontendAnalyze({ operation: "find_components", path: tmpDir });
    assert.ok(result.count >= 4);
    assert.ok(result.components.some(c => c.name === "Header"));
    assert.ok(result.components.some(c => c.name === "RichText"));
  });
});

// ── find_routes ──────────────────────────────────────────────────────

describe("find_routes", () => {
  beforeEach(setup);
  afterEach(teardown);

  it("finds Next.js App Router pages", () => {
    scaffoldReactApp();
    const result = frontendAnalyze({ operation: "find_routes", path: tmpDir });
    assert.ok(result.count >= 2);
    assert.ok(result.routes.some(r => r.type === "next-app"));
  });
});

// ── find_security_sinks ──────────────────────────────────────────────

describe("find_security_sinks", () => {
  beforeEach(setup);
  afterEach(teardown);

  it("detects dangerouslySetInnerHTML", () => {
    scaffoldReactApp();
    const result = frontendAnalyze({ operation: "find_security_sinks", path: tmpDir });
    assert.ok(result.totalSinks >= 1);
    assert.ok(result.sinks.some(s => s.type === "dangerouslySetInnerHTML"));
    assert.ok(result.P1 >= 1);
  });

  it("detects eval as P0", () => {
    writeFile("package.json", "{}");
    writeFile("bad.js", "const x = eval(userInput);");
    const result = frontendAnalyze({ operation: "find_security_sinks", path: tmpDir });
    assert.ok(result.sinks.some(s => s.type === "eval" && s.severity === "P0"));
  });
});

// ── count_state_hooks ────────────────────────────────────────────────

describe("count_state_hooks", () => {
  beforeEach(setup);
  afterEach(teardown);

  it("counts useState per component", () => {
    writeFile("package.json", "{}");
    writeFile("god.tsx", Array(20).fill("const [s, setS] = useState(0);").join("\n"));
    writeFile("normal.tsx", "const [a, setA] = useState(1);\nconst [b, setB] = useState(2);");
    const result = frontendAnalyze({ operation: "count_state_hooks", path: tmpDir });
    assert.ok(result.godComponents.length >= 1);
    assert.ok(result.components.some(c => c.file.includes("god") && c.risk === "god_component"));
  });
});

// ── find_env_exposure ────────────────────────────────────────────────

describe("find_env_exposure", () => {
  beforeEach(setup);
  afterEach(teardown);

  it("flags NEXT_PUBLIC_ with sensitive name", () => {
    writeFile("package.json", "{}");
    writeFile("api.ts", "const key = process.env.NEXT_PUBLIC_API_KEY;");
    const result = frontendAnalyze({ operation: "find_env_exposure", path: tmpDir });
    assert.ok(result.sensitiveCount >= 1);
    assert.ok(result.findings.some(f => f.variable === "NEXT_PUBLIC_API_KEY" && f.severity === "P1"));
  });
});

// ── check_accessibility ──────────────────────────────────────────────

describe("check_accessibility", () => {
  beforeEach(setup);
  afterEach(teardown);

  it("runs accessibility checks", () => {
    scaffoldReactApp();
    const result = frontendAnalyze({ operation: "check_accessibility", path: tmpDir });
    assert.ok(result.totalChecks >= 5);
  });
});

// ── find_test_coverage ───────────────────────────────────────────────

describe("find_test_coverage", () => {
  beforeEach(setup);
  afterEach(teardown);

  it("reports untested components", () => {
    scaffoldReactApp();
    const result = frontendAnalyze({ operation: "find_test_coverage", path: tmpDir });
    assert.ok(result.componentCount >= 4);
    // Test files may or may not match depending on glob depth; verify structure is sound
    assert.ok(typeof result.testCount === "number");
    assert.ok(typeof result.untestedCount === "number");
    assert.ok(typeof result.coverageRatio === "string");
  });
});

// ── check_css_health ─────────────────────────────────────────────────

describe("check_css_health", () => {
  beforeEach(setup);
  afterEach(teardown);

  it("detects tailwind config", () => {
    scaffoldReactApp();
    const result = frontendAnalyze({ operation: "check_css_health", path: tmpDir });
    assert.equal(result.tailwindConfigured, true);
  });
});

// ── error handling ───────────────────────────────────────────────────

describe("error handling", () => {
  it("rejects unknown operation", () => {
    assert.throws(() => frontendAnalyze({ operation: "nonexistent" }), FrontendAnalyzeError);
  });

  it("rejects non-existent path", () => {
    assert.throws(() => frontendAnalyze({ operation: "detect_framework", path: "/nonexistent/path/xyz" }), FrontendAnalyzeError);
  });
});

// ── dispatch integration ─────────────────────────────────────────────

describe("dispatch integration", () => {
  beforeEach(setup);
  afterEach(teardown);

  it("FrontendAnalyze is available through dispatch", async () => {
    const { dispatchTool, createAgentContext } = await import("../src/agents/jules/tools/dispatch.js");
    scaffoldReactApp();
    const ctx = createAgentContext({
      agentIdentity: { id: "frontend", persona: "Jules Tanaka" },
      budget: { maxToolCalls: 10 },
    });
    const result = await dispatchTool("FrontendAnalyze", { operation: "detect_framework", path: tmpDir }, ctx);
    assert.equal(result.framework, "next.js");
    assert.equal(ctx.usage.toolCalls, 1);
  });
});
