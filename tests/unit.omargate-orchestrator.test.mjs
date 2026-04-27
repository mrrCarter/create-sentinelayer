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
  });
});
