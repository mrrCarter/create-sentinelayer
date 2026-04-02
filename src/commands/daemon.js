import path from "node:path";

import pc from "picocolors";

import {
  WORK_ITEM_STATUSES,
  appendAdminErrorEvent,
  listErrorQueue,
  runErrorDaemonWorker,
} from "../daemon/error-worker.js";
import {
  ASSIGNMENT_STATUSES,
  claimAssignment,
  heartbeatAssignment,
  listAssignments,
  reassignAssignment,
  releaseAssignment,
} from "../daemon/assignment-ledger.js";
import {
  JIRA_STATUSES,
  commentJiraIssue,
  listJiraIssues,
  openJiraIssue,
  startJiraLifecycle,
  transitionJiraIssue,
} from "../daemon/jira-lifecycle.js";
import {
  DAEMON_BUDGET_LIFECYCLE_STATES,
  applyDaemonBudgetCheck,
  listBudgetStates,
} from "../daemon/budget-governor.js";
import {
  OPERATOR_STOP_MODES,
  applyOperatorStopControl,
  buildOperatorControlSnapshot,
  getBudgetHealthColor,
  normalizeOperatorStopMode,
} from "../daemon/operator-control.js";
import { buildArtifactLineageIndex, listArtifactLineage } from "../daemon/artifact-lineage.js";

function shouldEmitJson(options, command) {
  const local = Boolean(options && options.json);
  const globalFromCommand =
    command && command.optsWithGlobals ? Boolean(command.optsWithGlobals().json) : false;
  return local || globalFromCommand;
}

function parsePositiveInteger(rawValue, field, fallbackValue) {
  if (rawValue === undefined || rawValue === null || String(rawValue).trim() === "") {
    return fallbackValue;
  }
  const normalized = Number(rawValue);
  if (!Number.isFinite(normalized) || normalized <= 0) {
    throw new Error(`${field} must be a positive integer.`);
  }
  return Math.floor(normalized);
}

function parseCsv(rawValue) {
  if (rawValue === undefined || rawValue === null || String(rawValue).trim() === "") {
    return [];
  }
  return String(rawValue)
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function parseMetadata(rawValue) {
  if (!rawValue) {
    return {};
  }
  const parsed = JSON.parse(String(rawValue));
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("metadataJson must parse to an object.");
  }
  return parsed;
}

