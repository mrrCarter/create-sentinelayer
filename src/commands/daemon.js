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
