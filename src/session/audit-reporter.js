import { createAgentEvent } from "../events/schema.js";
import { registerAgent } from "./agent-registry.js";
import { listActiveSessions } from "./store.js";
import { appendToStream } from "./stream.js";

const ORCHESTRATOR_AGENT_ID = "audit-orchestrator";

function normalizeString(value) {
  return String(value || "").trim();
}

function formatSeveritySummary(summary = {}) {
  return `P0=${Number(summary.P0 || 0)} P1=${Number(summary.P1 || 0)} P2=${Number(summary.P2 || 0)} P3=${Number(summary.P3 || 0)}`;
}

function formatDurationSeconds(durationMs) {
  return `${Math.max(0, Math.round(Number(durationMs || 0) / 1000))}s`;
}

/**
 * Resolve which senti session an audit run should report into.
 * Explicit id wins; otherwise the workspace's most recently active local
 * session (the one `create-sentinelayer` bootstraps for new projects).
 * Returns "" when relay is disabled or no session exists — audit runs
 * never require a session.
 */
export async function resolveAuditSessionId({
  targetPath = process.cwd(),
  explicitSessionId = "",
  disabled = false,
} = {}) {
  if (disabled) {
    return "";
  }
  const explicit = normalizeString(explicitSessionId);
  if (explicit) {
    return explicit;
  }
  const sessions = await listActiveSessions({ targetPath }).catch(() => []);
  if (!Array.isArray(sessions) || sessions.length === 0) {
    return "";
  }
  const sorted = [...sessions].sort((left, right) =>
    normalizeString(right.lastInteractionAt || right.updatedAt || right.createdAt).localeCompare(
      normalizeString(left.lastInteractionAt || left.updatedAt || left.createdAt)
    )
  );
  return normalizeString(sorted[0]?.sessionId);
}

/**
 * Relay audit-orchestrator lifecycle events into a senti session so swarm
 * personas can see each other's progress (start, per-agent completion,
 * final summary) in the project's shared room.
 *
 * Posts are queued sequentially so transcript order matches audit order,
 * and every post is best-effort: a session outage never fails an audit.
 */
export function createAuditSessionReporter({ sessionId, targetPath = process.cwd() } = {}) {
  const normalizedSessionId = normalizeString(sessionId);
  if (!normalizedSessionId) {
    return null;
  }

  const registeredAgents = new Set();
  let postedCount = 0;
  let failedCount = 0;
  let queue = Promise.resolve();

  const post = (agentId, message) => {
    const id = normalizeString(agentId) || ORCHESTRATOR_AGENT_ID;
    queue = queue.then(async () => {
      try {
        if (!registeredAgents.has(id)) {
          registeredAgents.add(id);
          await registerAgent(normalizedSessionId, {
            agentId: id,
            model: "audit-persona",
            role: "auditor",
            targetPath,
            trackProcessExit: false,
          }).catch(() => {});
        }
        const event = createAgentEvent({
          event: "session_message",
          agent: { id, persona: id },
          sessionId: normalizedSessionId,
          payload: { message, channel: "session" },
        });
        await appendToStream(normalizedSessionId, event, { targetPath, awaitRemoteSync: true });
        postedCount += 1;
      } catch {
        failedCount += 1;
      }
    });
    return queue;
  };

  const handleEvent = (evt) => {
    if (!evt || typeof evt !== "object") {
      return;
    }
    const payload = evt.payload && typeof evt.payload === "object" ? evt.payload : {};
    switch (evt.event) {
      case "phase_start":
        if (payload.phase === "dispatch") {
          void post(
            ORCHESTRATOR_AGENT_ID,
            `🔍 Audit dispatch started: ${Number(payload.agentCount || 0)} persona(s), max ${Number(payload.maxParallel || 1)} in parallel.`
          );
        }
        break;
      case "dispatch":
        void post(
          payload.agentId,
          `▶ Starting ${normalizeString(payload.persona) || normalizeString(payload.agentId)} audit (${normalizeString(payload.domain) || "general"}).`
        );
        break;
      case "agent_complete":
        void post(
          payload.agentId,
          `✅ ${normalizeString(payload.agentId)} audit complete: ${Number(payload.findingCount || 0)} finding(s) (${formatSeveritySummary(payload.summary)}), status=${normalizeString(payload.status) || "ok"}, ${formatDurationSeconds(payload.durationMs)}.`
        );
        break;
      case "phase_complete":
        if (payload.phase === "dispatch") {
          void post(
            ORCHESTRATOR_AGENT_ID,
            `Dispatch complete: ${Number(payload.agentCount || 0)} persona result(s) in ${formatDurationSeconds(payload.durationMs)}.`
          );
        }
        break;
      default:
        break;
    }
  };

  const stats = () => ({ posted: postedCount, failed: failedCount });

  const completed = async (result = {}) => {
    await post(
      ORCHESTRATOR_AGENT_ID,
      `🏁 Audit run ${normalizeString(result.runId)} complete — ${formatSeveritySummary(result.summary)} across ${Array.isArray(result.agentResults) ? result.agentResults.length : 0} persona(s). Report: ${normalizeString(result.reportMarkdownPath)}`
    );
    await queue;
    return stats();
  };

  const failed = async (error) => {
    await post(
      ORCHESTRATOR_AGENT_ID,
      `❌ Audit run failed: ${normalizeString(error?.message) || "unknown error"}`
    );
    await queue;
    return stats();
  };

  return {
    sessionId: normalizedSessionId,
    handleEvent,
    completed,
    failed,
  };
}
