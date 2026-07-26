import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  buildPersonaFileScope,
  decideSwarm,
  divideSwarmBudget,
  partitionFiles,
  runOmarGateOrchestrator,
} from "../src/review/omargate-orchestrator.js";

const tempRoots = [];

async function makeTempRoot() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "omargate-orchestrator-"));
  tempRoots.push(root);
  return root;
}

function makeFiles(count, prefix = "src/File") {
  return Array.from({ length: count }, (_, index) => `${prefix}${index}.js`);
}

function bigDeterministic(files = makeFiles(16)) {
  return {
    summary: { P0: 0, P1: 0, P2: 0, P3: 0, blocking: false },
    findings: [],
    scope: {
      scannedFiles: files.length,
      scannedRelativeFiles: files,
    },
    layers: {
      ingest: {
        summary: {
          filesScanned: files.length,
          totalLoc: 5200,
        },
      },
    },
    metadata: {},
    artifacts: {},
  };
}

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

describe("OmarGate swarm helpers", () => {
  it("decides to swarm when file count exceeds the Jules threshold", () => {
    const decision = decideSwarm({
      scope: {
        scannedRelativeFiles: makeFiles(16),
      },
    });

    assert.equal(decision.spawn, true);
    assert.equal(decision.fileCount, 16);
    assert.match(decision.reason, /files exceeds threshold/);
  });

  it("decides to swarm when estimated LOC exceeds the threshold", () => {
    const decision = decideSwarm({
      scope: {
        scannedRelativeFiles: makeFiles(8),
        totalLoc: 5001,
      },
    });

    assert.equal(decision.spawn, true);
    assert.equal(decision.estimatedLoc, 5001);
    assert.match(decision.reason, /LOC exceeds threshold/);
  });

  it("decides to swarm when route group count reaches the threshold", () => {
    const decision = decideSwarm({
      scope: {
        scannedRelativeFiles: [
          "app/dashboard/page.tsx",
          "app/settings/page.tsx",
          "pages/billing/index.tsx",
        ],
      },
    });

    assert.equal(decision.spawn, true);
    assert.equal(decision.routeGroups, 3);
    assert.match(decision.reason, /route groups exceeds threshold/);
  });

  it("keeps small scopes on the single-call path", () => {
    const decision = decideSwarm({
      scope: {
        scannedRelativeFiles: ["src/a.js", "src/b.js"],
        totalLoc: 100,
      },
    });

    assert.equal(decision.spawn, false);
  });

  it("partitions unique files into <=12 file chunks and splits budget", () => {
    const partitions = partitionFiles([...makeFiles(25), "src/File0.js"]);
    assert.deepEqual(partitions.map((chunk) => chunk.length), [12, 12, 1]);
    assert.equal(partitions.every((chunk) => chunk.length <= 12), true);

    const budget = divideSwarmBudget(0.9, partitions.length);
    assert.equal(budget.subagentCount, 3);
    assert.ok(budget.maxCostUsd <= 0.3);
  });

  it("builds scope from deterministic review output", () => {
    const scope = buildPersonaFileScope({
      deterministic: bigDeterministic(["src/a.js", "src/b.js"]),
    });

    assert.equal(scope.scannedFiles, 2);
    assert.deepEqual(scope.scannedRelativeFiles, ["src/a.js", "src/b.js"]);
    assert.equal(scope.totalLoc, 5200);
  });
});

