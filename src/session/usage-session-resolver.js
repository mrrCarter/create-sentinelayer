import process from "node:process";

import { listActiveSessions } from "./store.js";

const USAGE_SESSION_ENV_KEYS = [
  "SENTINELAYER_NOTIFY_SESSION",
  "SENTINELAYER_SESSION_ID",
  "SL_SESSION_ID",
];

function normalizeString(value) {
  return String(value || "").trim();
}

function isSafeUsageSessionId(value) {
  const normalized = normalizeString(value);
  if (!/^[A-Za-z0-9._-]{1,200}$/.test(normalized)) return false;
  if (normalized === "." || normalized === "..") return false;
  if (normalized.includes("..")) return false;
  return true;
}

function normalizeTrustedUsageSessionId(value, source) {
  const normalized = normalizeString(value);
  if (!normalized) return "";
  if (!isSafeUsageSessionId(normalized)) {
    throw new Error(
      `Invalid ${source} usage session id: must be a single session identifier without path traversal, separators, or control characters.`,
    );
  }
  return normalized;
}

function parseEpoch(value) {
  const epoch = Date.parse(normalizeString(value));
  return Number.isFinite(epoch) ? epoch : 0;
}

function sessionRecencyEpoch(session = {}) {
  return Math.max(
    parseEpoch(session.lastInteractionAt),
    parseEpoch(session.updatedAt),
    parseEpoch(session.createdAt),
  );
}

function resolveEnvUsageSession(env = process.env) {
  for (const key of USAGE_SESSION_ENV_KEYS) {
    const sessionId = normalizeTrustedUsageSessionId(env?.[key], key);
    if (sessionId) {
      return { sessionId, source: "env", envKey: key };
    }
  }
  return null;
}

export function selectMostRecentUsageSession(sessions = []) {
  const candidatesBySessionId = new Map();
  for (const session of Array.isArray(sessions) ? sessions : []) {
    const sessionId = normalizeString(session?.sessionId);
    if (!isSafeUsageSessionId(sessionId)) continue;

    const candidate = {
      sessionId,
      title: normalizeString(session?.title),
      recencyEpoch: sessionRecencyEpoch(session),
    };
    const existing = candidatesBySessionId.get(sessionId);
    if (!existing || candidate.recencyEpoch > existing.recencyEpoch) {
      candidatesBySessionId.set(sessionId, candidate);
    }
  }

  const candidates = Array.from(candidatesBySessionId.values());

  if (candidates.length === 0) {
    return { sessionId: "", source: "none", reason: "no_active_session" };
  }

  candidates.sort((left, right) => {
    if (right.recencyEpoch !== left.recencyEpoch) {
      return right.recencyEpoch - left.recencyEpoch;
    }
    return left.sessionId.localeCompare(right.sessionId);
  });

  const [winner, runnerUp] = candidates;
  if (runnerUp && runnerUp.recencyEpoch === winner.recencyEpoch) {
    return {
      sessionId: "",
      source: "ambiguous",
      reason: "multiple_active_sessions_same_recency",
      candidates: candidates.map((candidate) => candidate.sessionId),
    };
  }

  return {
    sessionId: winner.sessionId,
    source: "local_active_session",
    title: winner.title || null,
    candidates: candidates.map((candidate) => candidate.sessionId),
  };
}

export async function resolveUsageSessionId({
  explicitSessionId = "",
  targetPath = process.cwd(),
  env = process.env,
  listActiveSessionsFn = listActiveSessions,
} = {}) {
  const explicit = normalizeTrustedUsageSessionId(explicitSessionId, "--notify-session");
  if (explicit) {
    return { sessionId: explicit, source: "explicit" };
  }

  const envSession = resolveEnvUsageSession(env);
  if (envSession) {
    return envSession;
  }

  try {
    const sessions = await listActiveSessionsFn({ targetPath });
    return selectMostRecentUsageSession(sessions);
  } catch (error) {
    return {
      sessionId: "",
      source: "error",
      reason: "list_active_sessions_failed",
      errorCode: error && typeof error === "object" ? normalizeString(error.code) || null : null,
    };
  }
}
