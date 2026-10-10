// Owner/delegator controls for the Agent Admission Contract.
//
// Agent-side key generation, approval polling, proof-of-possession claim, and
// credential storage remain in admission.js. This module is deliberately the
// human control plane only: inspect requests, approve/deny them, or revoke a
// live grant. Every mutation uses the same session CSRF + idempotency contract
// as the existing request/claim path.

import process from "node:process";

import { checkedTransport, credentialFor, isAuthenticated } from "../auth/credential-destinations.js";
import { requestJson, requestJsonMutation } from "../auth/http.js";
import { resolveActiveAuthSession } from "../auth/service.js";
import { hasStoredAdmissionCredentials } from "./admission.js";
import { currentAdmittedAgent } from "./admission-auth.js";
import {
  SESSION_MUTATION_ORIGIN,
  createSessionMutationHeaders,
  createSessionMutationIdempotencyKey,
} from "./invitations.js";
import { urlPathSegment } from "../net/url-path.js";

/**
 * Approve, deny, revoke and mode changes are the room owner's decisions, made with the
 * owner's own session. They are unavailable while this process is an agent context:
 * SENTINELAYER_AGENT_ID is set, an agent admission scope is in force, or this machine
 * stores agent admission credentials. Checked before any credential lookup or request.
 */
export async function assertOwnerAccessContext({ env = process.env, homeDir } = {}) {
  let why = "";
  if (normalizeString(env.SENTINELAYER_AGENT_ID)) {
    why = "SENTINELAYER_AGENT_ID is set";
  } else if (currentAdmittedAgent()) {
    why = "an agent admission is in use";
  } else if (await hasStoredAdmissionCredentials({ homeDir })) {
    why = "agent admission credentials are stored on this machine";
  }
  if (why) {
    throw new Error(
      `Access approve, deny, revoke and mode are owner actions and are unavailable in an agent context (${why}). ` +
        `Use the room's web dashboard, or run the command from an environment without agent credentials.`,
    );
  }
}

export const ADMISSION_STATUSES = Object.freeze([
  "pending",
  "approved",
  "active",
  "denied",
  "cancelled",
  "expired",
  "revoked",
  "stopped",
]);

const ROUTES = Object.freeze({
  decision: "POST /api/v1/sessions/{session_id}/admissions/{admission_id}/decision",
  revoke: "POST /api/v1/sessions/{session_id}/admissions/{admission_id}/revoke",
  mode: "POST /api/v1/sessions/{session_id}/admission-mode",
});

function normalizeString(value) {
  return String(value ?? "").trim();
}

function required(value, label) {
  const normalized = normalizeString(value);
  if (!normalized) throw new Error(`${label} is required.`);
  return normalized;
}

async function authContext(targetPath, resolveAuthSession) {
  const auth = await resolveAuthSession({
    cwd: targetPath,
    env: process.env,
    autoRotate: false,
  });
  if (!isAuthenticated(auth) || !auth?.apiUrl) {
    throw new Error("Not authenticated. Run `sl auth login` first.");
  }
  return {
    credential: await credentialFor(auth),
    apiUrl: normalizeString(auth.apiUrl).replace(/\/+$/, ""),
  };
}

function admissionsUrl(apiUrl, sessionId, suffix = "") {
  return `${apiUrl}/api/v1/sessions/${urlPathSegment(sessionId, { label: "sessionId" })}/admissions${suffix}`;
}

function boundedIdempotencyKey(value, operation) {
  const explicit = normalizeString(value);
  if (explicit.length > 128) throw new Error("--idempotency-key must be at most 128 characters.");
  return explicit || createSessionMutationIdempotencyKey(operation);
}

async function mutateAdmission(
  sessionId,
  suffix,
  routeId,
  body,
  {
    targetPath,
    idempotencyKey,
    operationName,
    origin,
    resolveAuthSession,
    requestMutation,
  },
) {
  const key = boundedIdempotencyKey(idempotencyKey, operationName);
  const auth = await authContext(targetPath, resolveAuthSession);
  const result = await checkedTransport(requestMutation)(admissionsUrl(auth.apiUrl, sessionId, suffix), {
    method: "POST",
    operationName,
    idempotencyKey: key,
    credential: auth.credential,
    headers: createSessionMutationHeaders({
      credential: auth.credential,
      sessionId,
      routeId,
      idempotencyKey: key,
      origin,
    }),
    body,
  });
  return { idempotencyKey: key, result };
}