describe("runOmarGateOrchestrator swarm path", () => {
  it("fans out oversized persona scopes with paired lifecycle events and bounded cost", async () => {
    const targetPath = await makeTempRoot();
    const events = [];

    const result = await runOmarGateOrchestrator({
      targetPath,
      scanMode: "deep",
      includeOnly: ["security"],
      maxCostUsd: 1,
      dryRun: true,
      deterministic: bigDeterministic(),
      onEvent: (evt) => events.push(evt),
    });

    const swarmStart = events.find((evt) => evt.event === "swarm_start");
    assert.ok(swarmStart, "expected swarm_start event");
    assert.equal(swarmStart.payload.personaId, "security");
    assert.equal(swarmStart.payload.partitionCount, 2);
    assert.equal(swarmStart.payload.maxConcurrent <= 4, true);

    const agentStarts = events.filter((evt) => evt.event === "agent_start");
    const agentCompletions = events.filter((evt) => evt.event === "agent_complete");
    assert.equal(agentStarts.length, 2);
    assert.equal(agentCompletions.length, agentStarts.length);
    assert.equal(agentStarts.every((evt) => evt.payload.files.length <= 12), true);

    const swarmComplete = events.find((evt) => evt.event === "swarm_complete");
    assert.ok(swarmComplete, "expected swarm_complete event");
    assert.equal(swarmComplete.payload.subagentCount, 2);

    const persona = result.personas.find((entry) => entry.id === "security");
    assert.ok(persona?.swarm, "expected persona swarm metadata");
    assert.equal(persona.swarm.subagentCount, 2);
    assert.equal(persona.costUsd <= 1, true);
    assert.equal(result.totalCostUsd <= 1, true);

    const firstPromptPath = persona.swarm.subagents[0].artifacts?.promptPath;
    assert.ok(firstPromptPath, "expected subagent prompt artifact path");
    assert.match(firstPromptPath.replace(/\\/g, "/"), /swarm\/security\/subagent-1\/REVIEW_AI_PROMPT\.txt$/);
    const promptText = await fs.readFile(firstPromptPath, "utf-8");
    assert.match(promptText, /11-lens evidence contract/);
    assert.match(promptText, /lensEvidence/);
    assert.match(promptText, /user_impact/);
  });

  it("passes persona prompts through the non-swarm path and writes per-persona artifacts", async () => {
    const targetPath = await makeTempRoot();
    const runDirectory = path.join(targetPath, ".sentinelayer", "reviews", "review-test");

    const result = await runOmarGateOrchestrator({
      targetPath,
      scanMode: "deep",
      includeOnly: ["security"],
      maxCostUsd: 1,
      dryRun: true,
      deterministic: {
        summary: { P0: 0, P1: 0, P2: 0, P3: 0, blocking: false },
        findings: [],
        scope: {
          scannedFiles: 1,
          scannedRelativeFiles: ["src/auth.js"],
          totalLoc: 120,
        },
        layers: {},
        metadata: {},
        artifacts: { runDirectory },
      },
    });

    const persona = result.personas.find((entry) => entry.id === "security");
    assert.ok(persona?.artifacts?.promptPath, "expected persona prompt artifact path");
    assert.match(
      persona.artifacts.promptPath.replace(/\\/g, "/"),
      /\.sentinelayer\/reviews\/review-test\/personas\/security\/REVIEW_AI_PROMPT\.txt$/
    );

    const promptText = await fs.readFile(persona.artifacts.promptPath, "utf-8");
    assert.match(promptText, /Nina Patel/);
    assert.match(promptText, /11-lens evidence contract/);
    assert.match(promptText, /lensEvidence/);
    assert.match(promptText, /trafficLight/);
  });

  it("records Omar Deep billing entries with custom action and shared session", async () => {
    const targetPath = await makeTempRoot();
    const calls = [];

    const result = await runOmarGateOrchestrator({
      targetPath,
      scanMode: "deep",
      includeOnly: ["security"],
      maxCostUsd: 1,
      dryRun: true,
      usageSessionId: "sess-omargate-deep",
      requireUsageLedger: true,
      usageRecorder: async (sessionId, params, options) => {
        calls.push({ sessionId, params, options });
        return {
          ok: true,
          ledgerEntry: {
            ...params,
            ledgerEntryId: `bill-${calls.length}`,
          },
        };
      },
      deterministic: {
        summary: { P0: 0, P1: 0, P2: 0, P3: 0, blocking: false },
        findings: [],
        scope: {
          scannedFiles: 1,
          scannedRelativeFiles: ["src/auth.js"],
          totalLoc: 120,
        },
        layers: {},
        metadata: {},
        artifacts: {},
      },
    });

    assert.equal(calls.length, 1);
    assert.equal(calls[0].sessionId, "sess-omargate-deep");
    assert.equal(calls[0].params.action, "omargate_deep");
    assert.equal(calls[0].params.agentId, "omargate-security");
    assert.equal(calls[0].params.billingTier, "internal");
    assert.equal(calls[0].params.metadata.sourceCommand, "omargate deep");
    assert.equal(calls[0].params.metadata.personaId, "security");
    assert.equal(calls[0].params.metadata.scanMode, "deep");
    assert.equal(calls[0].options.targetPath, targetPath);
    assert.equal(result.personas[0].billing.ok, true);
    assert.equal(result.personas[0].billing.ledgerEntry.action, "omargate_deep");
  });

  it("fails closed when required Omar Deep usage ledger recording fails", async () => {
    const targetPath = await makeTempRoot();

    await assert.rejects(
      () =>
        runOmarGateOrchestrator({
          targetPath,
          scanMode: "deep",
          includeOnly: ["security"],
          maxCostUsd: 1,
          dryRun: true,
          usageSessionId: "sess-omargate-required",
          requireUsageLedger: true,
          usageRecorder: async () => {
            throw new Error("quota projection unavailable");
          },
          deterministic: {
            summary: { P0: 0, P1: 0, P2: 0, P3: 0, blocking: false },
            findings: [],
            scope: {
              scannedFiles: 1,
              scannedRelativeFiles: ["src/auth.js"],
              totalLoc: 120,
            },
            layers: {},
            metadata: {},
            artifacts: {},
          },
        }),
      /OmarGate required usage ledger recording failed for 1\/1 persona\(s\)/
    );
  });

  it("turns all-persona AI failures into a blocking P0 orchestrator finding", async () => {
    const targetPath = await makeTempRoot();

    const result = await runOmarGateOrchestrator({
      targetPath,
      scanMode: "deep",
      includeOnly: ["security", "backend"],
      maxCostUsd: 1,
      dryRun: false,
      aiReviewRunner: async () => {
        throw new Error("SentinelLayer LLM proxy error (502 UPSTREAM_ERROR)");
      },
      deterministic: {
        summary: { P0: 0, P1: 0, P2: 0, P3: 0, blocking: false },
        findings: [],
        scope: {
          scannedFiles: 1,
          scannedRelativeFiles: ["src/auth.js"],
          totalLoc: 120,
        },
        layers: {},
        metadata: {},
        artifacts: {},
      },
    });

    assert.equal(result.personaHealth.healthy, false);
    assert.equal(result.personaHealth.error, 2);
    assert.equal(result.summary.P0, 1);
    assert.equal(result.summary.blocking, true);
    assert.equal(result.findingsBySource.orchestrator, 1);
    assert.equal(result.reconciliation.orchestratorFindings, 1);
    assert.match(result.findings[0].message, /all 2 dispatched personas errored/);
    assert.equal(result.findings[0].file, "<omargate>");
  });

  it("turns non-dry-run persona coverage without call evidence into a blocking P1 finding", async () => {
    const targetPath = await makeTempRoot();

    const result = await runOmarGateOrchestrator({
      targetPath,
      scanMode: "deep",
      includeOnly: ["security"],
      maxCostUsd: 1,
      dryRun: false,
      aiReviewRunner: async () => ({
        findings: [],
        summary: { P0: 0, P1: 0, P2: 0, P3: 0, blocking: false },
        costUsd: 0,
      }),
      deterministic: {
        summary: { P0: 0, P1: 0, P2: 0, P3: 0, blocking: false },
        findings: [],
        scope: {
          scannedFiles: 1,
          scannedRelativeFiles: ["src/auth.js"],
          totalLoc: 120,
        },
        layers: {},
        metadata: {},
        artifacts: {},
      },
    });

    assert.equal(result.personaHealth.healthy, false);
    assert.equal(result.personaHealth.ok, 1);
    assert.equal(result.summary.P1, 1);
    assert.equal(result.summary.blocking, true);
    assert.match(result.findings[0].message, /lacked token-bearing usage/);
    assert.equal(result.personaHealth.aiCallEvidence.confirmedCalls, 0);
  });

  it("accepts zero-priced token-bearing usage as successful AI coverage", async () => {
    const targetPath = await makeTempRoot();

    const result = await runOmarGateOrchestrator({
      targetPath,
      scanMode: "deep",
      includeOnly: ["security"],
      maxCostUsd: 1,
      dryRun: false,
      aiReviewRunner: async () => ({
        findings: [],
        summary: { P0: 0, P1: 0, P2: 0, P3: 0, blocking: false },
        usage: {
          inputTokens: 2001,
          outputTokens: 53,
          costUsd: 0,
        },
      }),
      deterministic: {
        summary: { P0: 0, P1: 0, P2: 0, P3: 0, blocking: false },
        findings: [],
        scope: {
          scannedFiles: 1,
          scannedRelativeFiles: ["src/auth.js"],
          totalLoc: 120,
        },
        layers: {},
        metadata: {},
        artifacts: {},
      },
    });

    assert.equal(result.totalCostUsd, 0);
    assert.equal(result.personaHealth.healthy, true);
    assert.equal(result.personaHealth.aiCallEvidence.confirmedCalls, 1);
    assert.equal(result.personaHealth.aiCallEvidence.usageBackedCalls, 1);
    assert.equal(result.personaHealth.aiCallEvidence.ledgerBackedCalls, 0);
    assert.equal(result.personaHealth.aiCallEvidence.pricedCalls, 0);
    assert.equal(result.personaHealth.aiCallEvidence.totalTokens, 2054);
    assert.equal(result.findingsBySource.orchestrator, 0);
    assert.equal(result.summary.blocking, false);
  });

  it("accepts a zero-customer-price token-bearing billing ledger as successful AI coverage", async () => {
    const targetPath = await makeTempRoot();

    const result = await runOmarGateOrchestrator({
      targetPath,
      scanMode: "deep",
      includeOnly: ["testing"],
      maxCostUsd: 1,
      dryRun: false,
      aiReviewRunner: async () => ({
        findings: [],
        summary: { P0: 0, P1: 0, P2: 0, P3: 0, blocking: false },
        costUsd: 0,
        billing: {
          ok: true,
          event: "session_usage",
          ledgerEntry: {
            inputTokens: 1905,
            outputTokens: 1700,
            totalTokens: 3605,
            providerCostUsd: 0.027134,
            customerCostUsd: null,
          },
        },
      }),
      deterministic: {
        summary: { P0: 0, P1: 0, P2: 0, P3: 0, blocking: false },
        findings: [],
        scope: {
          scannedFiles: 1,
          scannedRelativeFiles: ["tests/runtime.test.mjs"],
          totalLoc: 120,
        },
        layers: {},
        metadata: {},
        artifacts: {},
      },
    });

    assert.equal(result.totalCostUsd, 0);
    assert.equal(result.personaHealth.healthy, true);
    assert.equal(result.personaHealth.aiCallEvidence.confirmedCalls, 1);
    assert.equal(result.personaHealth.aiCallEvidence.ledgerBackedCalls, 1);
    assert.equal(result.personaHealth.aiCallEvidence.pricedCalls, 1);
    assert.equal(result.personaHealth.aiCallEvidence.totalTokens, 3605);
    assert.equal(result.personaHealth.aiCallEvidence.providerCostUsd, 0.027134);
    assert.equal(result.personaHealth.aiCallEvidence.customerCostUsd, 0);
    assert.equal(result.findingsBySource.orchestrator, 0);
    assert.equal(result.summary.blocking, false);
  });

  it("fails closed when one successful persona lacks provider-call evidence", async () => {
    const targetPath = await makeTempRoot();

    const result = await runOmarGateOrchestrator({
      targetPath,
      scanMode: "deep",
      includeOnly: ["security", "testing"],
      maxCostUsd: 1,
      dryRun: false,
      aiReviewRunner: async ({ runId }) => ({
        findings: [],
        summary: { P0: 0, P1: 0, P2: 0, P3: 0, blocking: false },
        usage: runId.endsWith("-security")
          ? { inputTokens: 100, outputTokens: 20, costUsd: 0 }
          : { inputTokens: 0, outputTokens: 0, costUsd: 0 },
      }),
      deterministic: {
        summary: { P0: 0, P1: 0, P2: 0, P3: 0, blocking: false },
        findings: [],
        scope: {
          scannedFiles: 1,
          scannedRelativeFiles: ["src/auth.js"],
          totalLoc: 120,
        },
        layers: {},
        metadata: {},
        artifacts: {},
      },
    });

    assert.equal(result.personaHealth.ok, 2);
    assert.equal(result.personaHealth.verifiedOk, 1);
    assert.equal(result.personaHealth.unverifiedOk, 1);
    assert.equal(result.personaHealth.healthy, false);
    assert.equal(result.personaHealth.aiCallEvidence.confirmedCalls, 1);
    assert.equal(result.findingsBySource.orchestrator, 1);
    assert.match(result.findings.at(-1).message, /1\/2 successful personas lacked/);
    assert.equal(result.summary.P1, 1);
    assert.equal(result.summary.blocking, true);
  });

  it("aggregates zero-priced token evidence across swarm subagents", async () => {
    const targetPath = await makeTempRoot();

    const result = await runOmarGateOrchestrator({
      targetPath,
      scanMode: "deep",
      includeOnly: ["security"],
      maxCostUsd: 1,
      dryRun: false,
      aiReviewRunner: async () => ({
        findings: [],
        summary: { P0: 0, P1: 0, P2: 0, P3: 0, blocking: false },
        usage: {
          inputTokens: 100,
          outputTokens: 20,
          costUsd: 0,
        },
      }),
      deterministic: bigDeterministic(),
    });

    assert.equal(result.personaHealth.healthy, true);
    assert.equal(result.personaHealth.aiCallEvidence.confirmedCalls, 2);
    assert.equal(result.personaHealth.aiCallEvidence.totalTokens, 240);
    assert.equal(result.personas[0].swarm.subagentCount, 2);
    assert.equal(result.findingsBySource.orchestrator, 0);
  });
});

