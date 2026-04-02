import fsp from "node:fs/promises";
import path from "node:path";

import { resolveOutputRoot } from "../config/service.js";

function normalizeString(value) {
  return String(value || "").trim();
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function pathExists(targetPath) {
  try {
    await fsp.access(targetPath);
    return true;
  } catch {
    return false;
  }
}

function toAgentRows(summary = {}, events = []) {
  const byAgent = new Map();
  for (const agentId of summary.selectedAgents || []) {
    byAgent.set(agentId, {
      agentId,
      eventCount: 0,
      lastEventType: "",
      lastTimestamp: "",
      lastMessage: "",
      status: summary.completed ? "completed" : "running",
    });
  }

  for (const event of events) {
    const agentId = normalizeString(event.agentId || "unknown").toLowerCase() || "unknown";
    const current = byAgent.get(agentId) || {
      agentId,
      eventCount: 0,
      lastEventType: "",
      lastTimestamp: "",
      lastMessage: "",
      status: summary.completed ? "completed" : "running",
    };
    current.eventCount += 1;
    current.lastEventType = normalizeString(event.eventType);
    current.lastTimestamp = normalizeString(event.timestamp);
    current.lastMessage = normalizeString(event.message);
    byAgent.set(agentId, current);
  }

  if (!summary.completed && summary.stop?.blocking) {
    const omar = byAgent.get("omar") || {
      agentId: "omar",
      eventCount: 0,
      lastEventType: "",
      lastTimestamp: "",
      lastMessage: "",
      status: "stopped",
    };
    omar.status = "stopped";
    byAgent.set("omar", omar);
  }

  return [...byAgent.values()].sort((left, right) => left.agentId.localeCompare(right.agentId));
}

export async function resolveSwarmRuntimeFiles({
  targetPath = ".",
  outputDir = "",
  runId = "",
  env,
  homeDir,
} = {}) {
  const normalizedTargetPath = path.resolve(String(targetPath || "."));
  const outputRoot = await resolveOutputRoot({
    cwd: normalizedTargetPath,
    outputDirOverride: outputDir,
    env,
    homeDir,
  });
  const swarmsDirectory = path.join(outputRoot, "swarms");
  const requestedRunId = normalizeString(runId);
  if (requestedRunId) {
    const runtimeDirectory = path.join(swarmsDirectory, requestedRunId, "runtime");
    return {
      outputRoot,
      runId: requestedRunId,
      runtimeDirectory,
      runtimeJsonPath: path.join(runtimeDirectory, "SWARM_RUNTIME.json"),
      runtimeEventsPath: path.join(runtimeDirectory, "events.ndjson"),
    };
  }

  const entries = await fsp.readdir(swarmsDirectory, { withFileTypes: true });
  const runtimeCandidates = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue;
    }
    if (!entry.name.startsWith("swarm-runtime-")) {
      continue;
    }
    const runtimeDirectory = path.join(swarmsDirectory, entry.name, "runtime");
    const runtimeJsonPath = path.join(runtimeDirectory, "SWARM_RUNTIME.json");
    if (!(await pathExists(runtimeJsonPath))) {
      continue;
    }
    const stats = await fsp.stat(runtimeJsonPath);
    runtimeCandidates.push({
      runId: entry.name,
      runtimeDirectory,
      runtimeJsonPath,
      runtimeEventsPath: path.join(runtimeDirectory, "events.ndjson"),
      mtimeMs: stats.mtimeMs,
    });
  }

  if (runtimeCandidates.length === 0) {
    throw new Error("No swarm runtime artifacts found.");
  }

  runtimeCandidates.sort((left, right) => right.mtimeMs - left.mtimeMs);
  const latest = runtimeCandidates[0];
  return {
    outputRoot,
    runId: latest.runId,
    runtimeDirectory: latest.runtimeDirectory,
    runtimeJsonPath: latest.runtimeJsonPath,
    runtimeEventsPath: latest.runtimeEventsPath,
  };
}

