import fsp from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { createHash, randomUUID } from "node:crypto";

import pc from "picocolors";

import { SentinelayerApiError, requestJsonMutation } from "../auth/http.js";
import {
  buildProvisionEmailPayload,
  normalizeAidenIdApiUrl,
  provisionEmailIdentity,
  resolveAidenIdCredentials,
} from "../ai/aidenid.js";
import { recordProvisionedIdentity } from "../ai/identity-store.js";
import { readStoredSession } from "../auth/session-store.js";
import { fetchAidenIdCredentials } from "../auth/service.js";
import { resolveActiveAuthSession } from "../auth/service.js";
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
import { startSenti, stopSenti } from "../session/daemon.js";
import { listRuntimeRuns } from "../session/runtime-bridge.js";
import {
  listFileLocks,
  releaseFileLocksForAgent,
} from "../session/file-locks.js";
import {
  injectSessionGuides,
  setupSessionGuides,
} from "../session/setup-guides.js";
import { listSessionTasks } from "../session/tasks.js";
import {
  createSession,
  DEFAULT_TTL_SECONDS,
  expireSession,
  getSession,
  isSessionCacheExpired,
  listActiveSessions,
  listAllSessions,
  recordSessionProvisionedIdentities,
  refreshSessionCacheForRemoteActivity,
  updateSessionTitle,
} from "../session/store.js";
import { appendToStream, readStream, tailStream } from "../session/stream.js";
import {
  addSessionEventIdentityKeys,
  dedupeSessionEvents,
  sessionEventHasKnownIdentity,
} from "../session/event-identity.js";
import { readSessionPreview } from "../session/preview.js";
import {
  createSessionMessageAction,
  listSessionMessageActions,
  listSessionsFromApi,
  probeSessionAccess,
  pollSessionEventsBefore,
  searchSessionEvents,
  syncSessionEventToApi,
  syncSessionMetadataToApi,
} from "../session/sync.js";
import { hydrateSessionFromRemote } from "../session/remote-hydrate.js";
import { mergeLiveSources } from "../session/live-source.js";
import { listenSessionEvents } from "../session/listener.js";
import { buildSessionRecap } from "../session/recap.js";
import { computeTranscriptStats } from "../session/transcript.js";
import { deriveSessionTitle } from "../session/senti-naming.js";
import { pushSessionTitleToApi } from "../session/title-sync.js";
import {
  buildDashboardUrl,
  buildTemplateLaunchPlan,
  getTemplateRegistry,
  resolveSessionTemplate,
} from "../session/templates.js";
import {
  createSessionCheckpoint,
  generateSessionCheckpoint,
  listSessionCheckpoints,
} from "../session/checkpoints.js";
import { authLoginHint, preferredCliCommand } from "../ui/command-hints.js";
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

const SESSION_MESSAGE_ACTION_TYPES = new Set([
  "ack",
  "working_on",
  "reply",
  "like",
  "dislike",
  "disregard",
  "view",
]);

const SESSION_MESSAGE_ACTION_ALIASES = new Map([
  ["comment", "reply"],
]);

const SESSION_MESSAGE_ACTION_DESCRIPTIONS = Object.freeze([
  {
    type: "ack",
    command: "sl session react <id> ack --target-sequence <n>",
    description: "Acknowledge that you read a message without adding a top-level post.",
  },
  {
    type: "working_on",
    command: "sl session action <id> working_on --target-sequence <n> --note \"scope\"",
    description: "Claim active ownership of a target message or task.",
  },
  {
    type: "reply",
    alias: "comment",
    command: "sl session reply <id> <sequence> \"message\"",
    description: "Thread a substantive response under a specific message.",
  },
  {
    type: "like",
    command: "sl session react <id> like --target-sequence <n>",
    description: "Positive lightweight feedback. Use --target-action-id <uuid> to react to a threaded reply.",
  },
  {
    type: "dislike",
    command: "sl session react <id> dislike --target-sequence <n>",
    description: "Negative lightweight feedback. Use --target-action-id <uuid> to react to a threaded reply.",
  },
  {
    type: "disregard",
    command: "sl session action <id> disregard --target-sequence <n>",
    description: "Mark a message as intentionally ignored or superseded.",
  },
  {
    type: "view",
    command: "sl session view <id> <sequence>",
    description: "Record a read receipt for a target message.",
  },
]);

function normalizeSessionMessageActionType(value) {
  const raw = normalizeString(value).toLowerCase();
  const normalized = SESSION_MESSAGE_ACTION_ALIASES.get(raw) || raw;
  if (!SESSION_MESSAGE_ACTION_TYPES.has(normalized)) {
    throw new Error(
      `action type must be one of: ${[...SESSION_MESSAGE_ACTION_TYPES].join(", ")}; aliases: comment=reply.`,
    );
  }
  return normalized;
}

function parseOptionalPositiveInteger(rawValue, field) {
  if (rawValue === undefined || rawValue === null || String(rawValue).trim() === "") {
    return null;
  }
  return parsePositiveInteger(rawValue, field, null);
}

function shortSha256(value) {
  return createHash("sha256").update(String(value || "")).digest("hex").slice(0, 32);
}

function actionEventType(actionType) {
  if (actionType === "reply") return "session_reply";
  if (actionType === "like" || actionType === "dislike") return "session_reaction";
  return "session_action";
}

function actionTargetSequence(action = {}) {
  const value = Number(action.targetSequenceId ?? action.target_sequence_id ?? 0);
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : null;
}

function actionTargetCursor(action = {}) {
  return normalizeString(action.targetCursor ?? action.target_cursor);
}

function actionTargetActionId(action = {}) {
  return normalizeString(action.targetActionId ?? action.target_action_id);
}

function actionActorId(action = {}) {
  return normalizeString(action.actorId ?? action.actor_id) || "unknown";
}

function actionCreatedAt(action = {}) {
  return normalizeString(action.createdAt ?? action.created_at) || new Date().toISOString();
}

function actionDisplayMessage(action = {}) {
  const actionType = normalizeString(action.actionType ?? action.action_type).toLowerCase();
  const targetSequence = actionTargetSequence(action);
  const targetActionId = actionTargetActionId(action);
  const parentLabel = targetSequence ? `#${targetSequence}` : actionTargetCursor(action) || "";
  const targetLabel = targetActionId
    ? `action:${targetActionId}${parentLabel ? ` (${parentLabel})` : ""}`
    : parentLabel || "target";
  const note = normalizeString(action.note);
  if (note) return `${actionType} ${targetLabel}: ${note}`;
  return `${actionType} ${targetLabel}`;
}

function buildSessionActionEvent(sessionId, action = {}) {
  const actionType = normalizeString(action.actionType ?? action.action_type).toLowerCase();
  if (!SESSION_MESSAGE_ACTION_TYPES.has(actionType)) return null;
  const id =
    normalizeString(action.id) ||
    shortSha256(
      JSON.stringify({
        actionType,
        targetSequenceId: actionTargetSequence(action),
        targetCursor: actionTargetCursor(action),
        targetActionId: actionTargetActionId(action),
        actorId: actionActorId(action),
        note: normalizeString(action.note),
        createdAt: actionCreatedAt(action),
      }),
    );
  const actorId = actionActorId(action);
  const event = createAgentEvent({
    event: actionEventType(actionType),
    agent: {
      id: actorId,
      role: normalizeString(action.actorRole ?? action.actor_role) || undefined,
      model: normalizeString(action.actorKind ?? action.actor_kind) || "session-action",
    },
    sessionId,
    ts: actionCreatedAt(action),
    payload: {
      actionId: id,
      actionType,
      targetSequenceId: actionTargetSequence(action),
      targetCursor: actionTargetCursor(action) || null,
      targetActionId: actionTargetActionId(action) || null,
      note: normalizeString(action.note) || null,
      message: actionDisplayMessage(action),
      source: "session_action",
    },
  });
  event.eventId = `session-action-${id}`;
  event.idempotencyToken = normalizeString(action.idempotencyKey ?? action.idempotency_key) || event.eventId;
  event.cursor = `action:${id}`;
  return event;
}

function buildSessionActionEvents(sessionId, actions = []) {
  return (Array.isArray(actions) ? actions : [])
    .map((action) => buildSessionActionEvent(sessionId, action))
    .filter(Boolean);
}

function eventTimestampMs(event = {}) {
  for (const key of ["ts", "timestamp", "createdAt", "at"]) {
    const epoch = Date.parse(normalizeString(event?.[key]));
    if (Number.isFinite(epoch)) return epoch;
  }
  return 0;
}

function eventSequenceNumber(event = {}) {
  for (const key of ["sequenceId", "sequence_id", "sequence"]) {
    const value = Number(event?.[key]);
    if (Number.isFinite(value)) return value;
  }
  return 0;
}

function mergeSessionActionEvents(events = [], actionEvents = []) {
  return dedupeSessionEvents([...(Array.isArray(events) ? events : []), ...actionEvents])
    .map((event, index) => ({ event, index }))
    .sort((left, right) => {
      const timeDiff = eventTimestampMs(left.event) - eventTimestampMs(right.event);
      if (timeDiff !== 0) return timeDiff;
      const sequenceDiff = eventSequenceNumber(left.event) - eventSequenceNumber(right.event);
      if (sequenceDiff !== 0) return sequenceDiff;
      return left.index - right.index;
    })
    .map((entry) => entry.event);
}

async function appendActionEventIfMissing(sessionId, actionEvent, { targetPath } = {}) {
  if (!actionEvent) return { appended: false, reason: "no_event", event: null };
  const existingEvents = await readStream(sessionId, { targetPath, tail: 0 }).catch(() => []);
  const knownKeys = new Set();
  for (const event of existingEvents) {
    addSessionEventIdentityKeys(knownKeys, event);
  }
  if (sessionEventHasKnownIdentity(actionEvent, knownKeys)) {
    return { appended: false, reason: "already_present", event: actionEvent };
  }
  const appended = await appendToStream(sessionId, actionEvent, {
    targetPath,
    syncRemote: false,
  });
  return { appended: true, reason: "", event: appended };
}

function defaultActionIdempotencyKey({
  actionType,
  targetSequenceId,
  targetCursor,
  targetActionId,
  note,
  agentId,
} = {}) {
  const target = normalizeString(targetActionId)
    ? `action:${normalizeString(targetActionId)}`
    : targetSequenceId
      ? `seq:${targetSequenceId}`
      : `cursor:${normalizeString(targetCursor)}`;
  const noteHash = note ? shortSha256(note) : "none";
  const actor = normalizeString(agentId) || "user";
  return `cli:${normalizeString(actionType).toLowerCase()}:${target}:${actor}:${noteHash}`;
}

function compareIsoDesc(left = "", right = "") {
  return normalizeString(right).localeCompare(normalizeString(left));
}

