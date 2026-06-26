import fsp from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { setTimeout as sleep } from "node:timers/promises";
import { createHash, randomUUID } from "node:crypto";
import { spawn as defaultSpawn } from "node:child_process";

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
  rememberAgentIdentity,
  registerAgent,
  unregisterAgent,
} from "../session/agent-registry.js";
import { inferSessionAgentIdentity } from "../session/agent-identity.js";
import { startSenti, stopSenti } from "../session/daemon.js";
import {
  getDaemonStatus,
  removeDaemonPidRecord,
  spawnDetachedSentiDaemon,
  writeDaemonPidRecord,
} from "../session/daemon-spawn.js";
import { listRuntimeRuns } from "../session/runtime-bridge.js";
import {
  listFileLocks,
  lockFile,
  releaseFileLocksForAgent,
  unlockFile,
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
import { fetchSessionListeners, formatListenerLine } from "../session/listeners.js";
import {
  filterSessionMaterialEvents,
  isSessionControlEvent,
} from "../session/control-events.js";
import {
  acceptSessionInvitation,
  normalizeSessionOnboarding,
  writeSessionOnboardingBrief,
} from "../session/invitations.js";
import { postFirstSentiMessage } from "../session/first-message.js";
import { createListenerHostWake } from "../session/wake/listen-wake.js";
import { appendToStream, readStream, tailStream } from "../session/stream.js";
import {
  addSessionEventIdentityKeys,
  dedupeSessionEvents,
  sessionEventIdentityKeys,
  sessionEventUpgradesExisting,
  sessionEventHasKnownIdentity,
} from "../session/event-identity.js";
import { readSessionPreview } from "../session/preview.js";
import {
  createSessionMessageAction,
  fetchSessionPinnedMessages,
  listSessionMessageActions,
  listSessionsFromApi,
  probeSessionAccess,
  pollSessionEvents,
  pollSessionEventsBefore,
  searchSessionEvents,
  syncSessionEventToApi,
  syncSessionMetadataToApi,
} from "../session/sync.js";
import { hydrateSessionFromRemote } from "../session/remote-hydrate.js";
import { mergeLiveSources } from "../session/live-source.js";
import { listenSessionEvents } from "../session/listener.js";
import { SESSION_LIVE_SUCCESS_TIPS } from "../session/coordination-guidance.js";
import {
  DEFAULT_ROTATING_LOG_MAX_BYTES,
  DEFAULT_ROTATING_LOG_MAX_FILES,
  installRotatingConsoleLog,
} from "../session/rotating-log.js";
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
  generateSessionCheckpointBatch,
  listSessionCheckpoints,
} from "../session/checkpoints.js";
import {
  buildCodexExecResumeInvocation,
  buildCodexWakePrompt,
  recordCodexWakeRegistration,
  runCodexExecResume,
} from "../session/wake/codex.js";
import createSentid from "../session/wake/sentid.js";
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

function messagePartsHaveContent(messageParts) {
  const parts = Array.isArray(messageParts) ? messageParts : [messageParts];
  return parts.some((part) => normalizeString(part));
}

function joinMessageParts(messageParts) {
  if (Array.isArray(messageParts)) {
    return messageParts.length === 1 ? String(messageParts[0] || "") : messageParts.join(" ");
  }
  return String(messageParts || "");
}

async function readUtf8FromStdin(stdin = process.stdin) {
  if (stdin.isTTY) {
    throw new Error("--stdin requires piped input.");
  }
  stdin.setEncoding("utf8");
  let text = "";
  for await (const chunk of stdin) {
    text += String(chunk);
  }
  return text;
}

async function resolveSessionSayMessageInput(messageParts, options = {}) {
  const hasPositionalMessage = messagePartsHaveContent(messageParts);
  const hasMessageFile = Boolean(normalizeString(options.messageFile));
  const hasStdin = Boolean(options.stdin);
  const sources = [hasPositionalMessage, hasMessageFile, hasStdin].filter(Boolean).length;
  if (sources > 1) {
    throw new Error("Use only one message source: positional message, --message-file, or --stdin.");
  }
  if (hasMessageFile) {
    return normalizeString(
      await fsp.readFile(path.resolve(process.cwd(), String(options.messageFile)), "utf-8"),
    );
  }
  if (hasStdin) {
    return normalizeString(await readUtf8FromStdin());
  }
  return normalizeString(joinMessageParts(messageParts));
}

function optionWasSetByCli(command, optionName) {
  if (!command || typeof command.getOptionValueSource !== "function") {
    return false;
  }
  return command.getOptionValueSource(optionName) === "cli";
}

const SESSION_SAY_CONFIRM_ATTEMPTS = 3;
const SESSION_SAY_CONFIRM_DELAY_MS = 250;
const SESSION_SAY_CONFIRM_PAGE_LIMIT = 200;
const SESSION_SAY_CONFIRM_MAX_PAGES = 10;
const SESSION_SAY_CONFIRM_TOTAL_TIMEOUT_MS = 10_000;
const SESSION_SAY_CONFIRM_REQUEST_TIMEOUT_MS = 2_000;
const SESSION_SAY_LOCAL_ONLY_REASONS = new Set([
  "no_session",
  "not_authenticated",
  "remote_sync_disabled_env",
]);
const SESSION_READ_AUTO_VIEW_TIMEOUT_MS = 500;

function isLocalOnlySessionSayReason(reason) {
  return SESSION_SAY_LOCAL_ONLY_REASONS.has(normalizeString(reason));
}

