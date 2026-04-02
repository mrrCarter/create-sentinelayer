import pc from "picocolors";

import { getBudgetHealthColor } from "../../daemon/operator-control.js";

// Shared helper utilities for daemon command modules.

export function shouldEmitJson(options, command) {
  const local = Boolean(options && options.json);
  const globalFromCommand =
    command && command.optsWithGlobals ? Boolean(command.optsWithGlobals().json) : false;
  return local || globalFromCommand;
}

export function parsePositiveInteger(rawValue, field, fallbackValue) {
  if (rawValue === undefined || rawValue === null || String(rawValue).trim() === "") {
    return fallbackValue;
  }
  const normalized = Number(rawValue);
  if (!Number.isFinite(normalized) || normalized <= 0) {
    throw new Error(`${field} must be a positive integer.`);
  }
  return Math.floor(normalized);
}

export function parseCsv(rawValue) {
  if (rawValue === undefined || rawValue === null || String(rawValue).trim() === "") {
    return [];
  }
  return String(rawValue)
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

export function parseMetadata(rawValue) {
  if (!rawValue) {
    return {};
  }
  const parsed = JSON.parse(String(rawValue));
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("metadataJson must parse to an object.");
  }
  return parsed;
}

export function parseBoolean(rawValue, fallbackValue) {
  if (rawValue === undefined || rawValue === null || String(rawValue).trim() === "") {
    return fallbackValue;
  }
  const normalized = String(rawValue).trim().toLowerCase();
  if (normalized === "true" || normalized === "1" || normalized === "yes") {
    return true;
  }
  if (normalized === "false" || normalized === "0" || normalized === "no") {
    return false;
  }
  throw new Error("Value must be true/false.");
}

export function printQueueSummary(payload) {
  console.log(pc.bold("OMAR error daemon queue"));
  console.log(pc.gray(`Queue: ${payload.queuePath}`));
  console.log(pc.gray(`State: ${payload.statePath}`));
  console.log(
    pc.gray(
      `visible=${payload.visibleCount} total=${payload.totalCount} stream_offset=${payload.workerState?.streamOffset ?? 0}`
    )
  );
  for (const item of payload.items) {
    console.log(
      `- ${item.workItemId} | ${item.severity} | ${item.status} | occurrences=${item.occurrenceCount} | ${item.service} ${item.endpoint}`
    );
  }
}

export function printAssignmentSummary(payload) {
  console.log(pc.bold("OMAR assignment ledger"));
  console.log(pc.gray(`Ledger: ${payload.ledgerPath}`));
  console.log(pc.gray(`Queue: ${payload.queuePath}`));
  console.log(pc.gray(`Events: ${payload.eventsPath}`));
  console.log(pc.gray(`visible=${payload.visibleCount} total=${payload.totalCount}`));
  for (const assignment of payload.assignments) {
    console.log(
      `- ${assignment.workItemId} | ${assignment.status} | ${assignment.assignedAgentIdentity || "unassigned"} | stage=${assignment.stage} | lease_expires=${assignment.leaseExpiresAt || "n/a"}`
    );
  }
}

export function printJiraSummary(payload) {
  console.log(pc.bold("OMAR Jira lifecycle"));
  console.log(pc.gray(`Lifecycle: ${payload.lifecyclePath}`));
  console.log(pc.gray(`Events: ${payload.eventsPath}`));
  console.log(pc.gray(`visible=${payload.visibleCount} total=${payload.totalCount}`));
  for (const issue of payload.issues) {
    console.log(
      `- ${issue.issueKey} | ${issue.status} | work_item=${issue.workItemId} | assignee=${issue.assignee || "n/a"}`
    );
  }
}

export function printBudgetSummary(payload) {
  console.log(pc.bold("OMAR budget governor"));
  console.log(pc.gray(`State: ${payload.budgetStatePath}`));
  console.log(pc.gray(`Events: ${payload.budgetEventsPath}`));
  console.log(pc.gray(`visible=${payload.visibleCount} total=${payload.totalCount}`));
  for (const record of payload.records) {
    const stopCodes = Array.isArray(record.stopReasons)
      ? record.stopReasons.map((item) => item.code).join(", ")
      : "";
    console.log(
      `- ${record.workItemId} | ${record.lifecycleState} | action=${record.lastAction || "NONE"} | quarantine_until=${record.quarantineUntil || "n/a"}${stopCodes ? ` | stops=${stopCodes}` : ""}`
    );
  }
}

