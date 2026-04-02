import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp, rm, writeFile } from "node:fs/promises";

import {
  listBuiltinAuditAgents,
  loadAuditRegistry,
  selectAuditAgents,
} from "../src/audit/registry.js";

test("Unit audit registry: built-in agent registry includes expected orchestrator personas", () => {
  const agents = listBuiltinAuditAgents();
  assert.equal(Array.isArray(agents), true);
  assert.equal(agents.length >= 13, true);
  assert.equal(agents.some((agent) => agent.id === "security"), true);
  assert.equal(agents.some((agent) => agent.id === "architecture"), true);
  assert.equal(agents.some((agent) => agent.id === "performance"), true);
  assert.equal(agents.some((agent) => agent.id === "compliance"), true);
  assert.equal(agents.some((agent) => agent.id === "testing"), true);
});

test("Unit audit registry: agent selection handles explicit filters and missing ids", () => {
  const agents = listBuiltinAuditAgents();
  const selected = selectAuditAgents(agents, "security,testing,missing-agent");
  assert.equal(selected.selected.length, 2);
  assert.equal(selected.selected.some((agent) => agent.id === "security"), true);
  assert.equal(selected.selected.some((agent) => agent.id === "testing"), true);
  assert.deepEqual(selected.missing, ["missing-agent"]);
});

test("Unit audit registry: custom registry file merges with built-in agents", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "create-sentinelayer-audit-registry-"));
  try {
    const registryPath = path.join(tempRoot, "audit-registry.json");
    await writeFile(
      registryPath,
      `${JSON.stringify(
        {
          agents: [
            {
              id: "security",
              maxTurns: 12,
              confidenceFloor: 0.92,
            },
            {
              id: "custom-domain",
              persona: "Custom Persona",
              domain: "Custom",
              tools: ["read"],
              maxTurns: 3,
              confidenceFloor: 0.7,
            },
          ],
        },
        null,
        2
      )}\n`,
      "utf-8"
    );

    const registry = await loadAuditRegistry({
      registryFile: registryPath,
    });
    assert.equal(registry.registrySource, "custom");
    assert.equal(registry.agents.some((agent) => agent.id === "custom-domain"), true);

    const security = registry.agents.find((agent) => agent.id === "security");
    assert.ok(security);
    assert.equal(security.maxTurns, 12);
    assert.equal(security.confidenceFloor, 0.92);
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

