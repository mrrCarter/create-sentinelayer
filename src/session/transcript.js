/**
 * Session transcript renderer — produces an iMessage-style Markdown
 * document from a session's NDJSON event stream + agent roster +
 * metadata. Deterministic: same inputs → identical output (modulo the
 * `generatedAt` line in the header).
 *
 * Adds at render time:
 *   - Per-agent active duration (first → last event with that agent id)
 *   - Total session live-for (createdAt → last event)
 *   - Token + cost roll-up from session_usage events through the
 *     pricing ledger, including idempotency dedupe
 *   - Avatar per speaker, picked from PERSONA_VISUALS / CLIENT_FAMILY_AVATARS,
 *     or a deterministic letter-tile fallback
 *   - Senti-orchestrator events tagged with the orchestrator avatar so
 *     "if orchestrator did anything it signs its name + time" — even
 *     when the underlying event came from a worker job
 *
 * Scales: O(events + agents). Tested up to 20 speakers without degradation.
 */

import { PERSONA_VISUALS, ORCHESTRATOR_VISUALS } from "../agents/persona-visuals.js";
import { buildSessionUsageLedger } from "./pricing-ledger.js";

/**
 * Avatar map for client families (the OUTSIDE-the-persona-set agents
 * that show up in any session: human users, browser-side coding
 * assistants, etc). Keep emoji + a one-color hint so terminal + web
 * renderers can tint consistently.
 */
export const CLIENT_FAMILY_AVATARS = Object.freeze({
  human: { avatar: "🧑", color: "blue", label: "Human" },
  claude: { avatar: "🟣", color: "purple", label: "Claude" },
  codex: { avatar: "🟢", color: "green", label: "Codex" },
  gpt: { avatar: "🟢", color: "green", label: "GPT" },
  gemini: { avatar: "🔷", color: "cyan", label: "Gemini" },
  grok: { avatar: "⚫", color: "gray", label: "Grok" },
  cli: { avatar: "💻", color: "white", label: "CLI" },
  guest: { avatar: "👤", color: "gray", label: "Guest" },
  senti: { avatar: "🛡️", color: "gold", label: "Senti" },
});

const TRANSCRIPT_EVENT_KINDS = new Set([
  "session_message",
  "session_say",
  "agent_response",
  "session_action",
  "session_reply",
  "session_reaction",
  "session_usage",
  "session_observation",
  "human_relay",
  "agent_join",
  "agent_left",
  "agent_killed",
  "agent_identified",
  "daemon_alert",
  "session_admin_kill",
]);

const SYSTEM_EVENT_KINDS = new Set([
  "agent_join",
  "agent_left",
  "agent_killed",
  "agent_identified",
  "daemon_alert",
  "session_admin_kill",
]);

function normalize(value) {
  return String(value == null ? "" : value).trim();
}

function detectFamily(modelOrId) {
  const v = normalize(modelOrId).toLowerCase();
  if (!v) return "guest";
  if (v.includes("senti") || v.includes("kai-chen")) return "senti";
  if (v.includes("claude") || v.includes("sonnet") || v.includes("opus")) return "claude";
  if (v.includes("codex") || v.startsWith("gpt-") || v === "gpt") return "codex";
  if (v.includes("gemini")) return "gemini";
  if (v.includes("grok")) return "grok";
  if (v.startsWith("human-") || v.includes("human")) return "human";
  if (v === "cli" || v.startsWith("cli-")) return "cli";
  if (v.startsWith("guest-")) return "guest";
  return v.split(/[\s:/_-]+/).find(Boolean) || "guest";
}

function letterTile(label) {
  const trimmed = normalize(label);
  if (!trimmed) return "·";
  return trimmed.slice(0, 2).toUpperCase();
}

/**
 * Resolve a speaker's display identity given the agent id, model, and
 * whatever profile bag the caller provides (e.g. github avatar URL,
 * google photo URL, friendly name from auth).
 */
