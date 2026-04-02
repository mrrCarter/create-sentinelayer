import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp, readFile, rm } from "node:fs/promises";

import {
  parseScenarioDsl,
  validateScenarioSpec,
  writeScenarioTemplate,
} from "../src/swarm/scenario-dsl.js";

test("Unit swarm scenario DSL: parse supports scenario/start_url/action commands", () => {
  const spec = parseScenarioDsl(`
scenario "nightly_smoke"
start_url "https://example.com"
tag "nightly"
action goto "https://example.com/login"
action fill "#email" "agent@example.com"
action click "button[type=submit]"
action wait 400
action screenshot "after-login.png"
`);

  assert.equal(spec.id, "nightly_smoke");
  assert.equal(spec.startUrl, "https://example.com");
  assert.deepEqual(spec.tags, ["nightly"]);
  assert.equal(spec.actions.length, 5);
  assert.equal(spec.actions[0].type, "goto");
  assert.equal(spec.actions[1].type, "fill");
  assert.equal(spec.actions[3].ms, 400);
});

test("Unit swarm scenario DSL: validator rejects missing id and actions", () => {
  const spec = parseScenarioDsl(`
tag "broken"
`);
  const validation = validateScenarioSpec(spec);
  assert.equal(validation.valid, false);
  assert.equal(validation.errors.some((error) => /scenario id/i.test(error)), true);
  assert.equal(validation.errors.some((error) => /at least one action/i.test(error)), true);
});

test("Unit swarm scenario DSL: template writer persists deterministic .sls output", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "create-sentinelayer-scenario-dsl-"));
  try {
    const result = await writeScenarioTemplate({
      scenarioId: "nightly_smoke",
      targetPath: tempRoot,
      startUrl: "https://example.com",
    });
    assert.match(String(result.filePath || ""), /[\\/]nightly_smoke\.sls$/);
    const content = await readFile(result.filePath, "utf-8");
    assert.match(content, /scenario "nightly_smoke"/);
    assert.match(content, /action goto "https:\/\/example\.com"/);
    assert.match(content, /action screenshot "nightly_smoke-home\.png"/);
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});