export function formatDurationSeconds(seconds) {
  const normalized = Number(seconds);
  if (!Number.isFinite(normalized) || normalized < 0) {
    return "n/a";
  }
  const total = Math.floor(normalized);
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const secs = total % 60;
  if (hours > 0) {
    return `${hours}h ${minutes}m ${secs}s`;
  }
  if (minutes > 0) {
    return `${minutes}m ${secs}s`;
  }
  return `${secs}s`;
}

export function colorizeBudgetHealth(value) {
  const normalized = getBudgetHealthColor(value);
  if (normalized === "RED") {
    return pc.red(normalized);
  }
  if (normalized === "YELLOW") {
    return pc.yellow(normalized);
  }
  return pc.green(normalized);
}

export function printControlPlaneSummary(payload) {
  console.log(pc.bold("OMAR operator control plane"));
  console.log(pc.gray(`State: ${payload.operatorStatePath}`));
  console.log(pc.gray(`Events: ${payload.operatorEventsPath}`));
  console.log(pc.gray(`Snapshot: ${payload.runPath}`));
  console.log(
    pc.gray(
      `visible=${payload.visibleWorkItems} total_queue=${payload.totalQueueItems} active_agents=${payload.agentRoster.length}`
    )
  );
  for (const row of payload.workItems) {
    console.log(
      `- ${row.workItemId} | ${row.severity} | ${row.workItemStatus} | agent=${row.assignedAgentIdentity || "unassigned"} | budget=${colorizeBudgetHealth(row.budgetHealthColor)} | elapsed=${formatDurationSeconds(row.sessionElapsedSeconds)} | idle=${formatDurationSeconds(row.sessionIdleSeconds)} | jira=${row.jiraIssueKey || "n/a"}`
    );
  }
  if (payload.agentRoster.length > 0) {
    console.log(pc.bold("Agent roster"));
    for (const agent of payload.agentRoster) {
      console.log(
        `- ${agent.agentIdentity} | work_items=${agent.workItemCount} | active=${agent.activeWorkItemCount} | blocked=${agent.blockedCount} | squashed=${agent.squashedCount} | longest_session=${formatDurationSeconds(agent.maxSessionElapsedSeconds)}`
      );
    }
  }
}

export function printLineageSummary(payload) {
  console.log(pc.bold("OMAR artifact lineage"));
  console.log(pc.gray(`Index: ${payload.indexPath}`));
  console.log(pc.gray(`Events: ${payload.eventPath}`));
  console.log(
    pc.gray(
      `visible=${payload.visibleCount} total=${payload.totalCount} lineage_run=${payload.lineageRunId || "n/a"}`
    )
  );
  for (const item of payload.workItems) {
    console.log(
      `- ${item.workItemId} | ${item.severity} | ${item.workItemStatus} | agent=${item.links?.agentIdentity || "unassigned"} | jira=${item.links?.jiraIssueKey || "n/a"} | budget=${item.links?.budgetLifecycleState || "WITHIN_BUDGET"} | operator_snapshot=${item.links?.latestOperatorSnapshotRunId || "n/a"}`
    );
  }
}

export function printHybridMapSummary(payload) {
  console.log(pc.bold("OMAR hybrid mapping overlay"));
  console.log(pc.gray(`Index: ${payload.mapIndexPath}`));
  console.log(pc.gray(`Events: ${payload.mapEventsPath}`));
  console.log(pc.gray(`visible=${payload.visibleCount} total=${payload.totalCount}`));
  for (const map of payload.maps) {
    console.log(
      `- ${map.workItemId} | run=${map.runId} | status=${map.status || "n/a"} | seeds=${map.deterministicSeedCount || 0} | scoped=${map.scopedFileCount || 0}`
    );
  }
}

export function printReliabilitySummary(payload) {
  console.log(pc.bold("OMAR reliability lane"));
  console.log(pc.gray(`Config: ${payload.configPath}`));
  console.log(pc.gray(`Billboard: ${payload.billboardPath}`));
  console.log(pc.gray(`Events: ${payload.eventsPath}`));
  console.log(
    pc.gray(
      `maintenance=${payload.billboard?.enabled ? "ON" : "OFF"} checks=${payload.config?.checks?.length || 0} recent_runs=${payload.recentRuns?.length || 0}`
    )
  );
  for (const run of payload.recentRuns || []) {
    console.log(
      `- ${run.runId} | ${run.overallStatus} | failures=${run.failureCount} | ${run.generatedAt}`
    );
  }
}