export function resolveSpeakerIdentity({
  agentId,
  agentModel = "",
  profile = null,
} = {}) {
  const id = normalize(agentId) || "unknown";
  const lowerId = id.toLowerCase();

  // 1. Persona visuals — Nina, Maya, Jules, etc.
  if (PERSONA_VISUALS[lowerId]) {
    const v = PERSONA_VISUALS[lowerId];
    return {
      agentId: id,
      family: lowerId,
      avatar: v.avatar,
      avatarUrl: null,
      color: v.color,
      displayName: v.fullName || v.shortName || id,
    };
  }

  // 2. Orchestrator visuals — Senti / Kai Chen
  if (lowerId === "senti" || lowerId === "kai-chen") {
    const v = ORCHESTRATOR_VISUALS["kai-chen"] || {};
    return {
      agentId: id,
      family: "senti",
      avatar: v.avatar || CLIENT_FAMILY_AVATARS.senti.avatar,
      avatarUrl: null,
      color: v.color || CLIENT_FAMILY_AVATARS.senti.color,
      displayName: v.fullName || "Senti",
    };
  }

  // 3. Caller-provided profile (github avatar, google photo) wins for humans.
  if (profile && (profile.avatarUrl || profile.displayName)) {
    return {
      agentId: id,
      family: profile.family || detectFamily(id || agentModel),
      avatar: profile.avatar || CLIENT_FAMILY_AVATARS.human.avatar,
      avatarUrl: normalize(profile.avatarUrl) || null,
      color: profile.color || CLIENT_FAMILY_AVATARS.human.color,
      displayName: normalize(profile.displayName) || id,
    };
  }

  // 4. Client family fallback by model / id pattern.
  const family = detectFamily(agentModel || id);
  const fallback = CLIENT_FAMILY_AVATARS[family] || CLIENT_FAMILY_AVATARS.guest;
  return {
    agentId: id,
    family,
    avatar: fallback.avatar,
    avatarUrl: null,
    color: fallback.color,
    displayName: id || letterTile(family),
  };
}

function eventTimestamp(event) {
  return normalize(event?.ts || event?.timestamp);
}

function actionTargetLabel(payload = {}) {
  const targetActionId = normalize(payload.targetActionId || payload.target_action_id);
  const targetSequence = Number(payload.targetSequenceId || payload.target_sequence_id || 0);
  const targetCursor = normalize(payload.targetCursor || payload.target_cursor);
  const parent =
    Number.isFinite(targetSequence) && targetSequence > 0
      ? `#${Math.floor(targetSequence)}`
      : targetCursor
        ? `cursor ${targetCursor}`
        : "";
  if (targetActionId) {
    return parent ? `reply action ${targetActionId} under ${parent}` : `reply action ${targetActionId}`;
  }
  return parent || "target";
}

function actionBody(event) {
  const payload = event && typeof event.payload === "object" ? event.payload : {};
  const kind = normalize(event?.event || event?.type);
  const actionType = normalize(payload.actionType || payload.action_type || kind.replace(/^session_/, ""));
  const target = actionTargetLabel(payload);
  const actionId = normalize(payload.actionId || payload.action_id);
  const note = normalize(payload.note);
  const metadata = [];
  if (actionId) metadata.push(`Action ID: \`${actionId}\``);
  if (actionType) metadata.push(`Action: \`${actionType}\``);
  if (kind === "session_reply") {
    return [
      `**Reply to:** \`${target}\``,
      ...metadata,
      note ? "" : null,
      note || normalize(payload.message),
    ].filter((line) => line !== null && line !== "").join("\n");
  }
  if (kind === "session_reaction") {
    return [
      `**Reaction:** \`${actionType || "reaction"}\` on \`${target}\``,
      ...metadata,
      note ? `Note: ${note}` : null,
    ].filter(Boolean).join("\n");
  }
  if (kind === "session_action") {
    return [
      `**Session action:** \`${actionType || "action"}\` on \`${target}\``,
      ...metadata,
      note ? "" : null,
      note,
    ].filter((line) => line !== null && line !== "").join("\n");
  }
  return "";
}

function boundedMarkdownText(value, { maxLength = 2_000 } = {}) {
  const text = normalize(value).replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  if (!maxLength || text.length <= maxLength) return text;
  const head = Math.max(120, Math.floor((maxLength - 3) * 0.75));
  const tail = Math.max(40, maxLength - 3 - head);
  return `${text.slice(0, head)}...${text.slice(-tail)}`;
}

