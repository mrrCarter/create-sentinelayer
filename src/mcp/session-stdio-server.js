import { createHash, randomUUID } from "node:crypto";
import process from "node:process";
import { setTimeout as sleep } from "node:timers/promises";

import { createAgentEvent } from "../events/schema.js";
import { appendToStream } from "../session/stream.js";
import { listFileLocks, lockFile, unlockFile } from "../session/file-locks.js";
import { eventMatchesAgent } from "../session/listener.js";
import { isSessionControlEvent } from "../session/control-events.js";
import {
  createSessionMessageAction,
  listSessionMessageActions,
  pollSessionEvents,
  pollSessionEventsBefore,
  syncSessionEventToApi,
} from "../session/sync.js";

export const SESSION_MCP_SERVER_NAME = "sentinelayer-session-mcp";
export const SESSION_MCP_PROTOCOL_VERSION = "2025-06-18";

const MAX_MESSAGE_CHARS = 16_000;
const MAX_TOOL_LIMIT = 200;
const DEFAULT_TOOL_LIMIT = 50;
const SESSION_MCP_CONFIRM_ATTEMPTS = 3;
const SESSION_MCP_CONFIRM_DELAY_MS = 250;
const SESSION_MCP_CONFIRM_PAGE_LIMIT = 200;
const SESSION_MCP_CONFIRM_MAX_PAGES = 10;
const SESSION_MCP_CONFIRM_TOTAL_TIMEOUT_MS = 10_000;
const SESSION_MCP_CONFIRM_REQUEST_TIMEOUT_MS = 2_000;
const JSON_RPC_VERSION = "2.0";
const CONTENT_LENGTH_PREFIX = "content-length:";
const SESSION_MESSAGE_ACTION_TYPES = new Set([
  "ack",
  "working_on",
  "reply",
  "like",
  "dislike",
  "disregard",
  "view",
]);
const SESSION_MESSAGE_ACTION_ALIASES = new Map([["comment", "reply"]]);

function normalizeString(value) {
  return String(value == null ? "" : value).trim();
}

function normalizeAgentId(value, fallbackValue = "") {
  const normalized = normalizeString(value)
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return normalized || fallbackValue;
}

function normalizePositiveInteger(value, fallbackValue) {
  if (value === undefined || value === null || String(value).trim() === "") {
    return fallbackValue;
  }
  const normalized = Number(value);
  if (!Number.isFinite(normalized) || normalized <= 0) {
    return fallbackValue;
  }
  return Math.floor(normalized);
}

function normalizeOptionalPositiveInteger(value, fieldName) {
  if (value === undefined || value === null || String(value).trim() === "") {
    return null;
  }
  const normalized = Number(value);
  if (!Number.isFinite(normalized) || normalized <= 0) {
    throw new Error(`${fieldName} must be a positive integer.`);
  }
  return Math.floor(normalized);
}

function confirmationRemainingMs(deadlineMs, nowMs) {
  const now = Number(nowMs()) || Date.now();
  return Math.max(0, Math.floor(deadlineMs - now));
}

function normalizeLimit(value) {
  return Math.max(1, Math.min(MAX_TOOL_LIMIT, normalizePositiveInteger(value, DEFAULT_TOOL_LIMIT)));
}

function truncateText(value, maxChars = MAX_MESSAGE_CHARS) {
  const normalized = normalizeString(value);
  if (normalized.length <= maxChars) {
    return { text: normalized, truncated: false };
  }
  return {
    text: normalized.slice(0, maxChars),
    truncated: true,
  };
}

function normalizeRecipients(value) {
  if (value === undefined || value === null) return [];
  const items = Array.isArray(value) ? value : String(value).split(/[\s,;]+/g);
  const seen = new Set();
  const recipients = [];
  for (const item of items) {
    const normalized = normalizeAgentId(item, "");
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    recipients.push(normalized);
  }
  return recipients;
}

