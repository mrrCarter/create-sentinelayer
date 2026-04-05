import path from "node:path";

import pc from "picocolors";

import {
  WORK_ITEM_STATUSES,
  appendAdminErrorEvent,
  listErrorQueue,
  runErrorDaemonWorker,
} from "../../daemon/error-worker.js";
import { buildArtifactLineageIndex, listArtifactLineage } from "../../daemon/artifact-lineage.js";
import {
  buildHybridScopeMap,
  buildHybridHandoffPackage,
  listHybridHandoffs,
  listHybridScopeMaps,
  showHybridHandoff,
  showHybridScopeMap,
} from "../../daemon/hybrid-mapper.js";
import {
  RELIABILITY_CHECK_IDS,
  getReliabilityLaneStatus,
  runReliabilityLane,
  setMaintenanceBillboard,
} from "../../daemon/reliability-lane.js";
import { getWatchdogStatus, runWatchdogTick } from "../../daemon/watchdog.js";
import {
  parseBoolean,
  parseCsv,
  parseMetadata,
  parsePositiveInteger,
  printHybridMapSummary,
  printLineageSummary,
  printQueueSummary,
  printReliabilitySummary,
  shouldEmitJson,
} from "./shared.js";

export function registerDaemonExtendedCommands(daemon) {
const lineage = daemon
  .command("lineage")
  .description("Build and inspect deterministic observability artifact lineage by work item");

lineage
  .option("--path <path>", "Workspace path for artifact/config resolution", ".")
  .option("--output-dir <path>", "Optional output dir override for daemon artifacts")
  .option(
    "--status <csv>",
    `Optional queue status filter (${WORK_ITEM_STATUSES.join(", ")})`
  )
  .option("--work-item-id <id>", "Filter to a specific work item id")
  .option("--limit <n>", "Maximum work items to return", "50")
  .option("--json", "Emit machine-readable output")
  .action(async (options, command) => {
    const targetPath = path.resolve(process.cwd(), String(options.path || "."));
    const listed = await listArtifactLineage({
      targetPath,
      outputDir: options.outputDir,
      statuses: parseCsv(options.status),
      workItemId: options.workItemId,
      limit: parsePositiveInteger(options.limit, "limit", 50),
    });
    const payload = {
      command: "daemon lineage",
      targetPath,
      indexPath: listed.lineageIndexPath,
      eventPath: listed.lineageEventsPath,
      generatedAt: listed.generatedAt,
      lineageRunId: listed.lineageRunId,
      summary: listed.summary,
      totalCount: listed.totalCount,
      visibleCount: listed.workItems.length,
      workItems: listed.workItems,
      runs: listed.runs,
    };
    if (shouldEmitJson(options, command)) {
      console.log(JSON.stringify(payload, null, 2));
      return;
    }
    printLineageSummary(payload);
  });

lineage
  .command("build")
  .description("Rebuild deterministic artifact lineage index from daemon observability artifacts")
  .option("--path <path>", "Workspace path for artifact/config resolution", ".")
  .option("--output-dir <path>", "Optional output dir override for daemon artifacts")
  .option("--now-iso <timestamp>", "Optional deterministic timestamp override")
  .option("--json", "Emit machine-readable output")
  .action(async (options, command) => {
    const targetPath = path.resolve(process.cwd(), String(options.path || "."));
    const built = await buildArtifactLineageIndex({
      targetPath,
      outputDir: options.outputDir,
      nowIso: options.nowIso,
    });
    const payload = {
      command: "daemon lineage build",
      targetPath,
      indexPath: built.indexPath,
      eventPath: built.eventPath,
      lineageRunId: built.lineageRunId,
      summary: built.summary,
      totalCount: built.workItems.length,
      visibleCount: Math.min(built.workItems.length, 20),
      workItems: built.workItems.slice(0, 20),
    };
    if (shouldEmitJson(options, command)) {
      console.log(JSON.stringify(payload, null, 2));
      return;
    }
    printLineageSummary(payload);
  });

lineage
  .command("list")
  .description("List lineage work-item records from the latest lineage index")
  .option("--path <path>", "Workspace path for artifact/config resolution", ".")
  .option("--output-dir <path>", "Optional output dir override for daemon artifacts")
  .option(
    "--status <csv>",
    `Optional queue status filter (${WORK_ITEM_STATUSES.join(", ")})`
  )
  .option("--work-item-id <id>", "Filter to a specific work item id")
  .option("--limit <n>", "Maximum work items to return", "50")
  .option("--json", "Emit machine-readable output")
  .action(async (options, command) => {
    const targetPath = path.resolve(process.cwd(), String(options.path || "."));
    const listed = await listArtifactLineage({
      targetPath,
      outputDir: options.outputDir,
      statuses: parseCsv(options.status),
      workItemId: options.workItemId,
      limit: parsePositiveInteger(options.limit, "limit", 50),
    });
    const payload = {
      command: "daemon lineage list",
      targetPath,
      indexPath: listed.lineageIndexPath,
      eventPath: listed.lineageEventsPath,
      generatedAt: listed.generatedAt,
      lineageRunId: listed.lineageRunId,
      summary: listed.summary,
      totalCount: listed.totalCount,
      visibleCount: listed.workItems.length,
      workItems: listed.workItems,
    };
    if (shouldEmitJson(options, command)) {
      console.log(JSON.stringify(payload, null, 2));
      return;
    }
    printLineageSummary(payload);
  });

lineage
  .command("show")
  .description("Show one lineage work-item record by id")
  .argument("<workItemId>", "Queue work item id")
  .option("--path <path>", "Workspace path for artifact/config resolution", ".")
  .option("--output-dir <path>", "Optional output dir override for daemon artifacts")
  .option("--json", "Emit machine-readable output")
  .action(async (workItemId, options, command) => {
    const targetPath = path.resolve(process.cwd(), String(options.path || "."));
    const listed = await listArtifactLineage({
      targetPath,
      outputDir: options.outputDir,
      workItemId,
      limit: 1,
    });
    const record = listed.workItems[0] || null;
    if (!record) {
      throw new Error(`No lineage record found for work item '${workItemId}'.`);
    }
    const payload = {
      command: "daemon lineage show",
      targetPath,
      indexPath: listed.lineageIndexPath,
      eventPath: listed.lineageEventsPath,
      generatedAt: listed.generatedAt,
      lineageRunId: listed.lineageRunId,
      workItem: record,
    };
    if (shouldEmitJson(options, command)) {
      console.log(JSON.stringify(payload, null, 2));
      return;
    }
    console.log(pc.bold("OMAR artifact lineage record"));
    console.log(pc.gray(`Index: ${listed.lineageIndexPath}`));
    console.log(
      `${record.workItemId} status=${record.workItemStatus} jira=${record.links?.jiraIssueKey || "n/a"} agent=${record.links?.agentIdentity || "unassigned"}`
    );
  });

const map = daemon
  .command("map")
  .description("Hybrid deterministic + semantic codebase mapping overlay for work-item impact scope");

map
  .option("--path <path>", "Workspace path for artifact/config resolution", ".")
  .option("--output-dir <path>", "Optional output dir override for daemon artifacts")
  .option("--work-item-id <id>", "Optional work item filter")
  .option("--limit <n>", "Maximum map entries to return", "50")
  .option("--json", "Emit machine-readable output")
  .action(async (options, command) => {
    const targetPath = path.resolve(process.cwd(), String(options.path || "."));
    const listed = await listHybridScopeMaps({
      targetPath,
      outputDir: options.outputDir,
      workItemId: options.workItemId,
      limit: parsePositiveInteger(options.limit, "limit", 50),
    });
    const payload = {
      command: "daemon map",
      targetPath,
      mapIndexPath: listed.mapIndexPath,
      mapEventsPath: listed.mapEventsPath,
      generatedAt: listed.generatedAt,
      totalCount: listed.totalCount,
      visibleCount: listed.maps.length,
      maps: listed.maps,
    };
    if (shouldEmitJson(options, command)) {
      console.log(JSON.stringify(payload, null, 2));
      return;
    }
    printHybridMapSummary(payload);
  });

map
  .command("scope")
  .description("Build one hybrid scope map for a daemon work item")
  .argument("<workItemId>", "Queue work item id")
  .option("--path <path>", "Workspace path for artifact/config resolution", ".")
  .option("--output-dir <path>", "Optional output dir override for daemon artifacts")
  .option("--max-files <n>", "Maximum scoped files to emit", "40")
  .option("--graph-depth <n>", "Import-graph expansion depth", "2")
  .option("--now-iso <timestamp>", "Optional deterministic timestamp override")
  .option("--json", "Emit machine-readable output")
  .action(async (workItemId, options, command) => {
    const targetPath = path.resolve(process.cwd(), String(options.path || "."));
    const mapped = await buildHybridScopeMap({
      targetPath,
      outputDir: options.outputDir,
      workItemId,
      maxFiles: parsePositiveInteger(options.maxFiles, "max-files", 40),
      graphDepth: parsePositiveInteger(options.graphDepth, "graph-depth", 2),
      nowIso: options.nowIso,
    });
    const payload = {
      command: "daemon map scope",
      targetPath,
      runId: mapped.runId,
      runPath: mapped.runPath,
      mapIndexPath: mapped.mapIndexPath,
      mapEventsPath: mapped.mapEventsPath,
      strategy: mapped.strategy,
      summary: mapped.summary,
      workItem: mapped.workItem,
      scopedFiles: mapped.scopedFiles,
      importGraph: mapped.importGraph,
    };
    if (shouldEmitJson(options, command)) {
      console.log(JSON.stringify(payload, null, 2));
      return;
    }
    console.log(pc.bold("Hybrid scope map generated"));
    console.log(pc.gray(`Run: ${mapped.runId}`));
    console.log(pc.gray(`Artifact: ${mapped.runPath}`));
    console.log(
      `${mapped.workItem.workItemId} scoped_files=${mapped.summary.scopedFileCount} graph_nodes=${mapped.summary.graphNodeCount}`
    );
  });

map
  .command("list")
  .description("List hybrid scope map records")
  .option("--path <path>", "Workspace path for artifact/config resolution", ".")
  .option("--output-dir <path>", "Optional output dir override for daemon artifacts")
  .option("--work-item-id <id>", "Optional work item filter")
  .option("--limit <n>", "Maximum map entries to return", "50")
  .option("--json", "Emit machine-readable output")
  .action(async (options, command) => {
    const targetPath = path.resolve(process.cwd(), String(options.path || "."));
    const listed = await listHybridScopeMaps({
      targetPath,
      outputDir: options.outputDir,
      workItemId: options.workItemId,
      limit: parsePositiveInteger(options.limit, "limit", 50),
    });
    const payload = {
      command: "daemon map list",
      targetPath,
      mapIndexPath: listed.mapIndexPath,
      mapEventsPath: listed.mapEventsPath,
      generatedAt: listed.generatedAt,
      totalCount: listed.totalCount,
      visibleCount: listed.maps.length,
      maps: listed.maps,
    };
    if (shouldEmitJson(options, command)) {
      console.log(JSON.stringify(payload, null, 2));
      return;
    }
    printHybridMapSummary(payload);
  });

map
  .command("show")
  .description("Show one hybrid scope map artifact by work item (or explicit run)")
  .argument("<workItemId>", "Queue work item id")
  .option("--path <path>", "Workspace path for artifact/config resolution", ".")
  .option("--output-dir <path>", "Optional output dir override for daemon artifacts")
  .option("--run-id <id>", "Optional explicit map run id")
  .option("--json", "Emit machine-readable output")
  .action(async (workItemId, options, command) => {
    const targetPath = path.resolve(process.cwd(), String(options.path || "."));
    const shown = await showHybridScopeMap({
      targetPath,
      outputDir: options.outputDir,
      workItemId,
      runId: options.runId,
    });
    const payload = {
      command: "daemon map show",
      targetPath,
      mapIndexPath: shown.mapIndexPath,
      mapEventsPath: shown.mapEventsPath,
      mapPath: shown.mapPath,
      map: shown.map,
      payload: shown.payload,
    };
    if (shouldEmitJson(options, command)) {
      console.log(JSON.stringify(payload, null, 2));
      return;
    }
    console.log(pc.bold("Hybrid scope map"));
    console.log(pc.gray(`Artifact: ${shown.mapPath}`));
    console.log(
      `${shown.payload.workItem.workItemId} scoped_files=${shown.payload.summary?.scopedFileCount || 0} run=${shown.payload.runId}`
    );
  });

map
  .command("handoff")
  .description("Build deterministic handoff package from hybrid map scope for one work item")
  .argument("<workItemId>", "Queue work item id")
  .option("--path <path>", "Workspace path for artifact/config resolution", ".")
  .option("--output-dir <path>", "Optional output dir override for daemon artifacts")
  .option("--run-id <id>", "Optional explicit source map run id")
  .option("--assignee <identity>", "Primary target agent identity", "omar")
  .option("--max-files <n>", "Maximum scoped files to include in handoff package", "24")
  .option("--now-iso <timestamp>", "Optional deterministic timestamp override")
  .option("--json", "Emit machine-readable output")
  .action(async (workItemId, options, command) => {
    const targetPath = path.resolve(process.cwd(), String(options.path || "."));
    const handoff = await buildHybridHandoffPackage({
      targetPath,
      outputDir: options.outputDir,
      workItemId,
      mapRunId: options.runId,
      assignee: options.assignee,
      maxFiles: parsePositiveInteger(options.maxFiles, "max-files", 24),
      nowIso: options.nowIso,
    });
    const payload = {
      command: "daemon map handoff",
      targetPath,
      handoffRunId: handoff.handoffRunId,
      handoffPath: handoff.handoffPath,
      handoffIndexPath: handoff.handoffIndexPath,
      handoffEventsPath: handoff.handoffEventsPath,
      summary: handoff.summary,
      payload: handoff.payload,
    };
    if (shouldEmitJson(options, command)) {
      console.log(JSON.stringify(payload, null, 2));
      return;
    }
    console.log(pc.bold("Hybrid handoff package generated"));
    console.log(pc.gray(`Run: ${handoff.handoffRunId}`));
    console.log(pc.gray(`Artifact: ${handoff.handoffPath}`));
    console.log(
      `${handoff.payload.workItem.workItemId} assignee=${handoff.payload.assignee.primary} files=${handoff.summary.scopedFileCount} tokens=${handoff.summary.estimatedInputTokens}`
    );
  });

map
  .command("handoff-list")
  .description("List hybrid handoff package records")
  .option("--path <path>", "Workspace path for artifact/config resolution", ".")
  .option("--output-dir <path>", "Optional output dir override for daemon artifacts")
  .option("--work-item-id <id>", "Optional work item filter")
  .option("--limit <n>", "Maximum handoff records to return", "50")
  .option("--json", "Emit machine-readable output")
  .action(async (options, command) => {
    const targetPath = path.resolve(process.cwd(), String(options.path || "."));
    const listed = await listHybridHandoffs({
      targetPath,
      outputDir: options.outputDir,
      workItemId: options.workItemId,
      limit: parsePositiveInteger(options.limit, "limit", 50),
    });
    const payload = {
      command: "daemon map handoff-list",
      targetPath,
      handoffIndexPath: listed.handoffIndexPath,
      handoffEventsPath: listed.handoffEventsPath,
      generatedAt: listed.generatedAt,
      totalCount: listed.totalCount,
      visibleCount: listed.handoffs.length,
      handoffs: listed.handoffs,
    };
    if (shouldEmitJson(options, command)) {
      console.log(JSON.stringify(payload, null, 2));
      return;
    }
    console.log(pc.bold("Hybrid handoff packages"));
    console.log(pc.gray(`Index: ${listed.handoffIndexPath}`));
    console.log(pc.gray(`Events: ${listed.handoffEventsPath}`));
    console.log(pc.gray(`visible=${listed.handoffs.length} total=${listed.totalCount}`));
    for (const entry of listed.handoffs) {
      console.log(
        `- ${entry.handoffRunId} | work_item=${entry.workItemId} | assignee=${entry.assignee} | files=${entry.scopedFileCount}`
      );
    }
  });

map
  .command("handoff-show")
  .description("Show one hybrid handoff package artifact by work item (or explicit run)")
  .argument("<workItemId>", "Queue work item id")
  .option("--path <path>", "Workspace path for artifact/config resolution", ".")
  .option("--output-dir <path>", "Optional output dir override for daemon artifacts")
  .option("--handoff-run-id <id>", "Optional explicit handoff run id")
  .option("--json", "Emit machine-readable output")
  .action(async (workItemId, options, command) => {
    const targetPath = path.resolve(process.cwd(), String(options.path || "."));
    const shown = await showHybridHandoff({
      targetPath,
      outputDir: options.outputDir,
      workItemId,
      handoffRunId: options.handoffRunId,
    });
    const payload = {
      command: "daemon map handoff-show",
      targetPath,
      handoffIndexPath: shown.handoffIndexPath,
      handoffEventsPath: shown.handoffEventsPath,
      handoffPath: shown.handoffPath,
      handoff: shown.handoff,
      payload: shown.payload,
    };
    if (shouldEmitJson(options, command)) {
      console.log(JSON.stringify(payload, null, 2));
      return;
    }
    console.log(pc.bold("Hybrid handoff package"));
    console.log(pc.gray(`Artifact: ${shown.handoffPath}`));
    console.log(
      `${shown.payload.workItem.workItemId} assignee=${shown.payload.assignee.primary} files=${shown.payload.files.length}`
    );
  });

const reliability = daemon
  .command("reliability")
  .description("Midnight reliability lane controls and maintenance-billboard automation");

const watchdog = daemon
  .command("watchdog")
  .description("Stuck-agent watchdog heuristics with state-change alerts and channel dispatch");

watchdog
  .option("--path <path>", "Workspace path for artifact/config resolution", ".")
  .option("--output-dir <path>", "Optional output dir override for daemon artifacts")
  .option("--limit <n>", "Maximum recent runs to return", "10")
  .option("--json", "Emit machine-readable output")
  .action(async (options, command) => {
    const targetPath = path.resolve(process.cwd(), String(options.path || "."));
    const status = await getWatchdogStatus({
      targetPath,
      outputDir: options.outputDir,
      limit: parsePositiveInteger(options.limit, "limit", 10),
    });
    const payload = {
      command: "daemon watchdog",
      targetPath,
      configPath: status.configPath,
      statePath: status.statePath,
      eventsPath: status.eventsPath,
      runCount: status.runCount,
      activeAlertCount: status.activeAlertCount,
      activeAlerts: status.activeAlerts,
      recentRuns: status.recentRuns,
      config: status.config,
    };
    if (shouldEmitJson(options, command)) {
      console.log(JSON.stringify(payload, null, 2));
      return;
    }
    console.log(pc.bold("OMAR watchdog status"));
    console.log(pc.gray(`Config: ${status.configPath}`));
    console.log(pc.gray(`State: ${status.statePath}`));
    console.log(pc.gray(`Events: ${status.eventsPath}`));
    console.log(
      pc.gray(
        `active_alerts=${status.activeAlertCount} run_count=${status.runCount} channels=${status.config.channels.length}`
      )
    );
    for (const alert of status.activeAlerts) {
      console.log(
        `- ${alert.alertId} | ${alert.eventType} | ${alert.agentIdentity || "unassigned"} | ${alert.message}`
      );
    }
  });

watchdog
  .command("run")
  .description("Run one watchdog evaluation tick and optionally dispatch channel alerts")
  .option("--path <path>", "Workspace path for artifact/config resolution", ".")
  .option("--output-dir <path>", "Optional output dir override for daemon artifacts")
  .option("--no-tool-call-seconds <n>", "Idle threshold for no tool calls", "60")
  .option(
    "--repeated-file-reads-threshold <n>",
    "Consecutive repeated file-read threshold",
    "3"
  )
  .option(
    "--budget-warning-threshold <ratio>",
    "Budget warning ratio threshold (0-1)",
    "0.9"
  )
  .option("--turn-stall-turns <n>", "Turn-stall threshold", "5")
  .option("--limit <n>", "Maximum records to inspect", "200")
  .option("--execute <bool>", "Dispatch alerts to channels (true/false)", "false")
  .option("--now-iso <timestamp>", "Optional deterministic timestamp override")
  .option("--json", "Emit machine-readable output")
  .action(async (options, command) => {
    const targetPath = path.resolve(process.cwd(), String(options.path || "."));
    const budgetThreshold = Number(options.budgetWarningThreshold || 0.9);
    if (!Number.isFinite(budgetThreshold) || budgetThreshold < 0 || budgetThreshold > 1) {
      throw new Error("budget-warning-threshold must be a number between 0 and 1.");
    }
    const executed = await runWatchdogTick({
      targetPath,
      outputDir: options.outputDir,
      noToolCallSeconds: parsePositiveInteger(
        options.noToolCallSeconds,
        "no-tool-call-seconds",
        60
      ),
      repeatedFileReadsThreshold: parsePositiveInteger(
        options.repeatedFileReadsThreshold,
        "repeated-file-reads-threshold",
        3
      ),
      budgetWarningThreshold: budgetThreshold,
      turnStallTurns: parsePositiveInteger(options.turnStallTurns, "turn-stall-turns", 5),
      limit: parsePositiveInteger(options.limit, "limit", 200),
      execute: parseBoolean(options.execute, false),
      nowIso: options.nowIso,
    });
    const payload = {
      command: "daemon watchdog run",
      targetPath,
      runId: executed.runId,
      runPath: executed.runPath,
      configPath: executed.configPath,
      statePath: executed.statePath,
      eventsPath: executed.eventsPath,
      configExists: executed.configExists,
      summary: executed.summary,
      detections: executed.detections,
      activatedAlerts: executed.activatedAlerts,
      recoveredAlerts: executed.recoveredAlerts,
      notifications: executed.notifications,
    };
    if (shouldEmitJson(options, command)) {
      console.log(JSON.stringify(payload, null, 2));
      return;
    }
    console.log(pc.bold("OMAR watchdog tick complete"));
    console.log(pc.gray(`Run: ${executed.runId}`));
    console.log(pc.gray(`Artifact: ${executed.runPath}`));
    console.log(
      `detections=${executed.summary.detectionCount} activated=${executed.summary.activatedCount} recovered=${executed.summary.recoveredCount} notifications=${executed.summary.notificationCount}`
    );
    for (const alert of executed.activatedAlerts) {
      console.log(`- activated ${alert.alertId} | ${alert.eventType} | ${alert.message}`);
    }
    for (const alert of executed.recoveredAlerts) {
      console.log(`- recovered ${alert.alertId} | ${alert.message}`);
    }
  });

watchdog
  .command("status")
  .description("Show watchdog state and recent run summaries")
  .option("--path <path>", "Workspace path for artifact/config resolution", ".")
  .option("--output-dir <path>", "Optional output dir override for daemon artifacts")
  .option("--limit <n>", "Maximum recent runs to return", "10")
  .option("--json", "Emit machine-readable output")
  .action(async (options, command) => {
    const targetPath = path.resolve(process.cwd(), String(options.path || "."));
    const status = await getWatchdogStatus({
      targetPath,
      outputDir: options.outputDir,
      limit: parsePositiveInteger(options.limit, "limit", 10),
    });
    const payload = {
      command: "daemon watchdog status",
      targetPath,
      configPath: status.configPath,
      statePath: status.statePath,
      eventsPath: status.eventsPath,
      runCount: status.runCount,
      activeAlertCount: status.activeAlertCount,
      activeAlerts: status.activeAlerts,
      recentRuns: status.recentRuns,
      config: status.config,
    };
    if (shouldEmitJson(options, command)) {
      console.log(JSON.stringify(payload, null, 2));
      return;
    }
    console.log(pc.bold("OMAR watchdog status"));
    console.log(pc.gray(`Config: ${status.configPath}`));
    console.log(pc.gray(`State: ${status.statePath}`));
    console.log(pc.gray(`Events: ${status.eventsPath}`));
    console.log(
      pc.gray(
        `active_alerts=${status.activeAlertCount} run_count=${status.runCount} recent_runs=${status.recentRuns.length}`
      )
    );
    for (const run of status.recentRuns) {
      console.log(
        `- ${run.runId} | detections=${run.detectionCount} | activated=${run.activatedCount} | recovered=${run.recoveredCount}`
      );
    }
  });

reliability
  .option("--path <path>", "Workspace path for artifact/config resolution", ".")
  .option("--output-dir <path>", "Optional output dir override for daemon artifacts")
  .option("--limit <n>", "Maximum recent runs to return", "10")
  .option("--json", "Emit machine-readable output")
  .action(async (options, command) => {
    const targetPath = path.resolve(process.cwd(), String(options.path || "."));
    const status = await getReliabilityLaneStatus({
      targetPath,
      outputDir: options.outputDir,
      limit: parsePositiveInteger(options.limit, "limit", 10),
    });
    const payload = {
      command: "daemon reliability",
      targetPath,
      configPath: status.configPath,
      billboardPath: status.billboardPath,
      eventsPath: status.eventsPath,
      config: status.config,
      billboard: status.billboard,
      runCount: status.runCount,
      recentRuns: status.recentRuns,
    };
    if (shouldEmitJson(options, command)) {
      console.log(JSON.stringify(payload, null, 2));
      return;
    }
    printReliabilitySummary(payload);
  });

reliability
  .command("run")
  .description("Run one synthetic midnight reliability lane tick")
  .option("--path <path>", "Workspace path for artifact/config resolution", ".")
  .option("--output-dir <path>", "Optional output dir override for daemon artifacts")
  .option("--region <region>", "Target AWS region identifier", "us-east-1")
  .option("--timezone <timezone>", "Timezone label for run metadata", "UTC")
  .option(
    "--simulate-failure <csv>",
    `Simulate check failures (${RELIABILITY_CHECK_IDS.join(", ")})`
  )
  .option("--checks <csv>", "Optional subset of checks to run")
  .option(
    "--maintenance-auto-open <bool>",
    "Automatically enable maintenance billboard on lane failures (true/false)",
    "true"
  )
  .option(
    "--clear-maintenance-on-pass <bool>",
    "Clear reliability-lane maintenance billboard on passing run (true/false)",
    "true"
  )
  .option("--now-iso <timestamp>", "Optional deterministic timestamp override")
  .option("--json", "Emit machine-readable output")
  .action(async (options, command) => {
    const targetPath = path.resolve(process.cwd(), String(options.path || "."));
    const executed = await runReliabilityLane({
      targetPath,
      outputDir: options.outputDir,
      region: options.region,
      timezone: options.timezone,
      simulateFailures: parseCsv(options.simulateFailure),
      checks: parseCsv(options.checks),
      autoOpenMaintenance: parseBoolean(options.maintenanceAutoOpen, true),
      clearMaintenanceOnPass: parseBoolean(options.clearMaintenanceOnPass, true),
      nowIso: options.nowIso,
    });
    const payload = {
      command: "daemon reliability run",
      targetPath,
      runId: executed.runId,
      runPath: executed.runPath,
      configPath: executed.configPath,
      billboardPath: executed.billboardPath,
      eventsPath: executed.eventsPath,
      overallStatus: executed.overallStatus,
      checkCount: executed.checkCount,
      failureCount: executed.failureCount,
      checks: executed.checks,
      maintenance: executed.maintenance,
      worker: executed.worker,
    };
    if (shouldEmitJson(options, command)) {
      console.log(JSON.stringify(payload, null, 2));
      return;
    }
    console.log(pc.bold("Reliability lane run complete"));
    console.log(
      `${executed.runId} status=${executed.overallStatus} failures=${executed.failureCount} maintenance=${executed.maintenance.enabled ? "ON" : "OFF"}`
    );
    console.log(pc.gray(`Run artifact: ${executed.runPath}`));
  });

reliability
  .command("status")
  .description("Show reliability lane status, config, billboard, and recent runs")
  .option("--path <path>", "Workspace path for artifact/config resolution", ".")
  .option("--output-dir <path>", "Optional output dir override for daemon artifacts")
  .option("--limit <n>", "Maximum recent runs to return", "10")
  .option("--json", "Emit machine-readable output")
  .action(async (options, command) => {
    const targetPath = path.resolve(process.cwd(), String(options.path || "."));
    const status = await getReliabilityLaneStatus({
      targetPath,
      outputDir: options.outputDir,
      limit: parsePositiveInteger(options.limit, "limit", 10),
    });
    const payload = {
      command: "daemon reliability status",
      targetPath,
      configPath: status.configPath,
      billboardPath: status.billboardPath,
      eventsPath: status.eventsPath,
      config: status.config,
      billboard: status.billboard,
      runCount: status.runCount,
      recentRuns: status.recentRuns,
    };
    if (shouldEmitJson(options, command)) {
      console.log(JSON.stringify(payload, null, 2));
      return;
    }
    printReliabilitySummary(payload);
  });

const maintenance = daemon
  .command("maintenance")
  .description("Manual maintenance billboard controls for operator HITL visibility");

maintenance
  .option("--path <path>", "Workspace path for artifact/config resolution", ".")
  .option("--output-dir <path>", "Optional output dir override for daemon artifacts")
  .option("--json", "Emit machine-readable output")
  .action(async (options, command) => {
    const targetPath = path.resolve(process.cwd(), String(options.path || "."));
    const status = await getReliabilityLaneStatus({
      targetPath,
      outputDir: options.outputDir,
      limit: 1,
    });
    const payload = {
      command: "daemon maintenance",
      targetPath,
      billboardPath: status.billboardPath,
      eventsPath: status.eventsPath,
      billboard: status.billboard,
    };
    if (shouldEmitJson(options, command)) {
      console.log(JSON.stringify(payload, null, 2));
      return;
    }
    console.log(pc.bold("OMAR maintenance billboard"));
    console.log(pc.gray(`Billboard: ${status.billboardPath}`));
    console.log(
      `enabled=${status.billboard.enabled ? "true" : "false"} source=${status.billboard.source || "n/a"} updated=${status.billboard.lastUpdatedAt || "n/a"}`
    );
    if (status.billboard.message) {
      console.log(status.billboard.message);
    }
  });

maintenance
  .command("status")
  .description("Show current maintenance billboard state")
  .option("--path <path>", "Workspace path for artifact/config resolution", ".")
  .option("--output-dir <path>", "Optional output dir override for daemon artifacts")
  .option("--json", "Emit machine-readable output")
  .action(async (options, command) => {
    const targetPath = path.resolve(process.cwd(), String(options.path || "."));
    const status = await getReliabilityLaneStatus({
      targetPath,
      outputDir: options.outputDir,
      limit: 1,
    });
    const payload = {
      command: "daemon maintenance status",
      targetPath,
      billboardPath: status.billboardPath,
      eventsPath: status.eventsPath,
      billboard: status.billboard,
    };
    if (shouldEmitJson(options, command)) {
      console.log(JSON.stringify(payload, null, 2));
      return;
    }
    console.log(pc.bold("OMAR maintenance billboard"));
    console.log(pc.gray(`Billboard: ${status.billboardPath}`));
    console.log(
      `enabled=${status.billboard.enabled ? "true" : "false"} source=${status.billboard.source || "n/a"} updated=${status.billboard.lastUpdatedAt || "n/a"}`
    );
    if (status.billboard.message) {
      console.log(status.billboard.message);
    }
  });

maintenance
  .command("on")
  .description("Enable maintenance billboard manually")
  .option("--path <path>", "Workspace path for artifact/config resolution", ".")
  .option("--output-dir <path>", "Optional output dir override for daemon artifacts")
  .option("--reason <text>", "Reason for maintenance mode", "Manual maintenance window")
  .option("--message <text>", "Billboard message")
  .option("--actor <identity>", "Operator identity", "omar-operator")
  .option("--json", "Emit machine-readable output")
  .action(async (options, command) => {
    const targetPath = path.resolve(process.cwd(), String(options.path || "."));
    const updated = await setMaintenanceBillboard({
      targetPath,
      outputDir: options.outputDir,
      enabled: true,
      source: "manual",
      actor: options.actor,
      reason: options.reason,
      message:
        options.message ||
        "Maintenance mode is active while reliability lane findings are being remediated.",
    });
    const payload = {
      command: "daemon maintenance on",
      targetPath,
      billboardPath: updated.billboardPath,
      eventsPath: updated.eventsPath,
      billboard: updated.billboard,
    };
    if (shouldEmitJson(options, command)) {
      console.log(JSON.stringify(payload, null, 2));
      return;
    }
    console.log(pc.bold("Maintenance billboard enabled"));
    console.log(pc.gray(`Billboard: ${updated.billboardPath}`));
  });

maintenance
  .command("off")
  .description("Disable maintenance billboard manually")
  .option("--path <path>", "Workspace path for artifact/config resolution", ".")
  .option("--output-dir <path>", "Optional output dir override for daemon artifacts")
  .option("--reason <text>", "Reason for leaving maintenance mode", "Maintenance complete")
  .option("--message <text>", "Optional final message to persist")
  .option("--actor <identity>", "Operator identity", "omar-operator")
  .option("--json", "Emit machine-readable output")
  .action(async (options, command) => {
    const targetPath = path.resolve(process.cwd(), String(options.path || "."));
    const updated = await setMaintenanceBillboard({
      targetPath,
      outputDir: options.outputDir,
      enabled: false,
      source: "manual",
      actor: options.actor,
      reason: options.reason,
      message: options.message || "",
    });
    const payload = {
      command: "daemon maintenance off",
      targetPath,
      billboardPath: updated.billboardPath,
      eventsPath: updated.eventsPath,
      billboard: updated.billboard,
    };
    if (shouldEmitJson(options, command)) {
      console.log(JSON.stringify(payload, null, 2));
      return;
    }
    console.log(pc.bold("Maintenance billboard disabled"));
    console.log(pc.gray(`Billboard: ${updated.billboardPath}`));
  });

const error = daemon
  .command("error")
  .description("Record, route, and inspect admin error events for OMAR daemon processing");

error
  .command("record")
  .description("Record one admin error event into daemon intake stream")
  .option("--path <path>", "Workspace path for artifact/config resolution", ".")
  .option("--output-dir <path>", "Optional output dir override for daemon artifacts")
  .option("--source <source>", "Error source label", "admin_error_log")
  .option("--service <service>", "Service identifier", "sentinelayer-api")
  .option("--endpoint <endpoint>", "Endpoint or route", "unknown-endpoint")
  .option("--error-code <code>", "Error code", "UNKNOWN_ERROR")
  .option("--severity <severity>", "Severity (P0/P1/P2/P3)", "P2")
  .option("--message <message>", "Error summary message", "Unhandled runtime error")
  .option("--stack <stack>", "Optional stack trace text")
  .option("--commit-sha <sha>", "Optional commit sha")
  .option("--metadata-json <json>", "Optional metadata object as JSON string")
  .option("--json", "Emit machine-readable output")
  .action(async (options, command) => {
    const targetPath = path.resolve(process.cwd(), String(options.path || "."));
    const recorded = await appendAdminErrorEvent({
      targetPath,
      outputDir: options.outputDir,
      event: {
        source: options.source,
        service: options.service,
        endpoint: options.endpoint,
        errorCode: options.errorCode,
        severity: options.severity,
        message: options.message,
        stackTrace: options.stack,
        commitSha: options.commitSha,
        metadata: parseMetadata(options.metadataJson),
      },
    });
    const payload = {
      command: "daemon error record",
      targetPath,
      streamPath: recorded.streamPath,
      intakePath: recorded.intakePath,
      event: recorded.event,
    };
    if (shouldEmitJson(options, command)) {
      console.log(JSON.stringify(payload, null, 2));
      return;
    }

    console.log(pc.bold("OMAR daemon error event recorded"));
    console.log(pc.gray(`Stream: ${recorded.streamPath}`));
    console.log(pc.gray(`Intake artifact: ${recorded.intakePath}`));
    console.log(
      `event=${recorded.event.eventId} severity=${recorded.event.severity} fingerprint=${recorded.event.fingerprint}`
    );
  });

error
  .command("worker")
  .description("Run one daemon worker tick over queued admin error stream events")
  .option("--path <path>", "Workspace path for artifact/config resolution", ".")
  .option("--output-dir <path>", "Optional output dir override for daemon artifacts")
  .option("--max-events <n>", "Maximum stream events to process this tick", "200")
  .option("--json", "Emit machine-readable output")
  .action(async (options, command) => {
    const targetPath = path.resolve(process.cwd(), String(options.path || "."));
    const execution = await runErrorDaemonWorker({
      targetPath,
      outputDir: options.outputDir,
      maxEvents: parsePositiveInteger(options.maxEvents, "max-events", 200),
    });
    const payload = {
      command: "daemon error worker",
      targetPath,
      runId: execution.runId,
      runPath: execution.runPath,
      streamPath: execution.streamPath,
      queuePath: execution.queuePath,
      statePath: execution.statePath,
      maxEvents: execution.maxEvents,
      startOffset: execution.startOffset,
      endOffset: execution.endOffset,
      streamLength: execution.streamLength,
      processedCount: execution.processedCount,
      queuedCount: execution.queuedCount,
      dedupedCount: execution.dedupedCount,
      parseErrorCount: execution.parseErrorCount,
      queueDepth: execution.queueDepth,
      workerState: execution.state,
    };

    if (shouldEmitJson(options, command)) {
      console.log(JSON.stringify(payload, null, 2));
      return;
    }

    console.log(pc.bold("OMAR daemon worker tick completed"));
    console.log(pc.gray(`Run artifact: ${execution.runPath}`));
    console.log(
      `processed=${execution.processedCount} queued=${execution.queuedCount} deduped=${execution.dedupedCount} queue_depth=${execution.queueDepth}`
    );
  });

error
  .command("queue")
  .description("Inspect routed daemon queue items")
  .option("--path <path>", "Workspace path for artifact/config resolution", ".")
  .option("--output-dir <path>", "Optional output dir override for daemon artifacts")
  .option(
    "--status <csv>",
    `Optional queue status filter (${WORK_ITEM_STATUSES.join(", ")})`
  )
  .option("--limit <n>", "Maximum queue items to return", "50")
  .option("--json", "Emit machine-readable output")
  .action(async (options, command) => {
    const targetPath = path.resolve(process.cwd(), String(options.path || "."));
    const statuses = parseCsv(options.status);
    const listed = await listErrorQueue({
      targetPath,
      outputDir: options.outputDir,
      statuses,
      limit: parsePositiveInteger(options.limit, "limit", 50),
    });
    const payload = {
      command: "daemon error queue",
      targetPath,
      statuses,
      queuePath: listed.queuePath,
      statePath: listed.statePath,
      streamPath: listed.streamPath,
      totalCount: listed.totalCount,
      visibleCount: listed.items.length,
      items: listed.items,
      workerState: listed.state,
    };
    if (shouldEmitJson(options, command)) {
      console.log(JSON.stringify(payload, null, 2));
      return;
    }
    printQueueSummary(payload);
  });
}
