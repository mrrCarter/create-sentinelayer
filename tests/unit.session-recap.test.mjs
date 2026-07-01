import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";

import { Command } from "commander";

import { registerSessionCommand } from "../src/commands/session.js";
import { validateAgentEvent } from "../src/events/schema.js";
import { registerAgent } from "../src/session/agent-registry.js";
import { resolveSessionPaths } from "../src/session/paths.js";
import {
  buildSessionRecap,
  emitPeriodicRecap,
  shouldEmitRecap,
} from "../src/session/recap.js";
import { createSession } from "../src/session/store.js";
import { appendToStream, readStream } from "../src/session/stream.js";
import { acceptTask, assignTask } from "../src/session/tasks.js";

async function seedWorkspace(rootPath) {
  await mkdir(path.join(rootPath, "src"), { recursive: true });
  await writeFile(
    path.join(rootPath, "package.json"),
    JSON.stringify({ name: "session-recap-fixture", version: "1.0.0" }, null, 2),
    "utf-8"
  );
  await writeFile(path.join(rootPath, "src", "index.js"), "export const fixture = true;\n", "utf-8");
}

function buildSessionProgram() {
  const program = new Command();
  program
    .name("sl")
    .exitOverride()
    .configureOutput({
      writeOut: () => {},
      writeErr: () => {},
    });
  registerSessionCommand(program);
  return program;
}

async function captureConsoleLog(fn) {
  const lines = [];
  const originalLog = console.log;
  console.log = (...args) => {
    lines.push(args.map((arg) => String(arg)).join(" "));
  };
  try {
    await fn();
  } finally {
    console.log = originalLog;
  }
  return lines.join("\n");
}

