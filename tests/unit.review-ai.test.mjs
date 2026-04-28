import test from "node:test";
import assert from "node:assert/strict";

import { buildAiReviewPrompt, parseAiReviewResponse } from "../src/review/ai-review.js";

test("Unit AI review: parse structured JSON response into normalized findings", () => {
  const response = {
    summary: {
      highLevel: "High risk due to unsafe sink handling.",
    },
    findings: [
      {
        severity: "p1",
        file: "src/ui/render.jsx",
        line: 18,
        title: "Unsanitized HTML sink",
        rationale: "User input can reach dangerouslySetInnerHTML without sanitization.",
        suggestedFix: "Use sanitization before rendering untrusted content.",
        confidence: 0.91,
      },
      {
        severity: "unknown",
        file: "",
        line: "bad",
        title: "",
        rationale: "",
        suggestedFix: "",
      },
    ],
  };

  const parsed = parseAiReviewResponse({
    text: JSON.stringify(response),
    maxFindings: 10,
  });

  assert.equal(parsed.parser, "json");
  assert.equal(parsed.findings.length, 2);
  assert.equal(parsed.findings[0].severity, "P1");
  assert.equal(parsed.findings[0].file, "src/ui/render.jsx");
  assert.equal(parsed.findings[0].line, 18);
  assert.equal(parsed.findings[1].severity, "P2");
  assert.equal(parsed.findings[1].file, "unknown");
  assert.equal(parsed.findings[1].line, 1);
});

test("Unit AI review: parse fenced JSON and enforce max findings cap", () => {
  const raw = [
    "```json",
    JSON.stringify(
      {
        summary: "Medium risk",
        findings: [
          { severity: "P2", file: "a.js", line: 1, title: "A", rationale: "A", suggestedFix: "A" },
          { severity: "P2", file: "b.js", line: 2, title: "B", rationale: "B", suggestedFix: "B" },
          { severity: "P3", file: "c.js", line: 3, title: "C", rationale: "C", suggestedFix: "C" },
        ],
      },
      null,
      2
    ),
    "```",
  ].join("\n");

  const parsed = parseAiReviewResponse({
    text: raw,
    maxFindings: 2,
  });

  assert.equal(parsed.parser, "json");
  assert.equal(parsed.findings.length, 2);
  assert.equal(parsed.findings[0].file, "a.js");
  assert.equal(parsed.findings[1].file, "b.js");
});

test("Unit AI review: parse Jules-compatible evidence fields", () => {
  const parsed = parseAiReviewResponse({
    text: JSON.stringify({
      findings: [
        {
          severity: "P1",
          file: "src/session.js",
          line: 77,
          title: "SSE reconnect can miss events",
          evidence: "lastCursor is not used for backfill",
          lensEvidence: {
            E: "failed: reconnect path depends on live stream only",
            J: "failed: no rollback verification for missed messages",
          },
          reproduction: {
            type: "static_trace",
            steps: ["Disconnect SSE", "Post event", "Reconnect without /events backfill"],
          },
          user_impact: "User misses Claude audit messages in the dashboard.",
          trafficLight: "red",
          rootCause: "The stream consumer does not backfill the canonical event endpoint.",
          recommendedFix: "Poll /events?after=<cursor> on reconnect and slow tick.",
          confidence: 0.93,
        },
      ],
    }),
  });

  assert.equal(parsed.parser, "json");
  assert.equal(parsed.findings.length, 1);
  assert.deepEqual(parsed.findings[0].lensEvidence, {
    E: "failed: reconnect path depends on live stream only",
    J: "failed: no rollback verification for missed messages",
  });
  assert.deepEqual(parsed.findings[0].reproduction.steps, [
    "Disconnect SSE",
    "Post event",
    "Reconnect without /events backfill",
  ]);
  assert.equal(parsed.findings[0].userImpact, "User misses Claude audit messages in the dashboard.");
  assert.equal(parsed.findings[0].trafficLight, "red");
  assert.equal(parsed.findings[0].rootCause, "The stream consumer does not backfill the canonical event endpoint.");
  assert.equal(parsed.findings[0].recommendedFix, "Poll /events?after=<cursor> on reconnect and slow tick.");
});

test("Unit AI review: parse top-level JSON arrays as findings for legacy prompt compatibility", () => {
  const parsed = parseAiReviewResponse({
    text: JSON.stringify([
      {
        severity: "P2",
        file: "src/a.js",
        line: 4,
        title: "Array finding",
        rationale: "Legacy generic prompt returned an array.",
        suggestedFix: "Normalize arrays as findings.",
      },
    ]),
  });

  assert.equal(parsed.parser, "json");
  assert.equal(parsed.findings.length, 1);
  assert.equal(parsed.findings[0].message, "Array finding");
});

test("Unit AI review: non-JSON response falls back to summary-only mode", () => {
  const parsed = parseAiReviewResponse({
    text: "AI reviewer could not parse structured output due to malformed payload.",
    maxFindings: 5,
  });

  assert.equal(parsed.parser, "fallback_text");
  assert.equal(parsed.findings.length, 0);
  assert.match(parsed.summary, /could not parse|malformed|payload/i);
});

test("Unit AI review: prompt includes deterministic context and schema guardrails", () => {
  const prompt = buildAiReviewPrompt({
    targetPath: "/repo",
    mode: "diff",
    deterministicSummary: {
      P0: 0,
      P1: 1,
      P2: 4,
      P3: 2,
    },
    deterministicFindings: [
      {
        severity: "P1",
        file: "src/auth.js",
        line: 42,
        message: "Possible token exposure",
      },
    ],
    scopedFiles: ["src/auth.js", "src/server.js"],
    maxFindings: 7,
  });

  assert.match(prompt, /Output STRICT JSON only/);
  assert.match(prompt, /Maximum findings: 7/);
  assert.match(prompt, /Deterministic summary: P0=0 P1=1 P2=4 P3=2/);
  assert.match(prompt, /src\/auth\.js/);
  assert.match(prompt, /src\/server\.js/);
});

test("Unit AI review: prompt prepends persona system prompt when provided", () => {
  const prompt = buildAiReviewPrompt({
    targetPath: "/repo",
    mode: "full",
    deterministicSummary: { P0: 0, P1: 0, P2: 0, P3: 0 },
    systemPrompt: "PERSONA SYSTEM PROMPT\n11-lens evidence contract",
  });

  assert.equal(prompt.startsWith("PERSONA SYSTEM PROMPT"), true);
  assert.match(prompt, /11-lens evidence contract/);
  assert.match(prompt, /Output STRICT JSON only/);
  assert.match(prompt, /lensEvidence/);
  assert.match(prompt, /trafficLight/);
});
