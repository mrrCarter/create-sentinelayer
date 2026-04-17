import { randomBytes } from "node:crypto";
import fsp from "node:fs/promises";
import path from "node:path";
import process from "node:process";

import { STUCK_THRESHOLDS } from "../agents/jules/pulse.js";
import { createAgentEvent } from "../events/schema.js";
import { resolveSessionPaths } from "./paths.js";
import { appendToStream } from "./stream.js";

const AGENT_SNAPSHOT_SCHEMA_VERSION = "1.0.0";

const AGENT_ROLES = new Set([
  "coder",
  "reviewer",
  "tester",
  "daemon",
  "observer",
  "persona",
]);

const AGENT_STATUSES = new Set([
  "coding",
  "reviewing",
  "testing",
  "idle",
  "blocked",
  "watching",
]);

const LEAVE_REASONS = new Set([
  "task_complete",
  "error",
  "timeout",
  "manual",
  "killed",
]);

function normalizeString(value) {
  return String(value || "").trim();
}

function normalizeIsoTimestamp(value, fallbackIso = new Date().toISOString()) {
  const normalized = normalizeString(value);
  if (!normalized) {
    return fallbackIso;
  }
  const epoch = Date.parse(normalized);
  if (!Number.isFinite(epoch)) {
    return fallbackIso;
  }
  return new Date(epoch).toISOString();
}

function normalizeRole(value) {
  const normalized = normalizeString(value).toLowerCase();
  if (!AGENT_ROLES.has(normalized)) {
    throw new Error(`role must be one of: ${[...AGENT_ROLES].join(", ")}.`);
  }
  return normalized;
}

function normalizeStatus(value, fallbackValue = "idle") {
  const normalized = normalizeString(value).toLowerCase();
  if (!normalized) {
    return fallbackValue;
  }
  if (!AGENT_STATUSES.has(normalized)) {
    throw new Error(`status must be one of: ${[...AGENT_STATUSES].join(", ")}.`);
  }
  return normalized;
}

function normalizeLeaveReason(value) {
  const normalized = normalizeString(value).toLowerCase();
  if (!normalized) {
    return "manual";
  }
  if (!LEAVE_REASONS.has(normalized)) {
    throw new Error(`reason must be one of: ${[...LEAVE_REASONS].join(", ")}.`);
  }
  return normalized;
}

function sanitizePrefix(value) {
  const normalized = normalizeString(value)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (!normalized) {
    return "";
  }
  return normalized.slice(0, 12);
}

function deriveModelPrefix(modelName) {
  const normalized = normalizeString(modelName).toLowerCase();
  if (!normalized) {
    return "agent";
  }
  if (normalized.includes("claude")) return "claude";
  if (normalized.includes("codex")) return "codex";
  if (normalized.includes("gpt")) return "codex";
  if (normalized.includes("sonnet")) return "sonnet";
  if (normalized.includes("senti") || normalized.includes("sentinel")) return "senti";

  const token = normalized.split(/[\s:/_-]+/).find(Boolean) || normalized;
  return sanitizePrefix(token) || "agent";
}

function normalizeAgentSnapshot(snapshot = {}, nowIso = new Date().toISOString()) {
  return {
    schemaVersion: AGENT_SNAPSHOT_SCHEMA_VERSION,
    sessionId: normalizeString(snapshot.sessionId),
    agentId: normalizeString(snapshot.agentId),
    model: normalizeString(snapshot.model) || "unknown",
    role: normalizeRole(snapshot.role || "observer"),
    status: normalizeStatus(snapshot.status, "idle"),
    detail: normalizeString(snapshot.detail) || "",
    file: normalizeString(snapshot.file) || null,
    joinedAt: normalizeIsoTimestamp(snapshot.joinedAt, nowIso),
    lastActivityAt: normalizeIsoTimestamp(snapshot.lastActivityAt, nowIso),
    leftAt: snapshot.leftAt ? normalizeIsoTimestamp(snapshot.leftAt, nowIso) : null,
    leaveReason: snapshot.leaveReason ? normalizeLeaveReason(snapshot.leaveReason) : null,
    active: snapshot.active !== false,
    updatedAt: normalizeIsoTimestamp(snapshot.updatedAt, nowIso),
  };
}

async function readAgentSnapshot(snapshotPath) {
  try {
    const raw = await fsp.readFile(snapshotPath, "utf-8");
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return null;
    }
    return parsed;
  } catch (error) {
    if (error && typeof error === "object" && error.code === "ENOENT") {
      return null;
    }
    throw error;
  }
}

async function writeAgentSnapshot(snapshotPath, snapshot) {
  await fsp.mkdir(path.dirname(snapshotPath), { recursive: true });
  const tmpPath = `${snapshotPath}.${process.pid}.${Date.now()}.tmp`;
  await fsp.writeFile(tmpPath, `${JSON.stringify(snapshot, null, 2)}\n`, "utf-8");
  await fsp.rename(tmpPath, snapshotPath);
}

async function emitAgentEvent(sessionId, event, payload, { targetPath = process.cwd() } = {}) {
  const envelope = createAgentEvent({
    event,
    agentId: payload.agentId,
    sessionId,
    payload,
  });
  await appendToStream(sessionId, envelope, { targetPath });
}

function buildAgentSnapshotPath(paths, agentId) {
  const normalizedAgentId = normalizeString(agentId);
  if (!normalizedAgentId) {
    throw new Error("agentId is required.");
  }
  return path.join(paths.agentsDir, `${normalizedAgentId}.json`);
}

export function generateAgentId(modelName) {
  const prefix = deriveModelPrefix(modelName);
  const suffix = randomBytes(2).toString("hex");
  return `${prefix}-${suffix}`;
}