function normalizeFileList(value) {
  const items = Array.isArray(value) ? value : String(value || "").split(/[\n,]+/g);
  const seen = new Set();
  const files = [];
  for (const item of items) {
    const file = normalizeString(item);
    if (!file || seen.has(file)) continue;
    seen.add(file);
    files.push(file);
  }
  if (files.length === 0) {
    throw new Error("files must include at least one path.");
  }
  return files;
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function cleanObject(record = {}) {
  const cleaned = {};
  for (const [key, value] of Object.entries(record)) {
    if (value !== undefined) {
      cleaned[key] = value;
    }
  }
  return cleaned;
}

function shortSha256(value) {
  return createHash("sha256").update(String(value || "")).digest("hex").slice(0, 32);
}

function eventAgentId(event = {}) {
  return normalizeAgentId(event?.agent?.id || event?.agentId || event?.agent_id, "");
}

function safePayload(payload = {}) {
  if (!isPlainObject(payload)) return {};
  const next = { ...payload };
  if (typeof next.message === "string") {
    const truncated = truncateText(next.message, MAX_MESSAGE_CHARS);
    next.message = truncated.text;
    if (truncated.truncated) next.truncated = true;
  }
  return next;
}

function summarizeSessionEvent(event = {}) {
  return cleanObject({
    cursor: normalizeString(event.cursor) || null,
    sequenceId: normalizePositiveInteger(event.sequenceId ?? event.sequence_id, null),
    event: normalizeString(event.event || event.type),
    ts: normalizeString(event.ts || event.timestamp || event.createdAt || event.created_at),
    sessionId: normalizeString(event.sessionId || event.session_id),
    agent: isPlainObject(event.agent)
      ? cleanObject({
          id: normalizeString(event.agent.id),
          model: normalizeString(event.agent.model),
          role: normalizeString(event.agent.role),
          displayName: normalizeString(event.agent.displayName),
          clientKind: normalizeString(event.agent.clientKind),
        })
      : undefined,
    payload: safePayload(event.payload),
    eventId: normalizeString(event.eventId),
    idempotencyToken: normalizeString(event.idempotencyToken),
  });
}

function sessionEventMatchesClientMessageId(event, clientMessageId) {
  const normalizedClientMessageId = normalizeString(clientMessageId);
  if (!normalizedClientMessageId || !isPlainObject(event)) {
    return false;
  }
  const payload = isPlainObject(event.payload) ? event.payload : {};
  const candidates = [
    event.id,
    event.eventId,
    event.event_id,
    event.idempotencyToken,
    event.idempotency_token,
    event.clientMessageId,
    event.client_message_id,
    payload.id,
    payload.messageId,
    payload.message_id,
    payload.eventId,
    payload.event_id,
    payload.idempotencyToken,
    payload.idempotency_token,
    payload.clientMessageId,
    payload.client_message_id,
  ];
  return candidates.some((candidate) => normalizeString(candidate) === normalizedClientMessageId);
}

async function readSessionConfirmationAnchor(sessionId, { targetPath, pollSessionEventsBeforeFn = pollSessionEventsBefore } = {}) {
  const result = await pollSessionEventsBeforeFn(sessionId, {
    targetPath,
    limit: 1,
    forceCircuitProbe: true,
  });
  if (!result?.ok) {
    return {
      ok: false,
      reason: normalizeString(result?.reason) || "confirmation_anchor_failed",
      cursor: null,
    };
  }
  const events = Array.isArray(result.events) ? result.events : [];
  const lastEvent = events[events.length - 1] || null;
  return {
    ok: true,
    reason: "",
    cursor: normalizeString(lastEvent?.cursor) || normalizeString(result.cursor) || null,
    sequenceId: normalizePositiveInteger(lastEvent?.sequenceId ?? lastEvent?.sequence_id, null),
  };
}

async function confirmSessionEventVisible(
  sessionId,
  clientMessageId,
  {
    targetPath,
    anchorCursor = null,
    pollSessionEventsFn = pollSessionEvents,
    pollSessionEventsBeforeFn = pollSessionEventsBefore,
    sleepFn = sleep,
    nowMs = Date.now,
    attempts = SESSION_MCP_CONFIRM_ATTEMPTS,
    delayMs = SESSION_MCP_CONFIRM_DELAY_MS,
    pageLimit = SESSION_MCP_CONFIRM_PAGE_LIMIT,
    maxPages = SESSION_MCP_CONFIRM_MAX_PAGES,
    totalTimeoutMs = SESSION_MCP_CONFIRM_TOTAL_TIMEOUT_MS,
    requestTimeoutMs = SESSION_MCP_CONFIRM_REQUEST_TIMEOUT_MS,
  } = {},
) {
  let lastReason = "not_visible";
  let checked = 0;
  let pages = 0;
  let tailChecks = 0;
  const normalizedAnchorCursor = normalizeString(anchorCursor) || null;
  const normalizedAttempts = normalizePositiveInteger(attempts, SESSION_MCP_CONFIRM_ATTEMPTS);
  const normalizedDelayMs = normalizePositiveInteger(delayMs, SESSION_MCP_CONFIRM_DELAY_MS);
  const normalizedPageLimit = normalizeLimit(pageLimit);
  const normalizedMaxPages = normalizePositiveInteger(maxPages, SESSION_MCP_CONFIRM_MAX_PAGES);
  const normalizedTotalTimeoutMs = normalizePositiveInteger(
    totalTimeoutMs,
    SESSION_MCP_CONFIRM_TOTAL_TIMEOUT_MS,
  );
  const normalizedRequestTimeoutMs = normalizePositiveInteger(
    requestTimeoutMs,
    SESSION_MCP_CONFIRM_REQUEST_TIMEOUT_MS,
  );
  const deadlineMs = (Number(nowMs()) || Date.now()) + normalizedTotalTimeoutMs;
  const nextRequestTimeoutMs = () => {
    const remaining = confirmationRemainingMs(deadlineMs, nowMs);
    if (remaining <= 0) return 0;
    return Math.max(1, Math.min(normalizedRequestTimeoutMs, remaining));
  };

  const maybeConfirmFromLatestTail = async () => {
    const timeoutMs = nextRequestTimeoutMs();
    if (timeoutMs <= 0) {
      lastReason = "confirmation_timeout";
      return null;
    }
    tailChecks += 1;
    let result = null;
    try {
      result = await pollSessionEventsBeforeFn(sessionId, {
        targetPath,
        limit: normalizedPageLimit,
        timeoutMs,
        forceCircuitProbe: true,
      });
    } catch (error) {
      lastReason = normalizeString(error?.code || error?.message) || "confirmation_tail_poll_failed";
      return null;
    }
    if (!result?.ok) {
      lastReason = normalizeString(result?.reason) || "confirmation_tail_poll_failed";
      return null;
    }
    const events = Array.isArray(result.events) ? result.events : [];
    checked += events.length;
    const confirmedEvent = events.find((candidate) => sessionEventMatchesClientMessageId(candidate, clientMessageId));
    if (!confirmedEvent) {
      lastReason = "not_visible";
      return null;
    }
    return {
      confirmed: true,
      reason: "",
      checked,
      pages,
      tailChecks,
      source: "latest_tail",
      anchorCursor: normalizedAnchorCursor,
      event: confirmedEvent,
    };
  };

  for (let attempt = 1; attempt <= normalizedAttempts; attempt += 1) {
    let pageCursor = normalizedAnchorCursor;
    for (let page = 1; page <= normalizedMaxPages; page += 1) {
      const timeoutMs = nextRequestTimeoutMs();
      if (timeoutMs <= 0) {
        return {
          confirmed: false,
          reason: "confirmation_timeout",
          checked,
          pages,
          tailChecks,
          anchorCursor: normalizedAnchorCursor,
        };
      }
      pages += 1;
      let result = null;
      try {
        result = await pollSessionEventsFn(sessionId, {
          targetPath,
          since: pageCursor,
          limit: normalizedPageLimit,
          timeoutMs,
          forceCircuitProbe: true,
        });
      } catch (error) {
        lastReason = normalizeString(error?.code || error?.message) || "confirmation_poll_failed";
        break;
      }
      if (!result?.ok) {
        lastReason = normalizeString(result?.reason) || "confirmation_poll_failed";
        break;
      }
      const events = Array.isArray(result.events) ? result.events : [];
      checked += events.length;
      const confirmedEvent = events.find((candidate) => sessionEventMatchesClientMessageId(candidate, clientMessageId));
      if (confirmedEvent) {
        return {
          confirmed: true,
          reason: "",
          checked,
          pages,
          tailChecks,
          source: "forward_cursor",
          anchorCursor: normalizedAnchorCursor,
          event: confirmedEvent,
        };
      }
      lastReason = "not_visible";
      const nextCursor = normalizeString(result.cursor);
      if (!events.length || !nextCursor || nextCursor === pageCursor) {
        break;
      }
      pageCursor = nextCursor;
    }
    const tailConfirmation = await maybeConfirmFromLatestTail();
    if (tailConfirmation) {
      return tailConfirmation;
    }
    if (attempt < normalizedAttempts) {
      const remaining = confirmationRemainingMs(deadlineMs, nowMs);
      if (remaining <= 0) {
        lastReason = "confirmation_timeout";
        break;
      }
      await sleepFn(Math.min(normalizedDelayMs, remaining));
    }
  }

  return {
    confirmed: false,
    reason: lastReason,
    checked,
    pages,
    tailChecks,
    anchorCursor: normalizedAnchorCursor,
  };
}

function messageActionActorId(action = {}) {
  return normalizeAgentId(action.actorId || action.actor_id || action.agentId || action.agent_id, "unknown");
}

function messageActionCreatedMs(action = {}) {
  const epoch = Date.parse(normalizeString(action.createdAt || action.created_at || action.ts || action.timestamp));
  return Number.isFinite(epoch) ? epoch : 0;
}

function isHumanMessageAction(action = {}) {
  if (action?.isHumanActivity === true) return true;
  if (normalizeString(action.actorKind || action.actor_kind).toLowerCase() === "human") return true;
  return messageActionActorId(action).startsWith("human-");
}

function summarizeMessageActionActivity(action = {}) {
  return cleanObject({
    id: normalizeString(action.id),
    sessionId: normalizeString(action.sessionId || action.session_id),
    targetSequenceId: normalizePositiveInteger(action.targetSequenceId ?? action.target_sequence_id, null),
    targetCursor: normalizeString(action.targetCursor || action.target_cursor),
    targetActionId: normalizeString(action.targetActionId || action.target_action_id),
    actionType: normalizeString(action.actionType || action.action_type),
    actorKind: normalizeString(action.actorKind || action.actor_kind),
    actorId: normalizeString(action.actorId || action.actor_id),
    actorRole: normalizeString(action.actorRole || action.actor_role),
    note: truncateText(action.note || action.message || "").text,
    createdAt: normalizeString(action.createdAt || action.created_at || action.ts || action.timestamp),
    activityType: normalizeString(action.activityType || action.activity_type) || "message_action",
    isHumanActivity: isHumanMessageAction(action),
  });
}

function recentHumanActivityFromActions(remoteActions = null, { limit = DEFAULT_TOOL_LIMIT } = {}) {
  const projected = remoteActions?.projection?.recentActivity;
  const source = Array.isArray(projected) && projected.length > 0 ? projected : remoteActions?.actions;
  return Array.isArray(source)
    ? source
        .filter((action) => action && typeof action === "object" && isHumanMessageAction(action))
        .sort((left, right) => {
          const timeDiff = messageActionCreatedMs(right) - messageActionCreatedMs(left);
          if (timeDiff !== 0) return timeDiff;
          return normalizeString(right.id).localeCompare(normalizeString(left.id));
        })
        .slice(0, normalizeLimit(limit))
        .map((action) => summarizeMessageActionActivity(action))
    : [];
}

function requireSessionId(input = {}) {
  const sessionId = normalizeString(input.sessionId || input.session_id || input.session);
  if (!sessionId) {
    throw new Error("sessionId is required.");
  }
  return sessionId;
}

function requireAgentId(input = {}) {
  const agentId = normalizeAgentId(input.agentId || input.agent_id || input.agent, "");
  if (!agentId || agentId === "cli-user" || agentId === "unknown" || agentId.startsWith("human-")) {
    throw new Error("agentId must be a non-human agent id.");
  }
  return agentId;
}

function normalizeSessionMessageActionType(value) {
  const raw = normalizeString(value).toLowerCase();
  const normalized = SESSION_MESSAGE_ACTION_ALIASES.get(raw) || raw;
  if (!SESSION_MESSAGE_ACTION_TYPES.has(normalized)) {
    throw new Error(
      `actionType must be one of: ${[...SESSION_MESSAGE_ACTION_TYPES].join(", ")}; aliases: comment=reply.`,
    );
  }
  return normalized;
}

function requireSessionActionTarget(input = {}) {
  const targetSequenceId = normalizeOptionalPositiveInteger(
    input.targetSequenceId || input.target_sequence_id || input.sequenceId || input.sequence_id,
    "targetSequenceId",
  );
  const targetCursor = normalizeString(input.targetCursor || input.target_cursor || input.cursor);
  const targetActionId = normalizeString(input.targetActionId || input.target_action_id || input.actionId);
  if (!targetSequenceId && !targetCursor && !targetActionId) {
    throw new Error("Provide targetSequenceId, targetCursor, or targetActionId.");
  }
  return {
    targetSequenceId,
    targetCursor,
    targetActionId,
  };
}

function defaultActionIdempotencyKey({
  actionType,
  targetSequenceId = null,
  targetCursor = "",
  targetActionId = "",
  note = "",
  agentId = "",
} = {}) {
  const target = targetSequenceId
    ? `seq:${targetSequenceId}`
    : targetActionId
      ? `action:${targetActionId}`
      : `cursor:${normalizeString(targetCursor)}`;
  const actor = normalizeAgentId(agentId, "unknown");
  return `mcp:${normalizeString(actionType).toLowerCase()}:${target}:${actor}:${shortSha256(note)}`;
}

function buildAgentEnvelope(agentId, input = {}) {
  return cleanObject({
    id: agentId,
    model: normalizeString(input.model || input.agentModel || input.agent_model) || "mcp",
    role: normalizeString(input.role) || "coder",
    displayName: normalizeString(input.displayName || input.display_name),
    clientKind: "mcp",
  });
}

function buildSessionMessageEvent({
  event,
  sessionId,
  agent,
  message,
  recipients = [],
  priority = "",
  idempotencyKey = "",
  nowIso = new Date().toISOString(),
  uuid = randomUUID,
  extraPayload = {},
} = {}) {
  const messageShape = truncateText(message);
  if (!messageShape.text) {
    throw new Error("message is required.");
  }

  const eventId = normalizeString(idempotencyKey) || `mcp-${event}-${uuid()}`;
  const payload = cleanObject({
    message: messageShape.text,
    channel: "session",
    source: "mcp",
    clientKind: "mcp",
    to: recipients.length > 0 ? recipients : undefined,
    priority: normalizeString(priority) || undefined,
    truncated: messageShape.truncated || undefined,
    ...extraPayload,
    clientMessageId: eventId,
  });
  return createAgentEvent({
    event,
    agent,
    sessionId,
    ts: nowIso,
    payload,
    eventId,
    idempotencyToken: eventId,
  });
}

async function runSessionAction({
  input = {},
  actionType,
  note = "",
  targetPath,
  createSessionMessageActionFn,
} = {}) {
  const sessionId = requireSessionId(input);
  const agentId = requireAgentId(input);
  const normalizedActionType = normalizeSessionMessageActionType(actionType || input.actionType || input.action_type);
  const target = requireSessionActionTarget(input);
  const normalizedNote = truncateText(note || input.note || input.message || input.text || "").text;
  const idempotencyKey =
    normalizeString(input.idempotencyKey || input.idempotency_key) ||
    defaultActionIdempotencyKey({
      actionType: normalizedActionType,
      ...target,
      note: normalizedNote,
      agentId,
    });

  if (Boolean(input.dryRun || input.dry_run)) {
    return {
      ok: true,
      dryRun: true,
      sessionId,
      agentId,
      actionType: normalizedActionType,
      ...target,
      note: normalizedNote,
      idempotencyKey,
    };
  }

  const result = await createSessionMessageActionFn(sessionId, {
    actionType: normalizedActionType,
    targetPath,
    ...target,
    note: normalizedNote,
    metadata: {
      source: "mcp",
      agentId,
    },
    idempotencyKey,
    timeoutMs: normalizePositiveInteger(input.timeoutMs || input.timeout_ms, 15_000),
  });

  return {
    ok: Boolean(result?.ok),
    reason: normalizeString(result?.reason),
    duplicate: Boolean(result?.duplicate),
    sessionId,
    agentId,
    actionType: normalizedActionType,
    ...target,
    note: normalizedNote,
    idempotencyKey,
    action: result?.action || null,
  };
}

async function persistSessionEvent({
  sessionId,
  event,
  targetPath,
  dryRun = false,
  syncSessionEventToApiFn = syncSessionEventToApi,
  pollSessionEventsBeforeFn = pollSessionEventsBefore,
  pollSessionEventsFn = pollSessionEvents,
  appendToStreamFn = appendToStream,
  sleepFn = sleep,
  confirmationAttempts = SESSION_MCP_CONFIRM_ATTEMPTS,
  confirmationDelayMs = SESSION_MCP_CONFIRM_DELAY_MS,
} = {}) {
  if (dryRun) {
    return {
      ok: true,
      dryRun: true,
      remoteSync: { synced: false, reason: "dry_run" },
      localCache: { cached: false, reason: "dry_run" },
      event: summarizeSessionEvent(event),
    };
  }

  const clientMessageId = normalizeString(event?.payload?.clientMessageId || event?.idempotencyToken || event?.eventId);
  const remoteConfirmationAnchor = await readSessionConfirmationAnchor(sessionId, {
    targetPath,
    pollSessionEventsBeforeFn,
  });
  if (!remoteConfirmationAnchor?.ok) {
    return {
      ok: false,
      reason: remoteConfirmationAnchor?.reason || "confirmation_anchor_failed",
      remoteSync: { synced: false, reason: "not_attempted" },
      remoteConfirmationAnchor,
      remoteConfirmation: {
        confirmed: false,
        reason: remoteConfirmationAnchor?.reason || "confirmation_anchor_failed",
        checked: 0,
        pages: 0,
        anchorCursor: null,
      },
      localCache: { cached: false, reason: "confirmation_anchor_failed" },
      event: summarizeSessionEvent(event),
    };
  }

  const remoteSync = await syncSessionEventToApiFn(sessionId, event, { targetPath });
  if (!remoteSync?.synced) {
    return {
      ok: false,
      reason: remoteSync?.reason || "remote_sync_failed",
      remoteSync,
      remoteConfirmationAnchor,
      remoteConfirmation: { confirmed: false, reason: "remote_sync_failed", checked: 0, pages: 0, anchorCursor: remoteConfirmationAnchor.cursor },
      localCache: { cached: false, reason: "remote_sync_failed" },
      event: summarizeSessionEvent(event),
    };
  }

  const remoteConfirmation = await confirmSessionEventVisible(sessionId, clientMessageId, {
    targetPath,
    anchorCursor: remoteConfirmationAnchor.cursor,
    pollSessionEventsFn,
    pollSessionEventsBeforeFn,
    sleepFn,
    attempts: confirmationAttempts,
    delayMs: confirmationDelayMs,
  });
  if (!remoteConfirmation?.confirmed) {
    return {
      ok: false,
      reason: remoteConfirmation?.reason || "remote_not_visible",
      remoteSync,
      remoteConfirmationAnchor,
      remoteConfirmation,
      localCache: { cached: false, reason: "remote_not_visible" },
      event: summarizeSessionEvent(event),
    };
  }

  let localCache = { cached: false, reason: "local_session_unavailable" };
  try {
    const persisted = await appendToStreamFn(sessionId, event, {
      targetPath,
      syncRemote: false,
    });
    localCache = {
      cached: true,
      event: summarizeSessionEvent(persisted),
    };
  } catch (error) {
    localCache = {
      cached: false,
      reason: normalizeString(error?.message) || "local_cache_failed",
    };
  }

  return {
    ok: true,
    reason: "",
    remoteSync,
    remoteConfirmationAnchor,
    remoteConfirmation,
    localCache,
    event: summarizeSessionEvent(event),
  };
}

export function createSessionMcpToolHandlers({
  targetPath = process.cwd(),
  pollSessionEventsFn = pollSessionEvents,
  pollSessionEventsBeforeFn = pollSessionEventsBefore,
  listSessionMessageActionsFn = listSessionMessageActions,
  createSessionMessageActionFn = createSessionMessageAction,
  lockFileFn = lockFile,
  unlockFileFn = unlockFile,
  listFileLocksFn = listFileLocks,
  syncSessionEventToApiFn = syncSessionEventToApi,
  appendToStreamFn = appendToStream,
  sleepFn = sleep,
  uuidFn = randomUUID,
  now = () => new Date().toISOString(),
} = {}) {
  return {
    async poll_inbox(input = {}) {
      const sessionId = requireSessionId(input);
      const agentId = requireAgentId(input);
      const cursor = normalizeString(input.cursor || input.after || input.since) || null;
      const limit = normalizeLimit(input.limit);
      const actionLimit = normalizeLimit(input.actionLimit || input.action_limit || limit);
      const includeActions = input.includeActions !== false && input.include_actions !== false;
      const includeSelf = Boolean(input.includeSelf || input.include_self);
      const includeControlEvents = Boolean(input.includeControlEvents || input.include_control_events);
      const includeRaw = Boolean(input.includeRaw || input.include_raw);

      const result = await pollSessionEventsFn(sessionId, {
        targetPath,
        since: cursor,
        limit,
        forceCircuitProbe: Boolean(input.forceCircuitProbe || input.force_circuit_probe),
      });
      if (!result?.ok) {
        return {
          ok: false,
          reason: result?.reason || "poll_failed",
          sessionId,
          agentId,
          cursor,
          events: [],
          eventCount: 0,
          inboxCount: 0,
        };
      }

      const events = (Array.isArray(result.events) ? result.events : []).filter((event) => {
        if (!includeControlEvents && isSessionControlEvent(event)) return false;
        if (!includeSelf && eventAgentId(event) === agentId) return false;
        return eventMatchesAgent(event, agentId);
      });
      const actionResult = includeActions
        ? await listSessionMessageActionsFn(sessionId, {
            targetPath,
            limit: actionLimit,
            forceCircuitProbe: Boolean(input.forceCircuitProbe || input.force_circuit_probe),
          })
        : null;
      const recentHumanActivity = actionResult?.ok
        ? recentHumanActivityFromActions(actionResult, { limit: actionLimit })
        : [];

      return {
        ok: true,
        reason: "",
        sessionId,
        agentId,
        cursor: normalizeString(result.cursor) || cursor,
        eventCount: Array.isArray(result.events) ? result.events.length : 0,
        inboxCount: events.length,
        recentHumanActivityCount: recentHumanActivity.length,
        recentHumanActivity,
        actionProjection: actionResult
          ? {
              ok: Boolean(actionResult.ok),
              reason: actionResult.reason || "",
              count: Array.isArray(actionResult.actions) ? actionResult.actions.length : 0,
            }
          : null,
        events: includeRaw ? events : events.map((event) => summarizeSessionEvent(event)),
      };
    },

    async send_message(input = {}) {
      const sessionId = requireSessionId(input);
      const agentId = requireAgentId(input);
      const recipients = normalizeRecipients(input.to || input.recipient || input.recipients);
      const agent = buildAgentEnvelope(agentId, input);
      const event = buildSessionMessageEvent({
        event: "session_message",
        sessionId,
        agent,
        message: input.message || input.text,
        recipients,
        idempotencyKey: input.idempotencyKey || input.idempotency_key,
        nowIso: now(),
        uuid: uuidFn,
      });
      return persistSessionEvent({
        sessionId,
        event,
        targetPath,
        dryRun: Boolean(input.dryRun || input.dry_run),
        syncSessionEventToApiFn,
        pollSessionEventsBeforeFn,
        pollSessionEventsFn,
        appendToStreamFn,
        sleepFn,
      });
    },

    async session_action(input = {}) {
      return runSessionAction({
        input,
        targetPath,
        createSessionMessageActionFn,
      });
    },

    async session_react(input = {}) {
      const reaction = normalizeSessionMessageActionType(input.reaction || input.actionType || input.action_type);
      if (!["ack", "like", "dislike"].includes(reaction)) {
        throw new Error("reaction must be one of: ack, like, dislike.");
      }
      return runSessionAction({
        input,
        actionType: reaction,
        targetPath,
        createSessionMessageActionFn,
      });
    },

    async session_reply(input = {}) {
      return runSessionAction({
        input,
        actionType: "reply",
        note: input.message || input.text || input.note,
        targetPath,
        createSessionMessageActionFn,
      });
    },

    async session_lock(input = {}) {
      const sessionId = requireSessionId(input);
      const agentId = requireAgentId(input);
      const files = normalizeFileList(input.files || input.file || input.paths);
      const intent = normalizeString(input.intent || input.reason);
      const ttlSeconds = normalizePositiveInteger(input.ttlSeconds || input.ttl_seconds, 300);
      const results = [];
      for (const file of files) {
        const result = await lockFileFn(sessionId, agentId, file, {
          intent,
          ttlSeconds,
          targetPath,
          syncRemote: input.syncRemote !== false && input.sync_remote !== false,
          awaitRemoteSync: input.awaitRemoteSync !== false && input.await_remote_sync !== false,
        });
        results.push({
          file: normalizeString(result?.file) || file,
          locked: Boolean(result?.locked),
          reason: normalizeString(result?.reason) || (result?.locked ? "locked" : "held_by_other_agent"),
          heldBy: normalizeString(result?.heldBy) || null,
          since: normalizeString(result?.since) || null,
          lock: result?.lock || null,
        });
      }
      const failed = results.filter((result) => !result.locked);
      return {
        ok: failed.length === 0,
        reason: failed.length === 0 ? "" : "lock_conflict",
        sessionId,
        agentId,
        lockedCount: results.length - failed.length,
        failedCount: failed.length,
        results,
      };
    },

    async session_unlock(input = {}) {
      const sessionId = requireSessionId(input);
      const agentId = requireAgentId(input);
      const files = normalizeFileList(input.files || input.file || input.paths);
      const reason = normalizeString(input.reason || input.intent) || "manual_release";
      const results = [];
      for (const file of files) {
        const result = await unlockFileFn(sessionId, agentId, file, {
          reason,
          force: false,
          targetPath,
          syncRemote: input.syncRemote !== false && input.sync_remote !== false,
          awaitRemoteSync: input.awaitRemoteSync !== false && input.await_remote_sync !== false,
        });
        results.push({
          file: normalizeString(result?.file) || file,
          unlocked: Boolean(result?.unlocked),
          reason: normalizeString(result?.reason) || (result?.unlocked ? "unlocked" : "not_locked"),
          heldBy: normalizeString(result?.heldBy) || null,
          since: normalizeString(result?.since) || null,
          lock: result?.lock || null,
        });
      }
      const failed = results.filter((result) => !result.unlocked && result.reason !== "not_locked");
      return {
        ok: failed.length === 0,
        reason: failed.length === 0 ? "" : "unlock_failed",
        sessionId,
        agentId,
        unlockedCount: results.filter((result) => result.unlocked).length,
        skippedCount: results.filter((result) => !result.unlocked && result.reason === "not_locked").length,
        failedCount: failed.length,
        results,
      };
    },

    async session_locks(input = {}) {
      const sessionId = requireSessionId(input);
      const locks = await listFileLocksFn(sessionId, {
        targetPath,
      });
      return {
        ok: true,
        reason: "",
        sessionId,
        lockCount: Array.isArray(locks) ? locks.length : 0,
        locks: Array.isArray(locks) ? locks : [],
      };
    },

    async attention_request(input = {}) {
      const sessionId = requireSessionId(input);
      const agentId = requireAgentId(input);
      const recipients = normalizeRecipients(input.to || input.recipient || input.recipients);
      const agent = buildAgentEnvelope(agentId, {
        ...input,
        role: normalizeString(input.role) || "observer",
      });
      const event = buildSessionMessageEvent({
        event: "help_request",
        sessionId,
        agent,
        message: input.message || input.reason || input.text,
        recipients,
        priority: normalizeString(input.priority) || "high",
        idempotencyKey: input.idempotencyKey || input.idempotency_key,
        nowIso: now(),
        uuid: uuidFn,
        extraPayload: cleanObject({
          requestType: "attention",
          severity: normalizeString(input.severity) || "normal",
        }),
      });
      return persistSessionEvent({
        sessionId,
        event,
        targetPath,
        dryRun: Boolean(input.dryRun || input.dry_run),
        syncSessionEventToApiFn,
        pollSessionEventsBeforeFn,
        pollSessionEventsFn,
        appendToStreamFn,
        sleepFn,
      });
    },
  };
}

export const SESSION_MCP_TOOLS = Object.freeze([
  {
    name: "poll_inbox",
    title: "Poll Senti Inbox",
    description:
      "Poll durable SentinelLayer session events after an optional cursor and return only events addressed or visible to the agent.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["sessionId", "agentId"],
      properties: {
        sessionId: { type: "string", minLength: 1 },
        agentId: { type: "string", minLength: 1 },
        cursor: { type: "string" },
        limit: { type: "integer", minimum: 1, maximum: MAX_TOOL_LIMIT, default: DEFAULT_TOOL_LIMIT },
        actionLimit: { type: "integer", minimum: 1, maximum: MAX_TOOL_LIMIT, default: DEFAULT_TOOL_LIMIT },
        includeActions: { type: "boolean", default: true },
        includeSelf: { type: "boolean", default: false },
        includeControlEvents: { type: "boolean", default: false },
        includeRaw: { type: "boolean", default: false },
      },
    },
  },
  {
    name: "send_message",
    title: "Send Senti Message",
    description:
      "Send an authenticated agent session_message through the canonical SentinelLayer session event API.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["sessionId", "agentId", "message"],
      properties: {
        sessionId: { type: "string", minLength: 1 },
        agentId: { type: "string", minLength: 1 },
        message: { type: "string", minLength: 1, maxLength: MAX_MESSAGE_CHARS },
        to: {
          anyOf: [
            { type: "string" },
            { type: "array", items: { type: "string" } },
          ],
        },
        model: { type: "string" },
        role: { type: "string" },
        displayName: { type: "string" },
        idempotencyKey: { type: "string" },
        dryRun: { type: "boolean", default: false },
      },
    },
  },
  {
    name: "session_action",
    title: "Record Senti Session Action",
    description:
      "Record a low-noise message action such as ack, working_on, disregard, view, like, dislike, or reply against a target session event.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["sessionId", "agentId", "actionType"],
      properties: {
        sessionId: { type: "string", minLength: 1 },
        agentId: { type: "string", minLength: 1 },
        actionType: { type: "string", enum: [...SESSION_MESSAGE_ACTION_TYPES] },
        targetSequenceId: { type: "integer", minimum: 1 },
        targetCursor: { type: "string" },
        targetActionId: { type: "string" },
        note: { type: "string", maxLength: MAX_MESSAGE_CHARS },
        idempotencyKey: { type: "string" },
        timeoutMs: { type: "integer", minimum: 1, default: 15000 },
        dryRun: { type: "boolean", default: false },
      },
    },
  },
  {
    name: "session_react",
    title: "React To Senti Message",
    description:
      "Acknowledge or react to a target session event with ack, like, or dislike.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["sessionId", "agentId", "reaction"],
      properties: {
        sessionId: { type: "string", minLength: 1 },
        agentId: { type: "string", minLength: 1 },
        reaction: { type: "string", enum: ["ack", "like", "dislike"] },
        targetSequenceId: { type: "integer", minimum: 1 },
        targetCursor: { type: "string" },
        targetActionId: { type: "string" },
        idempotencyKey: { type: "string" },
        timeoutMs: { type: "integer", minimum: 1, default: 15000 },
        dryRun: { type: "boolean", default: false },
      },
    },
  },
  {
    name: "session_reply",
    title: "Reply In Senti Thread",
    description:
      "Add a threaded reply/comment under a specific session event using the session action channel.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["sessionId", "agentId", "targetSequenceId", "message"],
      properties: {
        sessionId: { type: "string", minLength: 1 },
        agentId: { type: "string", minLength: 1 },
        targetSequenceId: { type: "integer", minimum: 1 },
        targetCursor: { type: "string" },
        targetActionId: { type: "string" },
        message: { type: "string", minLength: 1, maxLength: MAX_MESSAGE_CHARS },
        idempotencyKey: { type: "string" },
        timeoutMs: { type: "integer", minimum: 1, default: 15000 },
        dryRun: { type: "boolean", default: false },
      },
    },
  },
  {
    name: "session_lock",
    title: "Lock Senti Files",
    description:
      "Claim session-scoped file locks before editing files, using the same fail-closed lock registry as the CLI.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["sessionId", "agentId", "files"],
      properties: {
        sessionId: { type: "string", minLength: 1 },
        agentId: { type: "string", minLength: 1 },
        files: {
          anyOf: [
            { type: "string" },
            { type: "array", items: { type: "string" }, minItems: 1 },
          ],
        },
        intent: { type: "string" },
        ttlSeconds: { type: "integer", minimum: 1, default: 300 },
        syncRemote: { type: "boolean", default: true },
        awaitRemoteSync: { type: "boolean", default: true },
      },
    },
  },
  {
    name: "session_unlock",
    title: "Unlock Senti Files",
    description:
      "Release session-scoped file locks held by an agent.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["sessionId", "agentId", "files"],
      properties: {
        sessionId: { type: "string", minLength: 1 },
        agentId: { type: "string", minLength: 1 },
        files: {
          anyOf: [
            { type: "string" },
            { type: "array", items: { type: "string" }, minItems: 1 },
          ],
        },
        reason: { type: "string" },
        syncRemote: { type: "boolean", default: true },
        awaitRemoteSync: { type: "boolean", default: true },
      },
    },
  },
  {
    name: "session_locks",
    title: "List Senti File Locks",
    description:
      "List active file locks for a session.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["sessionId"],
      properties: {
        sessionId: { type: "string", minLength: 1 },
      },
    },
  },
  {
    name: "attention_request",
    title: "Request Senti Attention",
    description:
      "Create a help_request event for high-signal agent or human attention without relying on chat polling.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["sessionId", "agentId", "message"],
      properties: {
        sessionId: { type: "string", minLength: 1 },
        agentId: { type: "string", minLength: 1 },
        message: { type: "string", minLength: 1, maxLength: MAX_MESSAGE_CHARS },
        to: {
          anyOf: [
            { type: "string" },
            { type: "array", items: { type: "string" } },
          ],
        },
        priority: { type: "string", default: "high" },
        severity: { type: "string", default: "normal" },
        model: { type: "string" },
        role: { type: "string" },
        displayName: { type: "string" },
        idempotencyKey: { type: "string" },
        dryRun: { type: "boolean", default: false },
      },
    },
  },
]);