export async function listSessionAdmissions(
  sessionId,
  {
    status = "",
    targetPath = process.cwd(),
    resolveAuthSession = resolveActiveAuthSession,
    requestRead = requestJson,
  } = {},
) {
  const sid = required(sessionId, "session id");
  const normalizedStatus = normalizeString(status).toLowerCase();
  if (normalizedStatus && !ADMISSION_STATUSES.includes(normalizedStatus)) {
    throw new Error(
      `--status must be one of: ${ADMISSION_STATUSES.join(", ")}.`,
    );
  }
  const auth = await authContext(targetPath, resolveAuthSession);
  const query = normalizedStatus ? `?status=${encodeURIComponent(normalizedStatus)}` : "";
  return checkedTransport(requestRead)(`${admissionsUrl(auth.apiUrl, sid)}${query}`, {
    method: "GET",
    credential: auth.credential,
  });
}

export async function getSessionAdmission(
  sessionId,
  admissionId,
  {
    targetPath = process.cwd(),
    resolveAuthSession = resolveActiveAuthSession,
    requestRead = requestJson,
  } = {},
) {
  const sid = required(sessionId, "session id");
  const aid = required(admissionId, "admission id");
  const auth = await authContext(targetPath, resolveAuthSession);
  return checkedTransport(requestRead)(admissionsUrl(auth.apiUrl, sid, `/${urlPathSegment(aid, { label: "admissionId" })}`), {
    method: "GET",
    credential: auth.credential,
  });
}

export async function decideSessionAdmission(
  sessionId,
  admissionId,
  {
    decision,
    grantedActions,
    ttlSeconds,
    note,
    targetPath = process.cwd(),
    idempotencyKey = "",
    origin = SESSION_MUTATION_ORIGIN,
    resolveAuthSession = resolveActiveAuthSession,
    requestMutation = requestJsonMutation,
  } = {},
) {
  const sid = required(sessionId, "session id");
  const aid = required(admissionId, "admission id");
  const normalizedDecision = normalizeString(decision).toLowerCase();
  if (!["approve", "deny"].includes(normalizedDecision)) {
    throw new Error("decision must be approve or deny.");
  }
  if (normalizedDecision === "deny" && (grantedActions !== undefined || ttlSeconds !== undefined)) {
    throw new Error("A denied admission cannot include --scope or --ttl.");
  }
  const body = { decision: normalizedDecision };
  if (grantedActions !== undefined) body.grantedActions = grantedActions;
  if (ttlSeconds !== undefined) body.ttlSeconds = ttlSeconds;
  const normalizedNote = normalizeString(note);
  if (normalizedNote) body.note = normalizedNote;
  await assertOwnerAccessContext();
  return mutateAdmission(
    sid,
    `/${urlPathSegment(aid, { label: "admissionId" })}/decision`,
    ROUTES.decision,
    body,
    {
      targetPath,
      idempotencyKey,
      operationName: `session.admission_${normalizedDecision}`,
      origin,
      resolveAuthSession,
      requestMutation,
    },
  );
}

export async function revokeSessionAdmission(
  sessionId,
  admissionId,
  {
    reason,
    targetPath = process.cwd(),
    idempotencyKey = "",
    origin = SESSION_MUTATION_ORIGIN,
    resolveAuthSession = resolveActiveAuthSession,
    requestMutation = requestJsonMutation,
  } = {},
) {
  const sid = required(sessionId, "session id");
  const aid = required(admissionId, "admission id");
  const normalizedReason = normalizeString(reason);
  await assertOwnerAccessContext();
  return mutateAdmission(
    sid,
    `/${urlPathSegment(aid, { label: "admissionId" })}/revoke`,
    ROUTES.revoke,
    normalizedReason ? { reason: normalizedReason } : {},
    {
      targetPath,
      idempotencyKey,
      operationName: "session.admission_revoke",
      origin,
      resolveAuthSession,
      requestMutation,
    },
  );
}

export async function setSessionAdmissionMode(
  sessionId,
  mode,
  {
    targetPath = process.cwd(),
    idempotencyKey = "",
    origin = SESSION_MUTATION_ORIGIN,
    resolveAuthSession = resolveActiveAuthSession,
    requestMutation = requestJsonMutation,
  } = {},
) {
  const sid = required(sessionId, "session id");
  const normalizedMode = normalizeString(mode).toLowerCase();
  if (!["legacy", "required"].includes(normalizedMode)) {
    throw new Error("mode must be legacy or required.");
  }
  await assertOwnerAccessContext();
  const key = boundedIdempotencyKey(idempotencyKey, "session.admission_mode");
  const auth = await authContext(targetPath, resolveAuthSession);
  const result = await checkedTransport(requestMutation)(
    `${auth.apiUrl}/api/v1/sessions/${urlPathSegment(sid, { label: "sessionId" })}/admission-mode`,
    {
      method: "POST",
      operationName: "session.admission_mode",
      idempotencyKey: key,
      credential: auth.credential,
      headers: createSessionMutationHeaders({
        credential: auth.credential,
        sessionId: sid,
        routeId: ROUTES.mode,
        idempotencyKey: key,
        origin,
      }),
      body: { mode: normalizedMode },
    },
  );
  return { idempotencyKey: key, result };
}