describe("runOmarGateOrchestrator changed-file routing", () => {
  it("routes diff scope to only impacted personas and scopes deterministic files per persona", async () => {
    const targetPath = await makeTempRoot();
    const events = [];

    const result = await runOmarGateOrchestrator({
      targetPath,
      scanMode: "deep",
      maxCostUsd: 1,
      dryRun: true,
      deterministic: {
        mode: "diff",
        summary: { P0: 0, P1: 0, P2: 2, P3: 0, blocking: false },
        findings: [
          {
            severity: "P2",
            file: "src/components/Button.tsx",
            line: 1,
            message: "frontend finding",
          },
          {
            severity: "P2",
            file: ".github/workflows/ci.yml",
            line: 1,
            message: "release finding",
          },
        ],
        scope: {
          scannedFiles: 2,
          scannedRelativeFiles: [
            "src/components/Button.tsx",
            ".github/workflows/ci.yml",
          ],
        },
        layers: {},
        metadata: {},
        artifacts: {},
      },
      onEvent: (evt) => events.push(evt),
    });

    assert.equal(result.personaRouting.enabled, true);
    assert.equal(result.personaRouting.scopeMode, "diff");
    assert.deepEqual(result.personaRouting.effectivePersonas, ["release", "frontend"]);
    assert.deepEqual(result.personaRouting.filesByPersona.release, [".github/workflows/ci.yml"]);
    assert.deepEqual(result.personaRouting.filesByPersona.frontend, ["src/components/Button.tsx"]);
    assert.deepEqual(result.personas.map((entry) => entry.id), ["release", "frontend"]);

    const routingEvent = events.find((evt) => evt.event === "omargate_persona_routing");
    assert.ok(routingEvent, "expected routing event");
    assert.equal(routingEvent.payload.routing.changedFileCount, 2);

    const releasePrompt = await fs.readFile(
      result.personas.find((entry) => entry.id === "release").artifacts.promptPath,
      "utf-8"
    );
    const frontendPrompt = await fs.readFile(
      result.personas.find((entry) => entry.id === "frontend").artifacts.promptPath,
      "utf-8"
    );
    assert.match(releasePrompt, /\.github\/workflows\/ci\.yml/);
    assert.doesNotMatch(releasePrompt, /src\/components\/Button\.tsx/);
    assert.match(frontendPrompt, /src\/components\/Button\.tsx/);
    assert.doesNotMatch(frontendPrompt, /\.github\/workflows\/ci\.yml/);
  });

  it("keeps manual persona filters authoritative over changed-file routing", async () => {
    const targetPath = await makeTempRoot();

    const result = await runOmarGateOrchestrator({
      targetPath,
      scanMode: "deep",
      includeOnly: ["security"],
      maxCostUsd: 1,
      dryRun: true,
      deterministic: {
        mode: "diff",
        summary: { P0: 0, P1: 0, P2: 0, P3: 0, blocking: false },
        findings: [],
        scope: {
          scannedFiles: 1,
          scannedRelativeFiles: ["src/components/Button.tsx"],
        },
        layers: {},
        metadata: {},
        artifacts: {},
      },
    });

    assert.equal(result.personaRouting.enabled, false);
    assert.equal(result.personaRouting.reason, "manual_persona_filter");
    assert.deepEqual(result.personas.map((entry) => entry.id), ["security"]);
  });
});