function sessionEventMatchesClientMessageId(event, clientMessageId) {
  const normalizedClientMessageId = normalizeString(clientMessageId);
  if (!normalizedClientMessageId || !event || typeof event !== "object") {
    return false;
  }
  const payload = event.payload && typeof event.payload === "object" ? event.payload : {};
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

async function readSessionConfirmationAnchor(sessionId, { targetPath } = {}) {
  const result = await pollSessionEventsBefore(sessionId, {
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
    sequenceId: Number(lastEvent?.sequenceId ?? lastEvent?.sequence_id) || null,
  };
}

function normalizePositiveIntegerOrDefault(value, fallbackValue) {
  const normalized = Number(value);
  if (!Number.isFinite(normalized) || normalized <= 0) {
    return fallbackValue;
  }
  return Math.floor(normalized);
}

function confirmationRemainingMs(deadlineMs, nowMs) {
  const now = Number(nowMs()) || Date.now();
  return Math.max(0, Math.floor(deadlineMs - now));
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
    attempts = SESSION_SAY_CONFIRM_ATTEMPTS,
    delayMs = SESSION_SAY_CONFIRM_DELAY_MS,
    pageLimit = SESSION_SAY_CONFIRM_PAGE_LIMIT,
    maxPages = SESSION_SAY_CONFIRM_MAX_PAGES,
    totalTimeoutMs = SESSION_SAY_CONFIRM_TOTAL_TIMEOUT_MS,
    requestTimeoutMs = SESSION_SAY_CONFIRM_REQUEST_TIMEOUT_MS,
  } = {},
) {
  let lastReason = "not_visible";
  let checked = 0;
  let pages = 0;
  let tailChecks = 0;
  const normalizedAnchorCursor = normalizeString(anchorCursor) || null;
  const normalizedAttempts = normalizePositiveIntegerOrDefault(attempts, SESSION_SAY_CONFIRM_ATTEMPTS);
  const normalizedDelayMs = normalizePositiveIntegerOrDefault(delayMs, SESSION_SAY_CONFIRM_DELAY_MS);
  const normalizedPageLimit = normalizePositiveIntegerOrDefault(pageLimit, SESSION_SAY_CONFIRM_PAGE_LIMIT);
  const normalizedMaxPages = normalizePositiveIntegerOrDefault(maxPages, SESSION_SAY_CONFIRM_MAX_PAGES);
  const normalizedTotalTimeoutMs = normalizePositiveIntegerOrDefault(
    totalTimeoutMs,
    SESSION_SAY_CONFIRM_TOTAL_TIMEOUT_MS,
  );
  const normalizedRequestTimeoutMs = normalizePositiveIntegerOrDefault(
    requestTimeoutMs,
    SESSION_SAY_CONFIRM_REQUEST_TIMEOUT_MS,
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

function formatSessionListText(value, { maxLength = 80 } = {}) {
  const normalized = normalizeString(value)
    .replace(/[\r\n\t]+/g, " ")
    .replace(/\s+/g, " ")
    .replace(/"/g, "'");
  if (!normalized) {
    return "";
  }
  const limit = Math.max(8, Number(maxLength) || 80);
  return normalized.length > limit
    ? `${normalized.slice(0, Math.max(0, limit - 3)).trimEnd()}...`
    : normalized;
}

function sessionListCodebaseLabel(value) {
  const normalized = formatSessionListText(value, { maxLength: 120 });
  if (!normalized) {
    return "";
  }
  const segments = normalized.split(/[\\/]+/).filter(Boolean);
  if (segments.length <= 2) {
    return formatSessionListText(normalized, { maxLength: 80 });
  }
  return formatSessionListText(`.../${segments.slice(-2).join("/")}`, {
    maxLength: 80,
  });
}

export function formatSessionListLine(item = {}) {
  const sessionId = normalizeString(item.sessionId) || "unknown-session";
  const status = normalizeString(item.status) || "unknown";
  const archiveStatus = normalizeString(item.archiveStatus);
  const archive = archiveStatus ? ` archive=${archiveStatus}` : "";
  const title = formatSessionListText(item.title || item.summaryText, { maxLength: 72 });
  const codebase = sessionListCodebaseLabel(item.codebasePath);
  const titlePart = title ? ` title="${title}"` : "";
  const codebasePart = codebase ? ` codebase="${codebase}"` : "";
  const created = item.createdAt || "?";
  const lastActivity = item.lastActivityAt ? ` last=${item.lastActivityAt}` : "";
  return `${sessionId} status=${status}${archive}${titlePart}${codebasePart} created=${created}${lastActivity}`;
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
    description: "Manually backfill a read receipt for a target message; remote reads record views automatically.",
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
  if (actionType === "view") return null;
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

function readProjectionUnacknowledgedHumanMessages(remoteActions = null) {
  const messages = remoteActions?.projection?.unacknowledgedHumanMessages;
  return Array.isArray(messages)
    ? messages
        .filter((event) => event && typeof event === "object")
        .sort((left, right) => humanAskSortValue(right) - humanAskSortValue(left))
    : [];
}

function messageActionCreatedMs(action = {}) {
  const epoch = Date.parse(normalizeString(action.createdAt || action.created_at || action.ts || action.timestamp));
  return Number.isFinite(epoch) ? epoch : 0;
}

function messageActionActorId(action = {}) {
  return normalizeString(action.actorId || action.actor_id || action.agentId || action.agent_id) || "unknown";
}

function isHumanMessageAction(action = {}) {
  if (action?.isHumanActivity === true) return true;
  if (normalizeString(action.actorKind || action.actor_kind).toLowerCase() === "human") return true;
  return messageActionActorId(action).startsWith("human-");
}

function readProjectionRecentHumanActivity(remoteActions = null) {
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
    : [];
}

function formatMessageActionActivityLine(action = {}) {
  const actionType = normalizeString(action.actionType || action.action_type) || "action";
  const targetSequence = Number(action.targetSequenceId ?? action.target_sequence_id ?? 0);
  const targetActionId = normalizeString(action.targetActionId || action.target_action_id);
  const target = targetActionId
    ? `action:${targetActionId}`
    : targetSequence > 0
      ? `#${Math.floor(targetSequence)}`
      : normalizeString(action.targetCursor || action.target_cursor) || "unknown-target";
  const ts = normalizeString(action.createdAt || action.created_at || action.ts || action.timestamp);
  const note = normalizeString(action.note || action.message || "");
  const shortNote = note.length > 220 ? `${note.slice(0, 217)}...` : note;
  const suffix = shortNote ? `: ${shortNote}` : "";
  return `${actionType} ${target} by ${messageActionActorId(action)}${ts ? ` ${ts}` : ""}${suffix}`;
}

function humanAskSequence(event = {}) {
  const value = Number(event.sequenceId ?? event.sequence_id ?? event.sequence ?? 0);
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : null;
}

function humanAskAgentId(event = {}) {
  return normalizeString(event.agent?.id || event.agentId || event.agent_id) || "human";
}

function humanAskMessage(event = {}) {
  const payload = event.payload && typeof event.payload === "object" ? event.payload : {};
  return normalizeString(payload.message || payload.note || payload.reason || "");
}

function humanAskSortValue(event = {}) {
  const sequence = humanAskSequence(event);
  if (sequence) return sequence;
  const epoch = Date.parse(normalizeString(event.ts || event.timestamp || event.createdAt || event.created_at));
  return Number.isFinite(epoch) ? epoch : 0;
}

function formatHumanAskLine(event = {}) {
  const sequence = humanAskSequence(event);
  const sequenceLabel = sequence ? `#${sequence}` : normalizeString(event.cursor) || "unsequenced";
  const ts = normalizeString(event.ts || event.timestamp || event.createdAt || event.created_at);
  const message = humanAskMessage(event);
  const shortMessage = message.length > 220 ? `${message.slice(0, 217)}...` : message;
  const suffix = shortMessage ? `: ${shortMessage}` : "";
  return `${sequenceLabel} ${humanAskAgentId(event)}${ts ? ` ${ts}` : ""}${suffix}`;
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

async function pollSessionEventsBeforeTranscriptTail(sessionId, {
  targetPath,
  beforeSequence = null,
  tail = 20,
  includeControlEvents = false,
  timeoutMs = 15_000,
  maxPages = 10,
} = {}) {
  const targetMaterialCount = Math.max(1, Math.floor(Number(tail) || 20));
  const pageLimit = includeControlEvents
    ? Math.min(200, targetMaterialCount)
    : 200;
  const maxPageCount = Math.max(1, Math.min(25, Math.floor(Number(maxPages) || 10)));
  let nextBeforeSequence = beforeSequence;
  let latestResult = null;
  let combinedEvents = [];
  let pageCount = 0;

  for (let page = 0; page < maxPageCount; page += 1) {
    const result = await pollSessionEventsBefore(sessionId, {
      targetPath,
      beforeSequence: nextBeforeSequence,
      limit: pageLimit,
      timeoutMs,
    });
    pageCount += 1;
    if (!result?.ok) {
      if (!latestResult) return { ...result, pageCount };
      latestResult = {
        ...latestResult,
        reason: result?.reason || latestResult.reason || "partial_tail_fetch",
        partial: true,
      };
      break;
    }

    latestResult = result;
    const pageEvents = Array.isArray(result.events) ? result.events : [];
    combinedEvents = [...pageEvents, ...combinedEvents];
    const materialCount = includeControlEvents
      ? combinedEvents.length
      : filterSessionMaterialEvents(combinedEvents).length;

    if (includeControlEvents || materialCount >= targetMaterialCount) break;
    if (pageEvents.length < pageLimit) break;

    const candidateBefore = Number(result.beforeSequence || 0);
    if (!Number.isFinite(candidateBefore) || candidateBefore <= 0) break;
    const currentBefore = Number(nextBeforeSequence || 0);
    if (currentBefore > 0 && candidateBefore >= currentBefore) break;
    nextBeforeSequence = candidateBefore;
  }

  if (!latestResult) {
    return {
      ok: true,
      reason: "",
      events: [],
      cursor: null,
      beforeSequence: beforeSequence || null,
      pageCount,
    };
  }

  return {
    ...latestResult,
    events: combinedEvents,
    cursor: normalizeString(combinedEvents[combinedEvents.length - 1]?.cursor) || latestResult.cursor || null,
    pageCount,
    materialBackfillComplete:
      includeControlEvents || filterSessionMaterialEvents(combinedEvents).length >= targetMaterialCount,
  };
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

function sessionReadViewTarget(event = {}) {
  const eventType = normalizeString(event.event || event.type).toLowerCase();
  if (eventType !== "session_message" || isSessionControlEvent(event)) {
    return null;
  }
  const targetSequenceId = eventSequenceNumber(event);
  const targetCursor = normalizeString(event.cursor);
  if (!targetSequenceId && !targetCursor) {
    return null;
  }
  return {
    key: targetSequenceId ? `seq:${targetSequenceId}` : `cursor:${targetCursor}`,
    targetSequenceId: targetSequenceId || null,
    targetCursor,
  };
}

function normalizeAutoViewTimeoutMs(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return SESSION_READ_AUTO_VIEW_TIMEOUT_MS;
  }
  return Math.max(50, Math.min(5_000, Math.floor(parsed)));
}

async function writeSessionReadViews(sessionId, writeTargets = [], {
  targetPath,
  agentId,
  timeoutMs = SESSION_READ_AUTO_VIEW_TIMEOUT_MS,
} = {}) {
  if (!Array.isArray(writeTargets) || writeTargets.length === 0) {
    return;
  }
  const totalTimeoutMs = normalizeAutoViewTimeoutMs(timeoutMs);
  const controller = new AbortController();
  const startedAt = Date.now();
  const timeoutHandle = setTimeout(() => {
    try {
      controller.abort();
    } catch {
      // ignore
    }
  }, totalTimeoutMs);
  if (typeof timeoutHandle.unref === "function") {
    timeoutHandle.unref();
  }

  try {
    for (const target of writeTargets) {
      if (controller.signal.aborted) {
        break;
      }
      const elapsedMs = Math.max(0, Date.now() - startedAt);
      const remainingMs = Math.max(1, totalTimeoutMs - elapsedMs);
      const result = await createSessionMessageAction(sessionId, {
        actionType: "view",
        targetPath,
        targetSequenceId: target.targetSequenceId,
        targetCursor: target.targetCursor,
        metadata: {
          source: "cli_read",
          agentId,
        },
        idempotencyKey: defaultActionIdempotencyKey({
          actionType: "view",
          targetSequenceId: target.targetSequenceId,
          targetCursor: target.targetCursor,
          agentId,
        }),
        timeoutMs: remainingMs,
        signal: controller.signal,
      });
      if (!result?.ok) {
        break;
      }
    }
  } finally {
    clearTimeout(timeoutHandle);
  }
}

function recordSessionReadViews(sessionId, events = [], {
  targetPath,
  agentId,
  enabled = false,
  maxTargets = 50,
  timeoutMs = SESSION_READ_AUTO_VIEW_TIMEOUT_MS,
} = {}) {
  const maxAutoViewTargets = Math.max(0, Math.min(200, Number(maxTargets) || 0));
  const summary = {
    enabled: Boolean(enabled),
    agentId: normalizeString(agentId) || "cli-user",
    targetCount: 0,
    attempted: 0,
    recorded: 0,
    duplicates: 0,
    failed: 0,
    skipped: 0,
    queued: 0,
    background: false,
    reason: "",
  };
  if (!summary.enabled) {
    summary.reason = "disabled";
    return summary;
  }

  const seenTargets = new Set();
  const targets = [];
  for (const event of Array.isArray(events) ? events : []) {
    const target = sessionReadViewTarget(event);
    if (!target || seenTargets.has(target.key)) {
      continue;
    }
    seenTargets.add(target.key);
    targets.push(target);
  }
  summary.targetCount = targets.length;

  const writeTargets = maxAutoViewTargets > 0 ? targets.slice(-maxAutoViewTargets) : [];
  summary.skipped = Math.max(0, targets.length - writeTargets.length);
  summary.queued = writeTargets.length;
  if (summary.skipped > 0) {
    summary.reason = "target_cap_reached";
  }

  if (writeTargets.length === 0) {
    if (!summary.reason) {
      summary.reason = "no_targets";
    }
    return summary;
  }

  summary.background = true;
  if (!summary.reason) {
    summary.reason = "queued_best_effort";
  }

  void writeSessionReadViews(sessionId, writeTargets, {
    targetPath,
    agentId: summary.agentId,
    timeoutMs,
  }).catch(() => {
    // Best-effort view receipts must never affect transcript rendering.
  });

  return summary;
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

function parsePositiveMillisecondsFromSeconds(rawValue, field, fallbackSeconds) {
  return parsePositiveInteger(rawValue, field, fallbackSeconds) * 1000;
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

export function formatSentiDaemonStatusLine(sentiDaemon = {}, { cliCommand = "sl", sessionId = "" } = {}) {
  if (sentiDaemon.spawned) {
    return {
      tone: "green",
      text: `Senti: managing this session (daemon pid ${sentiDaemon.pid}, detached — survives this terminal). Log: ${sentiDaemon.logPath}`,
    };
  }
  if (sentiDaemon.reason === "already_running") {
    return {
      tone: "green",
      text: `Senti: already managing this session (daemon pid ${sentiDaemon.pid}).`,
    };
  }
  if (sentiDaemon.reason === "disabled" || sentiDaemon.reason === "opt_out") {
    return {
      tone: "gray",
      text: `Senti daemon skipped (${sentiDaemon.reason === "opt_out" ? "--no-daemon" : "SENTINELAYER_SKIP_SENTI_AUTOSTART=1"}); session is unmanaged. Start manually: ${cliCommand} session daemon ${sessionId}`,
    };
  }
  return {
    tone: "yellow",
    text: `! Senti daemon not started (${sentiDaemon.reason || "unknown"}); session is unmanaged. Start manually: ${cliCommand} session daemon ${sessionId}`,
  };
}

function printSentiDaemonStatusLine(sentiDaemon, context) {
  const line = formatSentiDaemonStatusLine(sentiDaemon, context);
  if (line.tone === "green") {
    console.log(pc.green(line.text));
  } else if (line.tone === "yellow") {
    console.log(pc.yellow(line.text));
  } else {
    console.log(pc.gray(line.text));
  }
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
async function fetchRemoteSessionDetail(endpoint, headers) {
  let response;
  try {
    response = await fetch(endpoint, { method: "GET", headers });
  } catch (err) {
    return {
      ok: false,
      response: null,
      status: 0,
      reason: normalizeString(err?.message) || "fetch_failed",
      retryable: true,
    };
  }
  if (response && response.ok) {
    return { ok: true, response, status: response.status, reason: "", retryable: false };
  }
  if (!response) {
    return { ok: false, response: null, status: 0, reason: "no_response", retryable: true };
  }
  const status = Number(response.status) || 0;
  return {
    ok: false,
    response,
    status,
    reason: `api_${status || "unknown"}`,
    retryable: status >= 500 && status < 600,
  };
}

async function parseRemoteSessionDetailResponse(response) {
  const body = await response.json().catch(() => ({}));
  return body && body.session && typeof body.session === "object"
    ? body.session
    : body && typeof body === "object"
      ? body
      : null;
}

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
  const firstAttempt = await fetchRemoteSessionDetail(endpoint, headers);
  const detail = firstAttempt.retryable
    ? await fetchRemoteSessionDetail(endpoint, headers)
    : firstAttempt;
  if (detail.ok) {
    return {
      ok: true,
      source: "singleton",
      session: await parseRemoteSessionDetailResponse(detail.response),
      status: detail.status,
    };
  }
  if (detail.status === 404) {
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
  if (detail.status === 403) {
    return { ok: false, reason: "forbidden", status: 403 };
  }
  return {
    ok: false,
    reason: detail.reason || "unknown",
    status: detail.status || undefined,
  };
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

export async function ensureWorkspaceSession({
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

function canPublishListenerPresence(agentId) {
  const normalized = normalizeAgentId(agentId, "");
  if (!normalized) return false;
  if (["cli-user", "unknown", "human", "user", "operator"].includes(normalized)) return false;
  return !(
    normalized.startsWith("human-") ||
    normalized.startsWith("user-") ||
    normalized.startsWith("guest-")
  );
}

const SESSION_OBSERVATION_SEVERITIES = new Set(["info", "p3", "p2", "p1", "p0"]);
const SESSION_OBSERVATION_KINDS = new Set([
  "ux",
  "process",
  "reliability",
  "security",
  "billing",
  "coordination",
  "architecture",
  "testing",
  "release",
  "other",
]);
const SESSION_OBSERVATION_SUMMARY_MAX_LENGTH = 4_000;
const SESSION_OBSERVATION_OPTION_MAX_LENGTH = 512;
const SESSION_OBSERVATION_PROPOSAL_MAX_LENGTH = 2_000;

function requireGrantedNonHumanAgentId(rawAgentId, commandName) {
  const agentId = normalizeAgentId(rawAgentId, "");
  if (!agentId || !canPublishListenerPresence(agentId)) {
    throw new Error(`${commandName} requires a granted non-human agent id.`);
  }
  return agentId;
}

function normalizeSessionObservationChoice(rawValue, allowedValues, fallbackValue, fieldName) {
  const value = normalizeString(rawValue || fallbackValue).toLowerCase();
  if (!allowedValues.has(value)) {
    throw new Error(`${fieldName} must be one of: ${[...allowedValues].join(", ")}.`);
  }
  return value;
}

function normalizeSessionObservationText(rawValue, fieldName, maxLength) {
  const value = normalizeString(rawValue);
  if (value.length > maxLength) {
    throw new Error(`${fieldName} must be ${maxLength} characters or fewer.`);
  }
  return value;
}

function listenerLifecycleEventName(type = "") {
  const normalized = normalizeString(type).toLowerCase();
  if (normalized === "started") return "session_listener_started";
  if (normalized === "stopped") return "session_listener_stopped";
  return "session_listener_heartbeat";
}

function compactPayload(record = {}) {
  return Object.fromEntries(
    Object.entries(record).filter(([, value]) => value !== undefined)
  );
}

function listenerPresenceHeartbeatFingerprint(lifecycle = {}) {
  return JSON.stringify(
    compactPayload({
      active: Boolean(lifecycle.active),
      state: normalizeString(lifecycle.state) || "heartbeat",
      transport: normalizeString(lifecycle.transport) || null,
      reason: normalizeString(lifecycle.reason) || null,
      idleIntervalSeconds: lifecycle.idleIntervalSeconds ?? null,
      activeIntervalSeconds: lifecycle.activeIntervalSeconds ?? null,
      activeWindowSeconds: lifecycle.activeWindowSeconds ?? null,
      lastHumanActivityAt: lifecycle.lastHumanActivityAt || null,
    }),
  );
}

export function shouldPublishListenerPresenceHeartbeat({
  lifecycle = {},
  nowMs = Date.now(),
  lastHeartbeatMs = 0,
  lastFingerprint = "",
  presenceIntervalMs = 60_000,
  presenceKeepaliveMs = 180_000,
} = {}) {
  const lifecycleType = normalizeString(lifecycle.type) || "heartbeat";
  if (lifecycleType !== "heartbeat") {
    return { publish: true, fingerprint: lastFingerprint, reason: "lifecycle" };
  }
  const fingerprint = listenerPresenceHeartbeatFingerprint(lifecycle);
  if (lifecycle.stopping) {
    return { publish: true, fingerprint, reason: "stopping" };
  }
  const currentMs = Number(nowMs) || Date.now();
  const previousMs = Number(lastHeartbeatMs) || 0;
  if (previousMs <= 0) {
    return { publish: true, fingerprint, reason: "first" };
  }
  if (fingerprint !== lastFingerprint) {
    return { publish: true, fingerprint, reason: "changed" };
  }
  const minIntervalMs = Math.max(1, Number(presenceIntervalMs) || 60_000);
  const keepaliveMs = Math.max(minIntervalMs, Number(presenceKeepaliveMs) || 180_000);
  const elapsedMs = currentMs - previousMs;
  if (elapsedMs >= keepaliveMs) {
    return { publish: true, fingerprint, reason: "keepalive" };
  }
  if (elapsedMs >= minIntervalMs) {
    return { publish: true, fingerprint, reason: "interval" };
  }
  return { publish: false, fingerprint, reason: "interval" };
}

async function publishListenerPresenceEvent({
  sessionId,
  targetPath,
  agentId,
  agentModel = "cli",
  displayName = "",
  provider = "",
  clientKind = "cli",
  listenerId,
  lifecycle = {},
} = {}) {
  const normalizedType = normalizeString(lifecycle.type) || "heartbeat";
  const eventName = listenerLifecycleEventName(normalizedType);
  const identity = inferSessionAgentIdentity({
    agentId,
    model: agentModel,
    displayName,
    provider,
    clientKind,
  });
  const event = createAgentEvent({
    event: eventName,
    sessionId,
    agent: {
      id: agentId,
      model: normalizeString(identity.model) || "cli",
      role: "listener",
      displayName: normalizeString(identity.displayName) || agentId,
      provider: normalizeString(identity.provider) || undefined,
      clientKind: normalizeString(identity.clientKind) || "cli",
    },
    eventId: `session-listener-${listenerId}-${normalizedType}-${lifecycle.pollCount ?? 0}`,
    idempotencyToken: `session-listener:${listenerId}:${normalizedType}:${lifecycle.pollCount ?? 0}`,
    payload: compactPayload({
      source: "session_listen",
      listenerId,
      lifecycle: normalizedType,
      state: normalizeString(lifecycle.state) || normalizedType,
      active: lifecycle.active,
      cursor: lifecycle.cursor || null,
      cursorSuffix: lifecycle.cursorSuffix,
      cursorSource: lifecycle.cursorSource,
      pollCount: lifecycle.pollCount,
      matched: lifecycle.matched,
      emitted: lifecycle.emitted,
      persistedCursor: lifecycle.persistedCursor,
      idleIntervalSeconds: lifecycle.idleIntervalSeconds,
      activeIntervalSeconds: lifecycle.activeIntervalSeconds,
      activeWindowSeconds: lifecycle.activeWindowSeconds,
      presenceIntervalSeconds: lifecycle.presenceIntervalSeconds,
      presenceKeepaliveSeconds: lifecycle.presenceKeepaliveSeconds,
      lastHumanActivityAt: lifecycle.lastHumanActivityAt,
      lastSleepMs: lifecycle.lastSleepMs,
      nextPollMs: lifecycle.nextPollMs,
      reason: lifecycle.reason || null,
      startedAt: lifecycle.startedAt,
      stoppedAt: lifecycle.stoppedAt,
      aborted: lifecycle.aborted,
      stopping: lifecycle.stopping,
    }),
  });
  return syncSessionEventToApi(sessionId, event, { targetPath });
}

function formatListenerCatchupNotice(catchup = {}) {
  const eventCount = Number(catchup.eventCount || 0);
  const matchingEventCount = Number(catchup.matchingEventCount || 0);
  const range = catchup.oldestEventAt && catchup.newestEventAt
    ? ` (${catchup.oldestEventAt} -> ${catchup.newestEventAt})`
    : "";
  return [
    `Listener catch-up from stored cursor ${catchup.cursor || "<none>"}:`,
    `${eventCount} event${eventCount === 1 ? "" : "s"} in this page`,
    `${matchingEventCount} addressed/broadcast to this agent${range}.`,
    "Use --from-now only when you intentionally want to skip old backlog.",
  ].join(" ");
}

// Periodic in-session coaching reminder surfaced by `session listen`. Keeps
// agents continually nudged toward good coordination (ack, claim work, reply
// in-thread, surface findings). `tick` makes each emission idempotent so the
// same reminder is not deduped across the run.
export function buildSessionCoachingEvent({
  sessionId,
  agentId,
  agentModel = "cli",
  displayName = "",
  provider = "",
  clientKind = "cli",
  listenerId = "",
  tick = 0,
  tips = SESSION_LIVE_SUCCESS_TIPS,
} = {}) {
  const tipList = Array.isArray(tips) && tips.length ? tips : SESSION_LIVE_SUCCESS_TIPS;
  const identity = inferSessionAgentIdentity({
    agentId,
    model: agentModel,
    displayName,
    provider,
    clientKind,
  });
  return createAgentEvent({
    event: "session_coaching",
    sessionId,
    agent: {
      id: agentId,
      model: normalizeString(identity.model) || "cli",
      role: "listener",
      displayName: normalizeString(identity.displayName) || agentId,
      provider: normalizeString(identity.provider) || undefined,
      clientKind: normalizeString(identity.clientKind) || "cli",
    },
    eventId: `session-coaching-${listenerId || agentId}-${tick}`,
    idempotencyToken: `session-coaching:${listenerId || agentId}:${tick}`,
    payload: compactPayload({
      source: "session_listen",
      kind: "coaching",
      message: "Session success reminders:",
      tips: [...tipList],
    }),
  });
}

function buildListenerCatchupEvent({
  sessionId,
  agentId,
  agentModel = "cli",
  displayName = "",
  provider = "",
  clientKind = "cli",
  listenerId,
  catchup = {},
} = {}) {
  const message = formatListenerCatchupNotice(catchup);
  const pollCount = Number(catchup.pollCount || 0);
  const identity = inferSessionAgentIdentity({
    agentId,
    model: agentModel,
    displayName,
    provider,
    clientKind,
  });
  return createAgentEvent({
    event: "session_listen_catchup",
    sessionId,
    agent: {
      id: agentId,
      model: normalizeString(identity.model) || "cli",
      role: "listener",
      displayName: normalizeString(identity.displayName) || agentId,
      provider: normalizeString(identity.provider) || undefined,
      clientKind: normalizeString(identity.clientKind) || "cli",
    },
    eventId: `session-listener-${listenerId}-catchup-${pollCount}`,
    idempotencyToken: `session-listener:${listenerId}:catchup:${pollCount}`,
    payload: compactPayload({
      source: "session_listen",
      listenerId,
      lifecycle: "catchup",
      state: "catching_up",
      message,
      cursor: catchup.cursor || null,
      candidateCursor: catchup.candidateCursor || null,
      cursorSuffix: catchup.cursorSuffix,
      cursorSource: catchup.cursorSource,
      pollCount,
      eventCount: Number(catchup.eventCount || 0),
      matchingEventCount: Number(catchup.matchingEventCount || 0),
      preStartEventCount: Number(catchup.preStartEventCount || 0),
      limit: Number(catchup.limit || 0) || undefined,
      replay: Boolean(catchup.replay),
      oldestEventAt: catchup.oldestEventAt || null,
      newestEventAt: catchup.newestEventAt || null,
    }),
  });
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

function formatAgentIdList(agentIds = []) {
  const normalized = agentIds.map((agentId) => normalizeString(agentId)).filter(Boolean);
  if (!normalized.length) return "";
  if (normalized.length <= 3) return normalized.join(", ");
  return `${normalized.slice(0, 3).join(", ")} +${normalized.length - 3} more`;
}

export function sessionSayRegistryRole(value) {
  const normalized = normalizeString(value).toLowerCase();
  if (["coder", "reviewer", "tester", "daemon", "observer", "persona"].includes(normalized)) {
    return normalized;
  }
  return "coder";
}

export async function resolveSessionSayIdentity({
  sessionId,
  agentId = "",
  targetPath = process.cwd(),
  env = process.env,
} = {}) {
  const explicitAgentId = normalizeString(agentId);
  if (explicitAgentId) {
    return {
      agentId: resolveSessionSayAgentId(explicitAgentId),
      source: "option",
      identityWarning: "",
      candidateAgentIds: [],
    };
  }

  const envAgentId = normalizeString(env?.SENTINELAYER_AGENT_ID || env?.SENTI_AGENT_ID);
  if (envAgentId && canPublishListenerPresence(envAgentId)) {
    return {
      agentId: resolveSessionSayAgentId(envAgentId),
      source: "env",
      identityWarning: "",
      candidateAgentIds: [],
    };
  }

  let candidateAgentIds = [];
  try {
    const agents = await listAgents(sessionId, { targetPath, includeInactive: false });
    candidateAgentIds = agents
      .map((agent) => normalizeString(agent.agentId))
      .filter((candidate) => canPublishListenerPresence(candidate));
  } catch {
    candidateAgentIds = [];
  }

  if (candidateAgentIds.length === 1) {
    return {
      agentId: resolveSessionSayAgentId(candidateAgentIds[0]),
      source: "local-agent",
      identityWarning: "",
      candidateAgentIds,
    };
  }

  const warningReason = candidateAgentIds.length > 1
    ? `multiple local joined agents are active (${formatAgentIdList(candidateAgentIds)})`
    : envAgentId && !canPublishListenerPresence(envAgentId)
      ? `configured SENTINELAYER_AGENT_ID '${envAgentId}' is reserved or human-scoped`
      : "no agent identity is configured";

  return {
    agentId: "cli-user",
    source: "fallback",
    identityWarning: `session say is sending as cli-user because ${warningReason}; pass --agent <id>, set SENTINELAYER_AGENT_ID, or run session join --agent <id> before posting.`,
    candidateAgentIds,
  };
}

export function shouldBlockImplicitCliUserSessionSay(identity = {}) {
  return identity?.source === "fallback" && normalizeString(identity?.agentId) === "cli-user";
}

/**
 * Wake hook for `session listen --wake "<command>"`. This is the reusable
 * notify->resume bridge: when the listener emits an event addressed to this
 * agent (or broadcast — including low-noise actions like ack/like), it runs a
 * host command so the host can resume/wake its agent. The event JSON is piped
 * to the command's stdin and key fields are exposed as SL_WAKE_* env vars.
 *
 * Bursts are coalesced: if a wake is already running, the latest event is
 * queued and fired once when the current one finishes, so a flood of activity
 * triggers one trailing wake instead of a storm of processes.
 */
export function createSessionWakeRunner({
  command,
  sessionId,
  agentId,
  emit = () => {},
  spawnImpl = defaultSpawn,
} = {}) {
  const wakeCommand = normalizeString(command);
  let busy = false;
  let pending = null;

  const run = (event) => {
    if (!wakeCommand) return;
    if (busy) {
      pending = event ?? {};
      return;
    }
    busy = true;
    const env = {
      ...process.env,
      SL_WAKE_SESSION_ID: normalizeString(sessionId),
      SL_WAKE_AGENT_ID: normalizeString(agentId),
      SL_WAKE_EVENT_TYPE: normalizeString(event?.event),
      SL_WAKE_EVENT_CURSOR: normalizeString(event?.cursor),
      SL_WAKE_EVENT_SEQUENCE: String(event?.sequenceId ?? event?.sequence_id ?? ""),
      SL_WAKE_ACTOR_ID: normalizeString(event?.agent?.id || event?.agentId),
    };
    let child;
    try {
      child = spawnImpl(wakeCommand, { shell: true, env, stdio: ["pipe", "ignore", "ignore"] });
    } catch (error) {
      busy = false;
      emit({ status: "error", reason: normalizeString(error?.message) || "spawn_failed" });
      return;
    }
    emit({
      status: "fired",
      eventType: env.SL_WAKE_EVENT_TYPE,
      cursor: env.SL_WAKE_EVENT_CURSOR,
      actorId: env.SL_WAKE_ACTOR_ID,
    });
    try {
      if (child && child.stdin) {
        child.stdin.write(JSON.stringify(event ?? {}));
        child.stdin.end();
      }
    } catch {
      // Broken pipe (command ignored stdin) is non-fatal for a wake hook.
    }
    const finish = (reason) => {
      busy = false;
      if (reason) emit({ status: "error", reason });
      const next = pending;
      pending = null;
      if (next !== null) run(next);
    };
    if (child && typeof child.on === "function") {
      child.on("error", (error) => finish(normalizeString(error?.message) || "wake_failed"));
      child.on("exit", (code) => finish(code && code !== 0 ? `exit_${code}` : ""));
    } else {
      finish("");
    }
  };

  return { trigger: run, hasCommand: Boolean(wakeCommand) };
}

// Message actions (ack/like/dislike/reply/view/working_on) must be authored by
// a concrete agent identity. The CLI's bare `cli-user` default is a reserved
// label the API rejects (api_422), so treat it as "unset" and resolve the real
// agent the same way `session say` does (explicit --agent > SENTINELAYER_AGENT_ID
// > the single joined agent). Returns the resolved identity; callers should use
// shouldBlockImplicitCliUserSessionSay() to refuse the implicit cli-user
// fallback before sending a request that is guaranteed to fail.
export async function resolveMessageActionIdentity({
  sessionId,
  optionAgent = "",
  targetPath = process.cwd(),
  env = process.env,
} = {}) {
  const explicit = normalizeString(optionAgent);
  const agentSeed = explicit && explicit.toLowerCase() !== "cli-user" ? explicit : "";
  return resolveSessionSayIdentity({ sessionId, agentId: agentSeed, targetPath, env });
}

async function ensureSessionSayAgentRegistered(
  sessionId,
  agent = {},
  { targetPath = process.cwd() } = {},
) {
  const agentId = normalizeString(agent.id);
  if (!canPublishListenerPresence(agentId)) {
    return { persisted: false, reason: "placeholder_agent" };
  }

  try {
    const activeAgents = await listAgents(sessionId, { targetPath, includeInactive: false });
    if (
      activeAgents.some(
        (existing) => normalizeString(existing.agentId).toLowerCase() === agentId.toLowerCase(),
      )
    ) {
      return { persisted: false, reason: "already_registered" };
    }
  } catch {
    // If the local registry is unreadable, let rememberAgentIdentity surface the
    // filesystem problem with its normal error message.
  }

  const registered = await rememberAgentIdentity(sessionId, {
    agentId,
    model: normalizeString(agent.model) || "cli",
    displayName: normalizeString(agent.displayName),
    provider: normalizeString(agent.provider),
    clientKind: normalizeString(agent.clientKind) || "cli",
    role: sessionSayRegistryRole(agent.role),
    targetPath,
  });

  return {
    persisted: true,
    agentId: registered.agentId,
  };
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
  const identity = inferSessionAgentIdentity({
    agentId: normalizedAgentId,
    model: resolvedModel,
    displayName: resolvedDisplayName,
    provider: registeredAgent?.provider,
    clientKind: normalizeString(clientKind) || normalizeString(registeredAgent?.clientKind) || "cli",
  });
  const envelope = {
    id: normalizedAgentId,
    model: normalizeString(identity.model) || resolvedModel || undefined,
    role: resolvedRole || undefined,
    displayName: normalizeString(identity.displayName) || resolvedDisplayName || undefined,
    provider: normalizeString(identity.provider) || undefined,
    clientKind:
      normalizeString(identity.clientKind) ||
      normalizeString(clientKind) ||
      normalizeString(registeredAgent?.clientKind) ||
      undefined,
  };
  return Object.fromEntries(Object.entries(envelope).filter(([, value]) => value !== undefined));
}

// Builds the lock/unlock say-convention directive the session daemon parses
// into the authoritative file-lock registry. Kept pure + exported for testing.
export function buildSessionLockDirective(verb, file, intent = "") {
  const normalizedFile = normalizeString(file);
  const normalizedIntent = normalizeString(intent);
  if (verb === "unlock") {
    return `unlock: ${normalizedFile} - ${normalizedIntent || "done"}`;
  }
  return normalizedIntent ? `lock: ${normalizedFile} - ${normalizedIntent}` : `lock: ${normalizedFile}`;
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

function summarizeSessionTailEvent(event = null) {
  if (!event || typeof event !== "object") return null;
  return {
    type: normalizeString(event.event || event.type) || null,
    sequenceId: Number(event.sequenceId ?? event.sequence_id) || null,
    cursor: normalizeString(event.cursor) || null,
    ts: normalizeString(event.ts || event.timestamp) || null,
    agentId: normalizeString(event.agent?.id || event.agentId || event.agent_id) || null,
    control: isSessionControlEvent(event),
  };
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
      upgraded: appended.upgraded,
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

function remoteSessionEventUpgradesLocal(localEvent = {}, remoteEvent = {}) {
  return sessionEventUpgradesExisting(localEvent, remoteEvent);
}

function indexSessionEventIdentityKeys(indexByKey, eventList = [], event = {}, index = -1) {
  if (!indexByKey || !Array.isArray(eventList) || index < 0) return;
  for (const key of sessionEventIdentityKeys(event)) {
    const existingIndex = indexByKey.get(key);
    const existingEvent = Number.isInteger(existingIndex) && existingIndex >= 0
      ? eventList[existingIndex]
      : null;
    if (!existingEvent || remoteSessionEventUpgradesLocal(existingEvent, event)) {
      indexByKey.set(key, index);
    }
  }
}

function findSessionEventIdentityIndex(indexByKey, event = {}) {
  if (!indexByKey) return -1;
  for (const key of sessionEventIdentityKeys(event)) {
    const index = indexByKey.get(key);
    if (Number.isInteger(index) && index >= 0) {
      return index;
    }
  }
  return -1;
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
  const localIndexByKey = new Map();
  const localEvents = await readStream(sessionId, {
    targetPath,
    tail: 0,
  });
  for (const [index, event] of localEvents.entries()) {
    addSessionEventIdentityKeys(knownKeys, event);
    indexSessionEventIdentityKeys(localIndexByKey, localEvents, event, index);
  }

  let appended = 0;
  let upgraded = 0;
  let skipped = 0;
  let failed = 0;
  for (const event of events) {
    const existingIndex = findSessionEventIdentityIndex(localIndexByKey, event);
    if (existingIndex >= 0) {
      const existing = localEvents[existingIndex];
      if (!remoteSessionEventUpgradesLocal(existing, event)) {
        skipped += 1;
        continue;
      }
      // Keep the richer canonical API row in local history when it
      // upgrades an optimistic/local post that had no durable cursor yet.
      // Future reads can then page by sequence instead of rediscovering the
      // upgrade every time.
      try {
        const persisted = await appendToStream(sessionId, event, {
          targetPath,
          syncRemote: false,
        });
        localEvents.push(persisted);
        addSessionEventIdentityKeys(knownKeys, persisted);
        indexSessionEventIdentityKeys(localIndexByKey, localEvents, persisted, localEvents.length - 1);
        upgraded += 1;
      } catch {
        addSessionEventIdentityKeys(knownKeys, event);
        failed += 1;
      }
      continue;
    }
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
    upgraded,
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
      "Start (or resume) a managed session. Reuses this workspace's most recent active session when it was active within the last hour (--force-new always mints a fresh id), then spawns the detached Senti daemon that manages it — agent greetings, mention routing, recaps, checkpoints — surviving this terminal. Pass --no-daemon for an unmanaged session.",
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
      "--force",
      "Alias of --force-new (both always mint a fresh session)",
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
    .option(
      "--no-daemon",
      "Do not spawn the detached Senti daemon (session will be unmanaged: no greetings, recaps, or checkpoints)",
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
        forceNew: Boolean(options.forceNew || options.force),
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

      // Make the session managed by default: spawn the Senti daemon as a
      // DETACHED process so greetings, mention routing, recaps, and
      // checkpoints keep running after this CLI command (and terminal)
      // exits. The old in-process `startSenti` died the moment this
      // action returned, so every session was effectively unmanaged.
      // Deduped via the session's pid file; best-effort and never blocks
      // session creation.
      let sentiDaemon = { spawned: false, pid: null, reason: "skipped", logPath: "" };
      if (sentiAutostartDisabled()) {
        sentiDaemon.reason = "disabled";
      } else if (options.daemon === false) {
        sentiDaemon.reason = "opt_out";
      } else {
        sentiDaemon = await spawnDetachedSentiDaemon({
          sessionId: created.sessionId,
          targetPath,
        });
      }
      payload.sentiDaemon = sentiDaemon;

      // Pin the deterministic first-Senti-message as the opening event of a
      // NEW room so every joining agent reads the operating protocol
      // (identity, mandatory commands, reaction/threading/lock/evidence
      // rules, cadence). Skipped on resume (already posted) and opt-outable
      // via SENTINELAYER_SKIP_FIRST_MESSAGE=1. Best-effort, never blocks.
      let firstMessage = { posted: false, reason: "skipped" };
      const skipFirstMessage = String(process.env.SENTINELAYER_SKIP_FIRST_MESSAGE || "").trim() === "1";
      if (!resumed && !skipFirstMessage) {
        firstMessage = await postFirstSentiMessage({
          sessionId: created.sessionId,
          targetPath,
        }).catch((error) => ({ posted: false, reason: normalizeString(error?.message) || "error" }));
      }
      payload.firstMessage = firstMessage;

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
        printSentiDaemonStatusLine(sentiDaemon, { cliCommand, sessionId: created.sessionId });
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
      console.log(pc.gray(`Dashboard: ${dashboardUrl}`));
      printSentiDaemonStatusLine(sentiDaemon, { cliCommand, sessionId: created.sessionId });
      console.log(
        pc.gray(
          `Agents join with: ${cliCommand} session join ${created.sessionId} --agent <name>`,
        ),
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
            (options.forceNew || options.force)
              ? `Tip: fresh session minted (--force-new honored). Subsequent \`${cliCommand} session start\` here within an hour will resume this new session.`
              : `Tip: subsequent \`${cliCommand} session start\` in this workspace within an hour will resume this session. Pass --force-new to override.`,
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
    .option("--invite-token <token>", "Invitation token to accept before joining the session")
    .option("--seat-key <key>", "Reserved session seat key to claim while accepting an invite")
    .option("--idempotency-key <key>", "Explicit idempotency key for invite acceptance")
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
      const explicitAgent = normalizeString(options.agent);
      const legacyName = normalizeString(options.name);
      const inviteToken = normalizeString(options.inviteToken);
      let invitationAccept = null;
      let invitationAcceptResult = null;
      if (inviteToken) {
        invitationAccept = await acceptSessionInvitation(normalizedSessionId, {
          targetPath,
          invitationToken: inviteToken,
          seatKey: options.seatKey,
          agentId: explicitAgent || legacyName,
          idempotencyKey: options.idempotencyKey,
        });
        invitationAcceptResult =
          invitationAccept?.result && typeof invitationAccept.result === "object"
            ? invitationAccept.result
            : null;
      }

      // PR #483 contract: verify the session exists and the caller has access
      // BEFORE materializing local cache state. Without this we'd silently
      // create a phantom local NDJSON for a session that's archived or owned
      // by another tenant — which is the bug Carter reported when asking for
      // a clean "share an id from web → join in CLI" flow.
      //
      // Invitation acceptance is the only exception to the old ordering:
      // before the invite is accepted the user may legitimately receive 403,
      // so --invite-token performs the guarded accept mutation first and this
      // verification proves membership immediately afterward.
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

      const acceptedOnboarding = normalizeSessionOnboarding(
        invitationAcceptResult?.onboarding,
        invitationAcceptResult?.claimedSeat,
      );
      const acceptedAgentId = normalizeString(acceptedOnboarding?.agentId);
      const agentSeed = explicitAgent || acceptedAgentId || legacyName;
      const resolvedAgentId = await defaultAgentId(agentSeed, targetPath);
      const roleWasExplicit = optionWasSetByCli(command, "role");
      const role =
        normalizeString(roleWasExplicit ? options.role : acceptedOnboarding?.role || options.role) ||
        "coder";
      const model = normalizeString(options.model) || "cli";
      const hasConcreteAgentIdentity = Boolean(explicitAgent || acceptedAgentId);

      // `registerAgent` already writes the canonical `agent_join` event to the
      // local NDJSON and best-effort relays it to /events via appendToStream
      // → syncSessionEventToApi. That gives us the exact `post-agent` parity
      // the spec calls for when `--agent <granted>` or an accepted reserved
      // seat provides a concrete agent id. We don't double-emit; we record
      // whether a durable agent identity path was used
      // so the JSON output can advertise it to callers (and tests).
      const joined = await registerAgent(normalizedSessionId, {
        targetPath,
        agentId: resolvedAgentId,
        model,
        displayName: normalizeString(acceptedOnboarding?.displayName),
        clientKind: "cli",
        role,
        trackProcessExit: false,
        awaitRemoteSync: hasConcreteAgentIdentity,
      });
      const agentJoinRelayed =
        joined.emittedJoinEvent !== false &&
        hasConcreteAgentIdentity &&
        Boolean(resolvedAgentId) &&
        resolvedAgentId !== "cli-user" &&
        resolvedAgentId !== "unknown" &&
        !resolvedAgentId.startsWith("human-");
      const onboardingBrief = await writeSessionOnboardingBrief(normalizedSessionId, {
        targetPath,
        onboarding: acceptedOnboarding,
        claimedSeat: invitationAcceptResult?.claimedSeat || null,
        agentId: joined.agentId,
      });

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
        displayName: joined.displayName || null,
        provider: joined.provider || null,
        clientKind: joined.clientKind || null,
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
        invitationAccepted: Boolean(invitationAcceptResult?.ok || invitationAccept),
        invitationAccept: invitationAccept
          ? {
              idempotencyKey: invitationAccept.idempotencyKey,
              claimedSeat: invitationAcceptResult?.claimedSeat || null,
              onboarding: acceptedOnboarding,
              capacity: invitationAcceptResult?.capacity || null,
            }
          : null,
        onboardingGuide: onboardingBrief
          ? {
              markdownPath: onboardingBrief.markdownPath,
              jsonPath: onboardingBrief.jsonPath,
            }
          : null,
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
      if (payload.invitationAccepted) {
        const seat = payload.invitationAccept?.claimedSeat || {};
        const seatLabel = normalizeString(seat.seatKey)
          ? `; claimed ${normalizeString(seat.seatType) || "reserved"} seat ${seat.seatKey}`
          : "";
        console.log(pc.green(`Invitation accepted${seatLabel}`));
      }
      console.log(pc.gray(`agent=${joined.agentId} role=${joined.role} model=${joined.model}`));
      if (payload.onboardingGuide?.markdownPath) {
        console.log(pc.gray(`onboarding=${payload.onboardingGuide.markdownPath}`));
      }
    });

  session
    .command("say <sessionId> [message...]")
    .description("Send a message to the session")
    .option(
      "--agent <id>",
      "Agent id to emit from; defaults to SENTINELAYER_AGENT_ID, then the sole local joined agent, then cli-user",
    )
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
    .option("--message-file <path>", "Read the message body from a UTF-8 file")
    .option("--stdin", "Read the message body from stdin")
    .option("--force-cli-user", "Allow fallback sends as cli-user when no agent identity can be resolved")
    .option("--local-only", "Append only to the local session cache without remote send confirmation")
    .option("--path <path>", "Workspace path for the session", ".")
    .option("--json", "Emit machine-readable output")
    .action(async (sessionId, messageParts, options, command) => {
      const normalizedSessionId = normalizeString(sessionId);
      if (!normalizedSessionId) {
        throw new Error("session id is required.");
      }
      const normalizedMessage = await resolveSessionSayMessageInput(messageParts, options);
      if (!normalizedMessage) {
        throw new Error("message is required.");
      }
      const targetPath = path.resolve(process.cwd(), String(options.path || "."));
      const identity = await resolveSessionSayIdentity({
        sessionId: normalizedSessionId,
        agentId: options.agent,
        targetPath,
      });
      const agentId = identity.agentId;
      if (shouldBlockImplicitCliUserSessionSay(identity) && !options.forceCliUser) {
        throw new Error(
          `${identity.identityWarning} Re-run with --force-cli-user only for intentional anonymous/operator relay posts.`,
        );
      }
      const localSession = await ensureLocalSessionForRemoteCommand(normalizedSessionId, {
        targetPath,
      });
      const to = normalizeString(options.to);
      const replyToSequenceId = parseOptionalPositiveInteger(options.replyTo, "reply-to");
      const replyToCursor = normalizeString(options.replyCursor);
      const clientMessageId = `cli-${randomUUID()}`;
      const eventPayload = {
        message: normalizedMessage,
        channel: "session",
        clientMessageId,
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
      const agent = await resolveSessionAgentEnvelope(normalizedSessionId, agentId, {
        targetPath,
        model: options.model,
        role: options.role,
        displayName: options.displayName,
      });
      const agentRegistration = await ensureSessionSayAgentRegistered(normalizedSessionId, agent, {
        targetPath,
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
      let remoteConfirmation = null;
      let remoteConfirmationAnchor = null;
      let localOnly = Boolean(options.localOnly) || remoteSessionLookupDisabled();
      if (!localOnly) {
        remoteConfirmationAnchor = await readSessionConfirmationAnchor(normalizedSessionId, { targetPath });
        if (!remoteConfirmationAnchor?.ok) {
          if (!localSession.materialized && isLocalOnlySessionSayReason(remoteConfirmationAnchor?.reason)) {
            localOnly = true;
          } else {
            throw new Error(
              `Remote send confirmation anchor failed (${remoteConfirmationAnchor?.reason || "unknown"}); local cache was not updated. Use --local-only only when you intentionally want an offline local note.`,
            );
          }
        }
      }
      if (!localOnly) {
        for (let attempt = 0; attempt < 2; attempt += 1) {
          remoteSync = await syncSessionEventToApi(normalizedSessionId, event, {
            targetPath,
          });
          if (remoteSync?.synced) break;
        }
        if (!remoteSync?.synced) {
          throw new Error(
            `Remote send failed (${remoteSync?.reason || "unknown"}); local cache was not updated. Use --local-only only when you intentionally want an offline local note.`,
          );
        } else {
          remoteConfirmation = await confirmSessionEventVisible(normalizedSessionId, clientMessageId, {
            targetPath,
            anchorCursor: remoteConfirmationAnchor?.cursor,
          });
          if (!remoteConfirmation?.confirmed) {
            throw new Error(
              `Remote send was accepted but not visible in canonical session events (${remoteConfirmation?.reason || "not_visible"}); local cache was not updated.`,
            );
          }
        }
      }
      const persisted = await appendToStream(normalizedSessionId, event, {
        targetPath,
        syncRemote: false,
      });
      const payload = {
        command: "session say",
        targetPath,
        sessionId: normalizedSessionId,
        agentId,
        event: persisted,
        materializedLocalSession: localSession.materialized,
        refreshedLocalSession: Boolean(localSession.refreshed),
        identitySource: identity.source,
        identityWarning: identity.identityWarning || undefined,
        agentRegistration,
        remoteSync: remoteSync || undefined,
        remoteConfirmationAnchor: remoteConfirmationAnchor || undefined,
        remoteConfirmation: remoteConfirmation || undefined,
        localOnly,
      };
      if (shouldEmitJson(options, command)) {
        console.log(JSON.stringify(payload, null, 2));
        return;
      }
      if (identity.identityWarning) {
        console.error(pc.yellow(`Identity warning: ${identity.identityWarning}`));
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
      const clientMessageId = `cli-agent-${randomUUID()}`;
      const eventPayload = {
        message: normalizedMessage,
        channel: "session",
        source: "agent",
        clientKind: "cli",
        clientMessageId,
      };
      if (to) {
        eventPayload.to = to;
      }
      const agentIdentity = inferSessionAgentIdentity({
        agentId,
        model: options.model,
        displayName: options.displayName,
        clientKind: "cli",
      });
      const agent = {
        id: agentId,
        model: normalizeString(agentIdentity.model) || "cli",
        displayName: normalizeString(agentIdentity.displayName) || undefined,
        provider: normalizeString(agentIdentity.provider) || undefined,
        role: normalizeString(options.role) || "coder",
        clientKind: normalizeString(agentIdentity.clientKind) || "cli",
      };
      const event = createAgentEvent({
        event: "session_message",
        agent,
        sessionId: normalizedSessionId,
        payload: eventPayload,
      });
      event.eventId = clientMessageId;
      event.idempotencyToken = clientMessageId;

      const remoteConfirmationAnchor = await readSessionConfirmationAnchor(normalizedSessionId, {
        targetPath,
      });
      if (!remoteConfirmationAnchor?.ok) {
        if (remoteConfirmationAnchor?.reason === "api_403") {
          throw new Error(
            `Agent post failed (api_403). Ensure this user has an active grant for '${agentId}'.`,
          );
        }
        throw new Error(
          `Agent post confirmation anchor failed (${remoteConfirmationAnchor?.reason || "unknown"}); local cache was not updated.`,
        );
      }
      const remoteSync = await syncSessionEventToApi(normalizedSessionId, event, {
        targetPath,
      });
      if (!remoteSync?.synced) {
        throw new Error(
          `Agent post failed (${remoteSync?.reason || "unknown"}). Ensure this user has an active grant for '${agentId}'.`,
        );
      }
      const remoteConfirmation = await confirmSessionEventVisible(normalizedSessionId, clientMessageId, {
        targetPath,
        anchorCursor: remoteConfirmationAnchor?.cursor,
      });
      if (!remoteConfirmation?.confirmed) {
        throw new Error(
          `Agent post was accepted but not visible in canonical session events (${remoteConfirmation?.reason || "not_visible"}); local cache was not updated.`,
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
        remoteConfirmationAnchor,
        remoteConfirmation,
      };
      if (shouldEmitJson(options, command)) {
        console.log(JSON.stringify(payload, null, 2));
        return;
      }
      console.log(formatEventLine(persisted));
    });

  session
    .command("observe <sessionId> [summary...]")
    .description("Record a durable product/process observation in the session")
    .requiredOption("--agent <id>", "Granted non-human agent id to record the observation as")
    .option("--model <model>", "Agent model/provider hint", "cli")
    .option("--display-name <name>", "Human-readable agent display name")
    .option("--role <role>", "Agent role metadata", "observer")
    .option(
      "--kind <kind>",
      `Observation kind: ${[...SESSION_OBSERVATION_KINDS].join(", ")}`,
      "process",
    )
    .option(
      "--severity <level>",
      `Observation severity: ${[...SESSION_OBSERVATION_SEVERITIES].join(", ")}`,
      "info",
    )
    .option("--owner <owner>", "Suggested owner/team for follow-up")
    .option("--batch <batch>", "Suggested PR batch or backlog lane")
    .option("--target-sequence <n>", "Anchor the observation to a session sequence id")
    .option("--target-cursor <cursor>", "Anchor the observation to a session event cursor")
    .option("--proposal <text>", "Suggested remediation or next step")
    .option("--message-file <path>", "Read the observation summary from a UTF-8 file")
    .option("--stdin", "Read the observation summary from stdin")
    .option("--path <path>", "Workspace path for the session", ".")
    .option("--json", "Emit machine-readable output")
    .action(async (sessionId, summaryParts, options, command) => {
      const normalizedSessionId = normalizeString(sessionId);
      if (!normalizedSessionId) {
        throw new Error("session id is required.");
      }
      const summary = normalizeSessionObservationText(
        await resolveSessionSayMessageInput(summaryParts, options),
        "summary",
        SESSION_OBSERVATION_SUMMARY_MAX_LENGTH,
      );
      if (!summary) {
        throw new Error("summary is required.");
      }
      const targetPath = path.resolve(process.cwd(), String(options.path || "."));
      const agentId = requireGrantedNonHumanAgentId(options.agent, "observe");
      const kind = normalizeSessionObservationChoice(
        options.kind,
        SESSION_OBSERVATION_KINDS,
        "process",
        "kind",
      );
      const severity = normalizeSessionObservationChoice(
        options.severity,
        SESSION_OBSERVATION_SEVERITIES,
        "info",
        "severity",
      );
      const owner = normalizeSessionObservationText(
        options.owner,
        "owner",
        SESSION_OBSERVATION_OPTION_MAX_LENGTH,
      );
      const proposedBatch = normalizeSessionObservationText(
        options.batch,
        "batch",
        SESSION_OBSERVATION_OPTION_MAX_LENGTH,
      );
      const proposal = normalizeSessionObservationText(
        options.proposal,
        "proposal",
        SESSION_OBSERVATION_PROPOSAL_MAX_LENGTH,
      );
      const targetSequenceId = parseOptionalPositiveInteger(options.targetSequence, "target-sequence");
      const targetCursor = normalizeSessionObservationText(
        options.targetCursor,
        "target-cursor",
        SESSION_OBSERVATION_OPTION_MAX_LENGTH,
      );
      const localSession = await ensureLocalSessionForRemoteCommand(normalizedSessionId, {
        targetPath,
      });
      const clientMessageId = `cli-observation-${randomUUID()}`;
      const eventPayload = {
        schema: "session_observation/v1",
        summary,
        message: summary,
        kind,
        severity,
        channel: "session",
        source: "session_observe",
        clientKind: "cli",
        clientMessageId,
      };
      if (owner) eventPayload.owner = owner;
      if (proposedBatch) eventPayload.proposedBatch = proposedBatch;
      if (proposal) eventPayload.proposal = proposal;
      if (targetSequenceId) eventPayload.targetSequenceId = targetSequenceId;
      if (targetCursor) eventPayload.targetCursor = targetCursor;

      const agent = await resolveSessionAgentEnvelope(normalizedSessionId, agentId, {
        targetPath,
        model: options.model,
        role: normalizeString(options.role) || "observer",
        displayName: options.displayName,
      });
      agent.role = normalizeString(agent.role) || "observer";
      agent.model = normalizeString(agent.model) || "cli";
      agent.clientKind = normalizeString(agent.clientKind) || "cli";

      const event = createAgentEvent({
        event: "session_observation",
        agent,
        sessionId: normalizedSessionId,
        payload: eventPayload,
      });
      event.eventId = clientMessageId;
      event.idempotencyToken = clientMessageId;

      const remoteConfirmationAnchor = await readSessionConfirmationAnchor(normalizedSessionId, {
        targetPath,
      });
      if (!remoteConfirmationAnchor?.ok) {
        if (remoteConfirmationAnchor?.reason === "api_403") {
          throw new Error(
            `Observation failed (api_403). Ensure this user has an active grant for '${agentId}'.`,
          );
        }
        throw new Error(
          `Observation confirmation anchor failed (${remoteConfirmationAnchor?.reason || "unknown"}); local cache was not updated.`,
        );
      }
      const remoteSync = await syncSessionEventToApi(normalizedSessionId, event, {
        targetPath,
      });
      if (!remoteSync?.synced) {
        throw new Error(
          `Observation failed (${remoteSync?.reason || "unknown"}). Ensure this user has an active grant for '${agentId}'.`,
        );
      }
      const remoteConfirmation = await confirmSessionEventVisible(normalizedSessionId, clientMessageId, {
        targetPath,
        anchorCursor: remoteConfirmationAnchor?.cursor,
      });
      if (!remoteConfirmation?.confirmed) {
        throw new Error(
          `Observation was accepted but not visible in canonical session events (${remoteConfirmation?.reason || "not_visible"}); local cache was not updated.`,
        );
      }

      const persisted = await appendToStream(normalizedSessionId, event, {
        targetPath,
        syncRemote: false,
      });
      const payload = {
        command: "session observe",
        targetPath,
        sessionId: normalizedSessionId,
        agentId,
        event: persisted,
        materializedLocalSession: localSession.materialized,
        refreshedLocalSession: Boolean(localSession.refreshed),
        remoteSync,
        remoteConfirmationAnchor,
        remoteConfirmation,
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
    // Resolve the authoring agent. The bare `cli-user` default is rejected by
    // the API (api_422); resolveMessageActionIdentity treats it as unset and
    // falls back to the joined agent. If no concrete identity resolves, fail
    // with actionable guidance instead of firing a request guaranteed to 422.
    const identity = await resolveMessageActionIdentity({
      sessionId: normalizedSessionId,
      optionAgent: options.agent,
      targetPath,
      env: process.env,
    });
    if (shouldBlockImplicitCliUserSessionSay(identity)) {
      throw new Error(
        identity.identityWarning ||
          `${commandName} requires an agent identity; pass --agent <id>, set SENTINELAYER_AGENT_ID, or run session join --agent <id> first.`,
      );
    }
    const agentId = identity.agentId;
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
    if (localAppend.event || actionEvent) {
      console.log(formatEventLine(localAppend.event || actionEvent));
    } else {
      const targetLabel = targetSequenceId ? `#${targetSequenceId}` : targetCursor || targetActionId || "target";
      console.log(pc.green(`Recorded ${normalizedActionType} on ${targetLabel}.`));
    }
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
    .option("--agent <id>", "Agent id authoring the action (defaults to the joined session agent)")
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
    .option("--agent <id>", "Agent id authoring the action (defaults to the joined session agent)")
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
    .option("--agent <id>", "Agent id authoring the action (defaults to the joined session agent)")
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
    .option("--agent <id>", "Agent id authoring the action (defaults to the joined session agent)")
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
    .description("Manually backfill a read receipt for a target session event")
    .option("--agent <id>", "Agent id authoring the action (defaults to the joined session agent)")
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
    .command("pins <sessionId>")
    .description("List the session's pinned messages with their content so agents can read them")
    .option("--path <path>", "Workspace path for the session", ".")
    .option("--json", "Emit machine-readable output")
    .action(async (sessionId, options, command) => {
      const normalizedSessionId = normalizeString(sessionId);
      if (!normalizedSessionId) {
        throw new Error("session id is required.");
      }
      const targetPath = path.resolve(process.cwd(), String(options.path || "."));
      await ensureLocalSessionForRemoteCommand(normalizedSessionId, { targetPath });
      const result = await fetchSessionPinnedMessages(normalizedSessionId, { targetPath });
      if (!result.ok) {
        throw new Error(`Could not load pinned messages (${result.reason || "unknown"}).`);
      }
      const pinLimit = result.pinLimit || 10;
      const payload = {
        command: "session pins",
        sessionId: normalizedSessionId,
        pinLimit,
        count: result.count,
        pins: result.pins,
      };
      if (shouldEmitJson(options, command)) {
        console.log(JSON.stringify(payload, null, 2));
        return payload;
      }
      if (!result.count) {
        console.log(pc.gray("No pinned messages in this session."));
        return payload;
      }
      console.log(pc.bold(`📌 Pinned messages (${result.count}/${pinLimit})`));
      for (const pin of result.pins) {
        const seqLabel = pin.targetSequenceId ? `#${pin.targetSequenceId}` : "(unknown sequence)";
        const author = pin.author || "unknown";
        const pinnedBy = pin.pinnedBy ? ` · pinned by ${pin.pinnedBy}` : "";
        const when = pin.pinnedAt ? ` · ${pin.pinnedAt}` : "";
        console.log("");
        console.log(pc.cyan(`${seqLabel}  ${author}${pinnedBy}${when}`));
        if (pin.content) {
          for (const line of String(pin.content).split("\n")) {
            console.log(`  ${line}`);
          }
        } else {
          console.log(pc.gray("  (no readable text content for this pinned event)"));
        }
      }
      return payload;
    });

  const runFileLockCommand = async (verb, sessionId, files, options, command) => {
    const normalizedSessionId = normalizeString(sessionId);
    if (!normalizedSessionId) {
      throw new Error("session id is required.");
    }
    const fileList = (Array.isArray(files) ? files : [files])
      .map((file) => normalizeString(file))
      .filter(Boolean);
    if (fileList.length === 0) {
      throw new Error(`session ${verb} requires at least one file path.`);
    }
    const targetPath = path.resolve(process.cwd(), String(options.path || "."));
    await ensureLocalSessionForRemoteCommand(normalizedSessionId, { targetPath });
    const identity = await resolveMessageActionIdentity({
      sessionId: normalizedSessionId,
      optionAgent: options.agent,
      targetPath,
      env: process.env,
    });
    if (shouldBlockImplicitCliUserSessionSay(identity)) {
      throw new Error(
        identity.identityWarning ||
          `session ${verb} requires an agent identity; pass --agent <id>, set SENTINELAYER_AGENT_ID, or run session join --agent <id> first.`,
      );
    }
    const intent = normalizeString(options.intent);
    const results = [];
    const processed = [];
    const skipped = [];
    const failed = [];
    for (const file of fileList) {
      if (verb === "lock") {
        const result = await lockFile(normalizedSessionId, identity.agentId, file, {
          intent,
          targetPath,
          awaitRemoteSync: true,
        });
        const record = {
          file: result.file || file,
          locked: Boolean(result.locked),
          reason: result.reason || (result.locked ? "locked" : "held_by_other_agent"),
          heldBy: result.heldBy || null,
          since: result.since || null,
        };
        results.push(record);
        if (result.locked) {
          processed.push(record.file);
        } else {
          failed.push(record);
        }
        continue;
      }

      const result = await unlockFile(normalizedSessionId, identity.agentId, file, {
        reason: intent || "manual_release",
        targetPath,
        awaitRemoteSync: true,
      });
      const record = {
        file: result.file || file,
        unlocked: Boolean(result.unlocked),
        reason: result.reason || (result.unlocked ? "unlocked" : "not_locked"),
        heldBy: result.heldBy || null,
        since: result.since || null,
      };
      results.push(record);
      if (result.unlocked) {
        processed.push(record.file);
      } else if (record.reason === "not_locked") {
        skipped.push(record);
      } else {
        failed.push(record);
      }
    }

    if (failed.length > 0) {
      const summary = failed
        .map((item) => `${item.file}${item.heldBy ? ` held by ${item.heldBy}` : ""}`)
        .join(", ");
      throw new Error(`session ${verb} failed for ${summary}`);
    }
    const payload = {
      command: `session ${verb}`,
      sessionId: normalizedSessionId,
      agentId: identity.agentId,
      files: processed,
      results,
      skipped,
    };
    if (shouldEmitJson(options, command)) {
      console.log(JSON.stringify(payload, null, 2));
      return payload;
    }
    const action = verb === "lock" ? "Requested lock on" : "Released";
    console.log(pc.green(`${action} ${processed.length} file(s) as ${identity.agentId}: ${processed.join(", ")}`));
    if (verb === "lock") {
      console.log(
        pc.gray("Senti enforces fail-closed; locks auto-release on TTL. Release with `sl session unlock`."),
      );
    }
    return payload;
  };

  session
    .command("lock <sessionId> <files...>")
    .description("Claim exclusive file locks via Senti (fail-closed, TTL auto-release)")
    .option("--intent <text>", "Why you're locking these files (shown to peers)")
    .option("--agent <id>", "Agent id claiming the lock (defaults to the joined session agent)")
    .option("--path <path>", "Workspace path for the session", ".")
    .option("--json", "Emit machine-readable output")
    .action(async (sessionId, files, options, command) => {
      await runFileLockCommand("lock", sessionId, files, options, command);
    });

  session
    .command("unlock <sessionId> <files...>")
    .description("Release file locks you hold (Senti only lets the holder release)")
    .option("--intent <text>", "Optional note on the release")
    .option("--agent <id>", "Agent id releasing the lock (defaults to the joined session agent)")
    .option("--path <path>", "Workspace path for the session", ".")
    .option("--json", "Emit machine-readable output")
    .action(async (sessionId, files, options, command) => {
      await runFileLockCommand("unlock", sessionId, files, options, command);
    });

  session
    .command("locks <sessionId>")
    .description("List active file locks for the session (who holds what, and when they expire)")
    .option("--path <path>", "Workspace path for the session", ".")
    .option("--json", "Emit machine-readable output")
    .action(async (sessionId, options, command) => {
      const normalizedSessionId = normalizeString(sessionId);
      if (!normalizedSessionId) {
        throw new Error("session id is required.");
      }
      const targetPath = path.resolve(process.cwd(), String(options.path || "."));
      await ensureLocalSessionForRemoteCommand(normalizedSessionId, { targetPath });
      const locks = await listFileLocks(normalizedSessionId, { targetPath });
      const lockList = Array.isArray(locks) ? locks : [];
      const payload = {
        command: "session locks",
        sessionId: normalizedSessionId,
        count: lockList.length,
        locks: lockList,
      };
      if (shouldEmitJson(options, command)) {
        console.log(JSON.stringify(payload, null, 2));
        return payload;
      }
      if (lockList.length === 0) {
        console.log(pc.gray("No active file locks."));
        return payload;
      }
      console.log(pc.bold(`Active file locks (${lockList.length})`));
      for (const lock of lockList) {
        const file = normalizeString(lock.file || lock.filePath) || "(unknown file)";
        const holder = normalizeString(lock.agentId) || "unknown";
        const expires = normalizeString(lock.expiresAt);
        console.log(pc.cyan(`  ${file}`) + pc.gray(`  held by ${holder}${expires ? ` · expires ${expires}` : ""}`));
      }
      return payload;
    });

  session
    .command("listeners <sessionId>")
    .description(
      "List who is actively listening to the session and at what poll cadence (active/idle/stale/stopped), derived from listener presence heartbeats. Mirrors the web roster.",
    )
    .option("--path <path>", "Workspace path for the session", ".")
    .option("--limit <n>", "Recent events to scan for heartbeats (default 200)", "200")
    .option("--json", "Emit machine-readable output")
    .action(async (sessionId, options, command) => {
      const normalizedSessionId = normalizeString(sessionId);
      if (!normalizedSessionId) {
        throw new Error("session id is required.");
      }
      const targetPath = path.resolve(process.cwd(), String(options.path || "."));
      await ensureLocalSessionForRemoteCommand(normalizedSessionId, { targetPath });
      const limit = parsePositiveInteger(options.limit, "limit", 200);
      const result = await fetchSessionListeners(normalizedSessionId, { targetPath, limit });
      const listeners = Array.isArray(result.listeners) ? result.listeners : [];
      const live = listeners.filter((row) => row.status === "active" || row.status === "idle").length;
      const payload = {
        command: "session listeners",
        sessionId: normalizedSessionId,
        ok: Boolean(result.ok),
        reason: result.ok ? undefined : result.reason,
        count: listeners.length,
        liveCount: live,
        listeners,
      };
      if (shouldEmitJson(options, command)) {
        console.log(JSON.stringify(payload, null, 2));
        return payload;
      }
      if (!result.ok) {
        console.log(pc.yellow(`Could not read listeners (${result.reason}).`));
        return payload;
      }
      if (listeners.length === 0) {
        console.log(pc.gray("No listeners detected (no recent presence heartbeats)."));
        return payload;
      }
      console.log(pc.bold(`Listeners (${live} live / ${listeners.length} seen)`));
      for (const row of listeners) {
        const line = formatListenerLine(row);
        if (row.status === "active") console.log(pc.green(`  ${line}`));
        else if (row.status === "idle") console.log(pc.cyan(`  ${line}`));
        else console.log(pc.gray(`  ${line}`));
      }
      return payload;
    });

  session
    .command("stop-listener <sessionId>")
    .description(
      "Ask an agent's listener to stop (save energy). Posts a listener_stop directive the listener honors on its next poll, then exits cleanly. Targets one agent with --agent; omit it to stop every listener in the room.",
    )
    .option("--agent <id>", "Agent whose listener to stop (omit to stop all listeners in the room)")
    .option("--path <path>", "Workspace path for the session", ".")
    .option("--json", "Emit machine-readable output")
    .action(async (sessionId, options, command) => {
      const normalizedSessionId = normalizeString(sessionId);
      if (!normalizedSessionId) {
        throw new Error("session id is required.");
      }
      const targetPath = path.resolve(process.cwd(), String(options.path || "."));
      const targetAgent = normalizeString(options.agent);
      await ensureLocalSessionForRemoteCommand(normalizedSessionId, { targetPath });
      const event = createAgentEvent({
        event: "listener_stop",
        agent: { id: "session-control", model: "control", persona: "Session Control" },
        sessionId: normalizedSessionId,
        payload: {
          // targetAgentId routes the directive to that agent's listener (an
          // event recipient); omitting it broadcasts to every listener.
          ...(targetAgent ? { targetAgentId: targetAgent } : { broadcast: true }),
          reason: "operator_stop",
        },
      });
      const remoteSync = await syncSessionEventToApi(normalizedSessionId, event, { targetPath }).catch(
        (error) => ({ synced: false, reason: normalizeString(error?.message) || "sync_failed" }),
      );
      await appendToStream(normalizedSessionId, event, { targetPath, syncRemote: false }).catch(() => {});
      const payload = {
        command: "session stop-listener",
        sessionId: normalizedSessionId,
        targetAgent: targetAgent || null,
        scope: targetAgent ? "agent" : "all",
        remoteSync: remoteSync || undefined,
      };
      if (shouldEmitJson(options, command)) {
        console.log(JSON.stringify(payload, null, 2));
        return payload;
      }
      console.log(
        pc.yellow(
          targetAgent
            ? `Listener stop requested for ${targetAgent}; it will exit on its next poll.`
            : "Listener stop requested for ALL listeners in this room.",
        ),
      );
      return payload;
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
    .option(
      "--presence-interval <seconds>",
      "Minimum seconds between remote listener heartbeat events (default 60)",
      "60",
    )
    .option(
      "--presence-keepalive <seconds>",
      "Maximum seconds between unchanged remote listener heartbeat events (default 180)",
      "180",
    )
    .option(
      "--no-presence",
      "Do not publish durable listener lifecycle/heartbeat events",
    )
    .option(
      "--model <model>",
      "Model/provider label to publish with listener presence",
      process.env.SENTINELAYER_AGENT_MODEL || process.env.SENTINELAYER_MODEL || "cli",
    )
    .option("--display-name <name>", "Human-readable listener name for presence")
    .option("--emit <format>", "Output format: ndjson or text", "ndjson")
    .option("--transport <mode>", "Listen transport: auto, stream, or poll (default auto)", "auto")
    .option("--limit <n>", "Maximum events to request per poll (default 200)", "200")
    .option("--path <path>", "Workspace path for the session", ".")
    .option("--since <cursor>", "Override the persisted listen cursor")
    .option("--from-now", "Advance the listen cursor to the latest durable event before polling")
    .option("--replay", "Emit matching historical events on the first poll")
    .option("--max-polls <n>", "Stop after N poll cycles (useful for tests and smoke checks)")
    .option(
      "--wake <command>",
      "Wake hook: run this shell command on each matched event (notify->resume bridge). Event JSON is piped to stdin; SL_WAKE_* env vars are set.",
    )
    .option(
      "--wake-host <name>",
      "Auto-wake: resume this host (claude|codex) on each addressed message so listening IS waking. Requires --resume-session.",
    )
    .option(
      "--resume-session <id>",
      "Host session/rollout id to resume on wake (the claude/codex session id, not the Senti id). Pairs with --wake-host.",
    )
    .option(
      "--coaching-interval <seconds>",
      "Seconds between in-session success reminders (ack, claim work, reply in-thread). Default 900; 0 disables.",
      "900",
    )
    .option("--no-coaching", "Do not emit periodic in-session success reminders")
    .option("--log-file <path>", "Also write listener output to a bounded rotating log file")
    .option(
      "--log-max-bytes <bytes>",
      `Rotate --log-file after this many bytes (default ${DEFAULT_ROTATING_LOG_MAX_BYTES})`,
      String(DEFAULT_ROTATING_LOG_MAX_BYTES),
    )
    .option(
      "--log-max-files <n>",
      `Total log files to retain including the active file (default ${DEFAULT_ROTATING_LOG_MAX_FILES})`,
      String(DEFAULT_ROTATING_LOG_MAX_FILES),
    )
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
      const presenceIntervalSeconds = parsePositiveInteger(
        options.presenceInterval,
        "presence-interval",
        60,
      );
      const presenceKeepaliveSeconds = parsePositiveInteger(
        options.presenceKeepalive,
        "presence-keepalive",
        180,
      );
      const listenerIdentity = inferSessionAgentIdentity({
        agentId,
        model: options.model,
        displayName: options.displayName,
        clientKind: "cli",
      });
      const agentModel = normalizeString(listenerIdentity.model) || "cli";
      const displayName = normalizeString(listenerIdentity.displayName) || agentId;
      const provider = normalizeString(listenerIdentity.provider);
      const clientKind = normalizeString(listenerIdentity.clientKind) || "cli";
      const limit = parsePositiveInteger(options.limit, "limit", 200);
      const emitFormat = normalizeString(options.emit).toLowerCase() || "ndjson";
      if (!["ndjson", "text"].includes(emitFormat)) {
        throw new Error("--emit must be one of: ndjson, text.");
      }
      const listenLogPath = normalizeString(options.logFile)
        ? path.resolve(targetPath, String(options.logFile))
        : "";
      // Optional wake hook: run a host command on each matched event so the
      // host can resume/wake its agent (the notify->resume bridge).
      const emitWakeNotice = (payload = {}) => {
        if (emitFormat === "ndjson") {
          console.log(
            JSON.stringify(
              createAgentEvent({
                event: "session_wake_hook",
                agentId,
                sessionId: normalizedSessionId,
                payload,
              }),
            ),
          );
        } else {
          const status = normalizeString(payload.status) || "fired";
          const detail = payload.reason ? ` (${payload.reason})` : payload.eventType ? ` ${payload.eventType}` : "";
          console.log(pc.cyan(`wake hook ${status}${detail}`));
        }
      };
      const wakeRunner = createSessionWakeRunner({
        command: options.wake,
        sessionId: normalizedSessionId,
        agentId,
        emit: emitWakeNotice,
      });
      // Auto-wake cutover: when --wake-host + --resume-session are given, an
      // addressed message INSTANTLY resumes the host (claude --resume / codex)
      // via the built wake bus — turning `listen` into a true waker on the
      // same poll. resolve-target routing inside ensures real-message-only,
      // addressed-to-us, never-self.
      const wakeHost = normalizeString(options.wakeHost);
      const triggerHostWake = wakeHost
        ? createListenerHostWake({
            host: wakeHost,
            resumeSessionId: options.resumeSession,
            agentId,
            sessionId: normalizedSessionId,
          })
        : null;
      if (wakeHost && !triggerHostWake) {
        throw new Error(
          "--wake-host requires a valid host (claude|codex) and --resume-session <host-session-id>.",
        );
      }
      const requestedTransport = normalizeString(options.transport).toLowerCase() || "auto";
      if (!["auto", "stream", "poll"].includes(requestedTransport)) {
        throw new Error("--transport must be one of: auto, stream, poll.");
      }
      const maxPolls =
        options.maxPolls === undefined
          ? null
          : parsePositiveInteger(options.maxPolls, "max-polls", 1);
      const listenTransport = requestedTransport === "auto" && maxPolls !== null
        ? "poll"
        : requestedTransport;
      const since = options.since === undefined ? undefined : String(options.since);
      if (options.fromNow && options.since !== undefined) {
        throw new Error("Use either --from-now or --since, not both.");
      }
      const restoreConsoleLog = listenLogPath
        ? installRotatingConsoleLog({
            logPath: listenLogPath,
            maxBytes: parsePositiveInteger(options.logMaxBytes, "log-max-bytes", DEFAULT_ROTATING_LOG_MAX_BYTES),
            maxFiles: parsePositiveInteger(options.logMaxFiles, "log-max-files", DEFAULT_ROTATING_LOG_MAX_FILES),
            tee: true,
          })
        : null;
      const ac = new AbortController();
      const onSigint = () => ac.abort();
      process.on("SIGINT", onSigint);
      const listenerId = `listener-${agentId}-${randomUUID()}`;
      const durablePresenceEnabled = options.presence !== false;
      const publishPresence = durablePresenceEnabled && canPublishListenerPresence(agentId);
      const presenceIntervalMs = Math.max(1, presenceIntervalSeconds) * 1000;
      const effectivePresenceKeepaliveSeconds =
        Math.max(presenceIntervalSeconds, presenceKeepaliveSeconds, intervalSeconds, 1);
      const presenceKeepaliveMs = effectivePresenceKeepaliveSeconds * 1000;
      let lastPresenceHeartbeatMs = 0;
      let lastPresenceHeartbeatFingerprint = "";

      // Periodic in-session success reminders (ack, claim work, reply
      // in-thread). Long-running interactive listeners only — skipped under
      // --max-polls (smoke/test) and when --no-coaching is set.
      const coachingIntervalSeconds =
        options.coaching === false
          ? 0
          : parsePositiveInteger(options.coachingInterval, "coaching-interval", 900);
      let coachingTick = 0;
      const emitCoaching = () => {
        if (emitFormat === "ndjson") {
          console.log(
            JSON.stringify(
              buildSessionCoachingEvent({
                sessionId: normalizedSessionId,
                agentId,
                agentModel,
                displayName,
                provider,
                clientKind,
                listenerId,
                tick: coachingTick++,
              }),
            ),
          );
        } else {
          console.log(pc.cyan("Session success reminders:"));
          for (const tip of SESSION_LIVE_SUCCESS_TIPS) {
            console.log(pc.gray(`  - ${tip}`));
          }
        }
      };
      let coachingTimer = null;
      if (coachingIntervalSeconds > 0 && maxPolls === null) {
        emitCoaching();
        coachingTimer = setInterval(emitCoaching, coachingIntervalSeconds * 1000);
        if (coachingTimer && typeof coachingTimer.unref === "function") {
          coachingTimer.unref();
        }
      }

      if (emitFormat === "text") {
        console.log(
          pc.gray(
            `Listening to session ${normalizedSessionId} as ${agentId}; transport=${listenTransport} idle=${intervalSeconds}s active=${activeIntervalSeconds}s/${activeWindowSeconds}s. Press Ctrl+C to stop.`,
          ),
        );
        if (!durablePresenceEnabled) {
          console.log(
            pc.gray(
              "Remote listener presence is disabled; no durable lifecycle events will be written.",
            ),
          );
        } else if (!publishPresence) {
          console.log(
            pc.gray(
              "Listener presence is local-only for placeholder, human, and guest agent ids.",
            ),
          );
        }
        if (options.fromNow) {
          console.log(pc.gray("Priming listener from the latest durable event; old backlog will be skipped."));
        }
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
          fromNow: Boolean(options.fromNow),
          persistStartCursor: Boolean(options.fromNow),
          transport: listenTransport,
          maxPolls,
          signal: ac.signal,
          onCatchup: async (catchup) => {
            if (emitFormat === "ndjson") {
              console.log(
                JSON.stringify(
                  buildListenerCatchupEvent({
                    sessionId: normalizedSessionId,
                    agentId,
                    agentModel,
                    displayName,
                    provider,
                    clientKind,
                    listenerId,
                    catchup,
                  }),
                ),
              );
            } else {
              console.log(pc.yellow(formatListenerCatchupNotice(catchup)));
            }
          },
          onEvent: async (event) => {
            // Cut-listener: a `listener_stop` directive addressed to this
            // agent (from the web "stop listening" control or
            // `sl session stop-listener`) cleanly exits this listener to save
            // energy. Untargeted (no targetAgentId) stops every listener.
            if (normalizeString(event?.event) === "listener_stop") {
              const target = normalizeString(event?.payload?.targetAgentId);
              if (!target || target === agentId) {
                if (emitFormat !== "ndjson") {
                  console.log(pc.yellow(`Listener stop requested for ${agentId}; exiting.`));
                }
                ac.abort();
                return;
              }
            }
            if (emitFormat === "ndjson") {
              console.log(JSON.stringify(event));
            } else {
              console.log(formatEventLine(event));
            }
            // Fire the wake hook for any matched event (incl. ack/like) so the
            // host can resume its agent.
            wakeRunner.trigger(event);
            // Auto-wake: instantly resume the host on an addressed message.
            if (triggerHostWake) {
              void Promise.resolve(triggerHostWake.trigger(event)).then((outcome) => {
                if (outcome?.woken && emitFormat !== "ndjson") {
                  console.log(pc.green(`auto-wake: resumed ${wakeHost} (${agentId})`));
                } else if (outcome && !outcome.woken && outcome.reason !== "not_routed" && emitFormat !== "ndjson") {
                  console.log(pc.yellow(`auto-wake: ${wakeHost} resume failed (${outcome.reason})`));
                }
              });
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
          onLifecycle: async (lifecycle) => {
            // Wake-confirmation runs on every heartbeat regardless of presence:
            // re-resume agents that were woken but never acked within the
            // window; confirm + retire the ones that did. (Carter's receipt
            // idea — a wake isn't done until the agent actually reads it.)
            if (triggerHostWake && normalizeString(lifecycle?.type) === "heartbeat") {
              const outcome = await triggerHostWake
                .reconcile({
                  nowMs: Date.now(),
                  fetchActions: (seq) =>
                    listSessionMessageActions(normalizedSessionId, {
                      targetPath,
                      targetSequenceId: seq,
                    }),
                })
                .catch(() => null);
              if (outcome && (outcome.retried > 0 || outcome.deadLettered > 0) && emitFormat !== "ndjson") {
                console.log(
                  pc.yellow(
                    `auto-wake reconcile: re-resumed ${outcome.retried}, gave up on ${outcome.deadLettered} (no ack).`,
                  ),
                );
              }
            }
            if (!publishPresence) return;
            const lifecycleType = normalizeString(lifecycle?.type);
            const publishLifecycle = {
              ...lifecycle,
              presenceIntervalSeconds,
              presenceKeepaliveSeconds: effectivePresenceKeepaliveSeconds,
            };
            if (lifecycleType === "heartbeat") {
              const nowMs = Date.now();
              const heartbeatDecision = shouldPublishListenerPresenceHeartbeat({
                lifecycle: publishLifecycle,
                nowMs,
                lastHeartbeatMs: lastPresenceHeartbeatMs,
                lastFingerprint: lastPresenceHeartbeatFingerprint,
                presenceIntervalMs,
                presenceKeepaliveMs,
              });
              if (!heartbeatDecision.publish) {
                return;
              }
              lastPresenceHeartbeatFingerprint = heartbeatDecision.fingerprint;
              lastPresenceHeartbeatMs = nowMs;
            }
            await publishListenerPresenceEvent({
              sessionId: normalizedSessionId,
              targetPath,
              agentId,
              agentModel,
              displayName,
              provider,
              clientKind,
              listenerId,
              lifecycle: publishLifecycle,
            });
          },
        });
      } finally {
        if (coachingTimer) {
          clearInterval(coachingTimer);
        }
        if (restoreConsoleLog) {
          restoreConsoleLog();
        }
        process.removeListener("SIGINT", onSigint);
      }
    });

  session
    .command("daemon [sessionId]")
    .description(
      "Run the Senti daemon that manages a session: greet joining agents, route mentions, emit recaps, and generate durable checkpoints. `session start` spawns this automatically as a detached background process — run it manually only for foreground monitoring or after --no-daemon. Records its pid in the session dir (senti-daemon.json) and exits when the session expires.",
    )
    .option("--session <id>", "Session id to monitor")
    .option("--force", "Take over even if senti-daemon.json reports another live daemon for this session")
    .option("--path <path>", "Workspace path for the session", ".")
    .option("--tick-interval <seconds>", "Seconds between health ticks (default 30)", "30")
    .option("--stale-agent-seconds <seconds>", "Seconds before an inactive agent is flagged stale (default 90)", "90")
    .option("--recap-interval <seconds>", "Seconds between periodic recaps when activity continues (default 300)", "300")
    .option("--recap-inactivity <seconds>", "Seconds of inactivity before a recap closeout (default 600)", "600")
    .option("--recap-event-threshold <n>", "Meaningful events required to force a recap before interval (default 5)", "5")
    .option("--checkpoint-interval <seconds>", "Minimum seconds between checkpoint attempts (default 60)", "60")
    .option("--checkpoint-min-events <n>", "Minimum events for generated checkpoint windows (default 20)", "20")
    .option("--checkpoint-max-events <n>", "Maximum events per generated checkpoint window (default 80)", "80")
    .option("--checkpoint-event-threshold <n>", "Meaningful events required to attempt a checkpoint (default 20)", "20")
    .option("--checkpoint-idle <seconds>", "Seconds after latest source event before idle checkpoint attempt (default 600)", "600")
    .option("--no-checkpoints", "Disable durable checkpoint generation")
    .option("--no-checkpoint-closeout", "Skip the final closeout checkpoint when the daemon stops")
    .option("--log-file <path>", "Also write daemon output to a bounded rotating log file")
    .option(
      "--log-max-bytes <bytes>",
      `Rotate --log-file after this many bytes (default ${DEFAULT_ROTATING_LOG_MAX_BYTES})`,
      String(DEFAULT_ROTATING_LOG_MAX_BYTES),
    )
    .option(
      "--log-max-files <n>",
      `Total log files to retain including the active file (default ${DEFAULT_ROTATING_LOG_MAX_FILES})`,
      String(DEFAULT_ROTATING_LOG_MAX_FILES),
    )
    .option("--once", "Run one Senti health tick and exit (CI/dogfood smoke)")
    .option("--json", "Emit machine-readable output")
    .action(async (sessionId, options, command) => {
      const emitJson = shouldEmitJson(options, command);
      const normalizedSessionId = normalizeString(sessionId) || resolveSessionIdOption(options);
      if (!normalizedSessionId) {
        throw new Error("session daemon requires a session id (positional or --session).");
      }
      const targetPath = path.resolve(process.cwd(), String(options.path || "."));
      const tickIntervalMs = parsePositiveMillisecondsFromSeconds(
        options.tickInterval,
        "tick-interval",
        30,
      );
      const daemonLogPath = normalizeString(options.logFile)
        ? path.resolve(targetPath, String(options.logFile))
        : "";
      const restoreConsoleLog = daemonLogPath
        ? installRotatingConsoleLog({
            logPath: daemonLogPath,
            maxBytes: parsePositiveInteger(options.logMaxBytes, "log-max-bytes", DEFAULT_ROTATING_LOG_MAX_BYTES),
            maxFiles: parsePositiveInteger(options.logMaxFiles, "log-max-files", DEFAULT_ROTATING_LOG_MAX_FILES),
            tee: true,
          })
        : null;
      try {
      // One manager per session: refuse to double-run unless --force.
      // A stale pid file (reboot, hard kill) reads as not-running and is
      // safely overwritten.
      if (!options.once) {
        const existingDaemon = await getDaemonStatus(normalizedSessionId, { targetPath });
        if (existingDaemon.running && existingDaemon.pid !== process.pid && !options.force) {
          throw new Error(
            `A Senti daemon is already managing session ${normalizedSessionId} (pid ${existingDaemon.pid}). Use --force to take over.`,
          );
        }
        await writeDaemonPidRecord(normalizedSessionId, { targetPath, tickIntervalMs });
      }
      const daemon = await startSenti(normalizedSessionId, {
        targetPath,
        autoStart: false,
        tickIntervalMs,
        staleAgentSeconds: parsePositiveInteger(options.staleAgentSeconds, "stale-agent-seconds", 90),
        recapIntervalMs: parsePositiveMillisecondsFromSeconds(options.recapInterval, "recap-interval", 300),
        recapInactivityMs: parsePositiveMillisecondsFromSeconds(options.recapInactivity, "recap-inactivity", 600),
        recapActivityThreshold: parsePositiveInteger(options.recapEventThreshold, "recap-event-threshold", 5),
        checkpointGenerator: options.checkpoints === false ? null : undefined,
        checkpointIntervalMs: parsePositiveMillisecondsFromSeconds(options.checkpointInterval, "checkpoint-interval", 60),
        checkpointMinEvents: parsePositiveInteger(options.checkpointMinEvents, "checkpoint-min-events", 20),
        checkpointMaxEvents: parsePositiveInteger(options.checkpointMaxEvents, "checkpoint-max-events", 80),
        checkpointEventThreshold: parsePositiveInteger(options.checkpointEventThreshold, "checkpoint-event-threshold", 20),
        checkpointIdleMs: parsePositiveMillisecondsFromSeconds(options.checkpointIdle, "checkpoint-idle", 600),
        checkpointCloseoutOnStop: options.once ? false : options.checkpointCloseout !== false,
      });

      const runTickAndBuildPayload = async () => {
        const summary = await daemon.runTick(new Date().toISOString());
        return {
          command: "session daemon",
          sessionId: normalizedSessionId,
          targetPath,
          once: Boolean(options.once),
          running: daemon.isRunning(),
          summary,
          state: daemon.getState(),
        };
      };

      if (options.once) {
        try {
          const payload = await runTickAndBuildPayload();
          const stopped = await daemon.stop("once_complete");
          payload.running = false;
          payload.stopped = {
            stopped: Boolean(stopped?.stopped),
            reason: stopped?.reason || "once_complete",
            checkpointCloseout: stopped?.checkpointCloseout || null,
          };
          if (emitJson) {
            console.log(JSON.stringify(payload, null, 2));
            return;
          }
          const checkpoint = payload.summary?.checkpoint || {};
          const recap = payload.summary?.recap || {};
          console.log(
            pc.green(
              `senti tick: relayed=${Number(payload.summary?.humanMessages?.relayed || 0)} recap=${recap.emitted ? recap.mode || "emitted" : recap.reason || "none"} checkpoint=${checkpoint.created ? checkpoint.checkpointId || "created" : checkpoint.reason || "none"}`,
            ),
          );
          return;
        } finally {
          if (restoreConsoleLog) {
            restoreConsoleLog();
          }
        }
      }

      const controller = new AbortController();
      const stop = () => controller.abort();
      process.once("SIGINT", stop);
      process.once("SIGTERM", stop);
      const waitForNextTick = () =>
        new Promise((resolve) => {
          let timer = null;
          const cleanup = () => {
            controller.signal.removeEventListener("abort", onAbort);
            if (timer) {
              clearTimeout(timer);
              timer = null;
            }
          };
          const finish = () => {
            cleanup();
            resolve();
          };
          const onAbort = () => {
            finish();
          };
          controller.signal.addEventListener("abort", onAbort, { once: true });
          timer = setTimeout(finish, tickIntervalMs);
        });

      try {
        if (!emitJson) {
          console.log(
            pc.green(
              `senti daemon: monitoring session ${normalizedSessionId}; tick=${Math.round(tickIntervalMs / 1000)}s. Ctrl-C to stop.`,
            ),
          );
        }
        let payload = await runTickAndBuildPayload();
        if (emitJson) {
          console.log(JSON.stringify(payload));
        } else {
          console.log(pc.gray(`tick ${payload.summary.generatedAt}: recap=${payload.summary.recap.reason || payload.summary.recap.mode || "ok"} checkpoint=${payload.summary.checkpoint.reason || payload.summary.checkpoint.checkpointId || "ok"}`));
        }
        while (!controller.signal.aborted) {
          await waitForNextTick();
          if (controller.signal.aborted) break;
          payload = await runTickAndBuildPayload();
          if (emitJson) {
            console.log(JSON.stringify(payload));
          } else {
            console.log(pc.gray(`tick ${payload.summary.generatedAt}: recap=${payload.summary.recap.reason || payload.summary.recap.mode || "ok"} checkpoint=${payload.summary.checkpoint.reason || payload.summary.checkpoint.checkpointId || "ok"}`));
          }
          // A daemon must not outlive its session: stop cleanly once the
          // session expires or its local cache disappears.
          const liveSession = await getSession(normalizedSessionId, { targetPath }).catch(() => null);
          const expiresAtMs = Date.parse(liveSession?.expiresAt || "");
          if (
            !liveSession ||
            liveSession.status !== "active" ||
            (Number.isFinite(expiresAtMs) && expiresAtMs <= Date.now())
          ) {
            if (!emitJson) {
              console.log(pc.gray("senti daemon: session expired or closed; stopping."));
            }
            break;
          }
        }
      } finally {
        process.removeListener("SIGINT", stop);
        process.removeListener("SIGTERM", stop);
        await removeDaemonPidRecord(normalizedSessionId, {
          targetPath,
          onlyForPid: process.pid,
        }).catch(() => {});
        const stopped = await daemon.stop("signal");
        if (emitJson) {
          console.log(
            JSON.stringify({
              command: "session daemon",
              sessionId: normalizedSessionId,
              targetPath,
              stopped: {
                stopped: Boolean(stopped?.stopped),
                reason: stopped?.reason || "signal",
                checkpointCloseout: stopped?.checkpointCloseout || null,
              },
            }),
          );
        } else {
          console.log(pc.gray(`senti daemon stopped (${stopped?.reason || "signal"}).`));
        }
        if (restoreConsoleLog) {
          restoreConsoleLog();
        }
      }
      } finally {
        if (restoreConsoleLog) {
          restoreConsoleLog();
        }
      }
    });

  const wake = session
    .command("wake")
    .description("Wake or register host CLI sessions for the Senti notification bus");

  wake
    .command("codex [sessionId]")
    .description("Resume a Codex CLI session with a Senti wake prompt")
    .option("--session <id>", "Senti session id")
    .option("--codex-session <id>", "Codex rollout/session id to resume")
    .option("--last", "Resume the most recent Codex session instead of a specific id")
    .option("--message <text>", "Senti message body to inject into Codex")
    .option("--message-file <path>", "Read Senti message body from a file")
    .option("--from <id>", "Senti sender id", "senti")
    .option("--sequence <n>", "Senti source sequence id")
    .option("--cursor <cursor>", "Senti source cursor")
    .option("--priority <level>", "Senti source priority")
    .option("--dashboard-url <url>", "Dashboard URL for the Senti session")
    .option("--cwd <path>", "Workspace cwd for codex exec", ".")
    .option("--codex-bin <path>", "Codex executable", "codex")
    .option("--model <model>", "Optional Codex model override")
    .option("--codex-json", "Pass --json through to codex exec resume")
    .option("--skip-git-repo-check", "Pass --skip-git-repo-check through to codex")
    .option(
      "--dangerously-bypass-approvals-and-sandbox",
      "Pass Codex's dangerous no-approval/no-sandbox flag through to the resumed process",
    )
    .option("--timeout-ms <n>", "Wake process timeout in milliseconds", "600000")
    .option("--dry-run", "Print the resume invocation without spawning Codex")
    .option("--json", "Emit machine-readable output")
    .action(async (sessionId, options, command) => {
      const emitJson = shouldEmitJson(options, command);
      const normalizedSessionId = normalizeString(sessionId) || resolveSessionIdOption(options);
      const targetPath = path.resolve(process.cwd(), String(options.cwd || "."));
      if (options.message && options.messageFile) {
        throw new Error("Use either --message or --message-file, not both.");
      }
      const message = options.messageFile
        ? await fsp.readFile(path.resolve(process.cwd(), String(options.messageFile)), "utf-8")
        : normalizeString(options.message);
      const prompt = buildCodexWakePrompt({
        sentiSessionId: normalizedSessionId,
        message,
        from: options.from,
        sequenceId: parseOptionalPositiveInteger(options.sequence, "sequence"),
        cursor: options.cursor,
        priority: options.priority,
        dashboardUrl: options.dashboardUrl,
      });
      const invocation = buildCodexExecResumeInvocation({
        codexSessionId: options.codexSession,
        prompt,
        cwd: targetPath,
        codexBin: options.codexBin,
        useLast: Boolean(options.last),
        json: Boolean(options.codexJson),
        model: options.model,
        skipGitRepoCheck: Boolean(options.skipGitRepoCheck),
        dangerouslyBypassApprovalsAndSandbox: Boolean(options.dangerouslyBypassApprovalsAndSandbox),
      });
      const payload = {
        command: "session wake codex",
        sessionId: normalizedSessionId,
        dryRun: Boolean(options.dryRun),
        invocation,
        prompt,
      };
      if (options.dryRun) {
        if (emitJson) {
          console.log(JSON.stringify(payload, null, 2));
          return;
        }
        console.log(pc.green("Codex wake dry run"));
        console.log(`${payload.invocation.command} ${payload.invocation.args.map((arg) => JSON.stringify(arg)).join(" ")}`);
        return;
      }
      const result = await runCodexExecResume({
        invocation,
        timeoutMs: parsePositiveInteger(options.timeoutMs, "timeout-ms", 600000),
      });
      const output = {
        ...payload,
        result,
      };
      if (emitJson) {
        console.log(JSON.stringify(output, null, 2));
        return;
      }
      const color = result.exitCode === 0 ? pc.green : pc.yellow;
      console.log(color(`Codex wake completed with exit code ${result.exitCode}.`));
      if (normalizeString(result.stderr)) {
        console.log(pc.gray(result.stderr.trim()));
      }
      if (result.exitCode !== 0) {
        process.exitCode = Number(result.exitCode) || 1;
      }
    });

  wake
    .command("codex-notify [sessionId] [notificationJson]")
    .description("Record Codex notify payloads so sentid can resume the correct Codex rollout")
    .option("--session <id>", "Senti session id")
    .option("--agent <id>", "Senti agent id", process.env.SENTINELAYER_AGENT_ID || "codex")
    .option("--notification <json>", "Notification JSON override")
    .option("--path <path>", "Workspace path for the Senti session", ".")
    .option("--json", "Emit machine-readable output")
    .action(async (sessionId, notificationJson, options, command) => {
      const emitJson = shouldEmitJson(options, command);
      const normalizedSessionId = normalizeString(sessionId) || resolveSessionIdOption(options);
      const targetPath = path.resolve(process.cwd(), String(options.path || "."));
      const payload = normalizeString(options.notification) || normalizeString(notificationJson);
      const result = await recordCodexWakeRegistration({
        sessionId: normalizedSessionId,
        agentId: options.agent,
        notificationPayload: payload,
        targetPath,
      });
      const output = {
        command: "session wake codex-notify",
        sessionId: normalizedSessionId,
        agentId: normalizeString(options.agent) || "codex",
        ...result,
      };
      if (emitJson) {
        console.log(JSON.stringify(output, null, 2));
        return;
      }
      if (!result.registered) {
        console.log(pc.gray(`Ignored Codex notification: ${result.reason}.`));
        return;
      }
      console.log(pc.green(`Registered Codex wake target: ${result.registryPath}`));
    });

  wake
    .command("daemon [sessionId]")
    .description("Run the sentid wake daemon: watch the session stream and wake this agent on new messages")
    .option("--session <id>", "Senti session id")
    .option("--agent <id>", "Local agent this daemon wakes", process.env.SENTINELAYER_AGENT_ID || "")
    .option("--host <name>", "Host adapter to wake (claude|codex)", "claude")
    .option("--resume-session <id>", "Host session id to resume on wake")
    .option("--cwd <path>", "Workspace cwd", ".")
    .option("--idle-ms <n>", "Idle poll backoff in milliseconds", "1500")
    .option("--max-attempts <n>", "Wake retries before dead-letter", "5")
    .option("--once", "Run a single fetch/dispatch tick and exit (dogfood/CI)")
    .option("--json", "Emit machine-readable output")
    .action(async (sessionId, options, command) => {
      const emitJson = shouldEmitJson(options, command);
      const normalizedSessionId = normalizeString(sessionId) || resolveSessionIdOption(options);
      if (!normalizedSessionId) {
        throw new Error("session wake daemon requires a Senti session id (positional or --session).");
      }
      const agentId = normalizeString(options.agent);
      if (!agentId) {
        throw new Error("session wake daemon requires --agent (the local agent to wake).");
      }
      const host = normalizeString(options.host) || "claude";
      const resumeSessionId = normalizeString(options.resumeSession);
      if (!resumeSessionId) {
        throw new Error("session wake daemon requires --resume-session (the host session id to resume).");
      }
      const targetPath = path.resolve(process.cwd(), String(options.cwd || "."));
      const sentid = createSentid({
        sessionId: normalizedSessionId,
        agentId,
        host,
        resumeSessionId,
        targetPath,
        idleMs: parseOptionalPositiveInteger(options.idleMs, "idle-ms") || 1500,
        maxAttempts: parseOptionalPositiveInteger(options.maxAttempts, "max-attempts") || 5,
        logger: emitJson
          ? undefined
          : (level, msg, meta) => console.error(`[sentid:${level}] ${msg}${meta ? ` ${JSON.stringify(meta)}` : ""}`),
      });

      if (options.once) {
        const tick = await sentid.tickOnce({ fetchCursor: null });
        const out = {
          command: "session wake daemon",
          once: true,
          sessionId: normalizedSessionId,
          agent: agentId,
          host,
          cursor: sentid.getCursor(),
          dispatched: Array.isArray(tick.results) ? tick.results.length : 0,
          idle: Boolean(tick.idle),
        };
        console.log(
          emitJson
            ? JSON.stringify(out, null, 2)
            : pc.green(`sentid tick: cursor=${out.cursor} dispatched=${out.dispatched}${out.idle ? " (idle)" : ""}`),
        );
        return;
      }

      const ac = new AbortController();
      const stop = () => ac.abort();
      process.once("SIGINT", stop);
      process.once("SIGTERM", stop);
      if (!emitJson) {
        console.log(
          pc.green(`sentid daemon: waking ${agentId} (host=${host}) on session ${normalizedSessionId}. Ctrl-C to stop.`),
        );
      }
      await sentid.start({ signal: ac.signal });
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
    .option("--agent <id>", "Agent id for automatic view receipts", process.env.SENTINELAYER_AGENT_ID || "cli-user")
    .option("--no-view", "Do not record automatic view receipts for displayed remote messages")
    .option("--include-control-events", "Include listener lifecycle/control-plane events in transcript output")
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
      const includeControlEvents = Boolean(options.includeControlEvents);
      const readAgentId = await defaultAgentId(options.agent, targetPath);

      let hydration = null;
      let remoteTail = null;
      let remoteActions = null;
      let remoteTailStats = null;
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
          includeControlEvents,
        });
        remoteTail = await pollSessionEventsBeforeTranscriptTail(normalizedSessionId, {
          targetPath,
          beforeSequence,
          tail,
          includeControlEvents,
          timeoutMs: 15_000,
        });
        if (options.actions !== false) {
          remoteActions = await listSessionMessageActions(normalizedSessionId, {
            targetPath,
            limit: 500,
            timeoutMs: 15_000,
          });
        }
        const remoteTailEvents = remoteTail?.ok && Array.isArray(remoteTail.events) ? remoteTail.events : [];
        const latestEvent = remoteTailEvents[remoteTailEvents.length - 1] || null;
        const latestVisibleEvent = [...remoteTailEvents]
          .reverse()
          .find((event) => includeControlEvents || !isSessionControlEvent(event)) || null;
        const controlEventCount = remoteTailEvents.filter((event) => isSessionControlEvent(event)).length;
        remoteTailStats = {
          controlEventCount,
          materialEventCount: Math.max(0, remoteTailEvents.length - controlEventCount),
          latestEvent: summarizeSessionTailEvent(latestEvent),
          latestVisibleEvent: summarizeSessionTailEvent(latestVisibleEvent),
          latestActivityHidden: Boolean(
            latestEvent &&
              isSessionControlEvent(latestEvent) &&
              !includeControlEvents
          ),
        };
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
          if (remoteTailStats.latestActivityHidden) {
            const latest = remoteTailStats.latestEvent;
            const type = latest?.type || "control event";
            const seq = latest?.sequenceId ? ` seq=${latest.sequenceId}` : "";
            console.log(
              pc.gray(
                `Latest remote activity is hidden control-plane traffic (${type}${seq}); showing recent material messages. Use --include-control-events to inspect it.`,
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
        let remoteTailUpgraded = 0;
        const remoteTailAppendEvents = includeControlEvents
          ? remoteTail?.events
          : filterSessionMaterialEvents(remoteTail?.events || []);
        if (remoteTail?.ok && Array.isArray(remoteTailAppendEvents) && remoteTailAppendEvents.length > 0) {
          const knownKeys = new Set();
          const displayIndexByKey = new Map();
          for (const [index, event] of displayEvents.entries()) {
            addSessionEventIdentityKeys(knownKeys, event);
            indexSessionEventIdentityKeys(displayIndexByKey, displayEvents, event, index);
          }
          for (const event of remoteTailAppendEvents) {
            const existingIndex = findSessionEventIdentityIndex(displayIndexByKey, event);
            if (existingIndex >= 0) {
              const existing = displayEvents[existingIndex];
              if (remoteSessionEventUpgradesLocal(existing, event)) {
                displayEvents[existingIndex] = event;
                addSessionEventIdentityKeys(knownKeys, event);
                indexSessionEventIdentityKeys(displayIndexByKey, displayEvents, event, existingIndex);
                remoteTailUpgraded += 1;
              }
              continue;
            }
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
              indexSessionEventIdentityKeys(displayIndexByKey, displayEvents, appended, displayEvents.length - 1);
              remoteTailAppended += 1;
            } catch {
              displayEvents.push(event);
              addSessionEventIdentityKeys(knownKeys, event);
              indexSessionEventIdentityKeys(displayIndexByKey, displayEvents, event, displayEvents.length - 1);
              remoteTailDisplayedOnly += 1;
            }
          }
        }
        const actionEvents = remoteActions?.ok
          ? buildSessionActionEvents(normalizedSessionId, remoteActions.actions)
          : [];
        const unacknowledgedHumanMessages = remoteActions?.ok
          ? readProjectionUnacknowledgedHumanMessages(remoteActions)
          : [];
        const recentHumanActivity = remoteActions?.ok
          ? readProjectionRecentHumanActivity(remoteActions)
          : [];
        const dedupedDisplayEvents = dedupeSessionEvents(displayEvents);
        const transcriptEvents = includeControlEvents
          ? dedupedDisplayEvents
          : dedupedDisplayEvents.filter((event) => !isSessionControlEvent(event));
        const hiddenControlEventCount = dedupedDisplayEvents.length - transcriptEvents.length;
        const events = mergeSessionActionEvents(transcriptEvents, actionEvents).slice(-tail);
        const autoView = recordSessionReadViews(normalizedSessionId, events, {
          targetPath,
          agentId: readAgentId,
          enabled: Boolean(options.remote && options.view !== false),
          maxTargets: process.env.SENTINELAYER_SESSION_READ_VIEW_MAX_TARGETS || 50,
          timeoutMs: process.env.SENTINELAYER_SESSION_READ_VIEW_TIMEOUT_MS || SESSION_READ_AUTO_VIEW_TIMEOUT_MS,
        });
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
          includeControlEvents,
          hiddenControlEventCount,
          unacknowledgedHumanMessageCount: unacknowledgedHumanMessages.length,
          unacknowledgedHumanMessages,
          recentHumanActivityCount: recentHumanActivity.length,
          recentHumanActivity,
          autoView,
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
                      pageCount: Number(remoteTail.pageCount || 0),
                      materialBackfillComplete: Boolean(remoteTail.materialBackfillComplete),
                      verified: Boolean(remoteTail.ok),
                      appended: remoteTailAppended,
                      displayedOnly: remoteTailDisplayedOnly,
                      upgraded: remoteTailUpgraded,
                      controlEventCount: remoteTailStats?.controlEventCount || 0,
                      materialEventCount: remoteTailStats?.materialEventCount || 0,
                      latestEvent: remoteTailStats?.latestEvent || null,
                      latestVisibleEvent: remoteTailStats?.latestVisibleEvent || null,
                      latestActivityHidden: Boolean(remoteTailStats?.latestActivityHidden),
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
        if (unacknowledgedHumanMessages.length > 0) {
          console.log(pc.yellow(`Unacknowledged human asks: ${unacknowledgedHumanMessages.length}`));
          for (const event of unacknowledgedHumanMessages.slice(0, 3)) {
            console.log(pc.yellow(`- ${formatHumanAskLine(event)}`));
          }
        }
        if (recentHumanActivity.length > 0) {
          console.log(pc.yellow(`Recent human activity: ${recentHumanActivity.length}`));
          for (const action of recentHumanActivity.slice(0, 3)) {
            console.log(pc.yellow(`- ${formatMessageActionActivityLine(action)}`));
          }
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
              if (!includeControlEvents && isSessionControlEvent(item.event)) continue;
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
        if (!includeControlEvents && isSessionControlEvent(event)) {
          continue;
        }
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
    .option("--catch-up", "Generate multiple consecutive checkpoint windows until caught up or capped")
    .option("--max-checkpoints <n>", "Maximum checkpoint windows to create with --catch-up (default 5, max 50)", "5")
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
      if (options.catchUp) {
        const result = await generateSessionCheckpointBatch(normalizedSessionId, {
          targetPath,
          minEvents: options.minEvents,
          maxEvents: options.maxEvents,
          maxCheckpoints: options.maxCheckpoints,
          idempotencyKey: options.operationId,
          createdByAgentId: agentId,
        });
        const hydration = result.createdCount > 0
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
        if (result.createdCount > 0) {
          console.log(pc.bold(`checkpoint catch-up generated ${result.createdCount} checkpoint${result.createdCount === 1 ? "" : "s"}`));
          for (const item of result.results) {
            if (item.checkpoint) {
              console.log(formatCheckpointLine(item.checkpoint));
            }
          }
          console.log(pc.gray(`Stopped: ${result.stoppedReason || "complete"} after ${result.attemptedCount} attempt${result.attemptedCount === 1 ? "" : "s"}.`));
          if (hydration && !hydration.ok) {
            console.log(pc.gray(`Local hydrate skipped: ${hydration.reason || "unknown"}`));
          }
          return;
        }
        const last = result.lastResult || {};
        console.log(
          pc.gray(
            `No checkpoint created: ${normalizeString(last.reason || result.stoppedReason) || "not_needed"} (${Number(last.eventCount || 0)} events, min ${Number(last.minEvents || options.minEvents || 0)}).`,
          ),
        );
        return;
      }
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
    .option("--include-control-events", "Include listener/control-plane events in the exported transcript")
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
          includeControlEvents: Boolean(options.includeControlEvents),
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
      const includeControlEvents = Boolean(options.includeControlEvents);
      const dedupedEvents = dedupeSessionEvents(events);
      const transcriptBaseEvents = includeControlEvents
        ? dedupedEvents
        : filterSessionMaterialEvents(dedupedEvents);
      const hiddenControlEventCount = dedupedEvents.length - transcriptBaseEvents.length;
      const exportEvents = mergeSessionActionEvents(transcriptBaseEvents, actionEvents);
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
        lines.push(JSON.stringify({
          kind: "export_metadata",
          value: {
            includeControlEvents,
            hiddenControlEventCount,
            rawEventCount: events.length,
            eventCount: exportEvents.length,
          },
        }));
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
              hiddenControlEvents: hiddenControlEventCount,
              actions: Array.isArray(remoteActions?.actions) ? remoteActions.actions.length : 0,
              actionEvents: actionEvents.length,
              tasks: (tasks.tasks || []).length,
            },
            includeControlEvents,
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
            } tasks${hiddenControlEventCount ? ` (${hiddenControlEventCount} control events omitted)` : ""} → ${outPath}`,
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
    .option("--include-control-events", "Include listener/control-plane events in the Markdown transcript")
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
          includeControlEvents: Boolean(options.includeControlEvents),
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
      const includeControlEvents = Boolean(options.includeControlEvents);
      const dedupedEvents = dedupeSessionEvents(events);
      const transcriptBaseEvents = includeControlEvents
        ? dedupedEvents
        : filterSessionMaterialEvents(dedupedEvents);
      const hiddenControlEventCount = dedupedEvents.length - transcriptBaseEvents.length;
      const transcriptEvents = mergeSessionActionEvents(transcriptBaseEvents, actionEvents);

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
        includeControlEvents,
        hiddenControlEventCount,
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
      if (hiddenControlEventCount > 0) {
        console.log(pc.gray(`${hiddenControlEventCount} control events omitted; rerun with --include-control-events to inspect them.`));
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
          console.log(formatSessionListLine(item));
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
        const line = formatSessionListLine(item);
        const expires = item.expiresAt ? ` expires=${item.expiresAt}` : "";
        console.log(`${line}${expires}`);
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
