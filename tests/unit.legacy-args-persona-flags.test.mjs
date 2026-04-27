// Unit tests for buildLegacyArgs persona-flag pass-through (A-CLI-1 flags).

import test from "node:test";
import assert from "node:assert/strict";

import { buildLegacyArgs } from "../src/commands/legacy-args.js";

test("buildLegacyArgs: no persona options → no persona flags appended", () => {
  const args = buildLegacyArgs(["/omargate", "deep"], {
    commandOptions: { path: "." },
  });
  assert.ok(!args.includes("--persona"));
  assert.ok(!args.includes("--skip-persona"));
});

test("buildLegacyArgs: --persona appended when set", () => {
  const args = buildLegacyArgs(["/omargate", "deep"], {
    commandOptions: { path: ".", persona: "security,backend" },
  });
  const idx = args.indexOf("--persona");
  assert.ok(idx >= 0);
  assert.equal(args[idx + 1], "security,backend");
});

test("buildLegacyArgs: --skip-persona appended when set", () => {
  const args = buildLegacyArgs(["/omargate", "deep"], {
    commandOptions: { path: ".", skipPersona: "documentation,ai-governance" },
  });
  const idx = args.indexOf("--skip-persona");
  assert.ok(idx >= 0);
  assert.equal(args[idx + 1], "documentation,ai-governance");
});

test("buildLegacyArgs: both persona flags append independently", () => {
  const args = buildLegacyArgs(["/omargate", "deep"], {
    commandOptions: {
      path: ".",
      persona: "security,backend",
      skipPersona: "documentation",
    },
  });
  assert.ok(args.includes("--persona"));
  assert.ok(args.includes("--skip-persona"));
  const personaIdx = args.indexOf("--persona");
  const skipIdx = args.indexOf("--skip-persona");
  assert.equal(args[personaIdx + 1], "security,backend");
  assert.equal(args[skipIdx + 1], "documentation");
});

test("buildLegacyArgs: empty-string persona value treated as absent", () => {
  const args = buildLegacyArgs(["/omargate", "deep"], {
    commandOptions: { path: ".", persona: "", skipPersona: "   " },
  });
  assert.ok(!args.includes("--persona"));
  assert.ok(!args.includes("--skip-persona"));
});

test("buildLegacyArgs: --path and --persona coexist in correct order", () => {
  const args = buildLegacyArgs(["/omargate", "deep"], {
    commandOptions: { path: "/repo/x", persona: "security" },
  });
  // Path is appended first per existing convention; persona after.
  const pathIdx = args.indexOf("--path");
  const personaIdx = args.indexOf("--persona");
  assert.ok(pathIdx >= 0);
  assert.ok(personaIdx > pathIdx);
});

test("buildLegacyArgs: OmarGate runtime flags pass through to legacy implementation", () => {
  const args = buildLegacyArgs(["/omargate", "deep"], {
    commandOptions: {
      path: ".",
      aiDryRun: true,
      stream: true,
      scanMode: "deep",
      maxParallel: "3",
      maxCost: "1.25",
      model: "gpt-test",
      provider: "sentinelayer",
    },
  });

  for (const flag of ["--ai-dry-run", "--stream"]) {
    assert.ok(args.includes(flag), `expected ${flag}`);
  }
  for (const [flag, value] of [
    ["--scan-mode", "deep"],
    ["--max-parallel", "3"],
    ["--max-cost", "1.25"],
    ["--model", "gpt-test"],
    ["--provider", "sentinelayer"],
  ]) {
    const idx = args.indexOf(flag);
    assert.ok(idx >= 0, `expected ${flag}`);
    assert.equal(args[idx + 1], value);
  }
});

test("buildLegacyArgs: negated and dry-run flags pass through", () => {
  const args = buildLegacyArgs(["/omargate", "investor-dd"], {
    commandOptions: {
      ai: false,
      dryRun: true,
      email: false,
      dashboard: false,
      maxRuntimeMinutes: "45",
      notifyEmail: "ops@example.com",
      notifySession: "session-123",
    },
  });

  for (const flag of ["--no-ai", "--dry-run", "--no-email", "--no-dashboard"]) {
    assert.ok(args.includes(flag), `expected ${flag}`);
  }
  for (const [flag, value] of [
    ["--max-runtime-minutes", "45"],
    ["--notify-email", "ops@example.com"],
    ["--notify-session", "session-123"],
  ]) {
    const idx = args.indexOf(flag);
    assert.ok(idx >= 0, `expected ${flag}`);
    assert.equal(args[idx + 1], value);
  }
});

test("buildLegacyArgs: numeric zero passthrough values are preserved", () => {
  const args = buildLegacyArgs(["/omargate", "deep"], {
    commandOptions: {
      maxCost: 0,
    },
  });

  const idx = args.indexOf("--max-cost");
  assert.ok(idx >= 0);
  assert.equal(args[idx + 1], "0");
});