function toMcpTool(tool) {
  return {
    name: tool.name,
    title: tool.title,
    description: tool.description,
    inputSchema: tool.inputSchema,
  };
}

function buildToolResult(payload, { isError = false } = {}) {
  const structuredContent = isPlainObject(payload) ? payload : { value: payload };
  return cleanObject({
    content: [
      {
        type: "text",
        text: JSON.stringify(structuredContent),
      },
    ],
    structuredContent,
    isError: isError ? true : undefined,
  });
}

function jsonRpcSuccess(id, result) {
  return {
    jsonrpc: JSON_RPC_VERSION,
    id,
    result,
  };
}

function jsonRpcError(id, code, message, data = undefined) {
  return cleanObject({
    jsonrpc: JSON_RPC_VERSION,
    id: id ?? null,
    error: cleanObject({
      code,
      message,
      data,
    }),
  });
}

export async function handleMcpJsonRpcMessage(
  message,
  {
    targetPath = process.cwd(),
    handlers = createSessionMcpToolHandlers({ targetPath }),
    tools = SESSION_MCP_TOOLS,
  } = {}
) {
  if (!isPlainObject(message)) {
    return jsonRpcError(null, -32600, "Invalid Request");
  }
  const id = message.id;
  const method = normalizeString(message.method);
  const isNotification = id === undefined || id === null;

  if (!method) {
    return isNotification ? null : jsonRpcError(id, -32600, "Invalid Request");
  }

  if (method === "notifications/initialized") {
    return null;
  }

  if (method === "initialize") {
    if (isNotification) return null;
    return jsonRpcSuccess(id, {
      protocolVersion:
        normalizeString(message.params?.protocolVersion) || SESSION_MCP_PROTOCOL_VERSION,
      capabilities: {
        tools: {
          listChanged: false,
        },
      },
      serverInfo: {
        name: SESSION_MCP_SERVER_NAME,
        version: "0.20.0",
      },
      instructions:
        "Use poll_inbox with the returned cursor before acting; use send_message for durable session posts and attention_request for help_request events.",
    });
  }

  if (method === "ping") {
    return isNotification ? null : jsonRpcSuccess(id, {});
  }

  if (method === "tools/list") {
    if (isNotification) return null;
    return jsonRpcSuccess(id, {
      tools: tools.map((tool) => toMcpTool(tool)),
    });
  }

  if (method === "tools/call") {
    if (isNotification) return null;
    const toolName = normalizeString(message.params?.name);
    const args = isPlainObject(message.params?.arguments) ? message.params.arguments : {};
    const handler = handlers[toolName];
    if (typeof handler !== "function") {
      return jsonRpcSuccess(
        id,
        buildToolResult(
          {
            ok: false,
            reason: "unknown_tool",
            tool: toolName,
          },
          { isError: true },
        ),
      );
    }
    try {
      const result = await handler(args);
      return jsonRpcSuccess(id, buildToolResult(result, { isError: result?.ok === false }));
    } catch (error) {
      return jsonRpcSuccess(
        id,
        buildToolResult(
          {
            ok: false,
            reason: normalizeString(error?.message) || "tool_failed",
            tool: toolName,
          },
          { isError: true },
        ),
      );
    }
  }

  return isNotification ? null : jsonRpcError(id, -32601, "Method not found");
}

