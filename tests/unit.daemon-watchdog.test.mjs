import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";

import { resolveAssignmentLedgerStorage } from "../src/daemon/assignment-ledger.js";
import { resolveBudgetGovernorStorage } from "../src/daemon/budget-governor.js";
import {
  getWatchdogStatus,
  resolveWatchdogStorage,
  runWatchdogTick,
} from "../src/daemon/watchdog.js";

async function writeJson(filePath, payload) {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, `${JSON.stringify(payload, null, 2)}\n`, "utf-8");
}

test("Unit daemon watchdog: smart-frequency alerts activate once then recover", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "create-sentinelayer-watchdog-"));
  try {
    const nowIso = "2026-04-04T20:00:00.000Z";
    const staleIso = "2026-04-04T19:57:00.000Z";
    const storage = await resolveWatchdogStorage({
      targetPath: tempRoot,
    });
    const assignmentStorage = await resolveAssignmentLedgerStorage({
      targetPath: tempRoot,
    });
    const budgetStorage = await resolveBudgetGovernorStorage({
      targetPath: tempRoot,
    });

    await writeJson(storage.queuePath, {
      schemaVersion: "1.0.0",
      generatedAt: nowIso,
      items: [
        {
          workItemId: "work-1",
          severity: "P1",
          service: "sentinelayer-api",
          endpoint: "/api/auth/callback",
          errorCode: "E_AUTH",
          status: "IN_PROGRESS",
          updatedAt: staleIso,
          metadata: {},
        },
      ],
    });
    await writeJson(assignmentStorage.ledgerPath, {
      schemaVersion: "1.0.0",
      generatedAt: nowIso,
      assignments: [
        {
          workItemId: "work-1",
          assignedAgentIdentity: "maya.markov@agent",
          leasedAt: staleIso,
          leaseTtlSeconds: 3600,
          leaseExpiresAt: "2026-04-04T21:00:00.000Z",
          status: "IN_PROGRESS",
          stage: "fix",
          runId: "run-1",
          jiraIssueKey: "SLD-10",
          budgetSnapshot: {
            lastToolCallAt: staleIso,
            findingsProduced: 0,
          },
          heartbeatAt: staleIso,
          releasedAt: null,
          releaseReason: null,
          updatedAt: staleIso,
        },
      ],
    });
    await writeJson(budgetStorage.budgetStatePath, {
      schemaVersion: "1.0.0",
      generatedAt: nowIso,
      records: [
        {
          workItemId: "work-1",
          lifecycleState: "WITHIN_BUDGET",
          lastAction: "NONE",
          quarantineStartedAt: null,
          quarantineUntil: null,
          warnings: [],
          stopReasons: [],
          budget: { maxTokens: 1000 },
          usage: { tokensUsed: 10 },
          updatedAt: nowIso,
        },
      ],
    });

    const firstTick = await runWatchdogTick({
      targetPath: tempRoot,
      noToolCallSeconds: 60,
      nowIso,
      execute: false,
    });
    assert.equal(firstTick.summary.detectionCount >= 1, true);
    assert.equal(firstTick.summary.activatedCount >= 1, true);
    assert.equal(firstTick.activatedAlerts.some((alert) => alert.signalCode === "NO_TOOL_CALL"), true);

    const secondTick = await runWatchdogTick({
      targetPath: tempRoot,
      noToolCallSeconds: 60,
      nowIso: "2026-04-04T20:00:30.000Z",
      execute: false,
    });
    assert.equal(secondTick.summary.activatedCount, 0);
    assert.equal(secondTick.summary.recoveredCount, 0);

    await writeJson(assignmentStorage.ledgerPath, {
      schemaVersion: "1.0.0",
      generatedAt: nowIso,
      assignments: [
        {
          workItemId: "work-1",
          assignedAgentIdentity: "maya.markov@agent",
          leasedAt: staleIso,
          leaseTtlSeconds: 3600,
          leaseExpiresAt: "2026-04-04T21:00:00.000Z",
          status: "IN_PROGRESS",
          stage: "fix",
          runId: "run-1",
          jiraIssueKey: "SLD-10",
          budgetSnapshot: {
            lastToolCallAt: "2026-04-04T20:01:30.000Z",
            findingsProduced: 1,
          },
          heartbeatAt: "2026-04-04T20:01:30.000Z",
          releasedAt: null,
          releaseReason: null,
          updatedAt: "2026-04-04T20:01:30.000Z",
        },
      ],
    });

    const recoveredTick = await runWatchdogTick({
      targetPath: tempRoot,
      noToolCallSeconds: 60,
      nowIso: "2026-04-04T20:01:40.000Z",
      execute: false,
    });
    assert.equal(recoveredTick.summary.recoveredCount, 1);
    assert.equal(recoveredTick.recoveredAlerts[0].eventType, "alert_recovered");

    const status = await getWatchdogStatus({
      targetPath: tempRoot,
      limit: 5,
    });
    assert.equal(status.activeAlertCount, 0);
    assert.equal(status.recentRuns.length >= 1, true);
    assert.equal(status.statePath, storage.watchdogStatePath);
    assert.equal(status.eventsPath, storage.watchdogEventsPath);
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("Unit daemon watchdog: repeated file reads and budget warning emit dry-run channel notifications", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "create-sentinelayer-watchdog-alerts-"));
  try {
    const nowIso = "2026-04-04T21:00:00.000Z";
    const storage = await resolveWatchdogStorage({
      targetPath: tempRoot,
    });
    const assignmentStorage = await resolveAssignmentLedgerStorage({
      targetPath: tempRoot,
    });
    const budgetStorage = await resolveBudgetGovernorStorage({
      targetPath: tempRoot,
    });

    await writeFile(
      path.join(tempRoot, ".sentinelayer.yml"),
      [
        "alerts:",
        "  channels:",
        "    - type: slack",
        "      webhook_url: ${SLACK_WEBHOOK_URL}",
        "    - type: telegram",
        "      bot_token: ${TELEGRAM_BOT_TOKEN}",
        "      chat_id: ${TELEGRAM_CHAT_ID}",
        "  frequency: smart",
        "  events:",
        "    - agent_stuck",
        "    - budget_warning",
        "    - alert_recovered",
      ].join("\n"),
      "utf-8"
    );

    await writeJson(storage.queuePath, {
      schemaVersion: "1.0.0",
      generatedAt: nowIso,
      items: [
        {
          workItemId: "work-2",
          severity: "P2",
          service: "sentinelayer-api",
          endpoint: "/api/runtime/run",
          errorCode: "E_LOOP",
          status: "IN_PROGRESS",
          updatedAt: nowIso,
          metadata: {},
        },
      ],
    });
    await writeJson(assignmentStorage.ledgerPath, {
      schemaVersion: "1.0.0",
      generatedAt: nowIso,
      assignments: [
        {
          workItemId: "work-2",
          assignedAgentIdentity: "nina.patel@agent",
          leasedAt: nowIso,
          leaseTtlSeconds: 3600,
          leaseExpiresAt: "2026-04-04T22:00:00.000Z",
          status: "IN_PROGRESS",
          stage: "fix",
          runId: "run-2",
          jiraIssueKey: "SLD-11",
          budgetSnapshot: {
            lastToolCallAt: nowIso,
            recentFileReads: [
              "src/auth/service.js",
              "src/auth/service.js",
              "src/auth/service.js",
            ],
            findingsProduced: 0,
            turnCount: 10,
            lastProgressTurn: 2,
          },
          heartbeatAt: nowIso,
          releasedAt: null,
          releaseReason: null,
          updatedAt: nowIso,
        },
      ],
    });
    await writeJson(budgetStorage.budgetStatePath, {
      schemaVersion: "1.0.0",
      generatedAt: nowIso,
      records: [
        {
          workItemId: "work-2",
          lifecycleState: "WARNING_THRESHOLD",
          lastAction: "WARN",
          quarantineStartedAt: null,
          quarantineUntil: null,
          warnings: [{ code: "TOKENS_NEAR_LIMIT" }],
          stopReasons: [],
          budget: { maxTokens: 1000 },
          usage: { tokensUsed: 950 },
          updatedAt: nowIso,
        },
      ],
    });

    const tick = await runWatchdogTick({
      targetPath: tempRoot,
      nowIso,
      noToolCallSeconds: 60,
      repeatedFileReadsThreshold: 3,
      budgetWarningThreshold: 0.9,
      turnStallTurns: 5,
      execute: false,
      env: {
        ...process.env,
        SLACK_WEBHOOK_URL: "https://hooks.slack.test/watchdog",
        TELEGRAM_BOT_TOKEN: "token-123",
        TELEGRAM_CHAT_ID: "chat-456",
      },
    });

    assert.equal(
      tick.detections.some((detection) => detection.signalCode === "REPEATED_FILE_READ"),
      true
    );
    assert.equal(
      tick.detections.some((detection) => detection.signalCode === "BUDGET_WARNING_NO_FINDINGS"),
      true
    );
    assert.equal(tick.notifications.length >= 4, true);
    assert.equal(tick.notifications.every((notification) => notification.dryRun === true), true);

    const runPayload = JSON.parse(await readFile(tick.runPath, "utf-8"));
    assert.equal(runPayload.summary.notificationCount, tick.notifications.length);
    assert.equal(runPayload.summary.activatedCount, tick.activatedAlerts.length);
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});