export async function registerAgent(
  sessionId,
  { agentId = "", model = "", role = "observer", targetPath = process.cwd() } = {}
) {
  const paths = resolveSessionPaths(sessionId, { targetPath });
  const nowIso = new Date().toISOString();
  const resolvedAgentId = normalizeString(agentId) || generateAgentId(model);
  const snapshotPath = buildAgentSnapshotPath(paths, resolvedAgentId);

  const snapshot = normalizeAgentSnapshot(
    {
      sessionId: paths.sessionId,
      agentId: resolvedAgentId,
      model: normalizeString(model) || "unknown",
      role,
      status: "idle",
      detail: "",
      file: null,
      joinedAt: nowIso,
      lastActivityAt: nowIso,
      leftAt: null,
      leaveReason: null,
      active: true,
      updatedAt: nowIso,
    },
    nowIso
  );

  await writeAgentSnapshot(snapshotPath, snapshot);
  await emitAgentEvent(paths.sessionId, "agent_join", {
    agentId: snapshot.agentId,
    model: snapshot.model,
    role: snapshot.role,
    status: snapshot.status,
  }, { targetPath });

  return {
    ...snapshot,
    snapshotPath,
  };
}

export async function heartbeatAgent(
  sessionId,
  agentId,
  { status = "", detail = "", file = "", targetPath = process.cwd() } = {}
) {
  const paths = resolveSessionPaths(sessionId, { targetPath });
  const nowIso = new Date().toISOString();
  const snapshotPath = buildAgentSnapshotPath(paths, agentId);
  const existing = await readAgentSnapshot(snapshotPath);
  if (!existing) {
    throw new Error(`Agent '${normalizeString(agentId)}' is not registered in session '${paths.sessionId}'.`);
  }

  const snapshot = normalizeAgentSnapshot(
    {
      ...existing,
      status: normalizeStatus(status, normalizeStatus(existing.status || "idle")),
      detail: normalizeString(detail) || normalizeString(existing.detail),
      file: normalizeString(file) || normalizeString(existing.file) || null,
      lastActivityAt: nowIso,
      updatedAt: nowIso,
      active: true,
    },
    nowIso
  );

  await writeAgentSnapshot(snapshotPath, snapshot);
  return {
    ...snapshot,
    snapshotPath,
  };
}

export async function unregisterAgent(
  sessionId,
  agentId,
  { reason = "manual", targetPath = process.cwd() } = {}
) {
  const paths = resolveSessionPaths(sessionId, { targetPath });
  const nowIso = new Date().toISOString();
  const snapshotPath = buildAgentSnapshotPath(paths, agentId);
  const existing = await readAgentSnapshot(snapshotPath);
  if (!existing) {
    throw new Error(`Agent '${normalizeString(agentId)}' is not registered in session '${paths.sessionId}'.`);
  }

  const normalizedReason = normalizeLeaveReason(reason);
  const snapshot = normalizeAgentSnapshot(
    {
      ...existing,
      active: false,
      leftAt: nowIso,
      leaveReason: normalizedReason,
      updatedAt: nowIso,
    },
    nowIso
  );

  await writeAgentSnapshot(snapshotPath, snapshot);
  await emitAgentEvent(paths.sessionId, "agent_leave", {
    agentId: snapshot.agentId,
    reason: normalizedReason,
    role: snapshot.role,
    model: snapshot.model,
  }, { targetPath });

  return {
    ...snapshot,
    snapshotPath,
  };
}

export async function listAgents(
  sessionId,
  { targetPath = process.cwd(), includeInactive = true } = {}
) {
  const paths = resolveSessionPaths(sessionId, { targetPath });
  let entries = [];
  try {
    entries = await fsp.readdir(paths.agentsDir, { withFileTypes: true });
  } catch (error) {
    if (error && typeof error === "object" && error.code === "ENOENT") {
      return [];
    }
    throw error;
  }

  const agents = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
    const snapshotPath = path.join(paths.agentsDir, entry.name);
    const raw = await readAgentSnapshot(snapshotPath);
    if (!raw) continue;
    const normalized = normalizeAgentSnapshot(raw);
    if (normalized.sessionId !== paths.sessionId) continue;
    if (!includeInactive && normalized.active === false) continue;
    agents.push({
      ...normalized,
      snapshotPath,
    });
  }

  agents.sort((left, right) => right.lastActivityAt.localeCompare(left.lastActivityAt));
  return agents;
}

export function detectStaleAgents(
  agents,
  {
    idleThresholdSeconds = Number(STUCK_THRESHOLDS?.noToolCallSeconds || 90),
    nowIso = new Date().toISOString(),
  } = {}
) {
  const normalizedThreshold = Math.max(1, Math.floor(Number(idleThresholdSeconds || 90)));
  const nowEpoch = Date.parse(normalizeIsoTimestamp(nowIso, new Date().toISOString()));
  if (!Number.isFinite(nowEpoch)) {
    return [];
  }
  const list = Array.isArray(agents) ? agents : [];
  return list
    .map((agent) => normalizeAgentSnapshot(agent, nowIso))
    .filter((agent) => agent.active !== false)
    .map((agent) => {
      const activityEpoch = Date.parse(normalizeIsoTimestamp(agent.lastActivityAt, agent.joinedAt || nowIso));
      const idleSeconds = Number.isFinite(activityEpoch)
        ? Math.max(0, Math.floor((nowEpoch - activityEpoch) / 1000))
        : normalizedThreshold + 1;
      return {
        ...agent,
        idleSeconds,
      };
    })
    .filter((agent) => agent.idleSeconds >= normalizedThreshold);
}
