import path from "node:path";
import process from "node:process";
import { randomUUID } from "node:crypto";

import pc from "picocolors";

import {
  buildProvisionEmailPayload,
  normalizeAidenIdApiUrl,
  provisionEmailIdentity,
  resolveAidenIdCredentials,
} from "../ai/aidenid.js";
import { recordProvisionedIdentity } from "../ai/identity-store.js";
import { readStoredSession } from "../auth/session-store.js";
import { fetchAidenIdCredentials } from "../auth/service.js";
import { resolveOutputRoot } from "../config/service.js";
import {
  listAssignments,
  releaseLease,
} from "../daemon/assignment-ledger.js";
import { stopScopeEngine } from "../daemon/scope-engine.js";
import { createAgentEvent } from "../events/schema.js";
import {
  detectStaleAgents,
  listAgents,
  registerAgent,
  unregisterAgent,
} from "../session/agent-registry.js";
import { stopSenti } from "../session/daemon.js";
import { listRuntimeRuns } from "../session/runtime-bridge.js";
import {
  createSession,
  DEFAULT_TTL_SECONDS,
  getSession,
  listActiveSessions,
  recordSessionProvisionedIdentities,
} from "../session/store.js";
import { appendToStream, readStream, tailStream } from "../session/stream.js";
import { parseCsvTokens } from "./ai/shared.js";

function shouldEmitJson(options, command) {
  const local = Boolean(options && options.json);
  const globalFromCommand =
    command && command.optsWithGlobals ? Boolean(command.optsWithGlobals().json) : false;
  return local || globalFromCommand;
}