export async function loadSwarmDashboardSnapshot({
  targetPath = ".",
  outputDir = "",
  runId = "",
  env,
  homeDir,
} = {}) {
  const files = await resolveSwarmRuntimeFiles({
    targetPath,
    outputDir,
    runId,
    env,
    homeDir,
  });
  const summary = JSON.parse(await fsp.readFile(files.runtimeJsonPath, "utf-8"));
  const eventsRaw = await fsp.readFile(files.runtimeEventsPath, "utf-8");
  const events = String(eventsRaw || "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line));

  const snapshot = {
    runId: summary.runId,
    planRunId: summary.planRunId,
    scenario: summary.scenario,
    engine: summary.engine,
    execute: Boolean(summary.execute),
    completed: Boolean(summary.completed),
    stop: summary.stop || { stopClass: "NONE", reason: "", blocking: false },
    usage: summary.usage || {},
    eventCount: events.length,
    runtimeJsonPath: files.runtimeJsonPath,
    runtimeEventsPath: files.runtimeEventsPath,
    runtimeDirectory: files.runtimeDirectory,
    generatedAt: new Date().toISOString(),
    agentRows: toAgentRows(summary, events),
    recentEvents: events.slice(-10),
  };

  return snapshot;
}

export function renderSwarmDashboard(snapshot = {}) {
  const header = [
    `Swarm run: ${snapshot.runId}`,
    `Scenario: ${snapshot.scenario}`,
    `Status: ${snapshot.completed ? "completed" : "running"}${snapshot.stop?.blocking ? ` (${snapshot.stop.stopClass})` : ""}`,
    `Usage: tokens=${snapshot.usage.outputTokens || 0} tools=${snapshot.usage.toolCalls || 0} runtime_ms=${snapshot.usage.durationMs || 0} cost_usd=${snapshot.usage.costUsd || 0}`,
  ].join("\n");

  const rows = (snapshot.agentRows || [])
    .map(
      (row) =>
        `- ${row.agentId} status=${row.status} events=${row.eventCount} last=${row.lastEventType || "n/a"}`
    )
    .join("\n");

  return `${header}\nAgents:\n${rows || "- none"}`;
}

export async function watchSwarmDashboard({
  targetPath = ".",
  outputDir = "",
  runId = "",
  pollSeconds = 2,
  maxIdleSeconds = 20,
  env,
  homeDir,
  onSnapshot,
} = {}) {
  const pollMs = Math.max(250, Math.floor(Number(pollSeconds || 2) * 1000));
  const maxIdleMs = Math.max(1000, Math.floor(Number(maxIdleSeconds || 20) * 1000));
  let lastSignature = "";
  let lastUpdate = Date.now();
  const snapshots = [];

  while (true) {
    const snapshot = await loadSwarmDashboardSnapshot({
      targetPath,
      outputDir,
      runId,
      env,
      homeDir,
    });
    const signature = `${snapshot.eventCount}:${snapshot.usage.toolCalls || 0}:${snapshot.completed}:${snapshot.stop?.stopClass || "NONE"}`;
    if (signature !== lastSignature) {
      lastSignature = signature;
      lastUpdate = Date.now();
      snapshots.push(snapshot);
      if (onSnapshot) {
        await onSnapshot(snapshot);
      }
    }

    if (snapshot.completed || snapshot.stop?.blocking) {
      return {
        finalSnapshot: snapshot,
        snapshots,
        stopReason: snapshot.completed ? "COMPLETED" : snapshot.stop?.stopClass || "STOPPED",
      };
    }

    if (Date.now() - lastUpdate >= maxIdleMs) {
      return {
        finalSnapshot: snapshot,
        snapshots,
        stopReason: "IDLE_TIMEOUT",
      };
    }
    await sleep(pollMs);
  }
}
