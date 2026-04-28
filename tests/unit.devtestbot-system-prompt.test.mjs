import test from "node:test";
import assert from "node:assert/strict";

import { buildDevTestBotProductionPrompt } from "../src/agents/devtestbot/config/system-prompt.js";

test("devTestBot system prompt enforces scan-only privacy-preserving runtime testing", () => {
  const prompt = buildDevTestBotProductionPrompt({
    scope: "smoke",
    baseUrl: "https://example.test",
    runId: "run-123",
  });

  assert.match(prompt, /devtestbot\.run_session/i);
  assert.match(prompt, /scan-only/i);
  assert.match(prompt, /Do not extract user data/i);
  assert.match(prompt, /Never request, reveal, log, summarize, or return raw passwords/i);
  assert.match(prompt, /OTP/i);
  assert.match(prompt, /reset-link/i);
  assert.match(prompt, /console_errors/);
  assert.match(prompt, /network_errors/);
  assert.match(prompt, /a11y/);
  assert.match(prompt, /lighthouse/);
  assert.match(prompt, /click_coverage/);
  assert.match(prompt, /password_reset_e2e/);
  assert.match(prompt, /OUTPUT CONTRACT/);
  assert.match(prompt, /runtime:\/\/browser/);
});