function parseBoolean(rawValue, fallbackValue) {
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

function printQueueSummary(payload) {
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

function printAssignmentSummary(payload) {
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

function printJiraSummary(payload) {
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

function printBudgetSummary(payload) {
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

function formatDurationSeconds(seconds) {
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

function colorizeBudgetHealth(value) {
  const normalized = getBudgetHealthColor(value);
  if (normalized === "RED") {
    return pc.red(normalized);
  }
  if (normalized === "YELLOW") {
    return pc.yellow(normalized);
  }
  return pc.green(normalized);
}

function printControlPlaneSummary(payload) {
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

function printLineageSummary(payload) {
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

export function registerDaemonCommand(program) {
  const daemon = program
    .command("daemon")
    .description("OMAR daemon controls for error-event intake and routed queue management");

  daemon
    .option("--path <path>", "Workspace path for artifact/config resolution", ".")
    .option("--output-dir <path>", "Optional output dir override for daemon artifacts")
    .option("--json", "Emit machine-readable output")
    .action(async (options, command) => {
      const targetPath = path.resolve(process.cwd(), String(options.path || "."));
      const limit = 20;
      const listed = await listErrorQueue({
        targetPath,
        outputDir: options.outputDir,
        limit,
      });
      const payload = {
        command: "daemon",
        targetPath,
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

  const assign = daemon
    .command("assign")
    .description("Global assignment ledger for daemon queue ownership and lease lifecycle");

  assign
    .option("--path <path>", "Workspace path for artifact/config resolution", ".")
    .option("--output-dir <path>", "Optional output dir override for daemon artifacts")
    .option("--json", "Emit machine-readable output")
    .action(async (options, command) => {
      const targetPath = path.resolve(process.cwd(), String(options.path || "."));
      const listed = await listAssignments({
        targetPath,
        outputDir: options.outputDir,
        limit: 20,
      });
      const payload = {
        command: "daemon assign",
        targetPath,
        ledgerPath: listed.ledgerPath,
        queuePath: listed.queuePath,
        eventsPath: listed.eventsPath,
        totalCount: listed.totalCount,
        visibleCount: listed.assignments.length,
        assignments: listed.assignments,
      };
      if (shouldEmitJson(options, command)) {
        console.log(JSON.stringify(payload, null, 2));
        return;
      }
      printAssignmentSummary(payload);
    });

  assign
    .command("list")
    .description("List assignment ledger records")
    .option("--path <path>", "Workspace path for artifact/config resolution", ".")
    .option("--output-dir <path>", "Optional output dir override for daemon artifacts")
    .option(
      "--status <csv>",
      `Optional assignment status filter (${ASSIGNMENT_STATUSES.join(", ")})`
    )
    .option("--agent <identity>", "Filter by assigned agent identity")
    .option("--include-expired <bool>", "Include expired active leases (true/false)", "true")
    .option("--limit <n>", "Maximum assignments to return", "50")
    .option("--json", "Emit machine-readable output")
    .action(async (options, command) => {
      const targetPath = path.resolve(process.cwd(), String(options.path || "."));
      const listed = await listAssignments({
        targetPath,
        outputDir: options.outputDir,
        statuses: parseCsv(options.status),
        agentIdentity: options.agent,
        includeExpired: parseBoolean(options.includeExpired, true),
        limit: parsePositiveInteger(options.limit, "limit", 50),
      });
      const payload = {
        command: "daemon assign list",
        targetPath,
        statuses: parseCsv(options.status),
        agentIdentity: options.agent || null,
        includeExpired: parseBoolean(options.includeExpired, true),
        ledgerPath: listed.ledgerPath,
        queuePath: listed.queuePath,
        eventsPath: listed.eventsPath,
        totalCount: listed.totalCount,
        visibleCount: listed.assignments.length,
        assignments: listed.assignments,
      };
      if (shouldEmitJson(options, command)) {
        console.log(JSON.stringify(payload, null, 2));
        return;
      }
      printAssignmentSummary(payload);
    });

  assign
    .command("claim")
    .description("Claim a queue work item for an agent identity with lease metadata")
    .argument("<workItemId>", "Queue work item id")
    .option("--path <path>", "Workspace path for artifact/config resolution", ".")
    .option("--output-dir <path>", "Optional output dir override for daemon artifacts")
    .requiredOption("--agent <identity>", "Assigned agent identity (email or handle)")
    .option("--lease-ttl-seconds <n>", "Lease duration in seconds", "1800")
    .option("--stage <stage>", "Current workflow stage", "triage")
    .option("--run-id <id>", "Optional runtime run id")
    .option("--jira-issue-key <key>", "Optional Jira issue key")
    .option("--budget-snapshot-json <json>", "Optional budget snapshot JSON object")
    .option("--json", "Emit machine-readable output")
    .action(async (workItemId, options, command) => {
      const targetPath = path.resolve(process.cwd(), String(options.path || "."));
      const claimed = await claimAssignment({
        targetPath,
        outputDir: options.outputDir,
        workItemId,
        agentIdentity: options.agent,
        leaseTtlSeconds: parsePositiveInteger(options.leaseTtlSeconds, "lease-ttl-seconds", 1800),
        stage: options.stage,
        runId: options.runId,
        jiraIssueKey: options.jiraIssueKey,
        budgetSnapshot: parseMetadata(options.budgetSnapshotJson),
      });
      const payload = {
        command: "daemon assign claim",
        targetPath,
        ledgerPath: claimed.ledgerPath,
        queuePath: claimed.queuePath,
        eventsPath: claimed.eventsPath,
        assignment: claimed.assignment,
      };
      if (shouldEmitJson(options, command)) {
        console.log(JSON.stringify(payload, null, 2));
        return;
      }
      console.log(pc.bold("Assignment claimed"));
      console.log(
        `${claimed.assignment.workItemId} -> ${claimed.assignment.assignedAgentIdentity} (expires ${claimed.assignment.leaseExpiresAt})`
      );
    });

  assign
    .command("heartbeat")
    .description("Refresh lease heartbeat for an assigned work item")
    .argument("<workItemId>", "Queue work item id")
    .option("--path <path>", "Workspace path for artifact/config resolution", ".")
    .option("--output-dir <path>", "Optional output dir override for daemon artifacts")
    .requiredOption("--agent <identity>", "Assigned agent identity (email or handle)")
    .option("--lease-ttl-seconds <n>", "Lease duration in seconds", "1800")
    .option("--stage <stage>", "Current workflow stage")
    .option("--run-id <id>", "Optional runtime run id")
    .option("--jira-issue-key <key>", "Optional Jira issue key")
    .option("--budget-snapshot-json <json>", "Optional budget snapshot JSON object")
    .option("--json", "Emit machine-readable output")
    .action(async (workItemId, options, command) => {
      const targetPath = path.resolve(process.cwd(), String(options.path || "."));
      const heartbeat = await heartbeatAssignment({
        targetPath,
        outputDir: options.outputDir,
        workItemId,
        agentIdentity: options.agent,
        leaseTtlSeconds: parsePositiveInteger(options.leaseTtlSeconds, "lease-ttl-seconds", 1800),
        stage: options.stage,
        runId: options.runId,
        jiraIssueKey: options.jiraIssueKey,
        budgetSnapshot: parseMetadata(options.budgetSnapshotJson),
      });
      const payload = {
        command: "daemon assign heartbeat",
        targetPath,
        ledgerPath: heartbeat.ledgerPath,
        queuePath: heartbeat.queuePath,
        eventsPath: heartbeat.eventsPath,
        assignment: heartbeat.assignment,
      };
      if (shouldEmitJson(options, command)) {
        console.log(JSON.stringify(payload, null, 2));
        return;
      }
      console.log(pc.bold("Assignment heartbeat updated"));
      console.log(
        `${heartbeat.assignment.workItemId} -> ${heartbeat.assignment.assignedAgentIdentity} (expires ${heartbeat.assignment.leaseExpiresAt})`
      );
    });

  assign
    .command("release")
    .description("Release an assignment and transition work item status")
    .argument("<workItemId>", "Queue work item id")
    .option("--path <path>", "Workspace path for artifact/config resolution", ".")
    .option("--output-dir <path>", "Optional output dir override for daemon artifacts")
    .option("--agent <identity>", "Optional assigned agent identity check")
    .option("--status <status>", "Release status (QUEUED|DONE|BLOCKED|SQUASHED)", "QUEUED")
    .option("--stage <stage>", "Current workflow stage")
    .option("--run-id <id>", "Optional runtime run id")
    .option("--jira-issue-key <key>", "Optional Jira issue key")
    .option("--reason <reason>", "Optional release reason")
    .option("--budget-snapshot-json <json>", "Optional budget snapshot JSON object")
    .option("--json", "Emit machine-readable output")
    .action(async (workItemId, options, command) => {
      const targetPath = path.resolve(process.cwd(), String(options.path || "."));
      const released = await releaseAssignment({
        targetPath,
        outputDir: options.outputDir,
        workItemId,
        agentIdentity: options.agent,
        status: options.status,
        stage: options.stage,
        runId: options.runId,
        jiraIssueKey: options.jiraIssueKey,
        reason: options.reason,
        budgetSnapshot: parseMetadata(options.budgetSnapshotJson),
      });
      const payload = {
        command: "daemon assign release",
        targetPath,
        ledgerPath: released.ledgerPath,
        queuePath: released.queuePath,
        eventsPath: released.eventsPath,
        assignment: released.assignment,
      };
      if (shouldEmitJson(options, command)) {
        console.log(JSON.stringify(payload, null, 2));
        return;
      }
      console.log(pc.bold("Assignment released"));
      console.log(
        `${released.assignment.workItemId} status=${released.assignment.status} agent=${released.assignment.assignedAgentIdentity || "n/a"}`
      );
    });

  assign
    .command("reassign")
    .description("Reassign a work item lease to a different agent identity")
    .argument("<workItemId>", "Queue work item id")
    .option("--path <path>", "Workspace path for artifact/config resolution", ".")
    .option("--output-dir <path>", "Optional output dir override for daemon artifacts")
    .option("--from-agent <identity>", "Optional expected current agent identity")
    .requiredOption("--to-agent <identity>", "New assigned agent identity")
    .option("--lease-ttl-seconds <n>", "Lease duration in seconds", "1800")
    .option("--stage <stage>", "Current workflow stage", "triage")
    .option("--run-id <id>", "Optional runtime run id")
    .option("--jira-issue-key <key>", "Optional Jira issue key")
    .option("--budget-snapshot-json <json>", "Optional budget snapshot JSON object")
    .option("--json", "Emit machine-readable output")
    .action(async (workItemId, options, command) => {
      const targetPath = path.resolve(process.cwd(), String(options.path || "."));
      const reassigned = await reassignAssignment({
        targetPath,
        outputDir: options.outputDir,
        workItemId,
        fromAgentIdentity: options.fromAgent,
        toAgentIdentity: options.toAgent,
        leaseTtlSeconds: parsePositiveInteger(options.leaseTtlSeconds, "lease-ttl-seconds", 1800),
        stage: options.stage,
        runId: options.runId,
        jiraIssueKey: options.jiraIssueKey,
        budgetSnapshot: parseMetadata(options.budgetSnapshotJson),
      });
      const payload = {
        command: "daemon assign reassign",
        targetPath,
        ledgerPath: reassigned.ledgerPath,
        queuePath: reassigned.queuePath,
        eventsPath: reassigned.eventsPath,
        assignment: reassigned.assignment,
      };
      if (shouldEmitJson(options, command)) {
        console.log(JSON.stringify(payload, null, 2));
        return;
      }
      console.log(pc.bold("Assignment reassigned"));
      console.log(
        `${reassigned.assignment.workItemId} -> ${reassigned.assignment.assignedAgentIdentity} (expires ${reassigned.assignment.leaseExpiresAt})`
      );
    });

  const jira = daemon
    .command("jira")
    .description("Jira lifecycle artifacts for daemon work-item transitions and plan comments");

  jira
    .option("--path <path>", "Workspace path for artifact/config resolution", ".")
    .option("--output-dir <path>", "Optional output dir override for daemon artifacts")
    .option("--json", "Emit machine-readable output")
    .action(async (options, command) => {
      const targetPath = path.resolve(process.cwd(), String(options.path || "."));
      const listed = await listJiraIssues({
        targetPath,
        outputDir: options.outputDir,
        limit: 20,
      });
      const payload = {
        command: "daemon jira",
        targetPath,
        lifecyclePath: listed.lifecyclePath,
        eventsPath: listed.eventsPath,
        totalCount: listed.totalCount,
        visibleCount: listed.issues.length,
        issues: listed.issues,
      };
      if (shouldEmitJson(options, command)) {
        console.log(JSON.stringify(payload, null, 2));
        return;
      }
      printJiraSummary(payload);
    });

  jira
    .command("list")
    .description("List daemon Jira lifecycle issues")
    .option("--path <path>", "Workspace path for artifact/config resolution", ".")
    .option("--output-dir <path>", "Optional output dir override for daemon artifacts")
    .option("--work-item-id <id>", "Filter by work item id")
    .option("--issue-key <key>", "Filter by issue key")
    .option("--status <csv>", `Optional status filter (${JIRA_STATUSES.join(", ")})`)
    .option("--limit <n>", "Maximum issues to return", "50")
    .option("--json", "Emit machine-readable output")
    .action(async (options, command) => {
      const targetPath = path.resolve(process.cwd(), String(options.path || "."));
      const listed = await listJiraIssues({
        targetPath,
        outputDir: options.outputDir,
        workItemId: options.workItemId,
        issueKey: options.issueKey,
        statuses: parseCsv(options.status),
        limit: parsePositiveInteger(options.limit, "limit", 50),
      });
      const payload = {
        command: "daemon jira list",
        targetPath,
        workItemId: options.workItemId || null,
        issueKey: options.issueKey || null,
        statuses: parseCsv(options.status),
        lifecyclePath: listed.lifecyclePath,
        eventsPath: listed.eventsPath,
        totalCount: listed.totalCount,
        visibleCount: listed.issues.length,
        issues: listed.issues,
      };
      if (shouldEmitJson(options, command)) {
        console.log(JSON.stringify(payload, null, 2));
        return;
      }
      printJiraSummary(payload);
    });

  jira
    .command("open")
    .description("Create (or reuse) Jira lifecycle issue for a work item")
    .argument("<workItemId>", "Queue work item id")
    .option("--path <path>", "Workspace path for artifact/config resolution", ".")
    .option("--output-dir <path>", "Optional output dir override for daemon artifacts")
    .option("--summary <summary>", "Issue summary override")
    .option("--description <description>", "Issue description override")
    .option("--labels <csv>", "Additional labels")
    .option("--assignee <identity>", "Assignee identity")
    .option("--issue-key <key>", "Explicit issue key override")
    .option("--issue-key-prefix <prefix>", "Generated issue key prefix", "SLD")
    .option("--actor <identity>", "Lifecycle actor identity", "omar-daemon")
    .option("--json", "Emit machine-readable output")
    .action(async (workItemId, options, command) => {
      const targetPath = path.resolve(process.cwd(), String(options.path || "."));
      const opened = await openJiraIssue({
        targetPath,
        outputDir: options.outputDir,
        workItemId,
        summary: options.summary,
        description: options.description,
        labels: parseCsv(options.labels),
        assignee: options.assignee,
        issueKey: options.issueKey,
        issueKeyPrefix: options.issueKeyPrefix,
        actor: options.actor,
      });
      const payload = {
        command: "daemon jira open",
        targetPath,
        created: opened.created,
        lifecyclePath: opened.lifecyclePath,
        eventsPath: opened.eventsPath,
        issue: opened.issue,
      };
      if (shouldEmitJson(options, command)) {
        console.log(JSON.stringify(payload, null, 2));
        return;
      }
      console.log(pc.bold(opened.created ? "Jira issue created" : "Jira issue reused"));
      console.log(`${opened.issue.issueKey} -> work_item=${opened.issue.workItemId}`);
    });

  jira
    .command("start")
    .description("Create/reuse issue, post agent plan comment, and transition to IN_PROGRESS")
    .argument("<workItemId>", "Queue work item id")
    .requiredOption("--plan <message>", "Agent execution plan text")
    .option("--path <path>", "Workspace path for artifact/config resolution", ".")
    .option("--output-dir <path>", "Optional output dir override for daemon artifacts")
    .option("--actor <identity>", "Lifecycle actor identity", "omar-daemon")
    .option("--assignee <identity>", "Assignee identity")
    .option("--summary <summary>", "Issue summary override")
    .option("--description <description>", "Issue description override")
    .option("--labels <csv>", "Additional labels")
    .option("--issue-key <key>", "Explicit issue key override")
    .option("--issue-key-prefix <prefix>", "Generated issue key prefix", "SLD")
    .option("--json", "Emit machine-readable output")
    .action(async (workItemId, options, command) => {
      const targetPath = path.resolve(process.cwd(), String(options.path || "."));
      const started = await startJiraLifecycle({
        targetPath,
        outputDir: options.outputDir,
        workItemId,
        actor: options.actor,
        assignee: options.assignee,
        summary: options.summary,
        description: options.description,
        labels: parseCsv(options.labels),
        planMessage: options.plan,
        issueKey: options.issueKey,
        issueKeyPrefix: options.issueKeyPrefix,
      });
      const payload = {
        command: "daemon jira start",
        targetPath,
        created: started.created,
        lifecyclePath: started.lifecyclePath,
        eventsPath: started.eventsPath,
        issue: started.issue,
        transition: started.transition,
        comment: started.comment,
      };
      if (shouldEmitJson(options, command)) {
        console.log(JSON.stringify(payload, null, 2));
        return;
      }
      console.log(pc.bold("Jira lifecycle started"));
      console.log(`${started.issue.issueKey} status=${started.issue.status}`);
    });

  jira
    .command("comment")
    .description("Append a Jira lifecycle comment")
    .option("--path <path>", "Workspace path for artifact/config resolution", ".")
    .option("--output-dir <path>", "Optional output dir override for daemon artifacts")
    .option("--work-item-id <id>", "Work item id")
    .option("--issue-key <key>", "Issue key")
    .option("--actor <identity>", "Lifecycle actor identity", "omar-daemon")
    .option("--type <type>", "Comment type label", "checkpoint")
    .requiredOption("--message <message>", "Comment message")
    .option("--json", "Emit machine-readable output")
    .action(async (options, command) => {
      const targetPath = path.resolve(process.cwd(), String(options.path || "."));
      const commented = await commentJiraIssue({
        targetPath,
        outputDir: options.outputDir,
        workItemId: options.workItemId,
        issueKey: options.issueKey,
        actor: options.actor,
        type: options.type,
        message: options.message,
      });
      const payload = {
        command: "daemon jira comment",
        targetPath,
        lifecyclePath: commented.lifecyclePath,
        eventsPath: commented.eventsPath,
        issue: commented.issue,
        comment: commented.comment,
      };
      if (shouldEmitJson(options, command)) {
        console.log(JSON.stringify(payload, null, 2));
        return;
      }
      console.log(pc.bold("Jira lifecycle comment appended"));
      console.log(`${commented.issue.issueKey} type=${commented.comment.type}`);
    });

  jira
    .command("transition")
    .description("Transition Jira lifecycle issue status")
    .option("--path <path>", "Workspace path for artifact/config resolution", ".")
    .option("--output-dir <path>", "Optional output dir override for daemon artifacts")
    .option("--work-item-id <id>", "Work item id")
    .option("--issue-key <key>", "Issue key")
    .requiredOption("--to <status>", `Target status (${JIRA_STATUSES.join(", ")})`)
    .option("--actor <identity>", "Lifecycle actor identity", "omar-daemon")
    .option("--reason <text>", "Optional transition reason")
    .option("--json", "Emit machine-readable output")
    .action(async (options, command) => {
      const targetPath = path.resolve(process.cwd(), String(options.path || "."));
      const transitioned = await transitionJiraIssue({
        targetPath,
        outputDir: options.outputDir,
        workItemId: options.workItemId,
        issueKey: options.issueKey,
        toStatus: options.to,
        actor: options.actor,
        reason: options.reason,
      });
      const payload = {
        command: "daemon jira transition",
        targetPath,
        lifecyclePath: transitioned.lifecyclePath,
        eventsPath: transitioned.eventsPath,
        issue: transitioned.issue,
        transition: transitioned.transition,
      };
      if (shouldEmitJson(options, command)) {
        console.log(JSON.stringify(payload, null, 2));
        return;
      }
      console.log(pc.bold("Jira lifecycle transitioned"));
      console.log(
        `${transitioned.issue.issueKey} ${transitioned.transition.from} -> ${transitioned.transition.to}`
      );
    });

  const budget = daemon
    .command("budget")
    .description("Runtime budget governance checks with deterministic quarantine and kill actions");

  budget
    .option("--path <path>", "Workspace path for artifact/config resolution", ".")
    .option("--output-dir <path>", "Optional output dir override for daemon artifacts")
    .option("--json", "Emit machine-readable output")
    .action(async (options, command) => {
      const targetPath = path.resolve(process.cwd(), String(options.path || "."));
      const listed = await listBudgetStates({
        targetPath,
        outputDir: options.outputDir,
        limit: 20,
      });
      const payload = {
        command: "daemon budget",
        targetPath,
        budgetStatePath: listed.budgetStatePath,
        budgetEventsPath: listed.budgetEventsPath,
        totalCount: listed.totalCount,
        visibleCount: listed.records.length,
        records: listed.records,
      };
      if (shouldEmitJson(options, command)) {
        console.log(JSON.stringify(payload, null, 2));
        return;
      }
      printBudgetSummary(payload);
    });

  budget
    .command("status")
    .description("List budget governance state records")
    .option("--path <path>", "Workspace path for artifact/config resolution", ".")
    .option("--output-dir <path>", "Optional output dir override for daemon artifacts")
    .option("--work-item-id <id>", "Filter by work item id")
    .option(
      "--lifecycle-state <csv>",
      `Optional lifecycle filter (${DAEMON_BUDGET_LIFECYCLE_STATES.join(", ")})`
    )
    .option("--limit <n>", "Maximum records to return", "50")
    .option("--json", "Emit machine-readable output")
    .action(async (options, command) => {
      const targetPath = path.resolve(process.cwd(), String(options.path || "."));
      const listed = await listBudgetStates({
        targetPath,
        outputDir: options.outputDir,
        workItemId: options.workItemId,
        lifecycleStates: parseCsv(options.lifecycleState),
        limit: parsePositiveInteger(options.limit, "limit", 50),
      });
      const payload = {
        command: "daemon budget status",
        targetPath,
        workItemId: options.workItemId || null,
        lifecycleStates: parseCsv(options.lifecycleState),
        budgetStatePath: listed.budgetStatePath,
        budgetEventsPath: listed.budgetEventsPath,
        totalCount: listed.totalCount,
        visibleCount: listed.records.length,
        records: listed.records,
      };
      if (shouldEmitJson(options, command)) {
        console.log(JSON.stringify(payload, null, 2));
        return;
      }
      printBudgetSummary(payload);
    });

  budget
    .command("check")
    .description("Apply one budget-governance evaluation tick for a work item")
    .argument("<workItemId>", "Queue work item id")
    .option("--path <path>", "Workspace path for artifact/config resolution", ".")
    .option("--output-dir <path>", "Optional output dir override for daemon artifacts")
    .option(
      "--usage-json <json>",
      "Usage snapshot JSON (tokensUsed,costUsd,runtimeMs,toolCalls,pathOutOfScopeHits,networkDomainViolations)",
      "{}"
    )
    .option(
      "--budget-json <json>",
      "Budget envelope JSON (maxTokens,maxCostUsd,maxRuntimeMs,maxToolCalls,maxPathViolations,maxNetworkViolations,warningThresholdPercent,quarantineGraceSeconds)",
      "{}"
    )
    .option("--now-iso <timestamp>", "Optional deterministic timestamp override")
    .option("--json", "Emit machine-readable output")
    .action(async (workItemId, options, command) => {
      const targetPath = path.resolve(process.cwd(), String(options.path || "."));
      const checked = await applyDaemonBudgetCheck({
        targetPath,
        outputDir: options.outputDir,
        workItemId,
        usage: parseMetadata(options.usageJson),
        budget: parseMetadata(options.budgetJson),
        nowIso: options.nowIso,
      });
      const payload = {
        command: "daemon budget check",
        targetPath,
        workItemId,
        runId: checked.runId,
        runPath: checked.runPath,
        budgetStatePath: checked.budgetStatePath,
        budgetEventsPath: checked.budgetEventsPath,
        lifecycleState: checked.lifecycleState,
        action: checked.action,
        warnings: checked.warnings,
        stopReasons: checked.stopReasons,
        budget: checked.budget,
        usage: checked.usage,
        quarantineStartedAt: checked.quarantineStartedAt,
        quarantineUntil: checked.quarantineUntil,
        record: checked.record,
      };
      if (shouldEmitJson(options, command)) {
        console.log(JSON.stringify(payload, null, 2));
        return;
      }
      console.log(pc.bold("Budget governance check applied"));
      console.log(
        `${workItemId} lifecycle=${checked.lifecycleState} action=${checked.action} quarantine_until=${checked.quarantineUntil || "n/a"}`
      );
    });

  const control = daemon
    .command("control")
    .description(
      "Operator control plane snapshot and stop controls (agent roster, budget health, session timers)"
    );

  control
    .option("--path <path>", "Workspace path for artifact/config resolution", ".")
    .option("--output-dir <path>", "Optional output dir override for daemon artifacts")
    .option(
      "--status <csv>",
      `Optional queue status filter (${WORK_ITEM_STATUSES.join(", ")})`
    )
    .option("--agent <identity>", "Optional assigned-agent filter")
    .option("--limit <n>", "Maximum work items to return", "50")
    .option("--json", "Emit machine-readable output")
    .action(async (options, command) => {
      const targetPath = path.resolve(process.cwd(), String(options.path || "."));
      const snapshot = await buildOperatorControlSnapshot({
        targetPath,
        outputDir: options.outputDir,
        statuses: parseCsv(options.status),
        agentIdentity: options.agent,
        limit: parsePositiveInteger(options.limit, "limit", 50),
      });
      const payload = {
        command: "daemon control",
        targetPath,
        runId: snapshot.runId,
        runPath: snapshot.runPath,
        operatorStatePath: snapshot.operatorStatePath,
        operatorEventsPath: snapshot.operatorEventsPath,
        totalQueueItems: snapshot.totalQueueItems,
        visibleWorkItems: snapshot.visibleWorkItems,
        statusCounts: snapshot.statusCounts,
        healthCounts: snapshot.healthCounts,
        workItems: snapshot.workItems,
        agentRoster: snapshot.agentRoster,
      };
      if (shouldEmitJson(options, command)) {
        console.log(JSON.stringify(payload, null, 2));
        return;
      }
      printControlPlaneSummary(payload);
    });

  control
    .command("snapshot")
    .description("Create one deterministic operator control-plane snapshot artifact")
    .option("--path <path>", "Workspace path for artifact/config resolution", ".")
    .option("--output-dir <path>", "Optional output dir override for daemon artifacts")
    .option(
      "--status <csv>",
      `Optional queue status filter (${WORK_ITEM_STATUSES.join(", ")})`
    )
    .option("--agent <identity>", "Optional assigned-agent filter")
    .option("--limit <n>", "Maximum work items to return", "50")
    .option("--now-iso <timestamp>", "Optional deterministic timestamp override")
    .option("--json", "Emit machine-readable output")
    .action(async (options, command) => {
      const targetPath = path.resolve(process.cwd(), String(options.path || "."));
      const snapshot = await buildOperatorControlSnapshot({
        targetPath,
        outputDir: options.outputDir,
        statuses: parseCsv(options.status),
        agentIdentity: options.agent,
        limit: parsePositiveInteger(options.limit, "limit", 50),
        nowIso: options.nowIso,
      });
      const payload = {
        command: "daemon control snapshot",
        targetPath,
        runId: snapshot.runId,
        runPath: snapshot.runPath,
        operatorStatePath: snapshot.operatorStatePath,
        operatorEventsPath: snapshot.operatorEventsPath,
        totalQueueItems: snapshot.totalQueueItems,
        visibleWorkItems: snapshot.visibleWorkItems,
        statusCounts: snapshot.statusCounts,
        healthCounts: snapshot.healthCounts,
        workItems: snapshot.workItems,
        agentRoster: snapshot.agentRoster,
      };
      if (shouldEmitJson(options, command)) {
        console.log(JSON.stringify(payload, null, 2));
        return;
      }
      printControlPlaneSummary(payload);
    });

  control
    .command("stop")
    .description("Apply confirmed operator stop control (quarantine or squash) to a work item")
    .argument("<workItemId>", "Queue work item id")
    .option("--path <path>", "Workspace path for artifact/config resolution", ".")
    .option("--output-dir <path>", "Optional output dir override for daemon artifacts")
    .option(
      "--mode <mode>",
      `Stop mode (${OPERATOR_STOP_MODES.join(", ")})`,
      "QUARANTINE"
    )
    .option("--reason <text>", "Operator reason for stop action")
    .option("--actor <identity>", "Operator identity", "omar-operator")
    .option("--confirm", "Confirm stop action execution")
    .option("--now-iso <timestamp>", "Optional deterministic timestamp override")
    .option("--json", "Emit machine-readable output")
    .action(async (workItemId, options, command) => {
      const targetPath = path.resolve(process.cwd(), String(options.path || "."));
      const stopped = await applyOperatorStopControl({
        targetPath,
        outputDir: options.outputDir,
        workItemId,
        mode: normalizeOperatorStopMode(options.mode),
        reason: options.reason,
        actor: options.actor,
        confirm: Boolean(options.confirm),
        nowIso: options.nowIso,
      });
      const payload = {
        command: "daemon control stop",
        targetPath,
        workItemId: stopped.workItemId,
        mode: stopped.mode,
        targetStatus: stopped.targetStatus,
        actor: stopped.actor,
        reason: stopped.reason,
        operatorEventsPath: stopped.operatorEventsPath,
        queuePath: stopped.queuePath,
        queueItem: stopped.queueItem,
        assignment: stopped.assignment,
        jiraIssueKey: stopped.jiraIssueKey,
        jiraCommented: stopped.jiraCommented,
        jiraCommentWarning: stopped.jiraCommentWarning,
      };
      if (shouldEmitJson(options, command)) {
        console.log(JSON.stringify(payload, null, 2));
        return;
      }
      console.log(pc.bold("Operator stop applied"));
      console.log(
        `${stopped.workItemId} mode=${stopped.mode} status=${stopped.targetStatus} actor=${stopped.actor}`
      );
      if (stopped.jiraIssueKey) {
        console.log(
          `jira=${stopped.jiraIssueKey} commented=${stopped.jiraCommented ? "true" : "false"}`
        );
      }
      if (stopped.jiraCommentWarning) {
        console.log(pc.yellow(`jira_warning=${stopped.jiraCommentWarning}`));
      }
    });

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
