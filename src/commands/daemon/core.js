import path from "node:path";

import pc from "picocolors";

import { WORK_ITEM_STATUSES, listErrorQueue } from "../../daemon/error-worker.js";
import {
  ASSIGNMENT_STATUSES,
  claimAssignment,
  heartbeatAssignment,
  listAssignments,
  reassignAssignment,
  releaseAssignment,
} from "../../daemon/assignment-ledger.js";
import {
  JIRA_STATUSES,
  commentJiraIssue,
  listJiraIssues,
  openJiraIssue,
  startJiraLifecycle,
  transitionJiraIssue,
} from "../../daemon/jira-lifecycle.js";
import {
  DAEMON_BUDGET_LIFECYCLE_STATES,
  applyDaemonBudgetCheck,
  listBudgetStates,
} from "../../daemon/budget-governor.js";
import {
  OPERATOR_STOP_MODES,
  applyOperatorStopControl,
  buildOperatorControlSnapshot,
  normalizeOperatorStopMode,
} from "../../daemon/operator-control.js";
import {
  parseBoolean,
  parseCsv,
  parseMetadata,
  parsePositiveInteger,
  printAssignmentSummary,
  printBudgetSummary,
  printControlPlaneSummary,
  printJiraSummary,
  printQueueSummary,
  shouldEmitJson,
} from "./shared.js";

export function registerDaemonCoreCommands(daemon) {
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

}