function observationTargetLabel(payload = {}) {
  const targetSequence = Number(payload.targetSequenceId || payload.target_sequence_id || 0);
  if (Number.isFinite(targetSequence) && targetSequence > 0) {
    return `#${Math.floor(targetSequence)}`;
  }
  const targetCursor = tableText(payload.targetCursor || payload.target_cursor, { maxLength: 96 });
  return targetCursor ? `cursor ${targetCursor}` : "";
}

function observationBody(event) {
  const payload = event && typeof event.payload === "object" ? event.payload : {};
  const severity = tableText(payload.severity || "info", { maxLength: 16 }).toLowerCase();
  const kind = tableText(payload.kind || "process", { maxLength: 32 }).toLowerCase();
  const summary = boundedMarkdownText(payload.summary || payload.message || payload.text, {
    maxLength: 4_000,
  });
  const proposal = boundedMarkdownText(payload.proposal || payload.recommendation, {
    maxLength: 2_000,
  });
  const owner = tableText(payload.owner || payload.assignee, { maxLength: 96 });
  const proposedBatch = tableText(payload.proposedBatch || payload.batch, { maxLength: 96 });
  const target = observationTargetLabel(payload);
  const metadata = [];
  if (owner) metadata.push(`Owner: \`${owner}\``);
  if (proposedBatch) metadata.push(`Batch: \`${proposedBatch}\``);
  if (target) metadata.push(`Target: \`${target}\``);

  const lines = [`**Observation:** \`${severity || "info"}\` · \`${kind || "process"}\``];
  if (metadata.length) lines.push(metadata.join(" · "));
  if (summary) lines.push("", summary);
  if (proposal) lines.push("", "**Proposal:**", proposal);
  return lines.join("\n");
}

function eventBody(event) {
  const kind = normalize(event?.event || event?.type);
  if (kind === "session_action" || kind === "session_reply" || kind === "session_reaction") {
    return actionBody(event);
  }
  if (kind === "session_observation") {
    return observationBody(event);
  }
  const payload = event && typeof event.payload === "object" ? event.payload : {};
  // session_usage carries the response inside payload.response.text
  const responseText =
    typeof payload.response === "object" && payload.response
      ? payload.response.text
      : payload.response;
  const text =
    payload.message ||
    responseText ||
    payload.text ||
    payload.alert ||
    payload.reason ||
    "";
  return normalize(text);
}

/**
 * Compute deterministic activity stats from the event log:
 *  - sessionLiveSeconds: created → last event
 *  - perAgent[agentId]: { firstSeen, lastSeen, eventCount, activeSeconds, family, displayName, model }
 *  - totals: { tokenTotal, costTotalUsd } summed through the pricing ledger
 *  - sentiActions: count of orchestrator events
 */