test("Unit session recap: joining agent receives context briefing within 2 seconds", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "create-sentinelayer-session-recap-"));
  try {
    await seedWorkspace(tempRoot);
    const session = await createSession({ targetPath: tempRoot, ttlSeconds: 120 });

    await registerAgent(session.sessionId, {
      agentId: "codex-a1",
      model: "gpt-5.4",
      role: "coder",
      targetPath: tempRoot,
    });
    const joined = await registerAgent(session.sessionId, {
      agentId: "claude-b2",
      model: "claude-3.7-sonnet",
      role: "reviewer",
      targetPath: tempRoot,
    });

    const events = await readStream(session.sessionId, {
      tail: 50,
      targetPath: tempRoot,
    });
    const briefing = events.find(
      (event) =>
        event.event === "context_briefing" &&
        event.agent?.id === "senti" &&
        event.payload?.forAgent === joined.agentId
    );
    assert.ok(briefing);
    assert.equal(validateAgentEvent(briefing, { allowLegacy: false }), true);
    assert.equal(briefing.payload.ephemeral, true);
    assert.equal(briefing.payload.style, "italic-grey");
    assert.match(String(briefing.payload.recap || ""), /While you were away:/);
    const deltaMs = Date.parse(String(briefing.ts || "")) - Date.parse(String(joined.joinedAt || ""));
    assert.equal(deltaMs >= 0 && deltaMs <= 2_000, true);
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("Unit session recap: agent-join briefing includes operational rules", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "create-sentinelayer-session-rules-"));
  try {
    await seedWorkspace(tempRoot);
    const session = await createSession({ targetPath: tempRoot, ttlSeconds: 120 });
    const joined = await registerAgent(session.sessionId, {
      agentId: "claude-verifier",
      model: "claude-opus-4-7",
      role: "reviewer",
      targetPath: tempRoot,
    });

    const events = await readStream(session.sessionId, { tail: 50, targetPath: tempRoot });
    const briefing = events.find(
      (event) =>
        event.event === "context_briefing" &&
        event.agent?.id === "senti" &&
        event.payload?.forAgent === joined.agentId,
    );
    assert.ok(briefing);

    const message = String(briefing.payload.message || "");
    const rules = String(briefing.payload.rules || "");

    // payload.message is the rendered briefing the web reads first via payloadText.
    assert.ok(message.length > 0, "briefing payload.message must be non-empty");
    // Rules block is present in both the message and the standalone rules field.
    assert.match(message, /Reading the room/);
    assert.match(message, /Polling cadence/);
    assert.match(message, /session listen` is only a delivery cursor, not a grounding command/);
    assert.match(message, /Writing back/);
    assert.match(message, /Actions and threading/);
    assert.match(message, /Session grounding/);
    assert.match(message, /sl session daemon --session <id> --recap-interval 300 --checkpoint-interval 60/);
    assert.match(message, /sl session recap now <id> --remote --agent <your-name> --json/);
    assert.match(message, /sl session react <id> ack --target-sequence <n>/);
    assert.match(message, /sl session read <id> --remote --agent <your-name>/);
    assert.match(message, /reserve `sl session view <id> <sequence>` for repair\/backfill/);
    assert.match(message, /sl session reply <id> <sequence>/);
    assert.match(message, /sl session comment <id> <sequence>/);
    assert.match(message, /sl session actions/);
    assert.match(message, /sl session search <id> "<topic>" --limit 10/);
    assert.match(message, /markdown/i);
    assert.match(message, /Stop conditions/);
    assert.match(rules, /Reading the room/);
    assert.match(rules, /sl session read --remote --tail/);
    assert.match(rules, /join or recap before acting/);
    assert.match(rules, /Read receipts are automatic/);
    assert.match(rules, /sl session action <id> working_on --target-sequence <n>/);
    // Recap text is preserved separately for clients that want just the activity summary.
    assert.match(String(briefing.payload.recap || ""), /(While you were away|no active peers)/);
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("Unit session recap: includeJoinRules=false omits rules from briefing", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "create-sentinelayer-session-norules-"));
  try {
    await seedWorkspace(tempRoot);
    const session = await createSession({ targetPath: tempRoot, ttlSeconds: 120 });
    // Register without auto-emitting; emit manually with includeJoinRules: false.
    const { emitContextBriefing } = await import("../src/session/recap.js");
    const result = await emitContextBriefing(session.sessionId, {
      forAgentId: "test-agent",
      targetPath: tempRoot,
      includeJoinRules: false,
    });

    const message = String(result.event.payload.message || "");
    const rules = result.event.payload.rules;

    assert.equal(rules, null, "rules field should be null when includeJoinRules=false");
    assert.equal(
      /Reading the room/.test(message),
      false,
      "message should not include rules block when opted out",
    );
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("Unit session recap: includes task ownership ledger in recap text", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "create-sentinelayer-session-task-recap-"));
  try {
    await seedWorkspace(tempRoot);
    const session = await createSession({ targetPath: tempRoot, ttlSeconds: 120 });
    await registerAgent(session.sessionId, {
      agentId: "lead-r1f2",
      model: "gpt-5.4",
      role: "reviewer",
      targetPath: tempRoot,
    });
    await registerAgent(session.sessionId, {
      agentId: "codex-c3d4",
      model: "gpt-5.4",
      role: "coder",
      targetPath: tempRoot,
    });
    await registerAgent(session.sessionId, {
      agentId: "claude-a1b2",
      model: "claude-opus-4-7",
      role: "reviewer",
      targetPath: tempRoot,
    });

    const codexTask = await assignTask(session.sessionId, {
      fromAgentId: "lead-r1f2",
      toAgentId: "codex-c3d4",
      priority: "P1",
      task: "Implement checkpoint restore navigation contract.",
      targetPath: tempRoot,
      nowIso: "2026-05-19T09:00:00.000Z",
    });
    await acceptTask(session.sessionId, "codex-c3d4", codexTask.task.taskId, {
      targetPath: tempRoot,
      nowIso: "2026-05-19T09:01:00.000Z",
    });
    await assignTask(session.sessionId, {
      fromAgentId: "lead-r1f2",
      toAgentId: "claude-a1b2",
      priority: "P2",
      task: "Review recap UX and billing ledger spec.",
      targetPath: tempRoot,
      nowIso: "2026-05-19T09:02:00.000Z",
    });

    const recap = await buildSessionRecap(session.sessionId, {
      forAgentId: "codex-c3d4",
      targetPath: tempRoot,
      nowIso: "2026-05-19T09:03:00.000Z",
    });

    assert.match(recap.text, /Tasks: 2 active of 2 total/);
    assert.match(recap.text, /codex-c3d4 \(1 accepted\)/);
    assert.match(recap.text, /claude-a1b2 \(1 pending\)/);
    assert.match(recap.text, /P1 ACCEPTED codex-c3d4: Implement checkpoint restore/);
    assert.equal(recap.summary.pendingTasksForAgent, 1);
    assert.equal(recap.summary.taskLedger.accepted, 1);
    assert.equal(recap.summary.taskLedger.pending, 1);
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("Unit session recap: includes workspace todo plan grounding", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "create-sentinelayer-session-plan-recap-"));
  try {
    await seedWorkspace(tempRoot);
    await mkdir(path.join(tempRoot, "tasks"), { recursive: true });
    await writeFile(
      path.join(tempRoot, "tasks", "todo.md"),
      [
        "# Dogfood Work",
        "",
        "## Completed",
        "- [x] Ship checkpoint UX",
        "",
        "## Active Shipment",
        "- [ ] Build Senti auto recap",
        "- [ ] Verify npm release",
        "",
      ].join("\n"),
      "utf-8",
    );
    const session = await createSession({ targetPath: tempRoot, ttlSeconds: 120 });

    const recap = await buildSessionRecap(session.sessionId, {
      forAgentId: "codex",
      targetPath: tempRoot,
      nowIso: "2026-05-19T09:03:00.000Z",
    });

    assert.match(
      recap.text,
      /Plan: 2 open \/ 1 done in tasks\/todo\.md from create-sentinelayer-session-plan-recap-[^#]+#[a-f0-9]{8} \(session_metadata_target_path\)/,
    );
    assert.match(recap.text, /Current: Active Shipment/);
    assert.match(recap.text, /Active Shipment - Build Senti auto recap/);
    assert.match(recap.text, /Active Shipment - Verify npm release/);
    assert.equal(recap.summary.workPlan.exists, true);
    assert.match(
      recap.summary.workPlan.workspaceLabel,
      /^create-sentinelayer-session-plan-recap-/,
    );
    assert.match(recap.summary.workPlan.workspaceFingerprint, /^[a-f0-9]{8}$/);
    assert.match(
      recap.summary.workPlan.sourceLabel,
      /^tasks\/todo\.md from create-sentinelayer-session-plan-recap-/,
    );
    assert.equal(recap.summary.workPlan.sourceReason, "session_metadata_target_path");
    assert.equal(recap.summary.workPlan.total, 3);
    assert.equal(recap.summary.workPlan.open, 2);
    assert.equal(recap.summary.workPlan.completed, 1);
    assert.equal(recap.summary.workPlan.currentSection, "Active Shipment");
    assert.equal(recap.summary.workPlan.recentOpen[0].task, "Build Senti auto recap");
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("Unit session recap: reads todo plan from session workspace metadata, not caller cache path", async () => {
  const cacheRoot = await mkdtemp(path.join(os.tmpdir(), "create-sentinelayer-session-cache-"));
  const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), "create-sentinelayer-session-workspace-"));
  try {
    await seedWorkspace(cacheRoot);
    await seedWorkspace(workspaceRoot);
    await mkdir(path.join(cacheRoot, "tasks"), { recursive: true });
    await mkdir(path.join(workspaceRoot, "tasks"), { recursive: true });
    await writeFile(
      path.join(cacheRoot, "tasks", "todo.md"),
      ["# Wrong Cache Plan", "", "## Stale", "- [ ] Do not recap this stale caller cwd task"].join("\n"),
      "utf-8",
    );
    await writeFile(
      path.join(workspaceRoot, "tasks", "todo.md"),
      ["# Right Workspace Plan", "", "## Active Workspace", "- [ ] Recap the workspace-owned task"].join("\n"),
      "utf-8",
    );

    const session = await createSession({ targetPath: cacheRoot, ttlSeconds: 120 });
    const sessionPaths = resolveSessionPaths(session.sessionId, { targetPath: cacheRoot });
    const metadata = JSON.parse(await readFile(sessionPaths.metadataPath, "utf-8"));
    metadata.targetPath = workspaceRoot;
    await writeFile(sessionPaths.metadataPath, `${JSON.stringify(metadata, null, 2)}\n`, "utf-8");

    const recap = await buildSessionRecap(session.sessionId, {
      forAgentId: "codex",
      targetPath: cacheRoot,
      nowIso: "2026-05-19T09:03:00.000Z",
    });

    assert.match(recap.text, /Active Workspace - Recap the workspace-owned task/);
    assert.doesNotMatch(recap.text, /Wrong Cache Plan/);
    assert.doesNotMatch(recap.text, /stale caller cwd task/);
    assert.equal(recap.summary.workPlan.workspaceLabel, path.basename(workspaceRoot));
    assert.match(recap.summary.workPlan.workspaceFingerprint, /^[a-f0-9]{8}$/);
    assert.equal(recap.summary.workPlan.sourceReason, "session_metadata_target_path");
  } finally {
    await rm(cacheRoot, { recursive: true, force: true });
    await rm(workspaceRoot, { recursive: true, force: true });
  }
});

test("Unit session recap: handles empty and single-message transcript boundaries", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "create-sentinelayer-session-empty-boundary-"));
  try {
    await seedWorkspace(tempRoot);
    const session = await createSession({ targetPath: tempRoot, ttlSeconds: 120 });

    const emptyRecap = await buildSessionRecap(session.sessionId, {
      forAgentId: "codex",
      targetPath: tempRoot,
      nowIso: "2026-05-19T09:03:00.000Z",
    });
    assert.equal(emptyRecap.summary.recentActors, 0);
    assert.equal(emptyRecap.summary.totalFindingsCount, 0);
    assert.equal(emptyRecap.summary.workPlan.exists, false);
    assert.match(emptyRecap.text, /no recent peer activity/);
    assert.doesNotMatch(emptyRecap.text, /Plan:/);

    await appendToStream(session.sessionId, {
      event: "session_message",
      agent: { id: "claude-reviewer", model: "claude-opus-4-7" },
      payload: { message: "Single boundary message." },
      ts: "2026-05-19T09:04:00.000Z",
    }, { targetPath: tempRoot });

    const singleMessageRecap = await buildSessionRecap(session.sessionId, {
      forAgentId: "codex",
      targetPath: tempRoot,
      nowIso: "2026-05-19T09:05:00.000Z",
    });
    assert.equal(singleMessageRecap.summary.recentActors, 1);
    assert.deepEqual(singleMessageRecap.summary.recentActorIds, ["claude-reviewer"]);
    assert.equal(singleMessageRecap.summary.lastActorId, "claude-reviewer");
    assert.match(singleMessageRecap.text, /1 recent actor/);
    assert.match(singleMessageRecap.text, /claude-reviewer: Single boundary message/);
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("Unit session recap: suppresses current and next details for truncated todo plan windows", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "create-sentinelayer-session-large-plan-recap-"));
  try {
    await seedWorkspace(tempRoot);
    await mkdir(path.join(tempRoot, "tasks"), { recursive: true });

    const historicalLines = ["# Historical Dogfood Plan", ""];
    for (let index = 0; index < 6_000; index += 1) {
      historicalLines.push(
        `- [x] Old shipped item ${index} ${"already shipped and should not become live recap context ".repeat(2)}`,
      );
    }
    historicalLines.push(
      "",
      "## Plan",
      "- [ ] WI-5: Deploy stale web release tag",
      "- [ ] WI-6: Record stale CLI publish blocker note",
    );
    await writeFile(path.join(tempRoot, "tasks", "todo.md"), historicalLines.join("\n"), "utf-8");

    const session = await createSession({ targetPath: tempRoot, ttlSeconds: 120 });

    const recap = await buildSessionRecap(session.sessionId, {
      forAgentId: "codex",
      targetPath: tempRoot,
      nowIso: "2026-05-19T09:03:00.000Z",
    });

    assert.match(
      recap.text,
      /Plan: 2 open \/ \d+ done in recent tasks\/todo\.md from create-sentinelayer-session-large-plan-recap-[^#]+#[a-f0-9]{8} window \(session_metadata_target_path\)/,
    );
    assert.match(
      recap.text,
      /Current\/next items suppressed because the plan file is large/,
    );
    assert.doesNotMatch(recap.text, /Current: Plan/);
    assert.doesNotMatch(recap.text, /Next:/);
    assert.doesNotMatch(recap.text, /WI-5: Deploy stale web/);
    assert.equal(recap.summary.workPlan.exists, true);
    assert.equal(recap.summary.workPlan.truncated, true);
    assert.equal(recap.summary.workPlan.detailSuppressed, true);
    assert.equal(recap.summary.workPlan.detailSuppressionReason, "large_plan_recent_window");
    assert.equal(recap.summary.workPlan.currentSection, "");
    assert.deepEqual(recap.summary.workPlan.recentOpen, []);
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("Unit session recap: suppresses current and next details for historical generic todo plans", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "create-sentinelayer-session-historical-plan-recap-"));
  try {
    await seedWorkspace(tempRoot);
    await mkdir(path.join(tempRoot, "tasks"), { recursive: true });

    const lines = ["# Dogfood Backlog", "", "## Completed"];
    for (let index = 0; index < 176; index += 1) {
      lines.push(`- [x] Shipped historical slice ${index}`);
    }
    lines.push("", "## Plan");
    for (let index = 0; index < 17; index += 1) {
      lines.push(`- [ ] WI-${index + 1}: stale carried work item ${index + 1}`);
    }
    await writeFile(path.join(tempRoot, "tasks", "todo.md"), lines.join("\n"), "utf-8");

    const session = await createSession({ targetPath: tempRoot, ttlSeconds: 120 });

    const recap = await buildSessionRecap(session.sessionId, {
      forAgentId: "codex",
      targetPath: tempRoot,
      nowIso: "2026-05-19T09:03:00.000Z",
    });

    assert.match(
      recap.text,
      /Plan: 17 open \/ 176 done in tasks\/todo\.md from create-sentinelayer-session-historical-plan-recap-[^#]+#[a-f0-9]{8} \(session_metadata_target_path\)/,
    );
    assert.match(
      recap.text,
      /Current\/next items suppressed because this generic plan is mostly historical completed work/,
    );
    assert.doesNotMatch(recap.text, /Current: Plan/);
    assert.doesNotMatch(recap.text, /Next:/);
    assert.doesNotMatch(recap.text, /WI-5: stale carried work item/);
    assert.equal(recap.summary.workPlan.exists, true);
    assert.equal(recap.summary.workPlan.truncated, false);
    assert.equal(recap.summary.workPlan.detailSuppressed, true);
    assert.equal(recap.summary.workPlan.detailSuppressionReason, "historical_generic_plan_section");
    assert.equal(recap.summary.workPlan.currentSection, "");
    assert.deepEqual(recap.summary.workPlan.recentOpen, []);
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("Unit session recap: includes token and cost usage ledger", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "create-sentinelayer-session-usage-recap-"));
  try {
    await seedWorkspace(tempRoot);
    const session = await createSession({
      targetPath: tempRoot,
      ttlSeconds: 120,
      createdAt: "2026-05-19T08:00:00.000Z",
      expiresAt: "2027-05-19T08:00:00.000Z",
    });
    await appendToStream(
      session.sessionId,
      {
        event: "session_usage",
        agentId: "claude-mythos",
        ts: "2026-05-19T08:01:00.000Z",
        payload: {
          agentId: "claude-mythos",
          model: "claude-opus-4-7",
          usage: {
            totalTokens: 1000,
            inputTokens: 700,
            outputTokens: 300,
            costUsd: 0.02,
          },
        },
      },
      { targetPath: tempRoot },
    );
    await appendToStream(
      session.sessionId,
      {
        event: "session_usage",
        agentId: "codex",
        ts: "2026-05-19T08:02:00.000Z",
        payload: {
          agentId: "codex",
          model: "gpt-5.3-codex",
          usage: {
            input_tokens: 300,
            output_tokens: 200,
            provider_cost_usd: 0.01,
          },
        },
      },
      { targetPath: tempRoot },
    );

    const recap = await buildSessionRecap(session.sessionId, {
      forAgentId: "codex",
      maxEvents: 1,
      targetPath: tempRoot,
      nowIso: "2026-05-19T08:03:00.000Z",
    });

    assert.match(recap.text, /Usage: 1,500 tokens \/ \$0\.0300/);
    assert.match(recap.text, /Top agents: claude-mythos 1,000 tokens\/\$0\.0200; codex 500 tokens\/\$0\.0100/);
    assert.equal(recap.summary.usageTotals.totalTokens, 1500);
    assert.equal(recap.summary.usageTotals.inputTokens, 1000);
    assert.equal(recap.summary.usageTotals.outputTokens, 500);
    assert.equal(recap.summary.usageTotals.costUsd, 0.03);
    assert.equal(recap.summary.usageTopAgents[0].agentId, "claude-mythos");
    assert.equal(recap.summary.usageTopAgents[1].agentId, "codex");
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("Unit session recap: separates live listeners from recent transcript actors", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "create-sentinelayer-session-recap-listeners-"));
  try {
    await seedWorkspace(tempRoot);
    const session = await createSession({
      targetPath: tempRoot,
      ttlSeconds: 120,
      createdAt: "2026-05-19T08:00:00.000Z",
      expiresAt: "2027-05-19T08:00:00.000Z",
    });
    await appendToStream(
      session.sessionId,
      {
        event: "session_message",
        agentId: "codex-a1",
        sequenceId: 1,
        ts: "2026-05-19T08:01:00.000Z",
        payload: { message: "working on listener diagnostics" },
      },
      { targetPath: tempRoot },
    );
    await appendToStream(
      session.sessionId,
      {
        event: "session_message",
        agentId: "claude-b2",
        sequenceId: 2,
        ts: "2026-05-19T08:02:00.000Z",
        payload: { message: "reviewing the recap wording" },
      },
      { targetPath: tempRoot },
    );
    await appendToStream(
      session.sessionId,
      {
        event: "session_listener_heartbeat",
        agent: { id: "codex-a1", model: "gpt-5", displayName: "Codex" },
        sequenceId: 3,
        ts: "2026-05-19T08:02:30.000Z",
        payload: {
          source: "session_listen",
          listenerId: "codex-a1",
          active: false,
          idleIntervalSeconds: 40,
          presenceKeepaliveSeconds: 180,
        },
      },
      { targetPath: tempRoot },
    );
    await appendToStream(
      session.sessionId,
      {
        event: "session_listener_heartbeat",
        agent: { id: "stale-bot", model: "gpt-5", displayName: "Stale Bot" },
        sequenceId: 4,
        ts: "2026-05-19T07:50:00.000Z",
        payload: {
          source: "session_listen",
          listenerId: "stale-bot",
          active: false,
          idleIntervalSeconds: 40,
          presenceKeepaliveSeconds: 180,
        },
      },
      { targetPath: tempRoot },
    );

    const recap = await buildSessionRecap(session.sessionId, {
      forAgentId: "human-carter",
      maxEvents: 20,
      targetPath: tempRoot,
      nowIso: "2026-05-19T08:03:00.000Z",
    });

    assert.match(recap.text, /1 live listener \(codex-a1\)/);
    assert.match(recap.text, /2 recent actors \(claude-b2, codex-a1\)/);
    assert.doesNotMatch(recap.text, /2 active/);
    assert.equal(recap.summary.activeAgents, 2);
    assert.equal(recap.summary.recentActors, 2);
    assert.deepEqual(recap.summary.recentActorIds, ["claude-b2", "codex-a1"]);
    assert.equal(recap.summary.liveListeners, 1);
    assert.deepEqual(recap.summary.liveListenerIds, ["codex-a1"]);
    assert.equal(recap.summary.listenerCount, 2);
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("Unit session recap: listener heartbeats do not trigger recap prompts", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "create-sentinelayer-session-recap-heartbeats-"));
  try {
    await seedWorkspace(tempRoot);
    const session = await createSession({ targetPath: tempRoot, ttlSeconds: 120 });
    await appendToStream(
      session.sessionId,
      {
        event: "session_listener_heartbeat",
        agent: { id: "codex-a1", model: "gpt-5", displayName: "Codex" },
        ts: "2026-05-19T08:01:00.000Z",
        payload: {
          source: "session_listen",
          listenerId: "codex-a1",
          active: false,
          idleIntervalSeconds: 40,
          presenceKeepaliveSeconds: 180,
        },
      },
      { targetPath: tempRoot },
    );

    const shouldRecap = await shouldEmitRecap(session.sessionId, "human-carter", {
      lastReadAt: "2026-05-19T08:00:00.000Z",
      targetPath: tempRoot,
      nowIso: "2026-05-19T08:10:00.000Z",
      newEventThreshold: 1,
      inactivityMs: 1,
    });

    assert.equal(shouldRecap, false);
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("Unit session recap: CLI recap now emits deterministic JSON", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "create-sentinelayer-session-recap-now-"));
  try {
    await seedWorkspace(tempRoot);
    const session = await createSession({ targetPath: tempRoot, ttlSeconds: 120 });
    await registerAgent(session.sessionId, {
      agentId: "lead-r1f2",
      model: "gpt-5.4",
      role: "reviewer",
      targetPath: tempRoot,
    });
    await registerAgent(session.sessionId, {
      agentId: "codex-c3d4",
      model: "gpt-5.4",
      role: "coder",
      targetPath: tempRoot,
    });
    const codexTask = await assignTask(session.sessionId, {
      fromAgentId: "lead-r1f2",
      toAgentId: "codex-c3d4",
      priority: "P1",
      task: "Implement deterministic recap command output.",
      targetPath: tempRoot,
      nowIso: "2026-05-19T12:00:00.000Z",
    });
    await acceptTask(session.sessionId, "codex-c3d4", codexTask.task.taskId, {
      targetPath: tempRoot,
      nowIso: "2026-05-19T12:01:00.000Z",
    });

    const program = buildSessionProgram();
    const stdout = await captureConsoleLog(async () => {
      await program.parseAsync(
        [
          "session",
          "recap",
          "now",
          "--session",
          session.sessionId,
          "--agent",
          "codex-c3d4",
          "--path",
          tempRoot,
          "--max-events",
          "50",
          "--json",
        ],
        { from: "user" },
      );
    });

    const payload = JSON.parse(stdout);
    assert.equal(payload.command, "session recap now");
    assert.equal(payload.sessionId, session.sessionId);
    assert.equal(payload.agentId, "codex-c3d4");
    assert.equal(payload.maxEvents, 50);
    assert.equal(payload.ephemeral, true);
    assert.equal(payload.style, "italic-grey");
    assert.match(payload.recap, /Tasks: 1 active of 1 total/);
    assert.equal(payload.summary.pendingTasksForAgent, 1);
    assert.equal(payload.summary.taskLedger.accepted, 1);
    assert.equal(payload.summary.taskLedger.recent[0].taskId, codexTask.task.taskId);
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("Unit session recap: recent window uses event time, not late backfill append order", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "create-sentinelayer-session-recap-order-"));
  try {
    await seedWorkspace(tempRoot);
    const session = await createSession({ targetPath: tempRoot, ttlSeconds: 120 });

    await appendToStream(
      session.sessionId,
      {
        event: "session_message",
        agentId: "claude-reviewer",
        eventId: "fresh-proof",
        sequenceId: 200,
        ts: "2026-05-19T12:10:00.000Z",
        payload: { message: "fresh production proof is complete" },
      },
      { targetPath: tempRoot },
    );
    await appendToStream(
      session.sessionId,
      {
        event: "session_message",
        agentId: "claude-reviewer",
        eventId: "fresh-proof",
        sequenceId: 200,
        ts: "2026-05-19T12:10:00.000Z",
        payload: { message: "fresh production proof is complete" },
      },
      { targetPath: tempRoot },
    );
    await appendToStream(
      session.sessionId,
      {
        event: "session_message",
        agentId: "claude-reviewer",
        sequenceId: 100,
        ts: "2026-05-08T12:00:00.000Z",
        payload: { message: "old hydrated backfill should not dominate recap" },
      },
      { targetPath: tempRoot },
    );

    const recap = await buildSessionRecap(session.sessionId, {
      forAgentId: "codex",
      maxEvents: 1,
      targetPath: tempRoot,
      nowIso: "2026-05-19T12:11:00.000Z",
    });

    assert.match(recap.text, /fresh production proof is complete/);
    assert.doesNotMatch(recap.text, /old hydrated backfill/);
    assert.equal((recap.text.match(/fresh production proof is complete/g) || []).length, 1);
    assert.equal(recap.summary.lastEventAt, "2026-05-19T12:10:00.000Z");
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("Unit session recap: elapsedMinutes uses session age while windowElapsedMinutes uses selected events", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "create-sentinelayer-session-recap-age-"));
  try {
    await seedWorkspace(tempRoot);
    const session = await createSession({
      targetPath: tempRoot,
      ttlSeconds: 86_400,
      createdAt: "2026-05-19T00:00:00.000Z",
      expiresAt: "2027-05-19T00:00:00.000Z",
    });
    await appendToStream(
      session.sessionId,
      {
        event: "session_message",
        agentId: "claude-reviewer",
        sequenceId: 10,
        ts: "2026-05-19T11:30:00.000Z",
        payload: { message: "older event outside selected window" },
      },
      { targetPath: tempRoot },
    );
    await appendToStream(
      session.sessionId,
      {
        event: "session_message",
        agentId: "claude-reviewer",
        sequenceId: 11,
        ts: "2026-05-19T12:00:00.000Z",
        payload: { message: "latest selected event" },
      },
      { targetPath: tempRoot },
    );

    const recap = await buildSessionRecap(session.sessionId, {
      forAgentId: "codex",
      maxEvents: 1,
      targetPath: tempRoot,
      nowIso: "2026-05-19T12:01:00.000Z",
    });

    assert.equal(recap.summary.sessionStartedAt, "2026-05-19T00:00:00.000Z");
    assert.equal(recap.summary.elapsedMinutes, 721);
    assert.equal(recap.summary.windowElapsedMinutes, 1);
    assert.equal(recap.summary.lastEventAt, "2026-05-19T12:00:00.000Z");
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("Unit session recap: periodic recap emits while active and stops after inactivity", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "create-sentinelayer-session-periodic-"));
  let emitter = null;
  try {
    await seedWorkspace(tempRoot);
    const baseTime = Date.parse("2026-05-19T12:00:00.000Z");
    let nowOffsetMs = 20;
    const nowProvider = () => new Date(baseTime + nowOffsetMs).toISOString();
    const session = await createSession({ targetPath: tempRoot, ttlSeconds: 120 });
    await registerAgent(session.sessionId, {
      agentId: "codex-a1",
      model: "gpt-5.4",
      role: "coder",
      targetPath: tempRoot,
    });
    await appendToStream(
      session.sessionId,
      {
        event: "session_message",
        agentId: "codex-a1",
        ts: new Date(baseTime).toISOString(),
        payload: { message: "status: implementing recap flow" },
      },
      { targetPath: tempRoot }
    );
    await appendToStream(
      session.sessionId,
      {
        event: "session_usage",
        agentId: "codex-a1",
        ts: new Date(baseTime + 10).toISOString(),
        payload: {
          agentId: "codex-a1",
          model: "gpt-5.4",
          usage: {
            totalTokens: 600,
            inputTokens: 400,
            outputTokens: 200,
            costUsd: 0.006,
          },
        },
      },
      { targetPath: tempRoot },
    );

    emitter = emitPeriodicRecap(session.sessionId, {
      targetPath: tempRoot,
      intervalMs: 10_000,
      inactivityMs: 140,
      maxEvents: 50,
      nowProvider,
    });
    await emitter.tickNow();

    const firstPass = await readStream(session.sessionId, {
      tail: 50,
      targetPath: tempRoot,
    });
    const recaps = firstPass.filter((event) => event.event === "session_recap");
    assert.equal(recaps.length >= 1, true);
    assert.equal(recaps[0].payload.mode, "initial");
    assert.equal(recaps[0].payload.ephemeral, true);
    assert.equal(recaps[0].payload.style, "italic-grey");
    assert.match(recaps[0].payload.recap, /Usage: 600 tokens \/ \$0\.0060/);
    assert.equal(recaps[0].payload.summary.usageTotals.totalTokens, 600);
    assert.equal(recaps[0].payload.summary.usageTopAgents[0].agentId, "codex-a1");

    nowOffsetMs = 220;
    await emitter.tickNow();
    assert.equal(emitter.isRunning(), false);

    const secondPass = await readStream(session.sessionId, {
      tail: 50,
      targetPath: tempRoot,
    });
    const recapCount = secondPass.filter((event) => event.event === "session_recap").length;
    assert.equal(recapCount, 1);
  } finally {
    if (emitter && emitter.isRunning()) {
      emitter.stop("test_cleanup");
    }
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("Unit session recap: periodic emitter ignores interval when activity threshold is reached", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "create-sentinelayer-session-recap-threshold-"));
  let emitter = null;
  try {
    await seedWorkspace(tempRoot);
    const baseTime = Date.parse("2026-05-19T13:00:00.000Z");
    let nowOffsetMs = 100;
    const nowProvider = () => new Date(baseTime + nowOffsetMs).toISOString();
    const session = await createSession({ targetPath: tempRoot, ttlSeconds: 120 });
    await appendToStream(
      session.sessionId,
      {
        event: "session_message",
        agentId: "codex-a1",
        ts: new Date(baseTime).toISOString(),
        payload: { message: "initial recap source" },
      },
      { targetPath: tempRoot },
    );

    emitter = emitPeriodicRecap(session.sessionId, {
      targetPath: tempRoot,
      intervalMs: 60_000,
      inactivityMs: 600_000,
      newEventThreshold: 2,
      maxEvents: 50,
      nowProvider,
    });
    await emitter.tickNow();

    for (let index = 0; index < 2; index += 1) {
      await appendToStream(
        session.sessionId,
        {
          event: "session_message",
          agentId: "claude-reviewer",
          ts: new Date(baseTime + 1_000 + index * 1_000).toISOString(),
          payload: { message: `threshold source ${index + 1}` },
        },
        { targetPath: tempRoot },
      );
    }

    nowOffsetMs = 3_000;
    await emitter.tickNow();

    const events = await readStream(session.sessionId, {
      tail: 50,
      targetPath: tempRoot,
    });
    const recaps = events.filter((event) => event.event === "session_recap");
    assert.equal(recaps.length, 2);
    assert.equal(recaps[1].payload.mode, "activity_threshold");
    assert.equal(recaps[1].payload.sourceEventCount, 2);
    assert.equal(emitter.isRunning(), true);
  } finally {
    if (emitter && emitter.isRunning()) {
      emitter.stop("test_cleanup");
    }
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("Unit session recap: periodic emitter writes inactivity closeout before stopping", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "create-sentinelayer-session-recap-closeout-"));
  let emitter = null;
  try {
    await seedWorkspace(tempRoot);
    const baseTime = Date.parse("2026-05-19T14:00:00.000Z");
    let nowOffsetMs = 20;
    const nowProvider = () => new Date(baseTime + nowOffsetMs).toISOString();
    const session = await createSession({ targetPath: tempRoot, ttlSeconds: 120 });
    await appendToStream(
      session.sessionId,
      {
        event: "session_message",
        agentId: "codex-a1",
        ts: new Date(baseTime).toISOString(),
        payload: { message: "initial recap source" },
      },
      { targetPath: tempRoot },
    );

    emitter = emitPeriodicRecap(session.sessionId, {
      targetPath: tempRoot,
      intervalMs: 60_000,
      inactivityMs: 100,
      newEventThreshold: 5,
      maxEvents: 50,
      nowProvider,
    });
    await emitter.tickNow();

    await appendToStream(
      session.sessionId,
      {
        event: "session_message",
        agentId: "claude-reviewer",
        ts: new Date(baseTime + 40).toISOString(),
        payload: { message: "below-threshold handoff should close out on idle" },
      },
      { targetPath: tempRoot },
    );

    nowOffsetMs = 200;
    await emitter.tickNow();

    const events = await readStream(session.sessionId, {
      tail: 50,
      targetPath: tempRoot,
    });
    const recaps = events.filter((event) => event.event === "session_recap");
    assert.equal(recaps.length, 2);
    assert.equal(recaps[1].payload.mode, "inactivity");
    assert.equal(recaps[1].payload.sourceEventCount, 1);
    assert.equal(emitter.isRunning(), false);
    assert.equal(emitter.getState().stoppedReason, "inactive");
  } finally {
    if (emitter && emitter.isRunning()) {
      emitter.stop("test_cleanup");
    }
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("Unit session recap: shouldEmitRecap triggers on >=5 meaningful source events or inactivity", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "create-sentinelayer-session-should-recap-"));
  try {
    await seedWorkspace(tempRoot);
    const session = await createSession({ targetPath: tempRoot, ttlSeconds: 120 });
    await registerAgent(session.sessionId, {
      agentId: "agent-alpha",
      model: "gpt-5.4",
      role: "coder",
      targetPath: tempRoot,
    });
    await registerAgent(session.sessionId, {
      agentId: "agent-beta",
      model: "claude-3.7-sonnet",
      role: "reviewer",
      targetPath: tempRoot,
    });

    const lastReadAt = new Date().toISOString();
    const statusMessages = [
      "status update one",
      "status update two",
      "status update three",
      "status update four",
      "status update five",
    ];
    for (const message of statusMessages) {
      await appendToStream(
        session.sessionId,
        {
          event: "session_message",
          agentId: "agent-beta",
          payload: { message },
        },
        { targetPath: tempRoot }
      );
    }

    const byEventCount = await shouldEmitRecap(session.sessionId, "agent-alpha", {
      lastReadAt,
      targetPath: tempRoot,
    });
    assert.equal(byEventCount, true);

    const byInactivity = await shouldEmitRecap(session.sessionId, "agent-alpha", {
      lastReadAt: new Date(Date.now() + 1_000).toISOString(),
      targetPath: tempRoot,
      nowIso: new Date(Date.now() + 6 * 60_000).toISOString(),
    });
    assert.equal(byInactivity, true);
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});
