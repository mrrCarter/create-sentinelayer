import test from "node:test";
import assert from "node:assert/strict";

import {
  DEVTESTBOT_DEFINITION,
  DEVTESTBOT_LANES,
  listDevTestBotLanes,
} from "../src/agents/devtestbot/config/definition.js";

test("devTestBot definition is scan-only and exposes required capture lanes", () => {
  assert.equal(DEVTESTBOT_DEFINITION.id, "devtestbot");
  assert.equal(DEVTESTBOT_DEFINITION.permissionMode, "runtime-readonly");
  assert.equal(DEVTESTBOT_DEFINITION.scope.mandate, "scan_only");
  assert.equal(DEVTESTBOT_DEFINITION.scope.dataPolicy, "no_data_extraction");
  assert.deepEqual(DEVTESTBOT_DEFINITION.auditTools, ["devtestbot.run_session"]);
  assert.equal(DEVTESTBOT_DEFINITION.disallowedTools.includes("FileEdit"), true);
  assert.equal(DEVTESTBOT_DEFINITION.disallowedTools.includes("Shell"), true);

  for (const lane of [
    "console_errors",
    "network_errors",
    "a11y",
    "lighthouse",
    "click_coverage",
    "password_reset_e2e",
  ]) {
    assert.equal(DEVTESTBOT_LANES.includes(lane), true);
  }

  assert.deepEqual(listDevTestBotLanes(), [...DEVTESTBOT_LANES]);
  assert.equal(DEVTESTBOT_DEFINITION.confidenceFloor >= 0.8, true);
  assert.equal(DEVTESTBOT_DEFINITION.evidenceRequirements.includes("artifact_path"), true);
});