export function computeTranscriptStats({
  sessionMeta = {},
  events = [],
  speakerProfiles = new Map(),
  usageLedger = null,
} = {}) {
  const perAgent = new Map();
  let firstEventTs = null;
  let lastEventTs = null;
  let sentiActions = 0;

  const ensureAgentRecord = ({
    agentId,
    agentModel = "",
    epoch,
  } = {}) => {
    const normalizedAgentId = normalize(agentId);
    if (!normalizedAgentId || !Number.isFinite(epoch)) {
      return null;
    }
    if (!perAgent.has(normalizedAgentId)) {
      const profile = speakerProfiles.get(normalizedAgentId) || null;
      const identity = resolveSpeakerIdentity({
        agentId: normalizedAgentId,
        agentModel,
        profile,
      });
      perAgent.set(normalizedAgentId, {
        agentId: normalizedAgentId,
        family: identity.family,
        displayName: identity.displayName,
        avatar: identity.avatar,
        avatarUrl: identity.avatarUrl,
        color: identity.color,
        model: agentModel,
        firstSeenMs: epoch,
        lastSeenMs: epoch,
        eventCount: 0,
        tokens: 0,
        costUsd: 0,
      });
    }
    const record = perAgent.get(normalizedAgentId);
    if (!record.model && agentModel) {
      record.model = agentModel;
    }
    return record;
  };

  for (const event of events) {
    const ts = eventTimestamp(event);
    if (!ts) continue;
    const epoch = Date.parse(ts);
    if (!Number.isFinite(epoch)) continue;
    if (firstEventTs == null || epoch < firstEventTs) firstEventTs = epoch;
    if (lastEventTs == null || epoch > lastEventTs) lastEventTs = epoch;

    const agentId = normalize(event.agent?.id || event.agentId);
    if (!agentId) continue;
    const lowerId = agentId.toLowerCase();
    if (lowerId === "senti" || lowerId === "kai-chen") sentiActions += 1;

    const record = ensureAgentRecord({
      agentId,
      agentModel: event.agent?.model || event.agentModel || "",
      epoch,
    });
    if (!record) continue;
    record.eventCount += 1;
    if (epoch < record.firstSeenMs) record.firstSeenMs = epoch;
    if (epoch > record.lastSeenMs) record.lastSeenMs = epoch;
  }

  const resolvedUsageLedger = usageLedger || buildSessionUsageLedger(events, {
    sessionId: normalize(sessionMeta.sessionId),
  });
  const fallbackUsageEpoch =
    lastEventTs ??
    firstEventTs ??
    (Number.isFinite(Date.parse(sessionMeta?.createdAt)) ? Date.parse(sessionMeta.createdAt) : 0);
  for (const entry of resolvedUsageLedger.entries) {
    const entryEpoch = Number.isFinite(Date.parse(entry.timestamp))
      ? Date.parse(entry.timestamp)
      : fallbackUsageEpoch;
    const record = ensureAgentRecord({
      agentId: entry.agentId,
      agentModel: entry.model,
      epoch: entryEpoch,
    });
    if (!record) continue;
    if ((!record.model || record.model === "unknown") && entry.model && entry.model !== "unknown") {
      record.model = entry.model;
    }
    record.tokens += entry.totalTokens;
    record.costUsd = Math.round((record.costUsd + entry.providerCostUsd) * 1_000_000) / 1_000_000;
  }

  const createdAtMs = sessionMeta?.createdAt
    ? Date.parse(sessionMeta.createdAt)
    : null;
  let startedAtMs;
  if (Number.isFinite(createdAtMs) && firstEventTs != null) {
    // Imported sessions can have events older than the local createdAt;
    // pick the earlier of the two so live-for never goes negative.
    startedAtMs = Math.min(createdAtMs, firstEventTs);
  } else if (Number.isFinite(createdAtMs)) {
    startedAtMs = createdAtMs;
  } else {
    startedAtMs = firstEventTs;
  }
  const sessionLiveSeconds =
    startedAtMs != null && lastEventTs != null
      ? Math.max(0, Math.round((lastEventTs - startedAtMs) / 1000))
      : 0;

  const agents = [];
  for (const record of perAgent.values()) {
    agents.push({
      ...record,
      activeSeconds: Math.max(0, Math.round((record.lastSeenMs - record.firstSeenMs) / 1000)),
      firstSeen: new Date(record.firstSeenMs).toISOString(),
      lastSeen: new Date(record.lastSeenMs).toISOString(),
    });
  }
  agents.sort((a, b) => b.eventCount - a.eventCount);

  return {
    startedAt: startedAtMs ? new Date(startedAtMs).toISOString() : null,
    endedAt: lastEventTs ? new Date(lastEventTs).toISOString() : null,
    sessionLiveSeconds,
    agents,
    totals: {
      tokenTotal: resolvedUsageLedger.totals.totalTokens,
      inputTokens: resolvedUsageLedger.totals.inputTokens,
      outputTokens: resolvedUsageLedger.totals.outputTokens,
      costTotalUsd: resolvedUsageLedger.totals.providerCostUsd,
      customerCostTotalUsd: resolvedUsageLedger.totals.hasCustomerCost
        ? resolvedUsageLedger.totals.customerCostUsd
        : null,
      usageEntries: resolvedUsageLedger.entries.length,
      duplicatesSkipped: resolvedUsageLedger.duplicatesSkipped,
      unpriced: resolvedUsageLedger.totals.unpriced,
      estimatedEntries: resolvedUsageLedger.totals.estimatedEntries,
      priceBookVersions: resolvedUsageLedger.priceBookVersions,
    },
    sentiActions,
  };
}

function formatDuration(seconds) {
  const s = Math.max(0, Math.round(seconds));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const remS = s % 60;
  if (m < 60) return `${m}m ${remS}s`;
  const h = Math.floor(m / 60);
  const remM = m % 60;
  if (h < 24) return `${h}h ${remM}m`;
  const d = Math.floor(h / 24);
  const remH = h % 24;
  return `${d}d ${remH}h`;
}

