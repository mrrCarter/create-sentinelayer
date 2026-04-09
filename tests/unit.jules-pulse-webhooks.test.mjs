import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

import { sendAlert, buildAlertPayload } from "../src/agents/jules/pulse.js";

describe("sendAlert", () => {
  it("returns empty sent array when no channels configured", async () => {
    const alert = buildAlertPayload({
      agentId: "frontend", event: "agent_stuck",
      state: { durationMs: 5000, findingCount: 0 },
    });
    // No env vars set = no channels
    const result = await sendAlert(alert, []);
    assert.equal(result.sent.length, 0);
    assert.equal(result.errors.length, 0);
  });

  it("reports error for invalid slack webhook", async () => {
    const alert = buildAlertPayload({
      agentId: "frontend", event: "audit_complete",
      state: { findingCount: 5 },
    });
    const result = await sendAlert(alert, [
      { type: "slack", webhook_url: "https://localhost:1/nonexistent" },
    ]);
    assert.equal(result.sent.length, 0);
    assert.equal(result.errors.length, 1);
    assert.equal(result.errors[0].type, "slack");
  });

  it("reports error for invalid telegram config", async () => {
    const alert = buildAlertPayload({
      agentId: "frontend", event: "pr_merged",
      state: { prNumber: 42 },
    });
    const result = await sendAlert(alert, [
      { type: "telegram", bot_token: "invalid", chat_id: "0" },
    ]);
    assert.equal(result.sent.length, 0);
    assert.equal(result.errors.length, 1);
    assert.equal(result.errors[0].type, "telegram");
  });

  it("skips unknown channel types silently", async () => {
    const alert = buildAlertPayload({ agentId: "frontend", event: "agent_stuck", state: {} });
    const result = await sendAlert(alert, [{ type: "discord" }]);
    assert.equal(result.sent.length, 0);
    assert.equal(result.errors.length, 0);
  });

  it("handles multiple channels independently", async () => {
    const alert = buildAlertPayload({ agentId: "frontend", event: "fix_complete", state: {} });
    const result = await sendAlert(alert, [
      { type: "slack", webhook_url: "https://localhost:1/bad" },
      { type: "telegram", bot_token: "bad", chat_id: "0" },
    ]);
    // Both should fail but independently
    assert.equal(result.errors.length, 2);
  });

  it("webhook delivery uses explicit timeout wrapper", () => {
    const source = fs.readFileSync(new URL("../src/agents/jules/pulse.js", import.meta.url), "utf-8");
    assert.ok(source.includes("async function fetchWithTimeout(url, options, timeoutMs)"));
    assert.ok(source.includes("fetchWithTimeout(webhookUrl, {"));
    assert.ok(source.includes("fetchWithTimeout(url, {"));
  });
});
