import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp, rm, writeFile } from "node:fs/promises";

import {
  createIsolatedPersonaContext,
  runPersonaAgenticLoop,
} from "../src/audit/persona-loop.js";

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

test("Unit audit persona-loop: isolated persona contexts do not share message history references", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "create-sentinelayer-persona-isolation-"));
  try {
    const clientFactory = () => ({
      async invoke() {
        return { provider: "test", model: "test-model", text: "```json\n[]\n```" };
      },
    });

    const first = createIsolatedPersonaContext({
      agent: securityAgent(),
      rootPath: tempRoot,
      clientFactory,
    });
    const second = createIsolatedPersonaContext({
      agent: securityAgent(),
      rootPath: tempRoot,
      clientFactory,
    });

    assert.notEqual(first.runId, second.runId);
    assert.notEqual(first.messageHistory, second.messageHistory);
    assert.notEqual(first.blackboard, second.blackboard);
    assert.notEqual(first.client, second.client);
    assert.notEqual(first.ctx, second.ctx);
    assert.notEqual(first.tools.dispatcher, second.tools.dispatcher);
    assert.equal(first.isolation, "strict");

    first.messageHistory.push({ role: "user", content: "security-only evidence" });
    assert.equal(first.messageHistory.length, 1);
    assert.equal(second.messageHistory.length, 0);
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("Unit audit persona-loop: agent_start records isolation and seed counts", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "create-sentinelayer-persona-seed-counts-"));
  try {
    const events = [];
    const result = await runPersonaAgenticLoop({
      agent: securityAgent(),
      rootPath: tempRoot,
      dryRun: true,
      isolation: "relaxed",
      deterministicBaseline: {
        findings: [
          {
            severity: "P3",
            file: "index.js",
            line: 1,
            title: "Baseline issue",
            message: "Baseline issue",
          },
        ],
      },
      seedFindings: [
        {
          severity: "P2",
          file: "index.js",
          line: 1,
          title: "Seed issue",
          message: "Seed issue",
        },
      ],
      onEvent: (evt) => events.push(evt),
    });

    const start = events.find((event) => event.event === "agent_start");
    assert.ok(start);
    assert.equal(start.payload.isolation, "relaxed");
    assert.equal(start.payload.seedFindingCount, 1);
    assert.equal(start.payload.deterministicBaselineFindingCount, 1);
    assert.equal(result.isolation, "relaxed");
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("Unit audit persona-loop: parallel personas send disjoint message histories to clients", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "create-sentinelayer-persona-parallel-"));
  try {
    const prompts = {
      security: [],
      testing: [],
    };
    const makeClient = (agentId) => ({
      async invoke({ prompt }) {
        prompts[agentId].push(String(prompt || ""));
        return {
          provider: "test",
          model: "test-model",
          text: "No additional findings.\n```json\n[]\n```",
        };
      },
    });

    await Promise.all([
      runPersonaAgenticLoop({
        agent: securityAgent({ id: "security", persona: "Security Persona", domain: "Security" }),
        rootPath: tempRoot,
        maxTurns: 1,
        seedFindings: [
          {
            severity: "P2",
            file: "src/security-only.js",
            line: 1,
            title: "SECURITY_ONLY_SENTINEL",
            message: "SECURITY_ONLY_SENTINEL",
          },
        ],
        clientFactory: () => makeClient("security"),
      }),
      runPersonaAgenticLoop({
        agent: securityAgent({ id: "testing", persona: "Testing Persona", domain: "Testing" }),
        rootPath: tempRoot,
        maxTurns: 1,
        seedFindings: [
          {
            severity: "P2",
            file: "tests/testing-only.test.js",
            line: 1,
            title: "TESTING_ONLY_SENTINEL",
            message: "TESTING_ONLY_SENTINEL",
          },
        ],
        clientFactory: () => makeClient("testing"),
      }),
    ]);

    assert.equal(prompts.security.length, 1);
    assert.equal(prompts.testing.length, 1);
    assert.match(prompts.security[0], /SECURITY_ONLY_SENTINEL/);
    assert.doesNotMatch(prompts.security[0], /TESTING_ONLY_SENTINEL/);
    assert.match(prompts.testing[0], /TESTING_ONLY_SENTINEL/);
    assert.doesNotMatch(prompts.testing[0], /SECURITY_ONLY_SENTINEL/);
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

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