function timestampOnly(iso) {
  if (!iso) return "";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toISOString().replace("T", " ").replace(/\..+/, " UTC");
}

function avatarMd(identity) {
  if (identity.avatarUrl) {
    return `![${identity.displayName}](${identity.avatarUrl})`;
  }
  return identity.avatar || letterTile(identity.displayName || identity.agentId);
}

function intCell(value) {
  return Math.max(0, Math.floor(Number(value || 0))).toLocaleString("en-US");
}

function usdCell(value) {
  return `$${Number(value || 0).toFixed(6)}`;
}

function tableText(value, { maxLength = 160 } = {}) {
  const escaped = normalize(value)
    .replace(/\r?\n/g, " ")
    .replace(/\|/g, "\\|")
    .replace(/`/g, "'");
  if (!maxLength || escaped.length <= maxLength) return escaped;
  const head = Math.max(24, Math.floor((maxLength - 3) * 0.7));
  const tail = Math.max(12, maxLength - 3 - head);
  return `${escaped.slice(0, head)}...${escaped.slice(-tail)}`;
}

function codeCell(value) {
  const text = tableText(value);
  return text ? `\`${text}\`` : "—";
}

function optionalUsdCell(value, hasValue) {
  return hasValue ? usdCell(value) : "—";
}

function shortenIdempotencyKey(value, maxLength = 36) {
  const text = tableText(value, { maxLength: 0 });
  if (!text || text.length <= maxLength) return text;
  const head = Math.max(8, Math.floor((maxLength - 3) * 0.58));
  const tail = Math.max(6, maxLength - 3 - head);
  return `${text.slice(0, head)}...${text.slice(-tail)}`;
}

function rollupsByCostAndTokens(map) {
  return [...map.values()].sort((a, b) => (
    b.providerCostUsd - a.providerCostUsd ||
    b.totalTokens - a.totalTokens ||
    b.entries - a.entries ||
    tableText(a.label).localeCompare(tableText(b.label))
  ));
}

function estimateNote(count) {
  const normalized = Math.max(0, Math.floor(Number(count || 0)));
  if (normalized <= 0) return "";
  return `${normalized.toLocaleString("en-US")} estimated`;
}

function recentUsageEntries(entries, limit = 10) {
  return entries
    .map((entry, index) => ({ entry, index }))
    .sort((a, b) => {
      const aSequence = Number.isFinite(a.entry.sequenceId) ? a.entry.sequenceId : null;
      const bSequence = Number.isFinite(b.entry.sequenceId) ? b.entry.sequenceId : null;
      if (aSequence != null && bSequence != null && aSequence !== bSequence) {
        return bSequence - aSequence;
      }
      const aTime = Date.parse(a.entry.timestamp);
      const bTime = Date.parse(b.entry.timestamp);
      if (Number.isFinite(aTime) && Number.isFinite(bTime) && aTime !== bTime) {
        return bTime - aTime;
      }
      return b.index - a.index;
    })
    .slice(0, limit)
    .map(({ entry }) => entry);
}

function appendUsageRollupTable(lines, { title, labelHeader, rollups }) {
  lines.push(`### ${title}`);
  lines.push("");
  lines.push(`| ${labelHeader} | Entries | Input | Output | Total | Provider cost | Customer cost | Unpriced |`);
  lines.push("|---|---:|---:|---:|---:|---:|---:|---:|");
  if (rollups.length === 0) {
    lines.push(`| — | 0 | 0 | 0 | 0 | ${usdCell(0)} | — | 0 |`);
  } else {
    for (const rollup of rollups) {
      lines.push(
        `| ${codeCell(rollup.label)} | ${intCell(rollup.entries)} | ${intCell(rollup.inputTokens)} | ${intCell(rollup.outputTokens)} | ${intCell(rollup.totalTokens)} | ${usdCell(rollup.providerCostUsd)} | ${optionalUsdCell(rollup.customerCostUsd, rollup.hasCustomerCost)} | ${intCell(rollup.unpriced)} |`,
      );
    }
  }
  lines.push("");
}

function appendUsageLedgerSection(lines, usageLedger) {
  const totals = usageLedger.totals;
  lines.push("## Usage Ledger");
  lines.push("");

  if (usageLedger.entries.length === 0 && usageLedger.duplicatesSkipped === 0) {
    lines.push("_No usage telemetry recorded._");
    lines.push("");
    return;
  }

  const customerCostText = totals.hasCustomerCost
    ? `Customer cost: ${usdCell(totals.customerCostUsd)}`
    : "Customer cost: —";
  lines.push(`Accepted entries: ${intCell(usageLedger.entries.length)}`);
  lines.push(
    `Tokens: ${intCell(totals.totalTokens)} (input ${intCell(totals.inputTokens)} / output ${intCell(totals.outputTokens)})`,
  );
  lines.push(`Provider cost: ${usdCell(totals.providerCostUsd)} · ${customerCostText}`);
  lines.push(`Price books: ${usageLedger.priceBookVersions.map(tableText).filter(Boolean).join(", ") || "—"}`);
  const estimateText = totals.estimatedEntries > 0
    ? ` · Estimated entries: ${intCell(totals.estimatedEntries)}`
    : "";
  lines.push(
    `Duplicates skipped: ${intCell(usageLedger.duplicatesSkipped)} · Unpriced entries: ${intCell(totals.unpriced)}${estimateText}`,
  );
  if (totals.estimatedEntries > 0) {
    lines.push("_Estimated entries are output-text estimates from non-human session messages, not billing-grade provider usage._");
  }
  lines.push("");

  appendUsageRollupTable(lines, {
    title: "Per Agent",
    labelHeader: "Agent",
    rollups: rollupsByCostAndTokens(usageLedger.perAgent),
  });
  appendUsageRollupTable(lines, {
    title: "Per Action",
    labelHeader: "Action",
    rollups: rollupsByCostAndTokens(usageLedger.perAction),
  });

  lines.push("### Recent Entries");
  lines.push("");
  lines.push("| Time | Agent | Action | Model | Tokens | Provider cost | Customer cost | Idempotency key |");
  lines.push("|---|---|---|---|---:|---:|---:|---|");
  for (const entry of recentUsageEntries(usageLedger.entries)) {
    const action = entry.estimated
      ? `${entry.action} (${estimateNote(1)})`
      : entry.action;
    lines.push(
      `| ${tableText(timestampOnly(entry.timestamp)) || "—"} | ${codeCell(entry.agentId)} | ${codeCell(action)} | ${codeCell(entry.model)} | ${intCell(entry.totalTokens)} | ${usdCell(entry.providerCostUsd)} | ${optionalUsdCell(entry.customerCostUsd, entry.customerCostUsd != null)} | ${codeCell(shortenIdempotencyKey(entry.idempotencyKey))} |`,
    );
  }
  lines.push("");
}

/**
 * Build the iMessage-style markdown transcript.
 *
 * @param {object} params
 * @param {object} params.sessionMeta  - { sessionId, createdAt, status, ... }
 * @param {Array<object>} params.events
 * @param {Array<object>} [params.agents] - registered agents (optional)
 * @param {Map<string, object>} [params.speakerProfiles] - agentId →
 *   { displayName, avatarUrl, family, color }. Used to surface real
 *   GitHub / Google photos for human users.
 * @param {object} [params.options]
 * @param {boolean} [params.options.includeSystemEvents=true]
 * @returns {{ markdown: string, stats: object }}
 */
export function buildTranscriptMarkdown({
  sessionMeta = {},
  events = [],
  agents = [],
  speakerProfiles = new Map(),
  options = {},
} = {}) {
  const estimateMessageUsage = options.estimateMessageUsage !== false;
  const usageLedger = buildSessionUsageLedger(events, {
    sessionId: normalize(sessionMeta.sessionId),
    includeEstimatedMessages: estimateMessageUsage,
  });
  const includeSystemEvents = options.includeSystemEvents !== false;
  const stats = computeTranscriptStats({ sessionMeta, events, speakerProfiles, usageLedger });

  const lines = [];
  const sessionId = normalize(sessionMeta.sessionId) || "unknown";
  lines.push(`# Session ${sessionId}`);
  lines.push("");
  lines.push(`Generated: ${new Date().toISOString()}`);
  if (stats.startedAt) lines.push(`Started: ${stats.startedAt}`);
  if (stats.endedAt) lines.push(`Last activity: ${stats.endedAt}`);
  lines.push(`Live for: ${formatDuration(stats.sessionLiveSeconds)}`);
  lines.push(`Senti actions: ${stats.sentiActions}`);
  if (stats.totals.tokenTotal > 0 || stats.totals.costTotalUsd > 0) {
    const billableText =
      stats.totals.customerCostTotalUsd == null
        ? ""
        : ` · Billable: $${stats.totals.customerCostTotalUsd.toFixed(4)}`;
    const estimatedText =
      stats.totals.estimatedEntries > 0
        ? ` · Estimated entries: ${stats.totals.estimatedEntries.toLocaleString("en-US")}`
        : "";
    lines.push(
      `Tokens: ${stats.totals.tokenTotal.toLocaleString("en-US")} · Cost: $${stats.totals.costTotalUsd.toFixed(4)}${billableText}${estimatedText}`,
    );
  }
  lines.push("");

  // Participants table
  lines.push("## Participants");
  lines.push("");
  lines.push("| Avatar | Name | Family | Active for | Events | Tokens | Cost |");
  lines.push("|---|---|---|---:|---:|---:|---:|");
  for (const agent of stats.agents) {
    const identity = {
      avatar: agent.avatar,
      avatarUrl: agent.avatarUrl,
      displayName: agent.displayName,
      agentId: agent.agentId,
    };
    lines.push(
      `| ${avatarMd(identity)} | **${agent.displayName}** \`${agent.agentId}\` | ${agent.family} | ${formatDuration(agent.activeSeconds)} | ${agent.eventCount} | ${agent.tokens.toLocaleString("en-US")} | $${agent.costUsd.toFixed(4)} |`,
    );
  }
  // Surface registered-but-silent agents at the bottom of the table so
  // the participants list is comprehensive even if they never emitted
  // a stream event.
  const seenIds = new Set(stats.agents.map((a) => a.agentId));
  const silentRegisteredAgents = [];
  for (const registered of agents || []) {
    const id = normalize(registered?.agentId);
    if (!id || seenIds.has(id)) continue;
    seenIds.add(id);
    const profile = speakerProfiles.get(id) || null;
    const identity = resolveSpeakerIdentity({
      agentId: id,
      agentModel: registered.model || "",
      profile,
    });
    silentRegisteredAgents.push({ id, identity });
  }
  if (stats.agents.length === 0 && silentRegisteredAgents.length === 0) {
    lines.push("| 👤 | (no agents joined) | — | 0s | 0 | 0 | $0.00 |");
  }
  for (const registered of silentRegisteredAgents) {
    lines.push(
      `| ${avatarMd(registered.identity)} | **${registered.identity.displayName}** \`${registered.id}\` | ${registered.identity.family} | 0s · idle | 0 | 0 | $0.0000 |`,
    );
  }
  stats.participantCount = stats.agents.length + silentRegisteredAgents.length;
  lines.push("");

  appendUsageLedgerSection(lines, usageLedger);

  // Conversation
  lines.push("## Conversation");
  lines.push("");
  for (const event of events) {
    const kind = normalize(event?.event || event?.type);
    if (!kind || !TRANSCRIPT_EVENT_KINDS.has(kind)) continue;
    if (!includeSystemEvents && SYSTEM_EVENT_KINDS.has(kind)) continue;

    const agentId = normalize(event?.agent?.id || event?.agentId);
    const profile = speakerProfiles.get(agentId) || null;
    const identity = resolveSpeakerIdentity({
      agentId,
      agentModel: event.agent?.model || event.agentModel || "",
      profile,
    });
    const ts = eventTimestamp(event);
    const body = eventBody(event);

    if (SYSTEM_EVENT_KINDS.has(kind)) {
      const hint = body || kind.replace(/_/g, " ");
      lines.push(
        `- _${timestampOnly(ts)} · ${avatarMd(identity)} **${identity.displayName}** ${hint}_`,
      );
      continue;
    }

    lines.push(`### ${avatarMd(identity)} ${identity.displayName}`);
    lines.push(`> ${timestampOnly(ts)}`);
    lines.push("");
    if (body) {
      const indented = body
        .split(/\r?\n/)
        .map((line) => (line ? line : ""))
        .join("\n");
      lines.push(indented);
    } else {
      lines.push(`_${kind}_`);
    }
    lines.push("");
  }

  return {
    markdown: lines.join("\n"),
    stats,
  };
}
