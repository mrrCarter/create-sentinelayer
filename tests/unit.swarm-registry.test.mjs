import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp, rm, writeFile } from "node:fs/promises";

import {
  listBuiltinSwarmAgents,
  loadSwarmRegistry,
  selectSwarmAgents,
} from "../src/swarm/registry.js";

test("Unit swarm registry: built-in registry includes OMAR + specialist domains", () => {
  const agents = listBuiltinSwarmAgents();
  assert.equal(Array.isArray(agents), true);
  assert.equal(agents.length >= 13, true);
  assert.equal(agents.some((agent) => agent.id === "omar"), true);
  assert.equal(agents.some((agent) => agent.id === "security"), true);
  assert.equal(agents.some((agent) => agent.id === "architecture"), true);
  assert.equal(agents.some((agent) => agent.id === "reliability"), true);
});

test("Unit swarm registry: selection handles explicit filters and missing ids", () => {
  const agents = listBuiltinSwarmAgents();
  const selected = selectSwarmAgents(agents, "omar,security,missing-agent");
  assert.equal(selected.selected.length, 2);
  assert.equal(selected.selected.some((agent) => agent.id === "omar"), true);
  assert.equal(selected.selected.some((agent) => agent.id === "security"), true);
  assert.deepEqual(selected.missing, ["missing-agent"]);
});

test("Unit swarm registry: custom registry file merges with built-in agents", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "create-sentinelayer-swarm-registry-"));
  try {
    const registryPath = path.join(tempRoot, "swarm-registry.json");
    await writeFile(
      registryPath,
      `${JSON.stringify(
        {
          agents: [
            {
              id: "security",
              maxTurns: 10,
              defaultBudget: {
                maxCostUsd: 0.6,
                maxOutputTokens: 2500,
                maxRuntimeMs: 240000,
                maxToolCalls: 30,
              },
            },
            {
              id: "custom-daemon",
              persona: "Custom Daemon",
              role: "specialist",
              domain: "Daemon Ops",
              tools: ["read"],
              maxTurns: 4,
              confidenceFloor: 0.7,
              defaultBudget: {
                maxCostUsd: 0.4,
                maxOutputTokens: 1500,
                maxRuntimeMs: 180000,
                maxToolCalls: 20,
              },
            },
          ],
        },
        null,
        2
      )}\n`,
      "utf-8"
    );

    const registry = await loadSwarmRegistry({
      registryFile: registryPath,
    });
    assert.equal(registry.registrySource, "custom");
    assert.equal(registry.agents.some((agent) => agent.id === "custom-daemon"), true);

    const security = registry.agents.find((agent) => agent.id === "security");
    assert.ok(security);
    assert.equal(security.maxTurns, 10);
    assert.equal(security.defaultBudget.maxCostUsd, 0.6);
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});
