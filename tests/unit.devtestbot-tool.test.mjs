import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";

import { recordProvisionedIdentity } from "../src/ai/identity-store.js";
import {
  DEVTESTBOT_RUN_SESSION_TOOL,
  runDevTestBotSession,
} from "../src/agents/devtestbot/tool.js";

test("devTestBot run_session tool schema exposes scope, identityId, baseUrl, and recordVideo", () => {
  assert.equal(DEVTESTBOT_RUN_SESSION_TOOL.name, "devtestbot.run_session");
  const properties = DEVTESTBOT_RUN_SESSION_TOOL.parameters.properties;
  assert.ok(properties.scope);
  assert.ok(properties.identityId);
  assert.ok(properties.baseUrl);
  assert.ok(properties.recordVideo);
  assert.equal(DEVTESTBOT_RUN_SESSION_TOOL.parameters.required.includes("scope"), true);
});

test("devTestBot run_session dry-run writes a redacted artifact bundle", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "senti-devtestbot-tool-dry-"));
  try {
    const result = await runDevTestBotSession({
      scope: "smoke",
      execute: false,
      outputRoot: path.join(tempRoot, ".sentinelayer"),
      outputDir: path.join(tempRoot, "devtestbot"),
      baseUrl: "about:blank?token=fixture-secret-token",
    });

    assert.equal(result.completed, true);
    assert.equal(result.dryRun, true);
    assert.equal(result.findings.length, 1);
    assert.equal(result.findings[0].severity, "P3");
    assert.match(String(result.artifactBundle.findingsPath || ""), /findings\.json$/);
    assert.match(String(result.artifactBundle.eventsPath || ""), /events\.ndjson$/);
    assert.equal(JSON.stringify(result).includes("fixture-secret-token"), false);

    const persisted = JSON.parse(await readFile(result.artifactBundle.resultPath, "utf-8"));
    assert.equal(persisted.findingCount, 1);
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("devTestBot run_session executes a launcher, normalizes findings, and suppresses secrets", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "senti-devtestbot-tool-run-"));
  const outputRoot = path.join(tempRoot, ".sentinelayer");
  const outputDir = path.join(tempRoot, "devtestbot");
  const password = "fixture-password-secret";
  const token = "fixture-token-secret-value";
  try {
    await recordProvisionedIdentity({
      outputRoot,
      response: {
        id: "id_123",
        emailAddress: "scan@aidenid.test",
        status: "ACTIVE",
      },
      context: {
        source: "unit-test",
        tags: ["devtestbot"],
      },
    });

    const fakeLaunch = async ({ outputDir: launcherOutputDir }) => {
      await writeFixtureArtifacts(launcherOutputDir, { password, token });
      return {
        page: {
          waitForTimeout: async () => {},
        },
        goto: async () => ({ ok: () => true }),
        finalize: async () => ({
          outputDir: launcherOutputDir,
          artifacts: {
            consolePath: path.join(launcherOutputDir, "console.json"),
            networkPath: path.join(launcherOutputDir, "network.json"),
            a11yPath: path.join(launcherOutputDir, "a11y.json"),
            lighthousePath: path.join(launcherOutputDir, "lighthouse.json"),
            clickCoveragePath: path.join(launcherOutputDir, "click-coverage.json"),
            manifestPath: path.join(launcherOutputDir, "manifest.json"),
            videoMp4Path: path.join(launcherOutputDir, "video", "recording.mp4"),
          },
        }),
      };
    };

    const result = await runDevTestBotSession({
      scope: "smoke",
      identityId: "id_123",
      baseUrl: "https://example.test?token=fixture-token-secret-value",
      outputRoot,
      outputDir,
      execute: true,
      recordVideo: true,
    }, {
      launchImpl: fakeLaunch,
      identityCreds: {
        password,
        token,
      },
    });

    assert.equal(result.completed, true);
    assert.equal(result.dryRun, false);
    assert.equal(result.findings.length >= 4, true);
    assert.equal(result.events.some((event) => event.event === "agent_start"), true);
    assert.equal(result.events.some((event) => event.event === "tool_call"), true);
    assert.equal(result.events.some((event) => event.event === "tool_result"), true);
    assert.equal(result.events.some((event) => event.event === "finding"), true);
    assert.equal(result.events.every((event) => event.stream === "sl_event"), true);
    const serialized = JSON.stringify(result);
    assert.equal(serialized.includes(password), false);
    assert.equal(serialized.includes(token), false);
    assert.equal(serialized.includes("otp=123456"), false);
    assert.equal(serialized.includes("reset-link=https://example.test/reset"), false);
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

async function writeFixtureArtifacts(outputDir, { password, token }) {
  await writeFile(
    path.join(outputDir, "console.json"),
    JSON.stringify({
      events: [
        { type: "log", text: "ready" },
        { type: "error", text: `password=${password} token=${token} otp=123456` },
      ],
    }),
    "utf-8"
  );
  await writeFile(
    path.join(outputDir, "network.json"),
    JSON.stringify({
      events: [
        { phase: "request", url: `https://example.test/reset?token=${token}` },
        { phase: "response", status: 500, url: "https://example.test/api/reset" },
        { phase: "requestfailed", failure: `reset-link=https://example.test/reset?token=${token}` },
      ],
    }),
    "utf-8"
  );
  await writeFile(
    path.join(outputDir, "a11y.json"),
    JSON.stringify({
      available: true,
      violations: [{ id: "label", impact: "critical" }],
    }),
    "utf-8"
  );
  await writeFile(
    path.join(outputDir, "lighthouse.json"),
    JSON.stringify({
      categories: {
        performance: { score: 0.42 },
        accessibility: { score: 0.88 },
        "best-practices": { score: 0.91 },
        seo: { score: 0.95 },
      },
    }),
    "utf-8"
  );
  await writeFile(
    path.join(outputDir, "click-coverage.json"),
    JSON.stringify({ clicks: [{ id: "primary-action" }] }),
    "utf-8"
  );
  await writeFile(path.join(outputDir, "manifest.json"), JSON.stringify({ ok: true }), "utf-8");
}