function findHeaderSeparator(buffer) {
  const crlf = buffer.indexOf("\r\n\r\n");
  if (crlf >= 0) {
    return { index: crlf, length: 4 };
  }
  const lf = buffer.indexOf("\n\n");
  if (lf >= 0) {
    return { index: lf, length: 2 };
  }
  return null;
}

function stripLeadingBlankLines(buffer) {
  let start = 0;
  while (start < buffer.length && (buffer[start] === 0x0a || buffer[start] === 0x0d)) {
    start += 1;
  }
  return start > 0 ? buffer.subarray(start) : buffer;
}

export function readNextMcpMessage(buffer) {
  let nextBuffer = stripLeadingBlankLines(Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer || ""));
  if (nextBuffer.length === 0) return null;

  const prefix = nextBuffer.subarray(0, Math.min(nextBuffer.length, 32)).toString("utf8").toLowerCase();
  if (prefix.startsWith(CONTENT_LENGTH_PREFIX)) {
    const separator = findHeaderSeparator(nextBuffer);
    if (!separator) return null;
    const header = nextBuffer.subarray(0, separator.index).toString("utf8");
    const lengthLine = header
      .split(/\r?\n/g)
      .find((line) => line.toLowerCase().startsWith(CONTENT_LENGTH_PREFIX));
    const length = Number(normalizeString(lengthLine?.slice(CONTENT_LENGTH_PREFIX.length)));
    if (!Number.isFinite(length) || length < 0) {
      throw new Error("Invalid Content-Length header.");
    }
    const bodyStart = separator.index + separator.length;
    const bodyEnd = bodyStart + length;
    if (nextBuffer.length < bodyEnd) return null;
    return {
      raw: nextBuffer.subarray(bodyStart, bodyEnd).toString("utf8"),
      rest: nextBuffer.subarray(bodyEnd),
    };
  }

  const newlineIndex = nextBuffer.indexOf("\n");
  if (newlineIndex < 0) return null;
  const raw = nextBuffer.subarray(0, newlineIndex).toString("utf8").trim();
  return {
    raw,
    rest: nextBuffer.subarray(newlineIndex + 1),
  };
}