function buildSessionParticipants({ statsAgents = [], registeredAgents = [] } = {}) {
  const byAgentId = new Map();
  for (const agent of Array.isArray(statsAgents) ? statsAgents : []) {
    const agentId = normalizeString(agent?.agentId || agent?.id);
    if (!agentId) continue;
    byAgentId.set(agentId, {
      ...agent,
      agentId,
      registered: false,
      source: "events",
    });
  }

  for (const agent of Array.isArray(registeredAgents) ? registeredAgents : []) {
    const agentId = normalizeString(agent?.agentId || agent?.id);
    if (!agentId) continue;
    const existing = byAgentId.get(agentId);
    if (existing) {
      byAgentId.set(agentId, {
        ...existing,
        model: existing.model || normalizeString(agent.model),
        role: normalizeString(agent.role) || existing.role,
        status: normalizeString(agent.status) || existing.status,
        registered: true,
        source: "events+registry",
        joinedAt: normalizeString(agent.joinedAt) || existing.joinedAt,
        lastActivityAt: normalizeString(agent.lastActivityAt) || existing.lastActivityAt,
        active: agent.active,
      });
      continue;
    }
    byAgentId.set(agentId, {
      agentId,
      displayName: normalizeString(agent.displayName) || agentId,
      model: normalizeString(agent.model),
      role: normalizeString(agent.role),
      status: normalizeString(agent.status),
      firstSeen: normalizeString(agent.joinedAt) || null,
      lastSeen: normalizeString(agent.lastActivityAt) || normalizeString(agent.joinedAt) || null,
      joinedAt: normalizeString(agent.joinedAt) || null,
      lastActivityAt: normalizeString(agent.lastActivityAt) || null,
      active: agent.active,
      eventCount: 0,
      activeSeconds: 0,
      tokens: 0,
      costUsd: 0,
      registered: true,
      source: "registry",
    });
  }

  return [...byAgentId.values()].sort((left, right) => {
    const eventDelta = Number(right.eventCount || 0) - Number(left.eventCount || 0);
    if (eventDelta !== 0) return eventDelta;
    return compareIsoDesc(left.lastSeen || left.lastActivityAt, right.lastSeen || right.lastActivityAt);
  });
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

function normalizeComparablePath(value) {
  return String(value || "")
    .trim()
    .replace(/\\/g, "/")
    .replace(/\/+$/g, "")
    .toLowerCase();
}

function latestSessionActivityMs(entry = {}) {
  for (const key of ["lastInteractionAt", "lastActivityAt", "createdAt"]) {
    const epoch = Date.parse(normalizeString(entry[key]));
    if (Number.isFinite(epoch)) return epoch;
  }
  return 0;
}

function remoteSessionLookupDisabled() {
  return String(process.env.SENTINELAYER_SKIP_REMOTE_SYNC || "").trim() === "1";
}

function sentiAutostartDisabled() {
  return String(process.env.SENTINELAYER_SKIP_SENTI_AUTOSTART || "").trim() === "1";
}

function buildResumeContext(candidate, { reuseWindowSeconds = 3600 } = {}) {
  if (!candidate) return null;
  const source = normalizeString(candidate._source) || "unknown";
  const lastActivityAt =
    normalizeString(candidate.lastInteractionAt) ||
    normalizeString(candidate.lastActivityAt) ||
    normalizeString(candidate.updatedAt) ||
    normalizeString(candidate.createdAt) ||
    null;
  return {
    source,
    reuseWindowSeconds,
    lastActivityAt,
    reason: `recent_${source}_session`,
  };
}

async function resolveSessionRemoteSyncState({ dashboardUrl } = {}) {
  if (remoteSessionLookupDisabled()) {
    return {
      status: "disabled",
      attempted: false,
      reason: "remote_sync_disabled",
      dashboardUrl,
    };
  }

  let storedSession = null;
  try {
    storedSession = await readStoredSession();
  } catch {
    storedSession = null;
  }
  const apiUrl =
    normalizeString(storedSession?.apiUrl) ||
    normalizeString(process.env.SENTINELAYER_API_URL) ||
    "https://api.sentinelayer.com";
  const hasToken = Boolean(
    normalizeString(storedSession?.token) || normalizeString(process.env.SENTINELAYER_TOKEN),
  );
  if (!hasToken) {
    return {
      status: "auth_required",
      attempted: false,
      reason: "not_authenticated",
      apiUrl,
      dashboardUrl,
    };
  }
  return {
    status: "background_sync_queued",
    attempted: true,
    apiUrl,
    dashboardUrl,
  };
}

function mergeResumeCandidate(existing, incoming) {
  if (!existing) return incoming;
  const existingActivity = Number(existing._activityMs || 0);
  const incomingActivity = Number(incoming._activityMs || 0);
  const preferIncomingPaths = existing._source !== "local" && incoming._source === "local";
  const base = preferIncomingPaths ? incoming : existing;
  const other = preferIncomingPaths ? existing : incoming;
  return {
    ...base,
    title: normalizeString(base.title) || normalizeString(other.title) || null,
    lastActivityAt:
      normalizeString(incoming.lastActivityAt) || normalizeString(existing.lastActivityAt) || null,
    lastInteractionAt:
      normalizeString(incoming.lastInteractionAt) || normalizeString(existing.lastInteractionAt) || null,
    _activityMs: Math.max(existingActivity, incomingActivity),
  };
}

async function findReusableSessionCandidate({
  targetPath,
  reuseWindowSeconds = 3600,
  resume = true,
  forceNew = false,
} = {}) {
  if (forceNew || resume === false) return null;
  const cutoffMs = Date.now() - reuseWindowSeconds * 1000;
  const byId = new Map();

  try {
    const active = await listActiveSessions({ targetPath });
    for (const entry of active) {
      const activityMs = latestSessionActivityMs(entry);
      if (!activityMs || activityMs < cutoffMs) continue;
      const candidate = {
        ...entry,
        _source: "local",
        _activityMs: activityMs,
      };
      byId.set(entry.sessionId, mergeResumeCandidate(byId.get(entry.sessionId), candidate));
    }
  } catch {
    /* local lookup failure is non-fatal */
  }

  if (!remoteSessionLookupDisabled()) {
    try {
      const remote = await listSessionsFromApi({
        targetPath,
        includeArchived: false,
        limit: 50,
      });
      if (remote && remote.ok) {
        const normalizedTarget = normalizeComparablePath(targetPath);
        for (const entry of remote.sessions || []) {
          const codebase = normalizeComparablePath(entry.codebasePath || entry.targetPath);
          if (!codebase || codebase !== normalizedTarget) continue;
          if (entry.archiveStatus && entry.archiveStatus !== "active") continue;
          const activityMs = latestSessionActivityMs(entry);
          if (!activityMs || activityMs < cutoffMs) continue;
          const candidate = {
            sessionId: entry.sessionId,
            createdAt: entry.createdAt,
            lastActivityAt: entry.lastActivityAt,
            expiresAt: entry.expiresAt,
            status: entry.status || "active",
            template: entry.templateName || null,
            title: entry.title || null,
            _source: "remote",
            _activityMs: activityMs,
          };
          byId.set(entry.sessionId, mergeResumeCandidate(byId.get(entry.sessionId), candidate));
        }
      }
    } catch {
      /* remote lookup failure is non-fatal */
    }
  }

  const candidates = [...byId.values()];
  candidates.sort((left, right) => Number(right._activityMs || 0) - Number(left._activityMs || 0));
  return candidates[0] || null;
}

// Verify that a session id is reachable for the active user via the API
// singleton endpoint added in API PR #483 (`GET /api/v1/sessions/{id}`).
//
// Carter's complaint: "I can't create a session from the web and still have
// it available for you guys in CLI" — the historical CLI flow assumed the
// session was created locally first, so attaching to a web/peer-created
// session left the agent guessing about access. Singleton GET resolves
// that with one round-trip and gives us metadata for friendly output.
//
// Behaviour contract:
//   - Returns `{ ok: true, source, session, status }` on success.
//   - Returns `{ ok: false, reason: "not_found", status: 404 }` when the
//     session genuinely isn't visible to the caller (404 + list fallback
//     also empty). Callers should map this to a friendly "not found" exit.
//   - Returns `{ ok: false, reason: "forbidden", status: 403 }` for explicit
//     deny (caller is authenticated but not a member).
//   - On 5xx: retries ONCE, then surfaces `{ ok: false, reason: "api_5xx" }`.
//   - On 404 from the singleton: falls back to filtering the list endpoint
//     so users on stale prod servers (pre-#483) aren't blocked. If the list
//     contains the session id we treat it as success and return that row.
//   - When `SENTINELAYER_SKIP_REMOTE_SYNC=1` (test bootstrap), short-circuits
//     to `{ ok: true, source: "skipped", session: null }` so unit tests
//     can exercise the local materialization path without a real API.
async function verifyRemoteSession(sessionId, { targetPath } = {}) {
  const normalizedSessionId = normalizeString(sessionId);
  if (!normalizedSessionId) {
    return { ok: false, reason: "invalid_session_id" };
  }
  if (remoteSessionLookupDisabled()) {
    return { ok: true, source: "skipped", session: null };
  }
  let auth;
  try {
    auth = await resolveActiveAuthSession({
      cwd: targetPath || process.cwd(),
      env: process.env,
      autoRotate: false,
    });
  } catch {
    return { ok: false, reason: "no_session" };
  }
  if (!auth || !auth.token) {
    return { ok: false, reason: "not_authenticated", status: 401 };
  }
  const apiUrl = String(auth.apiUrl || "").replace(/\/+$/, "");
  if (!apiUrl) {
    return { ok: false, reason: "no_api_url" };
  }
  const endpoint = `${apiUrl}/api/v1/sessions/${encodeURIComponent(normalizedSessionId)}`;
  const headers = { Authorization: `Bearer ${auth.token}` };
  let lastReason = "unknown";
  for (let attempt = 0; attempt < 2; attempt += 1) {
    let response;
    try {
      response = await fetch(endpoint, { method: "GET", headers });
    } catch (err) {
      lastReason = normalizeString(err?.message) || "fetch_failed";
      continue;
    }
    if (response && response.ok) {
      const body = await response.json().catch(() => ({}));
      const sessionPayload = body && body.session && typeof body.session === "object"
        ? body.session
        : body && typeof body === "object"
          ? body
          : null;
      return {
        ok: true,
        source: "singleton",
        session: sessionPayload,
        status: response.status,
      };
    }
    if (!response) {
      lastReason = "no_response";
      continue;
    }
    if (response.status === 404) {
      // Pre-#483 fallback: scan the list endpoint once for the same id.
      const listResult = await listSessionsFromApi({
        targetPath,
        includeArchived: false,
        limit: 50,
      }).catch(() => null);
      if (listResult && listResult.ok) {
        const found = (listResult.sessions || []).find(
          (entry) => normalizeString(entry?.sessionId) === normalizedSessionId,
        );
        if (found) {
          return { ok: true, source: "list_fallback", session: found, status: 200 };
        }
      }
      return { ok: false, reason: "not_found", status: 404 };
    }
    if (response.status === 403) {
      return { ok: false, reason: "forbidden", status: 403 };
    }
    if (response.status >= 500 && response.status < 600) {
      lastReason = `api_${response.status}`;
      continue; // retry once on 5xx
    }
    return { ok: false, reason: `api_${response.status}`, status: response.status };
  }
  return { ok: false, reason: lastReason };
}

function normalizeRemoteResumeStatus(session = {}) {
  return normalizeString(session?.archiveStatus || session?.status).toLowerCase();
}

function remoteStatusAllowsResume(status) {
  if (!status) return true;
  return status === "active" || status === "pending";
}

async function reconcileLocalResumeCandidate(candidate, { targetPath } = {}) {
  if (!candidate || candidate._source !== "local" || remoteSessionLookupDisabled()) {
    return { candidate, staleResume: null };
  }
  const verification = await verifyRemoteSession(candidate.sessionId, { targetPath }).catch((error) => ({
    ok: false,
    reason: normalizeString(error?.message) || "probe_failed",
  }));

  if (verification.ok) {
    const remoteStatus = normalizeRemoteResumeStatus(verification.session);
    if (remoteStatusAllowsResume(remoteStatus)) {
      return { candidate, staleResume: null };
    }
    await expireSession(candidate.sessionId, { targetPath }).catch(() => null);
    return {
      candidate: null,
      staleResume: {
        sessionId: candidate.sessionId,
        source: "remote",
        reason: "remote_not_active",
        remoteStatus,
        action: "expired_local_and_created_new",
      },
    };
  }

  if (verification.reason === "not_found" || verification.reason === "forbidden") {
    await expireSession(candidate.sessionId, { targetPath }).catch(() => null);
    return {
      candidate: null,
      staleResume: {
        sessionId: candidate.sessionId,
        source: "remote",
        reason: verification.reason,
        remoteStatus: verification.reason,
        status: verification.status || null,
        action: "expired_local_and_created_new",
      },
    };
  }

  return {
    candidate,
    staleResume: {
      sessionId: candidate.sessionId,
      source: "remote",
      reason: verification.reason || "probe_failed",
      status: verification.status || null,
      action: "kept_local_resume",
    },
  };
}

// Render an absolute ISO timestamp as a coarse "Nm ago" / "Nh ago" / "Nd ago"
// label for human-readable join output. Returns `"never"` for missing input
// and `"just now"` for sub-minute deltas.
function formatRelativeAge(isoTimestamp) {
  const epoch = Date.parse(normalizeString(isoTimestamp));
  if (!Number.isFinite(epoch)) return "never";
  const deltaMs = Date.now() - epoch;
  if (deltaMs < 60_000) return "just now";
  const minutes = Math.floor(deltaMs / 60_000);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

async function ensureLocalSessionForRemoteCommand(
  sessionId,
  { targetPath, title = "", skipRemoteProbe = false, remoteSession = null } = {},
) {
  const existing = await getSession(sessionId, { targetPath });
  if (existing) {
    if (!isSessionCacheExpired(existing)) {
      return { materialized: false, refreshed: false, session: existing };
    }
    const existingStatus = normalizeString(existing.status).toLowerCase();
    const locallyClosedByStatus = existingStatus === "expired" || existingStatus === "archived";
    let verifiedRemoteSession = remoteSession;
    let verifiedRemoteStatus = normalizeString(
      verifiedRemoteSession?.archiveStatus || verifiedRemoteSession?.status,
    ).toLowerCase();
    if (locallyClosedByStatus && !skipRemoteProbe) {
      const verification = await verifyRemoteSession(sessionId, { targetPath }).catch((error) => ({
        ok: false,
        reason: normalizeString(error?.message) || "verify_failed",
      }));
      if (!verification?.ok) {
        throw new Error(
          `Session '${sessionId}' is ${existingStatus} locally and remote verification failed (${verification?.reason || "unknown"}).`,
        );
      }
      verifiedRemoteSession = verification.session || verifiedRemoteSession;
      verifiedRemoteStatus = normalizeString(
        verifiedRemoteSession?.archiveStatus || verifiedRemoteSession?.status,
      ).toLowerCase();
    }
    if (
      locallyClosedByStatus &&
      verifiedRemoteStatus &&
      !["active", "pending"].includes(verifiedRemoteStatus)
    ) {
      throw new Error(
        `Session '${sessionId}' is ${existingStatus} locally and remote status is ${verifiedRemoteStatus}; refusing to reopen a closed session.`,
      );
    }

    let access = { accessible: Boolean(skipRemoteProbe || locallyClosedByStatus), reason: "" };
    if (!skipRemoteProbe && !locallyClosedByStatus) {
      access = await probeSessionAccess(sessionId, { targetPath }).catch((error) => ({
        accessible: false,
        reason: normalizeString(error?.message) || "probe_failed",
      }));
    }
    if (!access?.accessible) {
      throw new Error(
        `Session '${sessionId}' is expired locally and remote access failed (${access?.reason || "unknown"}).`,
      );
    }

    const refreshed = await refreshSessionCacheForRemoteActivity(sessionId, {
      targetPath,
      title: title || normalizeString(verifiedRemoteSession?.title),
      expiresAt: normalizeString(verifiedRemoteSession?.expiresAt),
      lastInteractionAt:
        normalizeString(verifiedRemoteSession?.lastInteractionAt) ||
        normalizeString(verifiedRemoteSession?.lastActivityAt) ||
        normalizeString(verifiedRemoteSession?.updatedAt) ||
        normalizeString(verifiedRemoteSession?.createdAt),
    });
    return { materialized: false, refreshed: Boolean(refreshed), session: refreshed || existing };
  }
  // `skipRemoteProbe` is set by callers that have already verified the session
  // via `verifyRemoteSession` (the singleton GET) — re-probing the legacy
  // `/events?limit=1` endpoint here would be a redundant round-trip and, for
  // tests that mock only the singleton, would spuriously 404.
  if (!skipRemoteProbe) {
    const access = await probeSessionAccess(sessionId, { targetPath }).catch((error) => ({
      accessible: false,
      reason: normalizeString(error?.message) || "probe_failed",
    }));
    if (!access?.accessible) {
      throw new Error(
        `Session '${sessionId}' was not found locally and remote access failed (${access?.reason || "unknown"}).`,
      );
    }
  }
  const created = await createSession({
    targetPath,
    sessionId,
    title: normalizeString(title) || `remote-${String(sessionId).slice(0, 8)}`,
    createdAt: normalizeString(remoteSession?.createdAt),
    expiresAt: normalizeString(remoteSession?.expiresAt),
    lastInteractionAt:
      normalizeString(remoteSession?.lastInteractionAt) ||
      normalizeString(remoteSession?.lastActivityAt) ||
      normalizeString(remoteSession?.updatedAt) ||
      normalizeString(remoteSession?.createdAt),
  });
  return { materialized: true, refreshed: false, session: created };
}

async function ensureWorkspaceSession({
  targetPath,
  ttlSeconds = DEFAULT_TTL_SECONDS,
  template = null,
  title = "",
  resume = true,
  forceNew = false,
  reuseWindowSeconds = 3600,
} = {}) {
  const titleArg = normalizeString(title);
  const fallbackTitle = deriveSessionTitle(targetPath);
  const startedAt = Date.now();
  let resumedCandidate = await findReusableSessionCandidate({
    targetPath,
    reuseWindowSeconds,
    resume,
    forceNew,
  });
  const reconciliation = await reconcileLocalResumeCandidate(resumedCandidate, { targetPath });
  resumedCandidate = reconciliation.candidate;
  const staleResume = reconciliation.staleResume;
  let created;
  const resumeTitle =
    titleArg || normalizeString(resumedCandidate?.title) || fallbackTitle;

  if (resumedCandidate) {
    if (resumedCandidate._source === "remote" && !resumedCandidate.sessionDir) {
      created = await createSession({
        targetPath,
        ttlSeconds,
        sessionId: resumedCandidate.sessionId,
        title: resumeTitle,
        createdAt: resumedCandidate.createdAt,
        expiresAt: resumedCandidate.expiresAt,
        lastInteractionAt:
          resumedCandidate.lastInteractionAt ||
          resumedCandidate.lastActivityAt ||
          resumedCandidate.createdAt,
      });
    } else {
      created = {
        sessionId: resumedCandidate.sessionId,
        sessionDir: resumedCandidate.sessionDir || null,
        metadataPath: resumedCandidate.metadataPath || null,
        streamPath: resumedCandidate.streamPath || null,
        createdAt: resumedCandidate.createdAt,
        updatedAt: resumedCandidate.updatedAt || null,
        lastInteractionAt: resumedCandidate.lastInteractionAt || null,
        expiresAt: resumedCandidate.expiresAt,
        elapsedTimer: resumedCandidate.elapsedTimer || 0,
        renewalCount: resumedCandidate.renewalCount || 0,
        status: resumedCandidate.status || "active",
        template: resumedCandidate.template || null,
        title: normalizeString(resumedCandidate.title) || null,
        codebaseContext: resumedCandidate.codebaseContext || null,
      };
      if (resumeTitle && resumeTitle !== created.title) {
        const updated = await updateSessionTitle(created.sessionId, {
          targetPath,
          title: resumeTitle,
        }).catch(() => null);
        if (updated) {
          created = {
            ...created,
            ...updated,
          };
        }
      }
    }
  } else {
    created = await createSession({
      targetPath,
      ttlSeconds,
      template,
      title: titleArg || fallbackTitle,
    });
  }

  const effectiveTitle = titleArg || normalizeString(created.title) || fallbackTitle;
  const titleAuto = !titleArg && !resumedCandidate;
  const pendingTitleSync = Boolean(created.remoteTitleSync?.pending && effectiveTitle);
  const shouldPushTitle = Boolean(
    titleArg ||
      titleAuto ||
      pendingTitleSync ||
      (resumedCandidate && effectiveTitle && !normalizeString(resumedCandidate.title))
  );
  let titleSync = null;
  if (shouldPushTitle) {
    titleSync = await pushSessionTitleToApi(created.sessionId, effectiveTitle, { targetPath });
  }

  return {
    created: {
      ...created,
      title: effectiveTitle || null,
      resumed: Boolean(resumedCandidate),
    },
    resumedCandidate,
    durationMs: Date.now() - startedAt,
    title: effectiveTitle || null,
    titleAuto,
    titleSync,
    staleResume,
  };
}

function normalizeAgentId(value, fallbackValue = "cli-user") {
  const normalized = normalizeString(value)
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return normalized || fallbackValue;
}

// Preserve the literal default identity for `session say`. This command is
// often used by agents as a low-friction relay; silently rewriting the default
// `cli-user` to the authenticated human makes a forgotten --agent flag look
// like the workspace owner authored the message.
export function resolveSessionSayAgentId(value) {
  return normalizeAgentId(value, "cli-user");
}

async function defaultAgentId(value, _targetPath) {
  return resolveSessionSayAgentId(value);
}

async function resolveSessionAgentEnvelope(
  sessionId,
  agentId,
  {
    targetPath = process.cwd(),
    model = "",
    role = "",
    displayName = "",
    clientKind = "cli",
  } = {}
) {
  const normalizedAgentId = normalizeAgentId(agentId, "cli-user");
  let registeredAgent = null;
  try {
    const agents = await listAgents(sessionId, { targetPath, includeInactive: true });
    registeredAgent = agents.find(
      (agent) => normalizeString(agent.agentId).toLowerCase() === normalizedAgentId.toLowerCase(),
    );
  } catch {
    registeredAgent = null;
  }

  const resolvedModel = normalizeString(model) || normalizeString(registeredAgent?.model);
  const resolvedRole = normalizeString(role) || normalizeString(registeredAgent?.role);
  const resolvedDisplayName =
    normalizeString(displayName) || normalizeString(registeredAgent?.displayName);
  const envelope = {
    id: normalizedAgentId,
    model: resolvedModel || undefined,
    role: resolvedRole || undefined,
    displayName: resolvedDisplayName || undefined,
    clientKind: normalizeString(clientKind) || undefined,
  };
  return Object.fromEntries(Object.entries(envelope).filter(([, value]) => value !== undefined));
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
  if (type === "session_action" || type === "session_reply" || type === "session_reaction") {
    const actionType = normalizeString(payload.actionType) || type.replace(/^session_/, "");
    const targetSequence = Number(payload.targetSequenceId || 0);
    const target = Number.isFinite(targetSequence) && targetSequence > 0
      ? `#${Math.floor(targetSequence)}`
      : normalizeString(payload.targetCursor) || "target";
    const note = normalizeString(payload.note || payload.message || "");
    const suffix = note && note !== `${actionType} ${target}` ? `: ${note}` : "";
    return `${ts} ${agentId} ${type} ${actionType} ${target}${suffix}`;
  }
  const message = normalizeString(payload.message || payload.response || payload.alert || payload.reason || "");
  if (message) {
    return `${ts} ${agentId} ${type}: ${message}`;
  }
  return `${ts} ${agentId} ${type}`;
}

function checkpointSequenceRange(checkpoint = {}) {
  const start = Number(checkpoint.startSequence || 0);
  const end = Number(checkpoint.endSequence || 0);
  if (Number.isFinite(start) && start > 0 && Number.isFinite(end) && end > 0) {
    return `#${Math.floor(start)}-${Math.floor(end)}`;
  }
  if (Number.isFinite(start) && start > 0) {
    return `#${Math.floor(start)}`;
  }
  return "anchor pending";
}

function checkpointGradeLabel(checkpoint = {}) {
  const grade = normalizeString(checkpoint.grade || checkpoint.gradeLetter || checkpoint.grade_letter).toUpperCase();
  if (!["A", "B", "C", "D", "F"].includes(grade)) {
    return "";
  }
  const score = Number(checkpoint.gradeScore ?? checkpoint.grade_score);
  const scoreLabel = Number.isFinite(score) ? ` ${Math.max(0, Math.min(100, Math.floor(score)))}/100` : "";
  const rawReasons = Array.isArray(checkpoint.gradeReasons)
    ? checkpoint.gradeReasons
    : Array.isArray(checkpoint.grade_reasons)
      ? checkpoint.grade_reasons
      : [];
  const reasons = rawReasons
    .map((reason) => normalizeString(reason?.message || reason?.code || reason))
    .filter(Boolean)
    .slice(0, 2);
  const reasonLabel = reasons.length ? `: ${reasons.join("; ")}` : "";
  return ` completeness ${grade}${scoreLabel}${reasonLabel}`;
}

function checkpointSummarySections(checkpoint = {}) {
  const sections = checkpoint.summarySections || checkpoint.summary_sections;
  return sections && typeof sections === "object" && !Array.isArray(sections) ? sections : null;
}

function normalizeCheckpointTextItems(value, limit = 3) {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .map((item) => normalizeString(item))
    .filter(Boolean)
    .slice(0, limit);
}

function formatCheckpointSectionPreview(checkpoint = {}) {
  const sections = checkpointSummarySections(checkpoint);
  if (!sections) {
    return "";
  }
  const parts = [];
  const work = normalizeCheckpointTextItems(sections.workCompleted || sections.work_completed, 1)[0];
  if (work) {
    parts.push(`work: ${work}`);
  }
  const agents = Array.isArray(sections.agentContributions)
    ? sections.agentContributions
    : Array.isArray(sections.agent_contributions)
      ? sections.agent_contributions
      : [];
  const agentLabels = agents
    .map((item) => {
      const agentId = normalizeString(item?.agentId || item?.agent_id);
      const summary = normalizeString(item?.summary);
      return agentId && summary ? `${agentId}: ${summary}` : "";
    })
    .filter(Boolean)
    .slice(0, 2);
  if (agentLabels.length) {
    parts.push(`agents: ${agentLabels.join("; ")}`);
  }
  const evidence = Array.isArray(sections.evidence) ? sections.evidence : [];
  const evidenceLabels = evidence
    .map((item) => normalizeString(item?.label || item?.value))
    .filter(Boolean)
    .slice(0, 3);
  if (evidenceLabels.length) {
    parts.push(`evidence: ${evidenceLabels.join(", ")}`);
  }
  const risks = normalizeCheckpointTextItems(sections.risks, 1);
  if (risks.length) {
    parts.push(`risks: ${risks.join("; ")}`);
  }
  const nextSteps = normalizeCheckpointTextItems(sections.nextSteps || sections.next_steps, 1);
  if (nextSteps.length) {
    parts.push(`next: ${nextSteps.join("; ")}`);
  }
  return parts.length ? ` | ${parts.join(" | ")}` : "";
}

export function formatCheckpointLine(checkpoint = {}) {
  const id = normalizeString(checkpoint.checkpointId) || "checkpoint";
  const kind = normalizeString(checkpoint.kind) || "summary";
  const title = normalizeString(checkpoint.title) || "Untitled checkpoint";
  const byline = normalizeString(checkpoint.createdByAgentId || checkpoint.createdBy);
  const by = byline ? ` by ${byline}` : "";
  return `${checkpointSequenceRange(checkpoint)} ${id} [${kind}] ${title}${by}${checkpointGradeLabel(checkpoint)}${formatCheckpointSectionPreview(checkpoint)}`;
}

async function readCheckpointSummaryOption(options = {}, { targetPath } = {}) {
  const inlineSummary = normalizeString(options.summary);
  const summaryFile = normalizeString(options.summaryFile);
  if (inlineSummary && summaryFile) {
    throw new Error("Use either --summary or --summary-file, not both.");
  }
  if (summaryFile) {
    const resolved = path.resolve(targetPath || process.cwd(), summaryFile);
    return fsp.readFile(resolved, "utf-8");
  }
  return inlineSummary;
}

async function hydrateAfterCheckpointMutation(sessionId, { targetPath } = {}) {
  return hydrateSessionFromRemote({
    sessionId,
    targetPath,
    probeOpenCircuit: false,
    eventPageLimit: 200,
    maxEventPages: 5,
  }).catch((error) => ({
    ok: false,
    reason: error instanceof Error ? error.message : "hydrate_failed",
  }));
}

async function hydrateJoinBriefingContext(sessionId, { targetPath, limit = 100 } = {}) {
  const normalizedLimit = Math.max(1, Math.min(200, parsePositiveInteger(limit, "limit", 100)));
  try {
    const remoteTail = await pollSessionEventsBefore(sessionId, {
      targetPath,
      limit: normalizedLimit,
      timeoutMs: 15_000,
      forceCircuitProbe: true,
    });
    if (!remoteTail?.ok) {
      return {
        ok: false,
        reason: normalizeString(remoteTail?.reason) || "remote_tail_unavailable",
        remoteEvents: 0,
        appended: 0,
        skipped: 0,
        failed: 0,
      };
    }
    const appended = await appendMissingRemoteEvents(sessionId, remoteTail.events, {
      targetPath,
    });
    return {
      ok: true,
      reason: "",
      remoteEvents: Array.isArray(remoteTail.events) ? remoteTail.events.length : 0,
      appended: appended.appended,
      skipped: appended.skipped,
      failed: appended.failed,
      cursor: remoteTail.cursor || null,
      beforeSequence: remoteTail.beforeSequence || null,
    };
  } catch (error) {
    return {
      ok: false,
      reason: normalizeString(error?.message) || "join_context_hydrate_failed",
      remoteEvents: 0,
      appended: 0,
      skipped: 0,
      failed: 0,
    };
  }
}

async function appendMissingRemoteEvents(sessionId, remoteEvents = [], { targetPath } = {}) {
  const events = Array.isArray(remoteEvents) ? remoteEvents : [];
  if (events.length === 0) {
    return {
      appended: 0,
      skipped: 0,
      failed: 0,
    };
  }
  const knownKeys = new Set();
  const localEvents = await readStream(sessionId, {
    targetPath,
    tail: 0,
  });
  for (const event of localEvents) {
    addSessionEventIdentityKeys(knownKeys, event);
  }

  let appended = 0;
  let skipped = 0;
  let failed = 0;
  for (const event of events) {
    if (sessionEventHasKnownIdentity(event, knownKeys)) {
      skipped += 1;
      continue;
    }
    try {
      const persisted = await appendToStream(sessionId, event, {
        targetPath,
        syncRemote: false,
      });
      addSessionEventIdentityKeys(knownKeys, persisted);
      appended += 1;
    } catch {
      addSessionEventIdentityKeys(knownKeys, event);
      failed += 1;
    }
  }
  return {
    appended,
    skipped,
    failed,
  };
}

function formatTemplateLaunchLine(slot = {}) {
  const terminal = Number(slot.terminal || 0);
  const role = normalizeString(slot.role) || "agent";
  const command = normalizeString(slot.command);
  return `Terminal ${terminal} (${role}): ${command}`;
}

function formatApiError(error) {
  if (!(error instanceof SentinelayerApiError)) {
    return error instanceof Error ? error.message : String(error || "Unknown API error");
  }
  const requestId = error.requestId ? ` request_id=${error.requestId}` : "";
  return `${error.message} [${error.code}] status=${error.status}${requestId}`;
}

async function resolveAdminApiSession({ targetPath, explicitApiUrl }) {
  const session = await resolveActiveAuthSession({
    cwd: targetPath,
    env: process.env,
    explicitApiUrl,
    autoRotate: true,
  });
  if (!session || !session.token) {
    throw new Error(`No active auth token found. Run \`${authLoginHint()}\` first.`);
  }
  return session;
}

async function postAdminSessionMutation({
  session,
  pathSuffix,
  operationName,
  body = {},
  headers = {},
} = {}) {
  const apiUrl = normalizeString(session?.apiUrl).replace(/\/+$/, "");
  if (!apiUrl) {
    throw new Error("Missing apiUrl for admin session mutation.");
  }
  return requestJsonMutation(`${apiUrl}${pathSuffix}`, {
    method: "POST",
    operationName,
    headers: {
      Authorization: `Bearer ${normalizeString(session.token)}`,
      ...headers,
    },
    body,
  });
}

async function emitLocalAdminKillEvent(
  sessionId,
  { targetPath, reason, scope, apiResult, actorId = "admin" } = {}
) {
  const session = await getSession(sessionId, { targetPath });
  if (!session) {
    return null;
  }
  const event = createAgentEvent({
    event: "session_admin_kill",
    agentId: actorId,
    agentModel: "api-admin",
    sessionId,
    payload: {
      scope: normalizeString(scope) || "session",
      reason: normalizeString(reason) || "admin_kill",
      result: apiResult && typeof apiResult === "object" ? apiResult : null,
    },
  });
  return appendToStream(sessionId, event, { targetPath });
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
    .description(
      "Start (or resume) a persistent session. By default reuses the most recent active session for this workspace; pass --force-new to always mint a fresh id.",
    )
    .option("--path <path>", "Workspace path for the session", ".")
    .option("--title <title>", "Human-readable label (shown in web sidebar + transcript)")
    .option(
      "--template <name>",
      "Optional quick-start template (code-review, security-audit, e2e-test, incident-response, standup)"
    )
    .option(
      "--ttl-seconds <seconds>",
      `Session time-to-live in seconds (default ${DEFAULT_TTL_SECONDS}; template defaults override when omitted)`
    )
    .option(
      "--force-new",
      "Always create a new session even if a recent active one exists for this workspace",
    )
    .option(
      "--resume",
      "Reuse the most recent active session for this workspace when one is inside the reuse window",
      true,
    )
    .option(
      "--no-resume",
      "Disable automatic resume and mint a new session unless --force-new is also present",
    )
    .option(
      "--reuse-window-seconds <seconds>",
      "Window in which an existing active session for this workspace will be reused (default 3600 = 1h)",
      "3600",
    )
    .option("--json", "Emit machine-readable output")
    .action(async (options, command) => {
      const targetPath = path.resolve(process.cwd(), String(options.path || "."));
      const template = resolveSessionTemplate(options.template);
      const templateDefaultTtlSeconds =
        template && Number.isFinite(Number(template.ttlHours))
          ? Math.max(1, Math.floor(Number(template.ttlHours))) * 60 * 60
          : DEFAULT_TTL_SECONDS;
      const ttlSeconds = parsePositiveInteger(
        options.ttlSeconds,
        "ttl-seconds",
        templateDefaultTtlSeconds
      );
      const reuseWindowSeconds = parsePositiveInteger(
        options.reuseWindowSeconds,
        "reuse-window-seconds",
        3600,
      );
      const titleArg = normalizeString(options.title);
      const ensured = await ensureWorkspaceSession({
        targetPath,
        ttlSeconds,
        template,
        title: titleArg,
        resume: options.resume !== false,
        forceNew: Boolean(options.forceNew),
        reuseWindowSeconds,
      });
      const created = ensured.created;
      const resumed = Boolean(ensured.resumedCandidate);
      const durationMs = ensured.durationMs;
      const launchPlan = template ? buildTemplateLaunchPlan(created.sessionId, template) : [];
      const dashboardUrl = buildDashboardUrl(created.sessionId);
      const effectiveTitle = ensured.title;
      const cliCommand = preferredCliCommand();
      const resumeContext = buildResumeContext(ensured.resumedCandidate, { reuseWindowSeconds });
      const remoteSync = await resolveSessionRemoteSyncState({ dashboardUrl });

      const payload = {
        command: "session start",
        targetPath,
        durationMs,
        sessionId: created.sessionId,
        sessionDir: created.sessionDir,
        metadataPath: created.metadataPath,
        streamPath: created.streamPath,
        createdAt: created.createdAt,
        updatedAt: created.updatedAt,
        expiresAt: created.expiresAt,
        lastInteractionAt: created.lastInteractionAt,
        ttlSeconds,
        elapsedTimer: created.elapsedTimer,
        renewalCount: created.renewalCount,
        status: created.status,
        template: created.template,
        launchPlan,
        dashboardUrl,
        resumed,
        resumeSource: resumeContext?.source || null,
        resumeContext: resumeContext || undefined,
        staleResume: ensured.staleResume || undefined,
        remoteSync,
        title: effectiveTitle || null,
        titleAuto: Boolean(ensured.titleAuto),
        titleSync: ensured.titleSync || undefined,
      };

      // Best-effort admin visibility sync. Session creation remains local-first.
      if (remoteSync.attempted) {
        void syncSessionMetadataToApi(created.sessionId, {
          targetPath,
          sessionId: created.sessionId,
          status: created.status,
          createdAt: created.createdAt,
          expiresAt: created.expiresAt,
          title: effectiveTitle || null,
          ttlSeconds,
          template: created.template,
          codebaseContext: created.codebaseContext,
        }).catch(() => {});
      }

      // Auto-start the Senti orchestrator daemon. Without this, every
      // session ran with `Senti actions: 1` (just the welcome alert)
      // because nothing kicked the daemon ticking — agents joining
      // never got greeted, mentions never routed, recaps never fired.
      // Best-effort + non-blocking: the daemon registers itself in an
      // in-memory map keyed by (sessionId, targetPath) and tolerates
      // being started for an already-active session (returns the
      // existing handle). If the daemon fails to start (unauth env,
      // missing model proxy), the session keeps working — Senti just
      // stays quiet, same as before this change.
      if (!sentiAutostartDisabled()) {
        void startSenti(created.sessionId, { targetPath }).catch(() => {});
      }

      if (shouldEmitJson(options, command)) {
        console.log(JSON.stringify(payload, null, 2));
        return;
      }

      if (template) {
        console.log(
          resumed
            ? `Resumed session ${created.sessionId} (template: ${template.id})`
            : `Session ${created.sessionId} created (template: ${template.id})`,
        );
        if (launchPlan.length > 0 && !resumed) {
          console.log("");
          console.log("Launch your agents:");
          for (const slot of launchPlan) {
            console.log(formatTemplateLaunchLine(slot));
          }
        }
        console.log("");
        console.log(`Dashboard: ${dashboardUrl}`);
        return;
      }

      console.log(pc.bold(resumed ? "Session resumed" : "Session created"));
      console.log(pc.gray(`Session: ${created.sessionId}`));
      if (titleArg) console.log(pc.gray(`Title: ${titleArg}`));
      if (resumeContext) {
        console.log(
          pc.gray(
            `Resume source: ${resumeContext.source} (last activity ${resumeContext.lastActivityAt || "unknown"}; window ${reuseWindowSeconds}s)`,
          ),
        );
      }
      if (ensured.staleResume?.action === "expired_local_and_created_new") {
        console.log(
          pc.yellow(
            `Skipped stale local session ${ensured.staleResume.sessionId}: remote status is ${ensured.staleResume.remoteStatus || ensured.staleResume.reason}.`,
          ),
        );
      }
      if (created.streamPath) console.log(pc.gray(`Stream: ${created.streamPath}`));
      console.log(pc.gray(`${resumed ? "Resumed" : "Created"} in ${durationMs}ms`));
      console.log(
        `status=${created.status} created_at=${created.createdAt} expires_at=${created.expiresAt} ttl_seconds=${ttlSeconds}`,
      );
      if (remoteSync.status === "auth_required") {
        console.log(
          pc.yellow(
            `Dashboard sync pending: run \`${authLoginHint()}\`, then rerun \`${cliCommand} session start\` in this workspace to publish local metadata.`,
          ),
        );
      } else if (remoteSync.status === "disabled") {
        console.log(pc.gray("Dashboard sync disabled by SENTINELAYER_SKIP_REMOTE_SYNC=1."));
      }
      if (!resumed) {
        console.log(
          pc.gray(
            `Tip: subsequent \`${cliCommand} session start\` in this workspace within an hour will resume this session. Pass --force-new to override.`,
          ),
        );
      }
    });

  session
    .command("continue")
    .description("Alias for `session start --resume` — resume the most recent active session for this workspace, or create one if none exists.")
    .option("--path <path>", "Workspace path for the session", ".")
    .option("--title <title>", "Title applied if a new session is created")
    .option("--json", "Emit machine-readable output")
    .action(async (options, command) => {
      // Delegate to session start without --force-new. Commander parses
      // the args for us via the parent action; here we just shell out.
      const args = ["session", "start", "--path", String(options.path || ".")];
      if (options.title) args.push("--title", String(options.title));
      if (shouldEmitJson(options, command)) args.push("--json");
      await program.parseAsync(args, { from: "user" });
    });

  session
    .command("ensure")
    .description("Join or create the canonical session for this workspace and emit JSON")
    .option("--path <path>", "Workspace path for the session", ".")
    .option(
      "--session <id>",
      "Attach to an explicit remote-created session id (verifies + materializes local state, like `session join`).",
    )
    .option("--title <title>", "Title applied if a new or unnamed resumed session needs one")
    .option(
      "--ttl-seconds <seconds>",
      `Session time-to-live in seconds when a new session is minted (default ${DEFAULT_TTL_SECONDS})`
    )
    .option(
      "--force-new",
      "Always create a new session even if a recent active one exists for this workspace",
    )
    .option(
      "--resume",
      "Reuse the most recent active session for this workspace when one is inside the reuse window",
      true,
    )
    .option("--no-resume", "Disable automatic resume and mint a new session")
    .option(
      "--reuse-window-seconds <seconds>",
      "Window in which an existing active session for this workspace will be reused (default 3600 = 1h)",
      "3600",
    )
    .option("--json", "Emit machine-readable output (default for this command)")
    .action(async (options) => {
      const targetPath = path.resolve(process.cwd(), String(options.path || "."));
      const ttlSeconds = parsePositiveInteger(
        options.ttlSeconds,
        "ttl-seconds",
        DEFAULT_TTL_SECONDS,
      );
      const reuseWindowSeconds = parsePositiveInteger(
        options.reuseWindowSeconds,
        "reuse-window-seconds",
        3600,
      );

      // --session <id> short-circuit: behave like `session join`. This is the
      // path Carter cared about — "create on web, share id, attach in CLI".
      // We verify the session is reachable, materialize a minimal local
      // NDJSON if missing, and emit the same `{sessionId, title, resumed}`
      // contract callers already consume from `ensure`.
      const explicitSessionId = normalizeString(options.session);
      if (explicitSessionId) {
        const verification = await verifyRemoteSession(explicitSessionId, { targetPath });
        if (!verification.ok) {
          if (verification.status === 404 || verification.reason === "not_found") {
            throw new Error(
              `Session not found, archived, or not accessible to your account. (id=${explicitSessionId})`,
            );
          }
          if (verification.status === 403 || verification.reason === "forbidden") {
            throw new Error(
              `Session '${explicitSessionId}' exists but your account is not a member.`,
            );
          }
          if (verification.reason === "not_authenticated") {
            throw new Error(`Not authenticated. Run \`${authLoginHint()}\` first.`);
          }
          throw new Error(
            `Failed to verify session '${explicitSessionId}' (${verification.reason || "unknown"}). Try again in a moment.`,
          );
        }
        const remoteSession = verification.session || {};
        const localSession = await ensureLocalSessionForRemoteCommand(explicitSessionId, {
          targetPath,
          title: normalizeString(remoteSession.title),
          skipRemoteProbe: true,
          remoteSession,
        });
        const payload = {
          command: "session ensure",
          targetPath,
          sessionId: explicitSessionId,
          title: normalizeString(remoteSession.title) || localSession?.session?.title || null,
          resumed: true,
          attached: true,
          materializedLocalSession: localSession.materialized,
          refreshedLocalSession: Boolean(localSession.refreshed),
          verificationSource: verification.source,
          dashboardUrl: buildDashboardUrl(explicitSessionId),
        };
        console.log(JSON.stringify(payload, null, 2));
        return;
      }

      const ensured = await ensureWorkspaceSession({
        targetPath,
        ttlSeconds,
        title: normalizeString(options.title),
        resume: options.resume !== false,
        forceNew: Boolean(options.forceNew),
        reuseWindowSeconds,
      });
      const dashboardUrl = buildDashboardUrl(ensured.created.sessionId);
      const resumeContext = buildResumeContext(ensured.resumedCandidate, { reuseWindowSeconds });
      const remoteSync = await resolveSessionRemoteSyncState({ dashboardUrl });
      const payload = {
        command: "session ensure",
        targetPath,
        sessionId: ensured.created.sessionId,
        title: ensured.title || null,
        resumed: Boolean(ensured.resumedCandidate),
        resumeSource: resumeContext?.source || null,
        resumeContext: resumeContext || undefined,
        staleResume: ensured.staleResume || undefined,
        dashboardUrl,
        remoteSync,
        titleSync: ensured.titleSync || undefined,
      };
      console.log(JSON.stringify(payload, null, 2));
    });

  session
    .command("set-title <sessionId> <title>")
    .description("Set the human-readable title on a session (visible in web sidebar + transcript).")
    .option("--path <path>", "Workspace path for the session", ".")
    .option("--json", "Emit machine-readable output")
    .action(async (sessionId, title, options, command) => {
      const normalizedSessionId = normalizeString(sessionId);
      if (!normalizedSessionId) throw new Error("session id is required.");
      const normalizedTitle = normalizeString(title);
      if (!normalizedTitle) throw new Error("title is required.");
      const targetPath = path.resolve(process.cwd(), String(options.path || "."));
      const session = await resolveActiveAuthSession({
        cwd: targetPath,
        env: process.env,
        autoRotate: false,
      });
      if (!session?.token || !session?.apiUrl) {
        throw new Error(`Not authenticated. Run \`${authLoginHint()}\` first.`);
      }
      const apiUrl = String(session.apiUrl).replace(/\/+$/, "");
      const result = await requestJsonMutation(
        `${apiUrl}/api/v1/sessions/${encodeURIComponent(normalizedSessionId)}/title`,
        {
          method: "POST",
          operationName: "session.set_title",
          headers: { Authorization: `Bearer ${session.token}` },
          body: { title: normalizedTitle },
        },
      );
      const localUpdated = await updateSessionTitle(normalizedSessionId, {
        targetPath,
        title: normalizedTitle,
      }).catch(() => null);
      const payload = {
        command: "session set-title",
        sessionId: normalizedSessionId,
        title: normalizedTitle,
        localUpdated: Boolean(localUpdated),
        result,
      };
      if (shouldEmitJson(options, command)) {
        console.log(JSON.stringify(payload, null, 2));
        return;
      }
      console.log(pc.bold(`Title set on ${normalizedSessionId}`));
      console.log(pc.gray(`title=${normalizedTitle}`));
    });

  session
    .command("cleanup")
    .description("Bulk-archive empty stale sessions on the SentinelLayer dashboard. Targets sessions with ≤1 events older than --cutoff-minutes.")
    .option("--cutoff-minutes <n>", "Age threshold in minutes (default 60)", "60")
    .option("--max-events <n>", "Max events to still treat as empty (default 1)", "1")
    .option("--apply", "Actually archive (default is dry-run)")
    .option("--path <path>", "Workspace path", ".")
    .option("--json", "Emit machine-readable output")
    .action(async (options, command) => {
      const targetPath = path.resolve(process.cwd(), String(options.path || "."));
      const cutoffMinutes = parsePositiveInteger(options.cutoffMinutes, "cutoff-minutes", 60);
      const maxEvents = parsePositiveInteger(options.maxEvents, "max-events", 1);
      const dryRun = !options.apply;
      const session = await resolveActiveAuthSession({
        cwd: targetPath,
        env: process.env,
        autoRotate: false,
      });
      if (!session?.token || !session?.apiUrl) {
        throw new Error(`Not authenticated. Run \`${authLoginHint()}\` first.`);
      }
      const apiUrl = String(session.apiUrl).replace(/\/+$/, "");
      const result = await requestJsonMutation(
        `${apiUrl}/api/v1/sessions/sweep`,
        {
          method: "POST",
          operationName: "session.sweep_empty",
          headers: { Authorization: `Bearer ${session.token}` },
          body: {
            cutoffMinutes,
            maxEvents,
            dryRun,
          },
        },
      );
      const payload = {
        command: "session cleanup",
        dryRun,
        cutoffMinutes,
        maxEvents,
        result,
      };
      if (shouldEmitJson(options, command)) {
        console.log(JSON.stringify(payload, null, 2));
        return;
      }
      const scanned = result?.scanned || 0;
      const archived = result?.archived || 0;
      console.log(pc.bold(dryRun ? "Cleanup dry-run" : "Cleanup applied"));
      console.log(
        pc.gray(`scanned=${scanned} archived=${archived} cutoff=${cutoffMinutes}m max-events=${maxEvents}`),
      );
      if (dryRun && scanned > 0) {
        console.log(pc.gray(`Re-run with --apply to archive these ${scanned} sessions.`));
      }
    });

  session
    .command("templates")
    .description("List available session quick-start templates")
    .option("--json", "Emit machine-readable output")
    .action(async (options, command) => {
      const registry = getTemplateRegistry();
      const payload = {
        command: "session templates",
        ...registry,
      };
      if (shouldEmitJson(options, command)) {
        console.log(JSON.stringify(payload, null, 2));
        return;
      }
      console.log(`Session templates (registry ${registry.registryVersion}):`);
      for (const template of registry.templates) {
        console.log(`- ${template.id}: ${template.description}`);
      }
    });

  session
    .command("join <sessionId>")
    .description(
      "Attach to a remote-created session for posting and listening, materializing minimal local state on demand.",
    )
    .option("--name <name>", "Agent display name (legacy alias for --agent)")
    .option(
      "--agent <id>",
      "Granted agent id to emit an agent_join event as. Behaves like post-agent for human/placeholder ids — those are recorded in the local registry only.",
    )
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

      // PR #483 contract: verify the session exists and the caller has access
      // BEFORE materializing local cache state. Without this we'd silently
      // create a phantom local NDJSON for a session that's archived or owned
      // by another tenant — which is the bug Carter reported when asking for
      // a clean "share an id from web → join in CLI" flow.
      const verification = await verifyRemoteSession(normalizedSessionId, { targetPath });
      if (!verification.ok) {
        if (verification.status === 404 || verification.reason === "not_found") {
          throw new Error(
            `Session not found, archived, or not accessible to your account. (id=${normalizedSessionId})`,
          );
        }
        if (verification.status === 403 || verification.reason === "forbidden") {
          throw new Error(
            `Session '${normalizedSessionId}' exists but your account is not a member.`,
          );
        }
        if (verification.reason === "not_authenticated") {
          throw new Error(`Not authenticated. Run \`${authLoginHint()}\` first.`);
        }
        throw new Error(
          `Failed to verify session '${normalizedSessionId}' (${verification.reason || "unknown"}). Try again in a moment.`,
        );
      }

      const remoteSession = verification.session || {};
      const localSession = await ensureLocalSessionForRemoteCommand(normalizedSessionId, {
        targetPath,
        title: normalizeString(remoteSession.title),
        skipRemoteProbe: true,
        remoteSession,
      });
      const joinHydration = await hydrateJoinBriefingContext(normalizedSessionId, {
        targetPath,
      });

      const explicitAgent = normalizeString(options.agent);
      const agentSeed = explicitAgent || normalizeString(options.name);
      const resolvedAgentId = await defaultAgentId(agentSeed, targetPath);
      const role = normalizeString(options.role) || "coder";
      const model = normalizeString(options.model) || "cli";

      // `registerAgent` already writes the canonical `agent_join` event to the
      // local NDJSON and best-effort relays it to /events via appendToStream
      // → syncSessionEventToApi. That gives us the exact `post-agent` parity
      // the spec calls for when `--agent <granted>` is provided. We don't
      // double-emit; we just record whether the explicit agent path was used
      // so the JSON output can advertise it to callers (and tests).
      const joined = await registerAgent(normalizedSessionId, {
        targetPath,
        agentId: resolvedAgentId,
        model,
        role,
        trackProcessExit: false,
        awaitRemoteSync: Boolean(explicitAgent),
      });
      const agentJoinRelayed =
        Boolean(explicitAgent) &&
        Boolean(resolvedAgentId) &&
        resolvedAgentId !== "cli-user" &&
        resolvedAgentId !== "unknown" &&
        !resolvedAgentId.startsWith("human-");

      const eventCount = Number(remoteSession.eventCount ?? remoteSession.events ?? 0);
      const agents = Array.isArray(remoteSession.agents) ? remoteSession.agents : [];
      const agentCount = Number(remoteSession.agentCount ?? agents.length ?? 0);
      const lastActivityIso =
        normalizeString(remoteSession.lastInteractionAt) ||
        normalizeString(remoteSession.lastActivityAt) ||
        normalizeString(remoteSession.updatedAt) ||
        normalizeString(remoteSession.createdAt) ||
        "";
      const remoteTitle = normalizeString(remoteSession.title);

      const payload = {
        command: "session join",
        joined: true,
        targetPath,
        sessionId: normalizedSessionId,
        title: remoteTitle || null,
        agentId: joined.agentId,
        role: joined.role,
        model: joined.model,
        status: joined.status,
        joinedAt: joined.joinedAt,
        materializedLocalSession: localSession.materialized,
        refreshedLocalSession: Boolean(localSession.refreshed),
        verificationSource: verification.source,
        joinHydration,
        eventCount: Number.isFinite(eventCount) ? eventCount : 0,
        agentCount: Number.isFinite(agentCount) ? agentCount : 0,
        lastActivityAt: lastActivityIso || null,
        agentJoinRelayed,
      };
      if (shouldEmitJson(options, command)) {
        console.log(JSON.stringify(payload, null, 2));
        return;
      }
      const titleLabel = remoteTitle ? `"${remoteTitle}"` : "(untitled)";
      const ageLabel = lastActivityIso ? formatRelativeAge(lastActivityIso) : "never";
      console.log(
        pc.bold(
          `Joined session ${titleLabel} (${normalizedSessionId}) — ${payload.eventCount} events, ${payload.agentCount} agents, last activity ${ageLabel}`,
        ),
      );
      console.log(pc.gray(`agent=${joined.agentId} role=${joined.role} model=${joined.model}`));
    });

  session
    .command("say <sessionId> <message>")
    .description("Send a message to the session")
    .option("--agent <id>", "Agent id to emit from", "cli-user")
    .option(
      "--model <model>",
      "Agent model/provider hint; defaults to local joined agent metadata or SENTINELAYER_AGENT_MODEL",
      process.env.SENTINELAYER_AGENT_MODEL || "",
    )
    .option(
      "--display-name <name>",
      "Human-readable agent display name",
      process.env.SENTINELAYER_AGENT_DISPLAY_NAME || process.env.SENTINELAYER_AGENT_NAME || "",
    )
    .option(
      "--role <role>",
      "Agent role metadata; defaults to local joined agent metadata or SENTINELAYER_AGENT_ROLE",
      process.env.SENTINELAYER_AGENT_ROLE || "",
    )
    .option("--to <agent>", "Direct the message to a specific agent id")
    .option("--reply-to <sequence>", "Mark this message as a reply to a target sequence id")
    .option("--reply-cursor <cursor>", "Mark this message as a reply to a target event cursor")
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
      const agentId = await defaultAgentId(options.agent, targetPath);
      const localSession = await ensureLocalSessionForRemoteCommand(normalizedSessionId, {
        targetPath,
      });
      const to = normalizeString(options.to);
      const replyToSequenceId = parseOptionalPositiveInteger(options.replyTo, "reply-to");
      const replyToCursor = normalizeString(options.replyCursor);
      const eventPayload = {
        message: normalizedMessage,
        channel: "session",
      };
      if (to) {
        eventPayload.to = to;
      }
      if (replyToSequenceId) {
        eventPayload.replyToSequenceId = replyToSequenceId;
      }
      if (replyToCursor) {
        eventPayload.replyToCursor = replyToCursor;
      }
      const clientMessageId = `cli-${randomUUID()}`;
      const agent = await resolveSessionAgentEnvelope(normalizedSessionId, agentId, {
        targetPath,
        model: options.model,
        role: options.role,
        displayName: options.displayName,
      });
      const event = createAgentEvent({
        event: "session_message",
        agent,
        sessionId: normalizedSessionId,
        payload: eventPayload,
      });
      event.eventId = clientMessageId;
      event.idempotencyToken = clientMessageId;
      let remoteSync = null;
      if (localSession.materialized) {
        for (let attempt = 0; attempt < 2; attempt += 1) {
          remoteSync = await syncSessionEventToApi(normalizedSessionId, event, {
            targetPath,
          });
          if (remoteSync?.synced) break;
        }
        if (!remoteSync?.synced) {
          throw new Error(
            `Remote send failed (${remoteSync?.reason || "unknown"}); local cache was not updated.`,
          );
        }
      }
      const persisted = await appendToStream(normalizedSessionId, event, {
        targetPath,
        syncRemote: !localSession.materialized,
      });
      const payload = {
        command: "session say",
        targetPath,
        sessionId: normalizedSessionId,
        agentId,
        event: persisted,
        materializedLocalSession: localSession.materialized,
        refreshedLocalSession: Boolean(localSession.refreshed),
        remoteSync: remoteSync || undefined,
      };
      if (shouldEmitJson(options, command)) {
        console.log(JSON.stringify(payload, null, 2));
        return;
      }
      console.log(formatEventLine(persisted));
    });

  session
    .command("post-agent <sessionId> <message>")
    .description("Post an authenticated agent message through the canonical session event API")
    .requiredOption("--agent <id>", "Granted agent id to post as")
    .option("--model <model>", "Agent model/provider hint", "cli")
    .option("--display-name <name>", "Human-readable agent display name")
    .option("--role <role>", "Agent role metadata: coder, reviewer, tester, observer", "coder")
    .option("--to <agent>", "Direct the message to a specific agent id")
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
      const agentId = normalizeAgentId(options.agent, "");
      if (!agentId || agentId === "cli-user" || agentId === "unknown" || agentId.startsWith("human-")) {
        throw new Error("post-agent requires a granted non-human agent id.");
      }
      const localSession = await ensureLocalSessionForRemoteCommand(normalizedSessionId, {
        targetPath,
      });
      const to = normalizeString(options.to);
      const eventPayload = {
        message: normalizedMessage,
        channel: "session",
        source: "agent",
        clientKind: "cli",
      };
      if (to) {
        eventPayload.to = to;
      }
      const agent = {
        id: agentId,
        model: normalizeString(options.model) || "cli",
        displayName: normalizeString(options.displayName) || undefined,
        role: normalizeString(options.role) || "coder",
        clientKind: "cli",
      };
      const clientMessageId = `cli-agent-${randomUUID()}`;
      const event = createAgentEvent({
        event: "session_message",
        agent,
        sessionId: normalizedSessionId,
        payload: eventPayload,
      });
      event.eventId = clientMessageId;
      event.idempotencyToken = clientMessageId;

      const remoteSync = await syncSessionEventToApi(normalizedSessionId, event, {
        targetPath,
      });
      if (!remoteSync?.synced) {
        throw new Error(
          `Agent post failed (${remoteSync?.reason || "unknown"}). Ensure this user has an active grant for '${agentId}'.`,
        );
      }

      const persisted = await appendToStream(normalizedSessionId, event, {
        targetPath,
        syncRemote: false,
      });
      const payload = {
        command: "session post-agent",
        targetPath,
        sessionId: normalizedSessionId,
        agentId,
        event: persisted,
        materializedLocalSession: localSession.materialized,
        refreshedLocalSession: Boolean(localSession.refreshed),
        remoteSync,
      };
      if (shouldEmitJson(options, command)) {
        console.log(JSON.stringify(payload, null, 2));
        return;
      }
      console.log(formatEventLine(persisted));
    });

  async function runMessageActionCommand({
    sessionId,
    actionType,
    options,
    command,
    commandName = "session action",
    targetSequenceId: targetSequenceIdOverride = null,
    targetCursor: targetCursorOverride = "",
    targetActionId: targetActionIdOverride = "",
    note: noteOverride = "",
  } = {}) {
    const normalizedSessionId = normalizeString(sessionId);
    if (!normalizedSessionId) {
      throw new Error("session id is required.");
    }
    const normalizedActionType = normalizeSessionMessageActionType(actionType);
    const targetPath = path.resolve(process.cwd(), String(options.path || "."));
    const targetSequenceId =
      targetSequenceIdOverride ||
      parseOptionalPositiveInteger(options.targetSequence, "target-sequence");
    const targetCursor = normalizeString(targetCursorOverride) || normalizeString(options.targetCursor);
    const targetActionId = normalizeString(targetActionIdOverride) || normalizeString(options.targetActionId);
    if (!targetSequenceId && !targetCursor && !targetActionId) {
      throw new Error("Provide --target-sequence, --target-cursor, or --target-action-id.");
    }
    await ensureLocalSessionForRemoteCommand(normalizedSessionId, { targetPath });
    const note = normalizeString(noteOverride) || normalizeString(options.note);
    const agentId = await defaultAgentId(options.agent, targetPath);
    const idempotencyKey =
      normalizeString(options.idempotencyKey) ||
      defaultActionIdempotencyKey({
        actionType: normalizedActionType,
        targetSequenceId,
        targetCursor,
        targetActionId,
        note,
        agentId,
      });

    const result = await createSessionMessageAction(normalizedSessionId, {
      actionType: normalizedActionType,
      targetPath,
      targetSequenceId,
      targetCursor,
      targetActionId,
      note,
      metadata: {
        source: "cli",
        agentId,
      },
      idempotencyKey,
      timeoutMs: 15_000,
    });
    if (!result.ok || !result.action) {
      throw new Error(`Session action failed (${result.reason || "unknown"}).`);
    }
    const actionEvent = buildSessionActionEvent(normalizedSessionId, result.action);
    const localAppend = await appendActionEventIfMissing(normalizedSessionId, actionEvent, {
      targetPath,
    });
    const payload = {
      command: commandName,
      targetPath,
      sessionId: normalizedSessionId,
      actionType: normalizedActionType,
      duplicate: Boolean(result.duplicate),
      action: result.action,
      event: localAppend.event,
      localAppend: {
        appended: Boolean(localAppend.appended),
        reason: localAppend.reason || "",
      },
    };
    if (shouldEmitJson(options, command)) {
      console.log(JSON.stringify(payload, null, 2));
      return payload;
    }
    console.log(formatEventLine(localAppend.event || actionEvent));
    return payload;
  }

  session
    .command("actions")
    .description("List supported low-noise message actions with examples")
    .option("--json", "Emit machine-readable output")
    .action((options, command) => {
      const payload = {
        command: "session actions",
        actions: SESSION_MESSAGE_ACTION_DESCRIPTIONS,
      };
      if (shouldEmitJson(options, command)) {
        console.log(JSON.stringify(payload, null, 2));
        return payload;
      }
      console.log(pc.bold("Supported session message actions"));
      for (const action of SESSION_MESSAGE_ACTION_DESCRIPTIONS) {
        const alias = action.alias ? ` (alias: ${action.alias})` : "";
        console.log(`${pc.cyan(action.type)}${alias}`);
        console.log(`  ${action.description}`);
        console.log(pc.gray(`  ${action.command}`));
      }
      return payload;
    });

  session
    .command("action <sessionId> <actionType>")
    .description(
      "Create a message action for a target session event (ack, working_on, reply/comment, like, dislike, disregard, view)",
    )
    .option("--target-sequence <n>", "Target event sequence id")
    .option("--target-cursor <cursor>", "Target event cursor")
    .option("--target-action-id <uuid>", "Target a threaded reply/action by action UUID")
    .option("--note <text>", "Optional action note or reply body")
    .option("--agent <id>", "Agent id for local idempotency metadata", "cli-user")
    .option("--idempotency-key <key>", "Explicit idempotency key")
    .option("--path <path>", "Workspace path for the session", ".")
    .option("--json", "Emit machine-readable output")
    .action(async (sessionId, actionType, options, command) => {
      await runMessageActionCommand({ sessionId, actionType, options, command });
    });

  session
    .command("react <sessionId> <reaction>")
    .description("React to or acknowledge a target session event with ack, like, or dislike")
    .option("--target-sequence <n>", "Target event sequence id")
    .option("--target-cursor <cursor>", "Target event cursor")
    .option("--target-action-id <uuid>", "Target a threaded reply/action by action UUID")
    .option("--agent <id>", "Agent id for local idempotency metadata", "cli-user")
    .option("--idempotency-key <key>", "Explicit idempotency key")
    .option("--path <path>", "Workspace path for the session", ".")
    .option("--json", "Emit machine-readable output")
    .action(async (sessionId, reaction, options, command) => {
      const normalizedReaction = normalizeSessionMessageActionType(reaction);
      if (!["ack", "like", "dislike"].includes(normalizedReaction)) {
        throw new Error("reaction must be one of: ack, like, dislike.");
      }
      await runMessageActionCommand({
        sessionId,
        actionType: normalizedReaction,
        options,
        command,
        commandName: "session react",
      });
    });

  session
    .command("reply <sessionId> <targetSequenceId> <message...>")
    .description("Reply to a target session event using the message-action channel")
    .option("--agent <id>", "Agent id for local idempotency metadata", "cli-user")
    .option("--idempotency-key <key>", "Explicit idempotency key")
    .option("--path <path>", "Workspace path for the session", ".")
    .option("--json", "Emit machine-readable output")
    .action(async (sessionId, targetSequenceId, messageParts, options, command) => {
      const message = Array.isArray(messageParts) ? messageParts.join(" ") : messageParts;
      await runMessageActionCommand({
        sessionId,
        actionType: "reply",
        options,
        command,
        commandName: "session reply",
        targetSequenceId: parsePositiveInteger(targetSequenceId, "targetSequenceId", 0),
        note: message,
      });
    });

  session
    .command("comment <sessionId> <targetSequenceId> <message...>")
    .description("Alias for `session reply`; add a threaded comment to a target event")
    .option("--agent <id>", "Agent id for local idempotency metadata", "cli-user")
    .option("--idempotency-key <key>", "Explicit idempotency key")
    .option("--path <path>", "Workspace path for the session", ".")
    .option("--json", "Emit machine-readable output")
    .action(async (sessionId, targetSequenceId, messageParts, options, command) => {
      const message = Array.isArray(messageParts) ? messageParts.join(" ") : messageParts;
      await runMessageActionCommand({
        sessionId,
        actionType: "reply",
        options,
        command,
        commandName: "session comment",
        targetSequenceId: parsePositiveInteger(targetSequenceId, "targetSequenceId", 0),
        note: message,
      });
    });

  session
    .command("view <sessionId> <targetSequenceId>")
    .description("Record a read receipt for a target session event")
    .option("--agent <id>", "Agent id for local idempotency metadata", "cli-user")
    .option("--idempotency-key <key>", "Explicit idempotency key")
    .option("--path <path>", "Workspace path for the session", ".")
    .option("--json", "Emit machine-readable output")
    .action(async (sessionId, targetSequenceId, options, command) => {
      await runMessageActionCommand({
        sessionId,
        actionType: "view",
        options,
        command,
        commandName: "session view",
        targetSequenceId: parsePositiveInteger(targetSequenceId, "targetSequenceId", 0),
      });
    });

  session
    .command("listen")
    .description("Background-poll a session for events addressed to this agent or broadcast")
    .requiredOption("--session <id>", "Session id to listen to")
    .option(
      "--agent <id>",
      "Agent id to receive messages for",
      process.env.SENTINELAYER_AGENT_ID || "cli-user",
    )
    .option("--interval <seconds>", "Idle polling interval in seconds (default 60)", "60")
    .option(
      "--active-interval <seconds>",
      "Polling interval after recent human activity (default 5)",
      "5",
    )
    .option(
      "--active-window <seconds>",
      "Seconds after a human message to keep the active interval (default 300)",
      "300",
    )
    .option("--emit <format>", "Output format: ndjson or text", "ndjson")
    .option("--limit <n>", "Maximum events to request per poll (default 200)", "200")
    .option("--path <path>", "Workspace path for the session", ".")
    .option("--since <cursor>", "Override the persisted listen cursor")
    .option("--replay", "Emit matching historical events on the first poll")
    .option("--max-polls <n>", "Stop after N poll cycles (useful for tests and smoke checks)")
    .action(async (options) => {
      const normalizedSessionId = resolveSessionIdOption(options);
      const targetPath = path.resolve(process.cwd(), String(options.path || "."));
      const agentId = normalizeAgentId(options.agent, "cli-user");
      const intervalSeconds = parsePositiveInteger(options.interval, "interval", 60);
      const activeIntervalSeconds = parsePositiveInteger(
        options.activeInterval,
        "active-interval",
        5,
      );
      const activeWindowSeconds = parsePositiveInteger(options.activeWindow, "active-window", 300);
      const limit = parsePositiveInteger(options.limit, "limit", 200);
      const emitFormat = normalizeString(options.emit).toLowerCase() || "ndjson";
      if (!["ndjson", "text"].includes(emitFormat)) {
        throw new Error("--emit must be one of: ndjson, text.");
      }
      const maxPolls =
        options.maxPolls === undefined
          ? null
          : parsePositiveInteger(options.maxPolls, "max-polls", 1);
      const since = options.since === undefined ? undefined : String(options.since);
      const ac = new AbortController();
      const onSigint = () => ac.abort();
      process.on("SIGINT", onSigint);

      if (emitFormat === "text") {
        console.log(
          pc.gray(
            `Listening to session ${normalizedSessionId} as ${agentId}; idle=${intervalSeconds}s active=${activeIntervalSeconds}s/${activeWindowSeconds}s. Press Ctrl+C to stop.`,
          ),
        );
      }

      try {
        await listenSessionEvents({
          sessionId: normalizedSessionId,
          targetPath,
          agentId,
          intervalSeconds,
          activeIntervalSeconds,
          activeWindowSeconds,
          limit,
          since,
          replay: Boolean(options.replay),
          maxPolls,
          signal: ac.signal,
          onEvent: async (event) => {
            if (emitFormat === "ndjson") {
              console.log(JSON.stringify(event));
            } else {
              console.log(formatEventLine(event));
            }
          },
          onError: async (result) => {
            const reason = normalizeString(result?.reason) || "poll_failed";
            if (emitFormat === "ndjson") {
              console.log(
                JSON.stringify(
                  createAgentEvent({
                    event: "session_listen_error",
                    agentId,
                    sessionId: normalizedSessionId,
                    payload: {
                      reason,
                      cursor: result?.cursor || null,
                    },
                  }),
                ),
              );
            } else {
              console.log(pc.yellow(`Listen poll skipped (${reason}).`));
            }
          },
        });
      } finally {
        process.removeListener("SIGINT", onSigint);
      }
    });

  const recap = session
    .command("recap")
    .description("Build deterministic Senti session recaps");

  recap
    .command("now [sessionId]")
    .description("Summarize current session activity, peers, findings, locks, and task ownership")
    .option("--session <id>", "Session id to recap")
    .option(
      "--remote",
      "Hydrate the latest durable API events before building the recap",
    )
    .option(
      "--agent <id>",
      "Agent id requesting the recap; self-authored events are omitted from recent snippets",
      process.env.SENTINELAYER_AGENT_ID || "",
    )
    .option("--max-events <n>", "Maximum recent local events to inspect (default 100)", "100")
    .option("--path <path>", "Workspace path for the session", ".")
    .option("--json", "Emit machine-readable output")
    .action(async (sessionId, options, command) => {
      const normalizedSessionId = normalizeString(sessionId) || resolveSessionIdOption(options);
      const targetPath = path.resolve(process.cwd(), String(options.path || "."));
      const agentId = normalizeAgentId(options.agent, "");
      const maxEvents = parsePositiveInteger(options.maxEvents, "max-events", 100);
      let hydration = null;
      let remoteTail = null;
      let remoteAppend = null;
      if (options.remote) {
        hydration = await hydrateSessionFromRemote({
          sessionId: normalizedSessionId,
          targetPath,
        });
        remoteTail = await pollSessionEventsBefore(normalizedSessionId, {
          targetPath,
          limit: maxEvents,
          timeoutMs: 15_000,
        });
        if (remoteTail?.ok && Array.isArray(remoteTail.events) && remoteTail.events.length > 0) {
          remoteAppend = await appendMissingRemoteEvents(normalizedSessionId, remoteTail.events, {
            targetPath,
          });
        }
      }
      const current = await buildSessionRecap(normalizedSessionId, {
        forAgentId: agentId,
        maxEvents,
        targetPath,
      });
      const payload = {
        command: "session recap now",
        targetPath,
        sessionId: normalizedSessionId,
        agentId: current.forAgentId,
        maxEvents,
        generatedAt: current.generatedAt,
        ephemeral: current.ephemeral,
        style: current.style,
        recap: current.text,
        summary: current.summary,
        remote: options.remote
          ? {
              hydration,
              tailProbe: remoteTail
                ? {
                    ok: Boolean(remoteTail.ok),
                    reason: remoteTail.reason || "",
                    count: Array.isArray(remoteTail.events) ? remoteTail.events.length : 0,
                    cursor: remoteTail.cursor || null,
                  }
                : null,
              appendedTail: remoteAppend,
            }
          : null,
      };
      if (shouldEmitJson(options, command)) {
        console.log(JSON.stringify(payload, null, 2));
        return;
      }
      console.log(pc.bold(`Recap for session ${normalizedSessionId}`));
      if (payload.agentId) {
        console.log(pc.gray(`for agent=${payload.agentId}`));
      }
      console.log(current.text);
    });

  session
    .command("read <sessionId>")
    .description("Read recent session messages")
    .option("--tail <n>", "Number of recent events", "20")
    .option("--follow", "Continuously follow new events (local fs poll)")
    .option(
      "--live",
      "Subscribe to SSE + fs.watch combined source (replaces --follow). Same-machine peers via fs.watch, remote peers via SSE; events deduped by id.",
    )
    .option(
      "--remote",
      "Hydrate from the SentinelLayer API before reading (pulls web-posted messages into the local NDJSON)",
    )
    .option("--before-sequence <n>", "Remote page ending before this sequence id")
    .option("--no-actions", "Do not include remote message actions/replies/reactions")
    .option("--path <path>", "Workspace path for the session", ".")
    .option("--json", "Emit machine-readable output")
    .action(async (sessionId, options, command) => {
      const normalizedSessionId = normalizeString(sessionId);
      if (!normalizedSessionId) {
        throw new Error("session id is required.");
      }
      const targetPath = path.resolve(process.cwd(), String(options.path || "."));
      const tail = parsePositiveInteger(options.tail, "tail", 20);
      const beforeSequence = parseOptionalPositiveInteger(options.beforeSequence, "before-sequence");
      const emitJson = shouldEmitJson(options, command);

      let hydration = null;
      let remoteTail = null;
      let remoteActions = null;
      if (options.remote) {
        const authSession = await resolveActiveAuthSession({
          cwd: targetPath,
          env: process.env,
          autoRotate: false,
        });
        if (!authSession || !authSession.token) {
          throw new Error(`Remote session read requires authentication. Run \`${authLoginHint()}\` first.`);
        }
        hydration = await hydrateSessionFromRemote({
          sessionId: normalizedSessionId,
          targetPath,
        });
        remoteTail = await pollSessionEventsBefore(normalizedSessionId, {
          targetPath,
          beforeSequence,
          limit: tail,
          timeoutMs: 15_000,
        });
        if (options.actions !== false) {
          remoteActions = await listSessionMessageActions(normalizedSessionId, {
            targetPath,
            limit: 500,
            timeoutMs: 15_000,
          });
        }
        if (!emitJson) {
          if (hydration.ok) {
            console.log(
              pc.gray(
                `Hydrated from remote: relayed=${hydration.relayed} dropped=${hydration.dropped}.`,
              ),
            );
            if (hydration.eventsBackfillComplete === false) {
              console.log(
                pc.yellow(
                  `Remote backfill still has more pages (${hydration.eventsBackfillReason || "incomplete"}); latest tail was fetched directly.`,
                ),
              );
            }
          } else {
            console.log(
              pc.yellow(
                `Remote hydrate skipped (${hydration.reason}); showing local stream only.`,
              ),
            );
          }
          if (remoteActions && !remoteActions.ok) {
            console.log(
              pc.yellow(
                `Remote message actions skipped (${remoteActions.reason}); showing events only.`,
              ),
            );
          }
        }
      }

      if (!options.follow) {
        const allEvents = await readStream(normalizedSessionId, {
          targetPath,
          tail: 0,
        });
        const displayEvents = [...allEvents];
        let remoteTailAppended = 0;
        let remoteTailDisplayedOnly = 0;
        if (remoteTail?.ok && Array.isArray(remoteTail.events) && remoteTail.events.length > 0) {
          const knownKeys = new Set();
          for (const event of allEvents) {
            addSessionEventIdentityKeys(knownKeys, event);
          }
          for (const event of remoteTail.events) {
            if (sessionEventHasKnownIdentity(event, knownKeys)) {
              continue;
            }
            try {
              const appended = await appendToStream(normalizedSessionId, event, {
                targetPath,
                syncRemote: false,
              });
              displayEvents.push(appended);
              addSessionEventIdentityKeys(knownKeys, appended);
              remoteTailAppended += 1;
            } catch {
              displayEvents.push(event);
              addSessionEventIdentityKeys(knownKeys, event);
              remoteTailDisplayedOnly += 1;
            }
          }
        }
        const actionEvents = remoteActions?.ok
          ? buildSessionActionEvents(normalizedSessionId, remoteActions.actions)
          : [];
        const events = mergeSessionActionEvents(displayEvents, actionEvents).slice(-tail);
        const remoteVerified = Boolean(
          options.remote &&
            ((hydration && hydration.ok) || (remoteTail && remoteTail.ok))
        );
        const payload = {
          command: "session read",
          targetPath,
          sessionId: normalizedSessionId,
          tail,
          beforeSequence,
          count: events.length,
          events,
          displaySource: !options.remote
            ? "local"
            : remoteTail?.ok
              ? "remote_verified_tail"
              : hydration?.ok
                ? "hydrated_local"
                : "local_only",
          remoteVerified,
          localEventCount: allEvents.length,
          remote: hydration
            ? {
                ...hydration,
                tailProbe: remoteTail
                  ? {
                      ok: Boolean(remoteTail.ok),
                      reason: remoteTail.reason || "",
                      count: Array.isArray(remoteTail.events) ? remoteTail.events.length : 0,
                      cursor: remoteTail.cursor || null,
                      beforeSequence: remoteTail.beforeSequence || null,
                      verified: Boolean(remoteTail.ok),
                      appended: remoteTailAppended,
                      displayedOnly: remoteTailDisplayedOnly,
                    }
                  : null,
                actions: remoteActions
                  ? {
                      ok: Boolean(remoteActions.ok),
                      reason: remoteActions.reason || "",
                      count: Array.isArray(remoteActions.actions)
                        ? remoteActions.actions.length
                        : 0,
                      actions: remoteActions.actions || [],
                      syntheticEventCount: actionEvents.length,
                      projection: remoteActions.projection || null,
                    }
                  : null,
              }
            : hydration,
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

      if (options.live) {
        if (!emitJson) {
          console.log(
            pc.gray(
              `Live-tailing ${normalizedSessionId} (SSE + fs.watch)… Ctrl+C to stop.`,
            ),
          );
        }
        const ac = new AbortController();
        const onSigint = () => ac.abort();
        process.on("SIGINT", onSigint);
        const session = await resolveActiveAuthSession({
          cwd: targetPath,
          env: process.env,
          autoRotate: false,
        }).catch(() => null);
        const apiBaseUrl = session?.apiUrl || "";
        const token = session?.token || "";
        try {
          for await (const item of mergeLiveSources({
            sessionId: normalizedSessionId,
            targetPath,
            apiBaseUrl: apiBaseUrl || undefined,
            token: token || undefined,
            signal: ac.signal,
          })) {
            if (item.event) {
              if (emitJson) {
                console.log(JSON.stringify({ source: item.source, event: item.event }));
              } else {
                const sourceTag = item.source === "sse" ? pc.cyan("[sse]") : pc.gray("[fs] ");
                console.log(`${sourceTag} ${formatEventLine(item.event)}`);
              }
            } else if (item.error && !emitJson) {
              console.log(pc.yellow(`(${item.source} stream: ${item.error})`));
            }
          }
        } finally {
          process.removeListener("SIGINT", onSigint);
        }
        return;
      }

      if (!emitJson) {
        console.log(pc.gray(`Following session ${normalizedSessionId}... Press Ctrl+C to stop.`));
      }
      const seenFollowEvents = new Set();
      for await (const event of tailStream(normalizedSessionId, {
        targetPath,
        replayTail: tail,
      })) {
        if (sessionEventHasKnownIdentity(event, seenFollowEvents)) {
          continue;
        }
        addSessionEventIdentityKeys(seenFollowEvents, event);
        if (emitJson) {
          console.log(JSON.stringify(event));
        } else {
          console.log(formatEventLine(event));
        }
      }
    });

  session
    .command("search <sessionId> <query>")
    .description("Search durable API session events by text, event type, or agent")
    .option("--before-sequence <n>", "Return matches older than this sequence id")
    .option("--limit <n>", "Maximum search results (default 20, max 50)", "20")
    .option("--path <path>", "Workspace path for the session", ".")
    .option("--json", "Emit machine-readable output")
    .action(async (sessionId, query, options, command) => {
      const normalizedSessionId = normalizeString(sessionId);
      if (!normalizedSessionId) {
        throw new Error("session id is required.");
      }
      const normalizedQuery = normalizeString(query);
      if (normalizedQuery.length < 2) {
        throw new Error("query must be at least 2 characters.");
      }
      const targetPath = path.resolve(process.cwd(), String(options.path || "."));
      const beforeSequence = parseOptionalPositiveInteger(options.beforeSequence, "before-sequence");
      const limit = parsePositiveInteger(options.limit, "limit", 20);
      const result = await searchSessionEvents(normalizedSessionId, {
        query: normalizedQuery,
        targetPath,
        beforeSequence,
        limit,
        timeoutMs: 15_000,
      });
      const payload = {
        command: "session search",
        targetPath,
        sessionId: normalizedSessionId,
        ...result,
        nextBeforeSequence: result.nextBeforeSequence || null,
      };
      if (shouldEmitJson(options, command)) {
        console.log(JSON.stringify(payload, null, 2));
        return;
      }
      if (!result.ok) {
        throw new Error(`Session search failed (${result.reason || "unknown"}).`);
      }
      for (const item of result.results || []) {
        const event = item.event || {};
        const sequence = item.sequenceId ? `#${item.sequenceId}` : "";
        const snippet = normalizeString(item.snippet);
        console.log(`${sequence} ${formatEventLine(event)}${snippet ? ` | ${snippet}` : ""}`);
      }
      if (result.hasMore && result.nextBeforeSequence) {
        console.log(pc.gray(`More results before sequence ${result.nextBeforeSequence}.`));
      }
    });

  session
    .command("sync <sessionId>")
    .description(
      "Pull human messages from the SentinelLayer API into the local NDJSON stream",
    )
    .option(
      "--since <iso>",
      "Override the persisted cursor and start from this ISO timestamp",
    )
    .option("--path <path>", "Workspace path for the session", ".")
    .option("--json", "Emit machine-readable output")
    .action(async (sessionId, options, command) => {
      const normalizedSessionId = normalizeString(sessionId);
      if (!normalizedSessionId) {
        throw new Error("session id is required.");
      }
      const targetPath = path.resolve(process.cwd(), String(options.path || "."));
      const sinceArg = options.since == null ? undefined : String(options.since);

      const result = await hydrateSessionFromRemote({
        sessionId: normalizedSessionId,
        targetPath,
        since: sinceArg,
      });

      // Discriminate "owned-but-no-human-messages" from "not a member /
      // wrong session id". The hydrate path returns ok:true with
      // relayed=0 + cursor=null in both cases, which Carter just hit
      // on session d34f03ba — the user couldn't tell whether they
      // typed the wrong id or it was just genuinely empty.
      let access = null;
      if (result.ok && result.relayed === 0 && !result.cursor) {
        access = await probeSessionAccess(normalizedSessionId, { targetPath });
      }

      const payload = {
        command: "session sync",
        targetPath,
        sessionId: normalizedSessionId,
        ok: result.ok,
        reason: result.reason || "",
        relayed: result.relayed,
        dropped: result.dropped,
        cursor: result.cursor,
        persistedCursor: result.persistedCursor,
        humanRelayed: result.humanRelayed,
        eventsRelayed: result.eventsRelayed,
        eventsCursor: result.eventsCursor,
        materializedLocalSession: result.materializedLocalSession,
        localAppendComplete: result.localAppendComplete,
        access: access || undefined,
      };
      if (shouldEmitJson(options, command)) {
        console.log(JSON.stringify(payload, null, 2));
        return;
      }
      if (result.ok) {
        console.log(
          `Hydrated session ${normalizedSessionId}: relayed=${result.relayed} dropped=${result.dropped}.`,
        );
        if (access && !access.accessible) {
          if (access.reason === "session_not_found") {
            console.log(
              pc.yellow(
                `Heads up: that session id isn't in your account. Verify with \`sl session list --remote\`.`,
              ),
            );
          } else if (access.reason === "not_a_member") {
            console.log(
              pc.yellow(
                `Heads up: you aren't a member of session ${normalizedSessionId} — sync silently no-ops. Ask the owner to add you, or list your own with \`sl session list --remote\`.`,
              ),
            );
          } else if (access.reason !== "" && access.reason !== "no_session") {
            console.log(
              pc.gray(
                `(probe: ${access.reason}; if you expected messages, check \`sl session list --remote\`.)`,
              ),
            );
          }
        }
      } else {
        console.log(
          pc.yellow(
            `Hydrate skipped (${result.reason}). Local stream is unchanged; cursor=${result.cursor || "<none>"}.`,
          ),
        );
      }
    });

  const checkpoint = session
    .command("checkpoint")
    .description("List, create, and generate durable session checkpoints");

  checkpoint
    .command("list <sessionId>")
    .description("List durable checkpoints for a remote session")
    .option("--limit <n>", "Maximum checkpoints to return (default 100, max 200)", "100")
    .option("--path <path>", "Workspace path for auth/session context", ".")
    .option("--json", "Emit machine-readable output")
    .action(async (sessionId, options, command) => {
      const normalizedSessionId = normalizeString(sessionId);
      if (!normalizedSessionId) {
        throw new Error("session id is required.");
      }
      const targetPath = path.resolve(process.cwd(), String(options.path || "."));
      const result = await listSessionCheckpoints(normalizedSessionId, {
        targetPath,
        limit: options.limit,
      });
      const payload = {
        command: "session checkpoint list",
        targetPath,
        ...result,
      };
      if (shouldEmitJson(options, command)) {
        console.log(JSON.stringify(payload, null, 2));
        return;
      }
      if (result.checkpoints.length === 0) {
        console.log(pc.gray(`No checkpoints for session ${normalizedSessionId}.`));
        return;
      }
      for (const item of result.checkpoints) {
        console.log(formatCheckpointLine(item));
      }
    });

  checkpoint
    .command("create <sessionId>")
    .description("Create a durable checkpoint anchored to a canonical sequence range")
    .requiredOption("--start-sequence <n>", "First canonical event sequence included in the checkpoint")
    .requiredOption("--end-sequence <n>", "Last canonical event sequence included in the checkpoint")
    .requiredOption("--title <title>", "Short checkpoint title")
    .option("--summary <text>", "Checkpoint summary text")
    .option("--summary-file <file>", "Read checkpoint summary text from a file")
    .option("--kind <kind>", "Checkpoint kind (summary, handoff, milestone, billing)", "summary")
    .option("--checkpoint-id <id>", "Explicit checkpoint id; defaults to a stable hash of range/body")
    .option("--agent <id>", "Optional agent id recorded as checkpoint creator")
    .option("--token-start <n>", "Optional token-range start")
    .option("--token-end <n>", "Optional token-range end")
    .option("--path <path>", "Workspace path for auth/session context", ".")
    .option("--json", "Emit machine-readable output")
    .action(async (sessionId, options, command) => {
      const normalizedSessionId = normalizeString(sessionId);
      if (!normalizedSessionId) {
        throw new Error("session id is required.");
      }
      const targetPath = path.resolve(process.cwd(), String(options.path || "."));
      const agentId = normalizeString(options.agent)
        ? await defaultAgentId(options.agent, targetPath)
        : "";
      const summary = await readCheckpointSummaryOption(options, { targetPath });
      const result = await createSessionCheckpoint(normalizedSessionId, {
        targetPath,
        checkpointId: options.checkpointId,
        startSequence: options.startSequence,
        endSequence: options.endSequence,
        kind: options.kind,
        title: options.title,
        summary,
        createdByAgentId: agentId,
        tokenStart: options.tokenStart,
        tokenEnd: options.tokenEnd,
      });
      const hydration = await hydrateAfterCheckpointMutation(normalizedSessionId, { targetPath });
      const payload = {
        command: "session checkpoint create",
        targetPath,
        ...result,
        hydration,
      };
      if (shouldEmitJson(options, command)) {
        console.log(JSON.stringify(payload, null, 2));
        return;
      }
      const duplicate = result.duplicate ? "duplicate " : "";
      console.log(pc.bold(`${duplicate}checkpoint created`));
      if (result.checkpoint) {
        console.log(formatCheckpointLine(result.checkpoint));
      }
      if (!hydration.ok) {
        console.log(pc.gray(`Local hydrate skipped: ${hydration.reason || "unknown"}`));
      }
    });

  checkpoint
    .command("generate <sessionId>")
    .description("Generate a checkpoint from the next uncheckpointed durable event window")
    .option("--min-events <n>", "Minimum source events required before creating (default 20)", "20")
    .option("--max-events <n>", "Maximum source events to summarize (default 80, max 200)", "80")
    .option("--operation-id <key>", "Explicit retry key for this generate invocation")
    .option("--agent <id>", "Optional agent id recorded as checkpoint creator")
    .option("--path <path>", "Workspace path for auth/session context", ".")
    .option("--json", "Emit machine-readable output")
    .action(async (sessionId, options, command) => {
      const normalizedSessionId = normalizeString(sessionId);
      if (!normalizedSessionId) {
        throw new Error("session id is required.");
      }
      const targetPath = path.resolve(process.cwd(), String(options.path || "."));
      const agentId = normalizeString(options.agent)
        ? await defaultAgentId(options.agent, targetPath)
        : "";
      const result = await generateSessionCheckpoint(normalizedSessionId, {
        targetPath,
        minEvents: options.minEvents,
        maxEvents: options.maxEvents,
        idempotencyKey: options.operationId,
        createdByAgentId: agentId,
      });
      const hydration = result.checkpoint
        ? await hydrateAfterCheckpointMutation(normalizedSessionId, { targetPath })
        : null;
      const payload = {
        command: "session checkpoint generate",
        targetPath,
        ...result,
        hydration: hydration || undefined,
      };
      if (shouldEmitJson(options, command)) {
        console.log(JSON.stringify(payload, null, 2));
        return;
      }
      if (result.checkpoint) {
        console.log(pc.bold(result.duplicate ? "checkpoint already covered" : "checkpoint generated"));
        console.log(formatCheckpointLine(result.checkpoint));
        if (hydration && !hydration.ok) {
          console.log(pc.gray(`Local hydrate skipped: ${hydration.reason || "unknown"}`));
        }
        return;
      }
      console.log(
        pc.gray(
          `No checkpoint created: ${normalizeString(result.reason) || "not_needed"} (${Number(result.eventCount || 0)} events, min ${Number(result.minEvents || 0)}).`,
        ),
      );
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

      const [agents, runtimeRuns, leases, fileLocks, activeTasks, recentEvents] = await Promise.all([
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
        listFileLocks(normalizedSessionId, {
          targetPath,
          emitExpiredEvents: false,
        }),
        listSessionTasks(normalizedSessionId, {
          targetPath,
          statuses: ["PENDING", "ACCEPTED"],
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
        activeFileLocks: fileLocks,
        activeTasks: activeTasks.tasks,
        recentEvents,
      };
      if (shouldEmitJson(options, command)) {
        console.log(JSON.stringify(payload, null, 2));
        return;
      }

      console.log(pc.bold(`Session ${normalizedSessionId}`));
      console.log(
        pc.gray(
          `status=${sessionPayload.status} agents=${agents.length} stale=${staleAgents.length} runs=${runtimeRuns.length} leases=${leases.assignments.length} locks=${fileLocks.length} tasks=${activeTasks.tasks.length}`
        )
      );
      for (const event of recentEvents) {
        console.log(formatEventLine(event));
      }
    });

  session
    .command("export <sessionId>")
    .description(
      "Export full transcript + metadata + agents + tasks as JSON (compliance / portability / context handoff)",
    )
    .option(
      "--format <fmt>",
      "Output format: json (single object) or ndjson (one event per line)",
      "json",
    )
    .option("--out <file>", "Write to file instead of stdout")
    .option(
      "--remote",
      "Hydrate from the SentinelLayer API before exporting and include remote message actions",
    )
    .option("--no-actions", "Do not include remote message actions/replies/reactions")
    .option("--path <path>", "Workspace path for the session", ".")
    .action(async (sessionId, options) => {
      const normalizedSessionId = normalizeString(sessionId);
      if (!normalizedSessionId) {
        throw new Error("session id is required.");
      }
      const targetPath = path.resolve(process.cwd(), String(options.path || "."));
      const format = String(options.format || "json").trim().toLowerCase();
      if (format !== "json" && format !== "ndjson") {
        throw new Error(`--format must be 'json' or 'ndjson' (received '${format}').`);
      }
      let hydration = null;
      let remoteActions = null;
      if (options.remote) {
        hydration = await hydrateSessionFromRemote({
          sessionId: normalizedSessionId,
          targetPath,
        }).catch((error) => ({ ok: false, reason: error?.message || "hydrate_failed" }));
        if (options.actions !== false) {
          remoteActions = await listSessionMessageActions(normalizedSessionId, {
            targetPath,
            limit: 500,
            timeoutMs: 15_000,
          });
        }
      }

      const sessionPayload = await getSession(normalizedSessionId, { targetPath });
      if (!sessionPayload) {
        throw new Error(`Session '${normalizedSessionId}' was not found.`);
      }

      const [agents, events, tasks] = await Promise.all([
        listAgents(normalizedSessionId, {
          targetPath,
          includeInactive: true,
        }),
        readStream(normalizedSessionId, {
          targetPath,
          tail: 0,
        }),
        listSessionTasks(normalizedSessionId, {
          targetPath,
          limit: 5_000,
        }),
      ]);
      const actionEvents = remoteActions?.ok
        ? buildSessionActionEvents(normalizedSessionId, remoteActions.actions)
        : [];
      const exportEvents = mergeSessionActionEvents(events, actionEvents);
      const stats = computeTranscriptStats({
        sessionMeta: sessionPayload,
        events: exportEvents,
      });
      const participants = buildSessionParticipants({
        statsAgents: stats.agents,
        registeredAgents: agents,
      });

      let output;
      if (format === "ndjson") {
        const lines = [];
        lines.push(JSON.stringify({ kind: "session", value: sessionPayload }));
        for (const agent of agents) lines.push(JSON.stringify({ kind: "agent", value: agent }));
        for (const participant of participants) {
          lines.push(JSON.stringify({ kind: "participant", value: participant }));
        }
        for (const action of remoteActions?.actions || []) {
          lines.push(JSON.stringify({ kind: "action", value: action }));
        }
        for (const event of exportEvents) lines.push(JSON.stringify({ kind: "event", value: event }));
        for (const task of tasks.tasks || []) lines.push(JSON.stringify({ kind: "task", value: task }));
        output = `${lines.join("\n")}\n`;
      } else {
        output = `${JSON.stringify(
          {
            command: "session export",
            exportedAt: new Date().toISOString(),
            session: sessionPayload,
            agents,
            participants,
            actions: remoteActions?.actions || [],
            actionProjection: remoteActions?.projection || null,
            actionEvents,
            events: exportEvents,
            tasks: tasks.tasks || [],
            remote: {
              hydration,
              actions: remoteActions
                ? {
                    ok: Boolean(remoteActions.ok),
                    reason: remoteActions.reason || "",
                    count: Array.isArray(remoteActions.actions) ? remoteActions.actions.length : 0,
                    syntheticEventCount: actionEvents.length,
                  }
                : null,
            },
            counts: {
              agents: participants.length,
              participants: participants.length,
              derivedAgents: stats.agents.length,
              registeredAgents: agents.length,
              events: exportEvents.length,
              rawEvents: events.length,
              actions: Array.isArray(remoteActions?.actions) ? remoteActions.actions.length : 0,
              actionEvents: actionEvents.length,
              tasks: (tasks.tasks || []).length,
            },
            totals: stats.totals,
          },
          null,
          2,
        )}\n`;
      }

      const outArg = normalizeString(options.out);
      if (outArg) {
        const outPath = path.resolve(process.cwd(), outArg);
        await fsp.mkdir(path.dirname(outPath), { recursive: true });
        await fsp.writeFile(outPath, output, "utf-8");
        console.log(
          pc.gray(
            `Exported ${exportEvents.length} events / ${participants.length} participants (${agents.length} registered agents) / ${
              (tasks.tasks || []).length
            } tasks → ${outPath}`,
          ),
        );
      } else {
        process.stdout.write(output);
      }
    });

  session
    .command("download <sessionId>")
    .description(
      "Download an iMessage-style Markdown transcript: deterministic timestamps, per-agent active duration, known persona/orchestrator/family avatars, and human avatars from your auth profile",
    )
    .option("--out <file>", "Output path (default: <sessionId>.md in cwd)")
    .option(
      "--no-system-events",
      "Suppress join/leave/identified/daemon-alert lines (keeps only user + agent messages)",
    )
    .option(
      "--remote",
      "Hydrate from the SentinelLayer API before rendering (pulls web-posted messages into the local NDJSON)",
    )
    .option("--no-actions", "Do not include remote message actions/replies/reactions")
    .option("--path <path>", "Workspace path for the session", ".")
    .option("--json", "Emit machine-readable output")
    .action(async (sessionId, options, command) => {
      const normalizedSessionId = normalizeString(sessionId);
      if (!normalizedSessionId) {
        throw new Error("session id is required.");
      }
      const targetPath = path.resolve(process.cwd(), String(options.path || "."));
      const emitJson = shouldEmitJson(options, command);

      let hydration = null;
      let remoteActions = null;
      if (options.remote) {
        hydration = await hydrateSessionFromRemote({
          sessionId: normalizedSessionId,
          targetPath,
        }).catch((error) => ({ ok: false, reason: error?.message || "hydrate_failed" }));
        if (options.actions !== false) {
          remoteActions = await listSessionMessageActions(normalizedSessionId, {
            targetPath,
            limit: 500,
            timeoutMs: 15_000,
          });
        }
      }

      const sessionPayload = await getSession(normalizedSessionId, { targetPath });
      if (!sessionPayload) {
        throw new Error(`Session '${normalizedSessionId}' was not found.`);
      }

      const [agents, events] = await Promise.all([
        listAgents(normalizedSessionId, { targetPath, includeInactive: true }),
        readStream(normalizedSessionId, { targetPath, tail: 0 }),
      ]);
      const actionEvents = remoteActions?.ok
        ? buildSessionActionEvents(normalizedSessionId, remoteActions.actions)
        : [];
      const transcriptEvents = mergeSessionActionEvents(events, actionEvents);

      // Pull GitHub/Google avatar + display name from the active auth
      // session so any human-id seen in the stream renders with the
      // user's real photo instead of the generic 🧑 fallback.
      const speakerProfiles = new Map();
      const auth = await resolveActiveAuthSession({
        cwd: targetPath,
        env: process.env,
        autoRotate: false,
      }).catch(() => null);
      const userAvatarUrl = normalizeString(auth?.user?.avatarUrl);
      const userDisplay =
        normalizeString(auth?.user?.githubUsername) ||
        normalizeString(auth?.user?.email);
      if (userAvatarUrl || userDisplay) {
        const profile = {
          displayName: userDisplay || "You",
          avatarUrl: userAvatarUrl || null,
          family: "human",
        };
        for (const id of ["cli-user", "human", "you", "user"]) {
          speakerProfiles.set(id, profile);
        }
        if (userDisplay) speakerProfiles.set(userDisplay, profile);
      }

      const { buildTranscriptMarkdown } = await import(
        "../session/transcript.js"
      );
      const { markdown, stats } = buildTranscriptMarkdown({
        sessionMeta: {
          sessionId: normalizedSessionId,
          createdAt: sessionPayload.createdAt,
          status: sessionPayload.status,
        },
        events: transcriptEvents,
        agents,
        speakerProfiles,
        options: {
          // commander maps --no-system-events to systemEvents: false
          includeSystemEvents: options.systemEvents !== false,
        },
      });
      const participants = buildSessionParticipants({
        statsAgents: stats.agents,
        registeredAgents: agents,
      });

      const outArg = normalizeString(options.out);
      const outPath = outArg
        ? path.resolve(process.cwd(), outArg)
        : path.resolve(process.cwd(), `${normalizedSessionId}.md`);
      await fsp.mkdir(path.dirname(outPath), { recursive: true });
      await fsp.writeFile(outPath, markdown, "utf-8");

      const payload = {
        command: "session download",
        sessionId: normalizedSessionId,
        outPath,
        bytes: Buffer.byteLength(markdown, "utf-8"),
        eventCount: transcriptEvents.length,
        rawEventCount: events.length,
        actionCount: Array.isArray(remoteActions?.actions) ? remoteActions.actions.length : 0,
        actionEventCount: actionEvents.length,
        agentCount: participants.length,
        participantCount: participants.length,
        derivedAgentCount: stats.agents.length,
        registeredAgentCount: agents.length,
        participants,
        sessionLiveSeconds: stats.sessionLiveSeconds,
        sentiActions: stats.sentiActions,
        totals: stats.totals,
        remote: {
          hydration,
          actions: remoteActions
            ? {
                ok: Boolean(remoteActions.ok),
                reason: remoteActions.reason || "",
                count: Array.isArray(remoteActions.actions) ? remoteActions.actions.length : 0,
                syntheticEventCount: actionEvents.length,
                projection: remoteActions.projection || null,
              }
            : null,
        },
      };
      if (emitJson) {
        console.log(JSON.stringify(payload, null, 2));
        return;
      }
      console.log(pc.bold(`Downloaded session ${normalizedSessionId} → ${outPath}`));
      console.log(
        pc.gray(
          `${transcriptEvents.length} events · ${participants.length} participants (${agents.length} registered agents) · actions=${payload.actionCount} · live ${stats.sessionLiveSeconds}s · senti=${stats.sentiActions} · tokens=${stats.totals.tokenTotal} · cost=$${stats.totals.costTotalUsd.toFixed(4)}`,
        ),
      );
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
      const agentId = await defaultAgentId(options.agent, targetPath);
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
    .description(
      "List sessions. Defaults to local cache; pass --remote to query the SentinelLayer API for every session on your account.",
    )
    .option(
      "--remote",
      "Query the API for sessions on the authenticated account (covers sessions created from any workspace or the web dashboard)",
    )
    .option(
      "--include-archived",
      "Include archived/expired sessions (past conversations)",
    )
    .option(
      "--limit <n>",
      "Maximum sessions to return (default 50; ignored on --json)",
      "50",
    )
    .option("--path <path>", "Workspace path for sessions", ".")
    .option("--json", "Emit machine-readable output")
    .action(async (options, command) => {
      const targetPath = path.resolve(process.cwd(), String(options.path || "."));
      const includeArchived = Boolean(options.includeArchived);
      const limit = parsePositiveInteger(options.limit, "limit", 50);
      const emitJson = shouldEmitJson(options, command);

      if (options.remote) {
        const remote = await listSessionsFromApi({
          targetPath,
          includeArchived,
          limit: emitJson ? 200 : limit,
          fetchAll: emitJson,
        });
        const trimmed = emitJson ? remote.sessions : remote.sessions.slice(0, limit);
        const payload = {
          command: "session list",
          source: "remote",
          targetPath,
          includeArchived,
          ok: remote.ok,
          reason: remote.reason || "",
          count: remote.count,
          nextCursor: remote.nextCursor || null,
          hasMore: Boolean(remote.hasMore),
          truncated: Boolean(remote.truncated),
          warnings: Array.isArray(remote.warnings) ? remote.warnings : [],
          sessions: trimmed,
        };
        if (emitJson) {
          console.log(JSON.stringify(payload, null, 2));
          return;
        }
        if (!remote.ok) {
          console.log(
            pc.yellow(
              `Remote list unavailable (${remote.reason}). Try \`sl auth login\` or run without --remote for local cache.`,
            ),
          );
          return;
        }
        if (remote.sessions.length === 0) {
          console.log(
            pc.yellow(
              includeArchived
                ? "No sessions on your account."
                : "No active sessions on your account. Re-run with --include-archived to see history.",
            ),
          );
          return;
        }
        for (const item of trimmed) {
          const archive = item.archiveStatus ? ` archive=${item.archiveStatus}` : "";
          const created = item.createdAt || "?";
          const lastActivity = item.lastActivityAt
            ? ` last=${item.lastActivityAt}`
            : "";
          console.log(
            `${item.sessionId} status=${item.status}${archive} created=${created}${lastActivity}`,
          );
        }
        if (remote.count > trimmed.length || remote.hasMore) {
          console.log(
            pc.gray(
              remote.hasMore
                ? "… more sessions are available (raise --limit or use --json)."
                : `… ${remote.count - trimmed.length} more (raise --limit or use --json).`,
            ),
          );
        }
        if (remote.truncated) {
          console.log(
            pc.yellow(
              "Remote session listing is truncated by the page cap; JSON output includes nextCursor for resume.",
            ),
          );
        }
        return;
      }

      const sessions = includeArchived
        ? await listAllSessions({ targetPath })
        : await listActiveSessions({ targetPath });
      const trimmed = emitJson ? sessions : sessions.slice(0, limit);
      const payload = {
        command: "session list",
        source: "local",
        targetPath,
        includeArchived,
        count: sessions.length,
        sessions: trimmed,
      };
      if (emitJson) {
        console.log(JSON.stringify(payload, null, 2));
        return;
      }
      if (sessions.length === 0) {
        console.log(
          pc.yellow(
            includeArchived
              ? "No sessions in local cache. Run with --remote to fetch from the API."
              : "No active sessions in local cache. Run with --remote to see sessions from other workspaces or the web.",
          ),
        );
        return;
      }
      for (const item of trimmed) {
        const archive = item.archiveStatus ? ` archive=${item.archiveStatus}` : "";
        console.log(
          `${item.sessionId} status=${item.status}${archive} created=${item.createdAt} expires=${item.expiresAt}`,
        );
      }
      if (sessions.length > trimmed.length) {
        console.log(
          pc.gray(
            `… ${sessions.length - trimmed.length} more (raise --limit or use --json).`,
          ),
        );
      }
    });

  session
    .command("history")
    .description(
      "Past conversations with a one-line preview of the most recent message (alias for `session list --include-archived` + previews)",
    )
    .option("--limit <n>", "Maximum sessions to return", "50")
    .option("--no-preview", "Skip the per-session preview lookup")
    .option("--path <path>", "Workspace path for sessions", ".")
    .option("--json", "Emit machine-readable output")
    .action(async (options, command) => {
      const targetPath = path.resolve(process.cwd(), String(options.path || "."));
      const limit = parsePositiveInteger(options.limit, "limit", 50);
      const wantPreview = options.preview !== false;
      const sessions = await listAllSessions({ targetPath });
      const trimmed = shouldEmitJson(options, command) ? sessions : sessions.slice(0, limit);

      let previews = new Map();
      if (wantPreview && trimmed.length > 0) {
        const entries = await Promise.all(
          trimmed.map(async (item) => [
            item.sessionId,
            await readSessionPreview(item.sessionId, { targetPath }),
          ]),
        );
        previews = new Map(entries);
      }

      if (shouldEmitJson(options, command)) {
        const payload = {
          command: "session history",
          targetPath,
          count: sessions.length,
          sessions: trimmed.map((item) => ({
            ...item,
            preview: previews.get(item.sessionId) || null,
          })),
        };
        console.log(JSON.stringify(payload, null, 2));
        return;
      }

      if (sessions.length === 0) {
        console.log(pc.yellow("No sessions in cache."));
        return;
      }
      for (const item of trimmed) {
        const archive = item.archiveStatus.padEnd(8);
        const head =
          `${archive} ${item.sessionId} created=${item.createdAt}` +
          (item.archivedAt ? ` archived=${item.archivedAt}` : "");
        if (!wantPreview) {
          console.log(head);
          continue;
        }
        const preview = previews.get(item.sessionId);
        if (preview && preview.message) {
          const speaker = preview.agentId ? `${preview.agentId}: ` : "";
          console.log(`${head}\n  ${pc.gray(`${speaker}${preview.message}`)}`);
        } else {
          console.log(`${head}\n  ${pc.gray("(no messages yet)")}`);
        }
      }
      if (sessions.length > trimmed.length) {
        console.log(
          pc.gray(
            `… ${sessions.length - trimmed.length} more (raise --limit or use --json).`,
          ),
        );
      }
    });

  session
    .command("setup-guides <sessionId>")
    .description("Generate or update AGENTS.md and CLAUDE.md with session coordination rules")
    .option("--path <path>", "Workspace path for the session", ".")
    .option("--json", "Emit machine-readable output")
    .action(async (sessionId, options, command) => {
      const normalizedSessionId = normalizeString(sessionId);
      if (!normalizedSessionId) {
        throw new Error("session id is required.");
      }
      const targetPath = path.resolve(process.cwd(), String(options.path || "."));
      const result = await setupSessionGuides(normalizedSessionId, {
        targetPath,
      });
      const payload = {
        command: "session setup-guides",
        targetPath,
        sessionId: normalizedSessionId,
        sectionHeading: result.sectionHeading,
        agents: result.agents,
        claude: result.claude,
        sessionGuide: result.sessionGuide,
      };
      if (shouldEmitJson(options, command)) {
        console.log(JSON.stringify(payload, null, 2));
        return;
      }

      console.log(pc.bold(`Session guide sync complete for ${normalizedSessionId}`));
      console.log(pc.gray(`AGENTS.md: changed=${result.agents.changed} path=${result.agents.path}`));
      console.log(pc.gray(`CLAUDE.md: changed=${result.claude.changed} path=${result.claude.path}`));
      console.log(
        pc.gray(
          `.sentinelayer/AGENTS_SESSION_GUIDE.md: changed=${result.sessionGuide.changed} path=${result.sessionGuide.path}`
        )
      );
    });

  session
    .command("inject-guide <sessionId>")
    .description("Append coordination section to existing AGENTS.md and CLAUDE.md files")
    .option("--path <path>", "Workspace path for the session", ".")
    .option("--json", "Emit machine-readable output")
    .action(async (sessionId, options, command) => {
      const normalizedSessionId = normalizeString(sessionId);
      if (!normalizedSessionId) {
        throw new Error("session id is required.");
      }
      const targetPath = path.resolve(process.cwd(), String(options.path || "."));
      const result = await injectSessionGuides(normalizedSessionId, {
        targetPath,
      });
      const payload = {
        command: "session inject-guide",
        targetPath,
        sessionId: normalizedSessionId,
        sectionHeading: result.sectionHeading,
        agents: result.agents,
        claude: result.claude,
      };
      if (shouldEmitJson(options, command)) {
        console.log(JSON.stringify(payload, null, 2));
        return;
      }

      console.log(pc.bold(`Session guide section injected for ${normalizedSessionId}`));
      console.log(pc.gray(`AGENTS.md: existed=${result.agents.existed} changed=${result.agents.changed}`));
      console.log(pc.gray(`CLAUDE.md: existed=${result.claude.existed} changed=${result.claude.changed}`));
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
    .command("admin-kill <sessionId>")
    .description("Admin: kill a remote session through sentinelayer-api")
    .option("--reason <reason>", "Kill reason", "admin_kill")
    .option("--api-url <url>", "Override Sentinelayer API base URL")
    .option("--path <path>", "Workspace path for local stream sync", ".")
    .option("--json", "Emit machine-readable output")
    .action(async (sessionId, options, command) => {
      const normalizedSessionId = normalizeString(sessionId);
      if (!normalizedSessionId) {
        throw new Error("session id is required.");
      }
      const targetPath = path.resolve(process.cwd(), String(options.path || "."));
      const reason = normalizeString(options.reason) || "admin_kill";

      let apiSession;
      try {
        apiSession = await resolveAdminApiSession({
          targetPath,
          explicitApiUrl: options.apiUrl,
        });
      } catch (error) {
        throw new Error(formatApiError(error));
      }

      let result;
      try {
        result = await postAdminSessionMutation({
          session: apiSession,
          pathSuffix: `/api/v1/admin/sessions/${encodeURIComponent(normalizedSessionId)}/kill`,
          operationName: "session-admin-kill",
          body: { reason },
        });
      } catch (error) {
        throw new Error(formatApiError(error));
      }

      let localEvent = null;
      try {
        localEvent = await emitLocalAdminKillEvent(normalizedSessionId, {
          targetPath,
          reason,
          scope: "session",
          apiResult: result,
        });
      } catch {
        localEvent = null;
      }

      const payload = {
        command: "session admin-kill",
        targetPath,
        sessionId: normalizedSessionId,
        reason,
        apiUrl: apiSession.apiUrl,
        tokenSource: apiSession.source,
        result,
        localEventEmitted: Boolean(localEvent),
      };
      if (shouldEmitJson(options, command)) {
        console.log(JSON.stringify(payload, null, 2));
        return;
      }
      console.log(pc.bold(`Admin kill completed for session ${normalizedSessionId}`));
      console.log(pc.gray(`api=${apiSession.apiUrl} source=${apiSession.source} reason=${reason}`));
      if (payload.localEventEmitted) {
        console.log(pc.gray("Local stream event emitted."));
      }
    });

  session
    .command("admin-kill-all")
    .description("Admin: kill all active remote sessions (requires --confirm)")
    .option("--confirm", "Required confirmation flag")
    .option("--reason <reason>", "Kill reason", "admin_global_kill")
    .option("--api-url <url>", "Override Sentinelayer API base URL")
    .option("--path <path>", "Workspace path for local stream sync", ".")
    .option("--json", "Emit machine-readable output")
    .action(async (options, command) => {
      const targetPath = path.resolve(process.cwd(), String(options.path || "."));
      const reason = normalizeString(options.reason) || "admin_global_kill";
      const emitJson = shouldEmitJson(options, command);

      if (!options.confirm) {
        const confirmationMessage = "This will kill ALL active sessions. Pass --confirm to proceed.";
        const blockedPayload = {
          command: "session admin-kill-all",
          targetPath,
          blocked: true,
          reason,
          error: confirmationMessage,
        };
        if (emitJson) {
          console.log(JSON.stringify(blockedPayload, null, 2));
        } else {
          console.error(pc.red(confirmationMessage));
        }
        process.exitCode = 1;
        return;
      }

      let apiSession;
      try {
        apiSession = await resolveAdminApiSession({
          targetPath,
          explicitApiUrl: options.apiUrl,
        });
      } catch (error) {
        throw new Error(formatApiError(error));
      }

      let result;
      try {
        result = await postAdminSessionMutation({
          session: apiSession,
          pathSuffix: "/api/v1/admin/sessions/kill-all",
          operationName: "session-admin-kill-all",
          headers: {
            "X-Confirm-Kill-All": "true",
          },
          body: { reason },
        });
      } catch (error) {
        throw new Error(formatApiError(error));
      }

      const localSessions = await listActiveSessions({ targetPath });
      const localSessionIds = [];
      for (const item of localSessions) {
        try {
          const event = await emitLocalAdminKillEvent(item.sessionId, {
            targetPath,
            reason,
            scope: "global",
            apiResult: result,
          });
          if (event) {
            localSessionIds.push(item.sessionId);
          }
        } catch {
          // Best effort local mirror only.
        }
      }

      const payload = {
        command: "session admin-kill-all",
        targetPath,
        reason,
        apiUrl: apiSession.apiUrl,
        tokenSource: apiSession.source,
        result,
        localEventsEmitted: localSessionIds.length,
        localSessionIds,
      };
      if (emitJson) {
        console.log(JSON.stringify(payload, null, 2));
        return;
      }
      console.log(pc.bold("Admin kill-all completed"));
      console.log(pc.gray(`api=${apiSession.apiUrl} source=${apiSession.source} reason=${reason}`));
      if (localSessionIds.length > 0) {
        console.log(pc.gray(`local_events_emitted=${localSessionIds.length}`));
      }
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
      let lockRevocations = 0;
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

        const releasedLocks = await releaseFileLocksForAgent(sessionId, agentId, {
          targetPath,
          reason: `agent_killed:${reason}`,
          actorAgentId: "senti",
        });
        lockRevocations += Number(releasedLocks.releasedCount || 0);
        anyStopped = anyStopped || stopped;

        results.push({
          agentId,
          stopped,
          runtimeStops: stopDetails.runtimeStops,
          scopeStops: stopDetails.scopeStops,
          leaseRevocations: releasedCount,
          lockRevocations: Number(releasedLocks.releasedCount || 0),
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
        lockRevocations,
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
          `session=${sessionId} runtime_stops=${runtimeStops} scope_stops=${scopeStops} lease_revocations=${leaseRevocations} lock_revocations=${lockRevocations}`
        )
      );
      console.log(`stopped=${payload.stopped} reason=${reason} duration_ms=${durationMs}`);
    });
}
