import { randomUUID } from "node:crypto";
import process from "node:process";
import { setTimeout as sleep } from "node:timers/promises";

import { createAgentEvent } from "../events/schema.js";
import { appendToStream } from "../session/stream.js";
import { eventMatchesAgent } from "../session/listener.js";
import {
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
const JSON_RPC_VERSION = "2.0";
const CONTENT_LENGTH_PREFIX = "content-length:";

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

function eventAgentId(event = {}) {
  return normalizeAgentId(event?.agent?.id || event?.agentId || event?.agent_id, "");
}

function eventName(event = {}) {
  return normalizeString(event?.event || event?.type).toLowerCase();
}

function isControlEvent(event = {}) {
  const name = eventName(event);
  const payload = isPlainObject(event?.payload) ? event.payload : {};
  return (
    name.startsWith("session_listen_") ||
    name === "agent_heartbeat" ||
    normalizeString(payload.source).toLowerCase() === "session_listen"
  );
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
    sleepFn = sleep,
    attempts = SESSION_MCP_CONFIRM_ATTEMPTS,
    delayMs = SESSION_MCP_CONFIRM_DELAY_MS,
    pageLimit = SESSION_MCP_CONFIRM_PAGE_LIMIT,
    maxPages = SESSION_MCP_CONFIRM_MAX_PAGES,
  } = {},
) {
  let lastReason = "not_visible";
  let checked = 0;
  let pages = 0;
  const normalizedAnchorCursor = normalizeString(anchorCursor) || null;
  const normalizedAttempts = normalizePositiveInteger(attempts, SESSION_MCP_CONFIRM_ATTEMPTS);
  const normalizedDelayMs = normalizePositiveInteger(delayMs, SESSION_MCP_CONFIRM_DELAY_MS);
  const normalizedPageLimit = normalizeLimit(pageLimit);
  const normalizedMaxPages = normalizePositiveInteger(maxPages, SESSION_MCP_CONFIRM_MAX_PAGES);

  for (let attempt = 1; attempt <= normalizedAttempts; attempt += 1) {
    let pageCursor = normalizedAnchorCursor;
    for (let page = 1; page <= normalizedMaxPages; page += 1) {
      pages += 1;
      const result = await pollSessionEventsFn(sessionId, {
        targetPath,
        since: pageCursor,
        limit: normalizedPageLimit,
        forceCircuitProbe: true,
      });
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
    if (attempt < normalizedAttempts) {
      await sleepFn(normalizedDelayMs);
    }
  }

  return {
    confirmed: false,
    reason: lastReason,
    checked,
    pages,
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
        if (!includeControlEvents && isControlEvent(event)) return false;
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