export function writeMcpJsonRpcMessage(stream, message, { framing = "newline" } = {}) {
  const payload = JSON.stringify(message);
  if (normalizeString(framing).toLowerCase() === "content-length") {
    stream.write(`Content-Length: ${Buffer.byteLength(payload, "utf8")}\r\n\r\n${payload}`);
    return;
  }
  stream.write(`${payload}\n`);
}

export async function runMcpStdioServer({
  stdin = process.stdin,
  stdout = process.stdout,
  stderr = process.stderr,
  targetPath = process.cwd(),
  framing = "newline",
  handlers = createSessionMcpToolHandlers({ targetPath }),
  tools = SESSION_MCP_TOOLS,
} = {}) {
  let buffer = Buffer.alloc(0);
  let chain = Promise.resolve();

  function enqueue(raw) {
    chain = chain.then(async () => {
      let message;
      try {
        message = JSON.parse(raw);
      } catch (error) {
        writeMcpJsonRpcMessage(
          stdout,
          jsonRpcError(null, -32700, "Parse error", normalizeString(error?.message)),
          { framing },
        );
        return;
      }
      const response = await handleMcpJsonRpcMessage(message, {
        targetPath,
        handlers,
        tools,
      });
      if (response) {
        writeMcpJsonRpcMessage(stdout, response, { framing });
      }
    }).catch((error) => {
      try {
        stderr.write(`${normalizeString(error?.message) || "mcp_server_error"}\n`);
      } catch {
        // Ignore stderr failures; stdout must remain protocol-only.
      }
    });
  }

  return new Promise((resolve, reject) => {
    stdin.on("data", (chunk) => {
      buffer = Buffer.concat([buffer, Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)]);
      try {
        while (true) {
          const parsed = readNextMcpMessage(buffer);
          if (!parsed) break;
          buffer = parsed.rest;
          if (!normalizeString(parsed.raw)) continue;
          enqueue(parsed.raw);
        }
      } catch (error) {
        reject(error);
      }
    });
    stdin.on("error", reject);
    stdin.on("end", () => {
      chain.then(resolve, reject);
    });
    if (typeof stdin.resume === "function") {
      stdin.resume();
    }
  });
}