function normalizeString(value) {
  return String(value || "").trim();
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

function normalizeAgentId(value, fallbackValue = "cli-user") {
  const normalized = normalizeString(value)
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return normalized || fallbackValue;
}

async function runWithConcurrency(items = [], concurrency = 1, worker = async () => null) {
  const normalizedItems = Array.isArray(items) ? items : [];
  const normalizedConcurrency = Math.max(
    1,
    Math.min(
      normalizedItems.length || 1,
      Number.isFinite(Number(concurrency)) ? Math.floor(Number(concurrency)) : 1
    )
  );
  const results = new Array(normalizedItems.length);
  let cursor = 0;

  const runners = Array.from({ length: normalizedConcurrency }, async () => {
    while (cursor < normalizedItems.length) {
      const index = cursor;
      cursor += 1;
      results[index] = await worker(normalizedItems[index], index);
    }
  });
  await Promise.all(runners);
  return results;
}

function resolveSessionIdOption(options = {}) {
  const sessionId = normalizeString(options.session || options.id);
  if (!sessionId) {
    throw new Error("session id is required (use --session <id>).");
  }
  return sessionId;
}

function formatEventLine(event = {}) {
  const ts = normalizeString(event.ts || event.timestamp);
  const type = normalizeString(event.event || event.type) || "event";
  const agentId = normalizeString(event.agent?.id || event.agentId || "unknown");
  const payload = event.payload && typeof event.payload === "object" ? event.payload : {};
  const message = normalizeString(payload.message || payload.response || payload.alert || payload.reason || "");
  if (message) {
    return `${ts} ${agentId} ${type}: ${message}`;
  }
  return `${ts} ${agentId} ${type}`;
}

async function revokeAgentLeases(sessionId, agentId, { targetPath, reason } = {}) {
  const active = await listAssignments({
    targetPath,
    sessionId,
    agentIdentity: agentId,
    statuses: ["CLAIMED", "IN_PROGRESS"],
    includeExpired: true,
    limit: 500,
  });
  let releasedCount = 0;
  for (const assignment of active.assignments) {
    await releaseLease({
      targetPath,
      sessionId,
      workItemId: assignment.workItemId,
      agentIdentity: agentId,
      status: "QUEUED",
      reason,
    });
    releasedCount += 1;
  }
  return releasedCount;
}

async function emitAgentKilledEvent(sessionId, agentId, {
  targetPath,
  reason,
  leaseRevocations = 0,
} = {}) {
  const event = createAgentEvent({
    event: "agent_killed",
    agentId,
    sessionId,
    payload: {
      target: agentId,
      reason: normalizeString(reason) || "manual_stop",
      leaseRevocations: Number(leaseRevocations || 0),
    },
  });
  await appendToStream(sessionId, event, { targetPath });
  return event;
}

export function registerSessionCommand(program) {
  const session = program
    .command("session")
    .description("Multi-agent ephemeral coordination sessions");

  session
    .command("start")
    .description("Create a new persistent session with metadata + NDJSON stream")
    .option("--path <path>", "Workspace path for the session", ".")
    .option(
      "--ttl-seconds <seconds>",
      `Session time-to-live in seconds (default ${DEFAULT_TTL_SECONDS})`,
      String(DEFAULT_TTL_SECONDS)
    )
    .option("--json", "Emit machine-readable output")
    .action(async (options, command) => {
      const targetPath = path.resolve(process.cwd(), String(options.path || "."));
      const ttlSeconds = parsePositiveInteger(options.ttlSeconds, "ttl-seconds", DEFAULT_TTL_SECONDS);
      const startedAt = Date.now();
      const created = await createSession({
        targetPath,
        ttlSeconds,
      });
      const durationMs = Date.now() - startedAt;

      const payload = {
        command: "session start",
        targetPath,
        durationMs,
        sessionId: created.sessionId,
        sessionDir: created.sessionDir,
        metadataPath: created.metadataPath,
        streamPath: created.streamPath,
        createdAt: created.createdAt,
        expiresAt: created.expiresAt,
        elapsedTimer: created.elapsedTimer,
        renewalCount: created.renewalCount,
        status: created.status,
      };

      if (shouldEmitJson(options, command)) {
        console.log(JSON.stringify(payload, null, 2));
        return;
      }

      console.log(pc.bold("Session created"));
      console.log(pc.gray(`Session: ${created.sessionId}`));
      console.log(pc.gray(`Stream: ${created.streamPath}`));
      console.log(pc.gray(`Created in ${durationMs}ms`));
      console.log(
        `status=${created.status} created_at=${created.createdAt} expires_at=${created.expiresAt} ttl_seconds=${ttlSeconds}`
      );
    });

  session
    .command("join <sessionId>")
    .description("Join an active session")
    .option("--name <name>", "Agent display name")
    .option("--role <role>", "Agent role: coder, reviewer, tester, observer", "coder")
    .option("--model <model>", "Agent model hint", "cli")
    .option("--path <path>", "Workspace path for the session", ".")
    .option("--json", "Emit machine-readable output")
    .action(async (sessionId, options, command) => {
      const normalizedSessionId = normalizeString(sessionId);
      if (!normalizedSessionId) {
        throw new Error("session id is required.");
      }
      const targetPath = path.resolve(process.cwd(), String(options.path || "."));
      const joined = await registerAgent(normalizedSessionId, {
        targetPath,
        agentId: normalizeAgentId(options.name, "cli-user"),
        model: normalizeString(options.model) || "cli",
        role: options.role || "coder",
      });
      const payload = {
        command: "session join",
        targetPath,
        sessionId: normalizedSessionId,
        agentId: joined.agentId,
        role: joined.role,
        model: joined.model,
        status: joined.status,
        joinedAt: joined.joinedAt,
      };
      if (shouldEmitJson(options, command)) {
        console.log(JSON.stringify(payload, null, 2));
        return;
      }
      console.log(pc.bold(`Joined session ${normalizedSessionId}`));
      console.log(pc.gray(`agent=${joined.agentId} role=${joined.role} model=${joined.model}`));
    });

  session
    .command("say <sessionId> <message>")
    .description("Send a message to the session")
    .option("--agent <id>", "Agent id to emit from", "cli-user")
    .option("--path <path>", "Workspace path for the session", ".")
    .option("--json", "Emit machine-readable output")
    .action(async (sessionId, message, options, command) => {
      const normalizedSessionId = normalizeString(sessionId);
      if (!normalizedSessionId) {
        throw new Error("session id is required.");
      }
      const normalizedMessage = normalizeString(message);
      if (!normalizedMessage) {
        throw new Error("message is required.");
      }
      const targetPath = path.resolve(process.cwd(), String(options.path || "."));
      const agentId = normalizeAgentId(options.agent, "cli-user");
      const event = createAgentEvent({
        event: "session_message",
        agentId,
        sessionId: normalizedSessionId,
        payload: {
          message: normalizedMessage,
          channel: "session",
        },
      });
      const persisted = await appendToStream(normalizedSessionId, event, {
        targetPath,
      });
      const payload = {
        command: "session say",
        targetPath,
        sessionId: normalizedSessionId,
        agentId,
        event: persisted,
      };
      if (shouldEmitJson(options, command)) {
        console.log(JSON.stringify(payload, null, 2));
        return;
      }
      console.log(formatEventLine(persisted));
    });

  session
    .command("read <sessionId>")
    .description("Read recent session messages")
    .option("--tail <n>", "Number of recent events", "20")
    .option("--follow", "Continuously follow new events")
    .option("--path <path>", "Workspace path for the session", ".")
    .option("--json", "Emit machine-readable output")
    .action(async (sessionId, options, command) => {
      const normalizedSessionId = normalizeString(sessionId);
      if (!normalizedSessionId) {
        throw new Error("session id is required.");
      }
      const targetPath = path.resolve(process.cwd(), String(options.path || "."));
      const tail = parsePositiveInteger(options.tail, "tail", 20);
      const emitJson = shouldEmitJson(options, command);

      if (!options.follow) {
        const events = await readStream(normalizedSessionId, {
          targetPath,
          tail,
        });
        const payload = {
          command: "session read",
          targetPath,
          sessionId: normalizedSessionId,
          tail,
          count: events.length,
          events,
        };
        if (emitJson) {
          console.log(JSON.stringify(payload, null, 2));
          return;
        }
        for (const event of events) {
          console.log(formatEventLine(event));
        }
        return;
      }

      if (!emitJson) {
        console.log(pc.gray(`Following session ${normalizedSessionId}... Press Ctrl+C to stop.`));
      }
      for await (const event of tailStream(normalizedSessionId, {
        targetPath,
        replayTail: tail,
      })) {
        if (emitJson) {
          console.log(JSON.stringify(event));
        } else {
          console.log(formatEventLine(event));
        }
      }
    });

  session
    .command("status <sessionId>")
    .description("Show session status, agents, and health")
    .option("--path <path>", "Workspace path for the session", ".")
    .option("--json", "Emit machine-readable output")
    .action(async (sessionId, options, command) => {
      const normalizedSessionId = normalizeString(sessionId);
      if (!normalizedSessionId) {
        throw new Error("session id is required.");
      }
      const targetPath = path.resolve(process.cwd(), String(options.path || "."));
      const sessionPayload = await getSession(normalizedSessionId, {
        targetPath,
      });
      if (!sessionPayload) {
        throw new Error(`Session '${normalizedSessionId}' was not found.`);
      }

      const [agents, runtimeRuns, leases, recentEvents] = await Promise.all([
        listAgents(normalizedSessionId, {
          targetPath,
          includeInactive: false,
        }),
        Promise.resolve(
          listRuntimeRuns({
            sessionId: normalizedSessionId,
            targetPath,
            includeStopped: false,
          })
        ),
        listAssignments({
          targetPath,
          sessionId: normalizedSessionId,
          statuses: ["CLAIMED", "IN_PROGRESS"],
          includeExpired: true,
          limit: 100,
        }),
        readStream(normalizedSessionId, {
          targetPath,
          tail: 10,
        }),
      ]);

      const staleAgents = detectStaleAgents(agents, {});
      const payload = {
        command: "session status",
        targetPath,
        sessionId: normalizedSessionId,
        session: sessionPayload,
        activeAgents: agents,
        staleAgents,
        runtimeRuns,
        activeLeases: leases.assignments,
        recentEvents,
      };
      if (shouldEmitJson(options, command)) {
        console.log(JSON.stringify(payload, null, 2));
        return;
      }

      console.log(pc.bold(`Session ${normalizedSessionId}`));
      console.log(
        pc.gray(
          `status=${sessionPayload.status} agents=${agents.length} stale=${staleAgents.length} runs=${runtimeRuns.length} leases=${leases.assignments.length}`
        )
      );
      for (const event of recentEvents) {
        console.log(formatEventLine(event));
      }
    });

  session
    .command("leave <sessionId>")
    .description("Leave a session")
    .option("--agent <id>", "Agent id to unregister", "cli-user")
    .option("--reason <reason>", "Leave reason", "manual")
    .option("--path <path>", "Workspace path for the session", ".")
    .option("--json", "Emit machine-readable output")
    .action(async (sessionId, options, command) => {
      const normalizedSessionId = normalizeString(sessionId);
      if (!normalizedSessionId) {
        throw new Error("session id is required.");
      }
      const targetPath = path.resolve(process.cwd(), String(options.path || "."));
      const agentId = normalizeAgentId(options.agent, "cli-user");
      const left = await unregisterAgent(normalizedSessionId, agentId, {
        reason: options.reason || "manual",
        targetPath,
      });
      const payload = {
        command: "session leave",
        targetPath,
        sessionId: normalizedSessionId,
        agentId: left.agentId,
        reason: left.leaveReason,
        leftAt: left.leftAt,
      };
      if (shouldEmitJson(options, command)) {
        console.log(JSON.stringify(payload, null, 2));
        return;
      }
      console.log(pc.bold(`Left session ${normalizedSessionId}`));
      console.log(pc.gray(`agent=${left.agentId} reason=${left.leaveReason}`));
    });

  session
    .command("list")
    .description("List active sessions")
    .option("--path <path>", "Workspace path for sessions", ".")
    .option("--json", "Emit machine-readable output")
    .action(async (options, command) => {
      const targetPath = path.resolve(process.cwd(), String(options.path || "."));
      const sessions = await listActiveSessions({
        targetPath,
      });
      const payload = {
        command: "session list",
        targetPath,
        count: sessions.length,
        sessions,
      };
      if (shouldEmitJson(options, command)) {
        console.log(JSON.stringify(payload, null, 2));
        return;
      }
      if (sessions.length === 0) {
        console.log(pc.yellow("No active sessions."));
        return;
      }
      for (const item of sessions) {
        console.log(
          `${item.sessionId} status=${item.status} created_at=${item.createdAt} expires_at=${item.expiresAt}`
        );
      }
    });

  session
    .command("provision-emails <sessionId>")
    .description("Provision ephemeral AIdenID emails for swarm testing")
    .option("--count <n>", "Number of emails to provision", "5")
    .option("--tags <csv>", "Tags for provisioned identities", "session,swarm")
    .option("--ttl-hours <hours>", "Identity TTL in hours", "24")
    .option("--alias-template <value>", "Optional alias template override")
    .option("--concurrency <n>", "Parallel provision requests (max 10)", "10")
    .option("--path <path>", "Workspace path for the session", ".")
    .option("--output-dir <path>", "Optional artifact output root override")
    .option("--api-url <url>", "AIdenID API base URL", "https://api.aidenid.com")
    .option("--api-key <key>", "AIdenID API key (or use AIDENID_API_KEY env)")
    .option("--org-id <id>", "AIdenID org id (or use AIDENID_ORG_ID env)")
    .option("--project-id <id>", "AIdenID project id (or use AIDENID_PROJECT_ID env)")
    .option("--dry-run", "Plan provisioning without executing remote API calls")
    .option("--json", "Emit machine-readable output")
    .action(async (sessionId, options, command) => {
      const normalizedSessionId = normalizeString(sessionId);
      if (!normalizedSessionId) {
        throw new Error("session id is required.");
      }
      const targetPath = path.resolve(process.cwd(), String(options.path || "."));
      const sessionPayload = await getSession(normalizedSessionId, { targetPath });
      if (!sessionPayload) {
        throw new Error(`Session '${normalizedSessionId}' was not found.`);
      }

      const count = parsePositiveInteger(options.count, "count", 5);
      if (count > 50) {
        throw new Error("count must be <= 50 for a single provisioning batch.");
      }
      const ttlHours = parsePositiveInteger(options.ttlHours, "ttl-hours", 24);
      if (ttlHours > 24 * 30) {
        throw new Error("ttl-hours must be between 1 and 720.");
      }
      const requestedConcurrency = parsePositiveInteger(options.concurrency, "concurrency", 10);
      const concurrency = Math.max(1, Math.min(10, requestedConcurrency, count));
      const tags = parseCsvTokens(options.tags, ["session", "swarm"]);
      const apiUrl = normalizeAidenIdApiUrl(options.apiUrl);
      const outputRoot = await resolveOutputRoot({
        cwd: targetPath,
        outputDirOverride: options.outputDir,
        env: process.env,
      });

      const aliasBase =
        normalizeString(options.aliasTemplate) ||
        `session-${normalizedSessionId.slice(0, 8)}-identity`;

      if (Boolean(options.dryRun)) {
        const planned = Array.from({ length: count }, (_, index) => ({
          index: index + 1,
          aliasTemplate: `${aliasBase}-${index + 1}`,
          tags,
          ttlHours,
        }));
        const payload = {
          command: "session provision-emails",
          execute: false,
          sessionId: normalizedSessionId,
          targetPath,
          apiUrl,
          requestedCount: count,
          concurrency,
          tags,
          planned,
        };
        if (shouldEmitJson(options, command)) {
          console.log(JSON.stringify(payload, null, 2));
          return;
        }
        console.log(pc.bold(`Provision plan ready for session ${normalizedSessionId}`));
        console.log(pc.gray(`count=${count} concurrency=${concurrency} api=${apiUrl}`));
        return;
      }

      let storedSession = null;
      try {
        storedSession = await readStoredSession();
      } catch {
        storedSession = null;
      }

      const fetchCredentials =
        storedSession && storedSession.token
          ? () =>
              fetchAidenIdCredentials({
                apiUrl: storedSession.apiUrl,
                token: storedSession.token,
              })
          : null;
      const credentials = await resolveAidenIdCredentials({
        apiKey: options.apiKey,
        orgId: options.orgId,
        projectId: options.projectId,
        env: process.env,
        requireAll: true,
        session: storedSession,
        fetchCredentials,
      });

      const startedAt = Date.now();
      const indices = Array.from({ length: count }, (_, index) => index);
      const provisioned = await runWithConcurrency(indices, concurrency, async (index) => {
        const idempotencyKey = `session-${normalizedSessionId}-${index + 1}-${randomUUID()}`;
        const payload = buildProvisionEmailPayload({
          aliasTemplate: `${aliasBase}-${index + 1}`,
          ttlHours,
          tags,
        });
        const execution = await provisionEmailIdentity({
          apiUrl,
          apiKey: credentials.apiKey,
          orgId: credentials.orgId,
          projectId: credentials.projectId,
          idempotencyKey,
          payload,
        });

        const responseIdentity = execution.response || {};
        return {
          index: index + 1,
          idempotencyKey,
          identityId: normalizeString(responseIdentity.id) || null,
          emailAddress: normalizeString(responseIdentity.emailAddress) || null,
          status: normalizeString(responseIdentity.status) || null,
          expiresAt: responseIdentity.expiresAt || null,
          response: responseIdentity,
        };
      });

      for (const identity of provisioned) {
        await recordProvisionedIdentity({
          outputRoot,
          response: identity.response || {},
          context: {
            source: "session-provision-emails",
            apiUrl,
            orgId: credentials.orgId,
            projectId: credentials.projectId,
            idempotencyKey: identity.idempotencyKey,
            tags,
          },
        });
      }

      const identityIds = provisioned
        .map((identity) => normalizeString(identity.identityId))
        .filter(Boolean);
      const updatedSession = await recordSessionProvisionedIdentities(normalizedSessionId, {
        targetPath,
        identityIds,
        tags,
      });
      const streamEvent = await appendToStream(
        normalizedSessionId,
        createAgentEvent({
          event: "session_provision_emails",
          agentId: "senti",
          agentModel: "gpt-5.4-mini",
          sessionId: normalizedSessionId,
          payload: {
            requestedCount: count,
            provisionedCount: provisioned.length,
            identityIds,
            tags,
            ttlHours,
            concurrency,
          },
        }),
        { targetPath }
      );

      const durationMs = Date.now() - startedAt;
      const payload = {
        command: "session provision-emails",
        execute: true,
        targetPath,
        outputRoot,
        durationMs,
        sessionId: normalizedSessionId,
        apiUrl,
        requestedCount: count,
        provisionedCount: provisioned.length,
        concurrency,
        tags,
        ttlHours,
        identities: provisioned,
        sharedResources: updatedSession.sharedResources,
        event: streamEvent,
      };

      if (shouldEmitJson(options, command)) {
        console.log(JSON.stringify(payload, null, 2));
        return;
      }
      console.log(pc.bold(`Provisioned ${provisioned.length} identities for session ${normalizedSessionId}`));
      console.log(pc.gray(`concurrency=${concurrency} duration_ms=${durationMs}`));
    });

  session
    .command("kill")
    .description("Kill a single agent or all agents in a session")
    .option("--agent <id>", "Specific agent id to stop")
    .option("--all", "Kill every known agent in the session")
    .option("--session <id>", "Session id")
    .option("--id <sessionId>", "Deprecated alias for --session")
    .option("--path <path>", "Workspace path for the session", ".")
    .option("--reason <reason>", "Kill reason code", "manual_stop")
    .option("--json", "Emit machine-readable output")
    .action(async (options, command) => {
      const sessionId = resolveSessionIdOption(options);
      const targetPath = path.resolve(process.cwd(), String(options.path || "."));
      const reason = normalizeString(options.reason) || "manual_stop";
      const requestedAgent = normalizeString(options.agent).toLowerCase();

      if (!options.all && !requestedAgent) {
        throw new Error("session kill requires --agent <id> or --all.");
      }

      const startedAt = Date.now();
      const discoveredAgents = await listAgents(sessionId, {
        targetPath,
        includeInactive: false,
      });
      const agentsToKill = new Set();
      if (options.all) {
        agentsToKill.add("senti");
        agentsToKill.add("scope-engine");
        for (const agent of discoveredAgents) {
          const agentId = normalizeString(agent.agentId).toLowerCase();
          if (agentId) {
            agentsToKill.add(agentId);
          }
        }
      } else {
        agentsToKill.add(requestedAgent);
      }

      const results = [];
      let runtimeStops = 0;
      let scopeStops = 0;
      let leaseRevocations = 0;
      let anyStopped = false;

      for (const agentId of agentsToKill) {
        let stopped = false;
        let stopDetails = {};
        if (agentId === "senti") {
          const stopResult = await stopSenti(sessionId, {
            targetPath,
            reason,
          });
          runtimeStops += Number(stopResult?.runtimeStopSummary?.stoppedCount || 0);
          stopped = Boolean(stopResult?.stopped);
          stopDetails = {
            runtimeStops: Number(stopResult?.runtimeStopSummary?.stoppedCount || 0),
            scopeStops: 0,
          };
        } else if (agentId === "scope-engine") {
          const stopResult = await stopScopeEngine({
            targetPath,
            sessionId,
            reason,
          });
          scopeStops += Number(stopResult?.count || 0);
          stopped = Boolean(stopResult?.stopped);
          stopDetails = {
            runtimeStops: 0,
            scopeStops: Number(stopResult?.count || 0),
          };
        } else {
          try {
            await unregisterAgent(sessionId, agentId, {
              reason: "killed",
              targetPath,
            });
            stopped = true;
          } catch {
            stopped = false;
          }
          if (stopped) {
            await emitAgentKilledEvent(sessionId, agentId, {
              targetPath,
              reason,
              leaseRevocations: 0,
            });
          }
          stopDetails = {
            runtimeStops: 0,
            scopeStops: 0,
          };
        }

        const releasedCount = await revokeAgentLeases(sessionId, agentId, {
          targetPath,
          reason: `agent_killed:${reason}`,
        });
        leaseRevocations += releasedCount;
        anyStopped = anyStopped || stopped;

        results.push({
          agentId,
          stopped,
          runtimeStops: stopDetails.runtimeStops,
          scopeStops: stopDetails.scopeStops,
          leaseRevocations: releasedCount,
        });
      }

      const durationMs = Date.now() - startedAt;
      const primaryAgentId = !options.all ? requestedAgent : null;
      const payload = {
        command: "session kill",
        targetPath,
        durationMs,
        sessionId,
        agentId: primaryAgentId,
        all: Boolean(options.all),
        reason,
        stopped: anyStopped,
        runtimeStops,
        scopeStops,
        leaseRevocations,
        results,
      };

      if (shouldEmitJson(options, command)) {
        console.log(JSON.stringify(payload, null, 2));
        return;
      }

      if (payload.stopped) {
        console.log(pc.bold("Kill complete"));
      } else {
        console.log(pc.yellow(`No active target found in session ${sessionId}.`));
      }
      console.log(
        pc.gray(
          `session=${sessionId} runtime_stops=${runtimeStops} scope_stops=${scopeStops} lease_revocations=${leaseRevocations}`
        )
      );
      console.log(`stopped=${payload.stopped} reason=${reason} duration_ms=${durationMs}`);
    });
}
