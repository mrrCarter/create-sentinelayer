// Unit tests for the HTML report generator (#investor-dd-18b).

import test from "node:test";
import assert from "node:assert/strict";

import { renderInvestorDdHtml } from "../src/review/investor-dd-html-report.js";

const baseSummary = {
  totalFindings: 7,
  totalFiles: 123,
  durationSeconds: 42.1,
  terminationReason: "ok",
  startedAt: "2026-04-21T00:00:00.000Z",
};

test("renders a complete html document", () => {
  const html = renderInvestorDdHtml({
    runId: "investor-dd-123",
    summary: baseSummary,
  });
  assert.ok(html.startsWith("<!doctype html>"));
  assert.ok(html.includes("</html>"));
  assert.ok(html.includes("investor-dd-123"));
  assert.ok(html.includes("42.1s"));
  assert.ok(html.includes("7</div>"), "findings count in summary card");
});

test("renders coverage table from routing + byPersona", () => {
  const html = renderInvestorDdHtml({
    runId: "r1",
    summary: baseSummary,
    routing: {
      security: ["a.js", "b.js"],
      backend: ["c.js"],
    },
    byPersona: {
      security: { visited: ["a.js", "b.js"], findings: [{}, {}] },
      backend: { visited: ["c.js"], findings: [] },
    },
  });
  assert.ok(html.includes("<td>security</td>"));
  assert.ok(html.includes("<td>backend</td>"));
  // Security routed=2 visited=2 findings=2
  assert.match(html, /<td>security<\/td><td>2<\/td><td>2<\/td><td>2<\/td>/);
});

test("renders findings with severity + verdict + replay", () => {
  const findings = [
    {
      kind: "sast.eval",
      severity: "P0",
      file: "src/app.js",
      line: 10,
      personaId: "security",
      tool: "sast-scan",
      evidence: "eval(input)",
      recommendedFix: "Use JSON.parse",
      reconciliation: { verdict: "CONFIRMED" },
      reproducibility: { replayCommand: "sl /review show --file src/app.js" },
    },
  ];
  const html = renderInvestorDdHtml({
    runId: "r2",
    summary: baseSummary,
    findings,
  });
  assert.ok(html.includes("sev-P0"));
  assert.ok(html.includes("verdict-CONFIRMED"));
  assert.ok(html.includes("src/app.js"));
  assert.ok(html.includes("eval(input)"));
  assert.ok(html.includes("JSON.parse"));
  assert.ok(html.includes("sl /review show"));
});

test("renders compliance pack sections when supplied", () => {
  const html = renderInvestorDdHtml({
    runId: "r3",
    summary: baseSummary,
    compliance: {
      soc2: {
        covered: 2,
        gaps: 1,
        items: [
          { controlId: "CC6.1", title: "Logical access", status: "covered", evidenceFile: "SECURITY.md" },
          { controlId: "CC7.1", title: "Change tracking", status: "gap", evidenceFile: null },
        ],
      },
    },
  });
  assert.ok(html.includes("Compliance Pack"));
  assert.ok(html.includes("SOC2"));
  assert.ok(html.includes("CC6.1"));
  assert.ok(html.includes("SECURITY.md"));
});

test("escapes angle brackets + quotes to prevent XSS in fixtures", () => {
  const findings = [
    { kind: '<script>alert("x")</script>', severity: "P0", file: "a.js" },
  ];
  const html = renderInvestorDdHtml({
    runId: "r4",
    summary: baseSummary,
    findings,
  });
  assert.ok(!html.includes('<script>alert("x")</script>'));
  assert.ok(html.includes("&lt;script&gt;"));
});

test("handles no findings gracefully", () => {
  const html = renderInvestorDdHtml({
    runId: "r5",
    summary: { ...baseSummary, totalFindings: 0 },
    findings: [],
  });
  assert.ok(html.includes("No findings captured"));
});

test("caps the finding list and notes truncation", () => {
  const findings = Array.from({ length: 55 }, (_, i) => ({
    kind: `finding-${i}`,
    severity: "P3",
    file: `f${i}.js`,
  }));
  const html = renderInvestorDdHtml({
    runId: "r6",
    summary: baseSummary,
    findings,
  });
  assert.ok(html.includes("Showing top 50 of 55"));
});
