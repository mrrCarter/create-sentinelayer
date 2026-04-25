/**
 * Session transcript renderer — produces an iMessage-style Markdown
 * document from a session's NDJSON event stream + agent roster +
 * metadata. Deterministic: same inputs → identical output (modulo the
 * `generatedAt` line in the header).
 *
 * Adds at render time:
 *   - Per-agent active duration (first → last event with that agent id)
 *   - Total session live-for (createdAt → last event)
 *   - Token + cost roll-up if events carry usage payloads
 *   - Avatar per speaker, picked from PERSONA_VISUALS / CLIENT_FAMILY_AVATARS,
 *     or a deterministic letter-tile fallback
 *   - Senti-orchestrator events tagged with the orchestrator avatar so
 *     "if orchestrator did anything it signs its name + time" — even
 *     when the underlying event came from a worker job
 *
 * Scales: O(events + agents). Tested up to 20 speakers without degradation.
 */

import { PERSONA_VISUALS, ORCHESTRATOR_VISUALS } from "../agents/persona-visuals.js";

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

function eventBody(event) {
  const payload = event && typeof event.payload === "object" ? event.payload : {};
  const text =
    payload.message ||
    payload.response ||
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
 *  - totals: { tokenTotal, costTotalUsd } summed from any payload.usage hints
 *  - sentiActions: count of orchestrator events
 */
export function computeTranscriptStats({ sessionMeta = {}, events = [], speakerProfiles = new Map() } = {}) {
  const perAgent = new Map();
  let firstEventTs = null;
  let lastEventTs = null;
  let tokenTotal = 0;
  let costTotalUsd = 0;
  let sentiActions = 0;

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

    if (!perAgent.has(agentId)) {
      const profile = speakerProfiles.get(agentId) || null;
      const identity = resolveSpeakerIdentity({
        agentId,
        agentModel: event.agent?.model || event.agentModel || "",
        profile,
      });
      perAgent.set(agentId, {
        agentId,
        family: identity.family,
        displayName: identity.displayName,
        avatar: identity.avatar,
        avatarUrl: identity.avatarUrl,
        color: identity.color,
        model: event.agent?.model || event.agentModel || "",
        firstSeenMs: epoch,
        lastSeenMs: epoch,
        eventCount: 0,
        tokens: 0,
        costUsd: 0,
      });
    }
    const record = perAgent.get(agentId);
    record.eventCount += 1;
    if (epoch < record.firstSeenMs) record.firstSeenMs = epoch;
    if (epoch > record.lastSeenMs) record.lastSeenMs = epoch;

    const usage = event?.payload?.usage;
    if (usage && typeof usage === "object") {
      const t =
        Number(usage.totalTokens || usage.total_tokens || usage.tokens || 0) || 0;
      const c = Number(usage.costUsd || usage.cost_usd || usage.cost || 0) || 0;
      record.tokens += t;
      record.costUsd += c;
      tokenTotal += t;
      costTotalUsd += c;
    }
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
    totals: { tokenTotal, costTotalUsd },
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
  const includeSystemEvents = options.includeSystemEvents !== false;
  const stats = computeTranscriptStats({ sessionMeta, events, speakerProfiles });

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
    lines.push(
      `Tokens: ${stats.totals.tokenTotal.toLocaleString("en-US")} · Cost: $${stats.totals.costTotalUsd.toFixed(4)}`,
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
  if (stats.agents.length === 0) {
    lines.push("| 👤 | (no agents joined) | — | 0s | 0 | 0 | $0.00 |");
  }
  // Surface registered-but-silent agents at the bottom of the table so
  // the participants list is comprehensive even if they never emitted
  // a stream event.
  const seenIds = new Set(stats.agents.map((a) => a.agentId));
  for (const registered of agents || []) {
    const id = normalize(registered?.agentId);
    if (!id || seenIds.has(id)) continue;
    const profile = speakerProfiles.get(id) || null;
    const identity = resolveSpeakerIdentity({
      agentId: id,
      agentModel: registered.model || "",
      profile,
    });
    lines.push(
      `| ${avatarMd(identity)} | **${identity.displayName}** \`${id}\` | ${identity.family} | 0s · idle | 0 | 0 | $0.0000 |`,
    );
  }
  lines.push("");

  // Conversation
  lines.push("## Conversation");
  lines.push("");
  for (const event of events) {
    const kind = normalize(event.event || event.type);
    if (!kind || !TRANSCRIPT_EVENT_KINDS.has(kind)) continue;
    if (!includeSystemEvents && SYSTEM_EVENT_KINDS.has(kind)) continue;

    const agentId = normalize(event.agent?.id || event.agentId);
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
