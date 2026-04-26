import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp, rm, writeFile } from "node:fs/promises";

import { runPersonaAgenticLoop } from "../src/audit/persona-loop.js";

function securityAgent(overrides = {}) {
  return {
    id: "security",
    persona: "Nina Patel",
    domain: "Security",
    permissionMode: "plan",
    maxTurns: 4,
    confidenceFloor: 0.85,
    tools: ["FileRead", "Grep", "Glob", "Shell", "FileEdit"],
    ...overrides,
  };
}

test("Unit audit persona-loop: non-Jules persona uses tools, emits findings, and records output tokens", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "create-sentinelayer-persona-loop-"));
  try {
    await writeFile(
      path.join(tempRoot, "vuln.js"),
      "export const token = 'sk-live-1234567890abcdef1234567890';\n",
      "utf-8"
    );

    const events = [];
    let callCount = 0;
    const fakeClient = {
      async invoke() {
        callCount += 1;
        if (callCount === 1) {
          return {
            provider: "test",
            model: "test-model",
            text: [
              "I need to inspect the suspected file.",
              "```tool_use",
              "{\"tool\":\"FileRead\",\"input\":{\"file_path\":\"vuln.js\",\"limit\":40}}",
              "```",
            ].join("\n"),
          };
        }
        return {
          provider: "test",
          model: "test-model",
          text: [
            "The file contains a committed live-looking token.",
            "```json",
            "[{\"severity\":\"P1\",\"file\":\"vuln.js\",\"line\":1,\"title\":\"Committed secret token\",\"message\":\"Committed secret token\",\"evidence\":\"vuln.js:1 contains sk-live token material\",\"recommendedFix\":\"Move the value into a secret manager and rotate it\",\"user_impact\":\"An attacker can reuse the committed credential if it is valid.\",\"confidence\":0.93}]",
            "```",
          ].join("\n"),
        };
      },
    };

    const result = await runPersonaAgenticLoop({
      agent: securityAgent(),
      rootPath: tempRoot,
      ingest: { summary: { filesScanned: 1, totalLoc: 1 }, frameworks: [] },
      clientFactory: () => fakeClient,
      onEvent: (evt) => events.push(evt),
    });

    assert.equal(result.agentId, "security");
    assert.equal(result.findings.length, 1);
    assert.equal(result.findings[0].severity, "P1");
    assert.equal(result.usage.outputTokens > 0, true);
    assert.equal(events[0].event, "agent_start");
    assert.equal(events.some((event) => event.event === "tool_call" && event.payload.tool === "FileRead"), true);
    assert.equal(events.some((event) => event.event === "tool_result" && event.payload.tool === "FileRead"), true);
    assert.equal(events.some((event) => event.event === "finding"), true);
    assert.equal(events.at(-1).event, "agent_complete");
    assert.equal(events.every((event) => event.stream === "sl_event"), true);
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("Unit audit persona-loop: plan-mode personas keep FileEdit granted but unavailable", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "create-sentinelayer-persona-loop-plan-"));
  try {
    await writeFile(path.join(tempRoot, "index.js"), "export const ok = true;\n", "utf-8");

    const result = await runPersonaAgenticLoop({
      agent: securityAgent(),
      rootPath: tempRoot,
      dryRun: true,
    });

    assert.equal(result.grantedTools.includes("FileEdit"), true);
    assert.equal(result.availableTools.includes("FileEdit"), false);
    assert.equal(result.status, "dry_run");
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

