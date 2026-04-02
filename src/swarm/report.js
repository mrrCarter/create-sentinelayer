import fsp from "node:fs/promises";
import path from "node:path";

import { resolveOutputRoot } from "../config/service.js";
import { loadSwarmDashboardSnapshot, resolveSwarmRuntimeFiles } from "./dashboard.js";

function normalizeString(value) {
  return String(value || "").trim();
}

async function pathExists(targetPath) {
  try {
    await fsp.access(targetPath);
    return true;
  } catch {
    return false;
  }
}

function summarizeAgents(agentRows = []) {
  const summary = {
    completed: 0,
    running: 0,
    stopped: 0,
    unknown: 0,
  };
  for (const row of agentRows) {
    const status = normalizeString(row.status).toLowerCase();
    if (status === "completed") {
      summary.completed += 1;
      continue;
    }
    if (status === "running") {
      summary.running += 1;
      continue;
    }
    if (status === "stopped") {
      summary.stopped += 1;
      continue;
    }
    summary.unknown += 1;
  }
  return summary;
}

function buildReportMarkdown(report = {}) {
  const agentRows = (report.agentRows || [])
    .map(
      (row) =>
        `- ${row.agentId} status=${row.status} events=${row.eventCount} last=${row.lastEventType || "n/a"}`
    )
    .join("\n");
  const recentEvents = (report.recentEvents || [])
    .map((event) => `- ${event.timestamp} [${event.eventType}] ${event.agentId}: ${event.message}`)
    .join("\n");

  return `# SWARM_EXECUTION_REPORT

Generated: ${report.generatedAt}
Runtime run ID: ${report.runtimeRunId}
Plan run ID: ${report.planRunId || "n/a"}
Scenario: ${report.scenario}
Engine: ${report.engine}
Execute: ${report.execute ? "yes" : "no"}
Completed: ${report.completed ? "yes" : "no"}
Stop class: ${report.stop?.stopClass || "NONE"}
Stop reason: ${report.stop?.reason || "none"}

Usage:
- output_tokens: ${report.usage.outputTokens || 0}
- tool_calls: ${report.usage.toolCalls || 0}
- duration_ms: ${report.usage.durationMs || 0}
- cost_usd: ${report.usage.costUsd || 0}

Agents:
${agentRows || "- none"}

Recent events:
${recentEvents || "- none"}

Artifacts:
- runtime_json: ${report.runtimeJsonPath}
- runtime_events: ${report.runtimeEventsPath}
- plan_json: ${report.planJsonPath || "n/a"}
- report_json: ${report.reportJsonPath}
`;
}

export async function buildSwarmExecutionReport({
  targetPath = ".",
  outputDir = "",
  runId = "",
  planFile = "",
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
  const snapshot = await loadSwarmDashboardSnapshot({
    targetPath,
    outputDir,
    runId: files.runId,
    env,
    homeDir,
  });

  const outputRoot = await resolveOutputRoot({
    cwd: path.resolve(String(targetPath || ".")),
    outputDirOverride: outputDir,
    env,
    homeDir,
  });

  const runtimeSummary = JSON.parse(await fsp.readFile(files.runtimeJsonPath, "utf-8"));
  const selectedPlanPath = normalizeString(planFile)
    ? path.resolve(process.cwd(), planFile)
    : path.join(outputRoot, "swarms", normalizeString(runtimeSummary.planRunId), "SWARM_PLAN.json");
  const planJsonPath = (await pathExists(selectedPlanPath)) ? selectedPlanPath : "";
  const plan = planJsonPath ? JSON.parse(await fsp.readFile(planJsonPath, "utf-8")) : null;

  const reportJsonPath = path.join(files.runtimeDirectory, "SWARM_EXECUTION_REPORT.json");
  const reportMarkdownPath = path.join(files.runtimeDirectory, "SWARM_EXECUTION_REPORT.md");
  const report = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    runtimeRunId: runtimeSummary.runId,
    planRunId: normalizeString(runtimeSummary.planRunId),
    scenario: runtimeSummary.scenario,
    engine: runtimeSummary.engine,
    execute: Boolean(runtimeSummary.execute),
    completed: Boolean(runtimeSummary.completed),
    stop: runtimeSummary.stop || {
      stopClass: "NONE",
      reason: "",
      blocking: false,
    },
    usage: runtimeSummary.usage || {},
    eventCount: runtimeSummary.eventCount || snapshot.eventCount,
    agentRows: snapshot.agentRows,
    agentSummary: summarizeAgents(snapshot.agentRows),
    recentEvents: snapshot.recentEvents,
    runtimeJsonPath: files.runtimeJsonPath,
    runtimeEventsPath: files.runtimeEventsPath,
    planJsonPath,
    planSelectedAgents: Array.isArray(plan?.selectedAgents) ? plan.selectedAgents : [],
    reportJsonPath,
    reportMarkdownPath,
  };

  await fsp.writeFile(reportJsonPath, `${JSON.stringify(report, null, 2)}\n`, "utf-8");
  await fsp.writeFile(reportMarkdownPath, `${buildReportMarkdown(report).trim()}\n`, "utf-8");
  return report;
}
