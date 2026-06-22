import { createHmac, randomUUID } from "node:crypto";
import fsp from "node:fs/promises";
import path from "node:path";
import process from "node:process";

import { requestJsonMutation } from "../auth/http.js";
import { resolveActiveAuthSession } from "../auth/service.js";
import { renderCoordinationBulletList } from "./coordination-guidance.js";
import { resolveSessionPaths } from "./paths.js";

export const SESSION_INVITATION_ACCEPT_ROUTE_ID =
  "POST /api/v1/sessions/{session_id}/invitations/accept";
export const SESSION_MUTATION_ORIGIN = "https://sentinelayer.com";

function normalizeString(value) {
  return String(value || "").trim();
}

function safeFileToken(value, fallback = "onboarding") {
  const normalized = normalizeString(value)
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return (normalized || fallback).slice(0, 80);
}

export function canonicalSessionRef(value) {
  const raw = normalizeString(value);
  if (!raw) return "unavailable";
  return raw.toLowerCase();
}

export function createSessionMutationCsrfToken({
  bearerToken,
  sessionId,
  routeId,
  idempotencyKey,
} = {}) {
  const secret = normalizeString(bearerToken);
  if (!secret) return "";
  const message = [
    "session-mutation-csrf:v1",
    canonicalSessionRef(sessionId),
    normalizeString(routeId),
    normalizeString(idempotencyKey),
  ].join("\0");
  return createHmac("sha256", secret).update(message, "utf-8").digest("hex");
}

export function createSessionMutationHeaders({
  bearerToken,
  sessionId,
  routeId,
  idempotencyKey,
  origin = SESSION_MUTATION_ORIGIN,
} = {}) {
  const token = normalizeString(bearerToken);
  const normalizedOrigin = normalizeString(origin) || SESSION_MUTATION_ORIGIN;
  return {
    Authorization: `Bearer ${token}`,
    Origin: normalizedOrigin,
    "Sec-Fetch-Site": "same-site",
    "X-Sentinelayer-Session-Mutation": "session-mutation",
    "X-CSRF-Token": createSessionMutationCsrfToken({
      bearerToken: token,
      sessionId,
      routeId,
      idempotencyKey,
    }),
  };
}

export function createSessionMutationIdempotencyKey(operationName = "invitation-accept") {
  const operation = normalizeString(operationName)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 32) || "session-mutation";
  return `sl-cli-${operation}-${randomUUID()}`;
}

export async function acceptSessionInvitation(
  sessionId,
  {
    invitationToken,
    seatKey = "",
    agentId = "",
    targetPath = process.cwd(),
    idempotencyKey = "",
    origin = SESSION_MUTATION_ORIGIN,
    resolveAuthSession = resolveActiveAuthSession,
    requestMutation = requestJsonMutation,
  } = {},
) {
  const normalizedSessionId = normalizeString(sessionId);
  const normalizedInvitationToken = normalizeString(invitationToken);
  if (!normalizedSessionId) {
    throw new Error("session id is required.");
  }
  if (!normalizedInvitationToken) {
    throw new Error("invite token is required.");
  }

  const auth = await resolveAuthSession({
    cwd: targetPath,
    env: process.env,
    autoRotate: false,
  });
  if (!auth?.token || !auth?.apiUrl) {
    throw new Error("Not authenticated. Run `sl auth login` first.");
  }

  const resolvedIdempotencyKey =
    normalizeString(idempotencyKey) || createSessionMutationIdempotencyKey("session-invite-accept");
  const apiUrl = normalizeString(auth.apiUrl).replace(/\/+$/, "");
  const body = {
    token: normalizedInvitationToken,
  };
  const normalizedSeatKey = normalizeString(seatKey);
  const normalizedAgentId = normalizeString(agentId);
  if (normalizedSeatKey) body.seatKey = normalizedSeatKey;
  if (normalizedAgentId) body.agentId = normalizedAgentId;

  const result = await requestMutation(
    `${apiUrl}/api/v1/sessions/${encodeURIComponent(normalizedSessionId)}/invitations/accept`,
    {
      method: "POST",
      operationName: "session.invitation_accept",
      idempotencyKey: resolvedIdempotencyKey,
      headers: createSessionMutationHeaders({
        bearerToken: auth.token,
        sessionId: normalizedSessionId,
        routeId: SESSION_INVITATION_ACCEPT_ROUTE_ID,
        idempotencyKey: resolvedIdempotencyKey,
        origin,
      }),
      body,
    },
  );

  return {
    idempotencyKey: resolvedIdempotencyKey,
    result,
  };
}

export function normalizeSessionOnboarding(onboarding = {}, claimedSeat = null) {
  const onboardingSource =
    onboarding && typeof onboarding === "object" && !Array.isArray(onboarding) ? onboarding : {};
  const seatSource =
    claimedSeat && typeof claimedSeat === "object" && !Array.isArray(claimedSeat) ? claimedSeat : {};
  const normalized = {
    seatKey: normalizeString(onboardingSource.seatKey) || normalizeString(seatSource.seatKey) || null,
    agentId:
      normalizeString(onboardingSource.agentId) ||
      normalizeString(seatSource.claimedAgentId) ||
      normalizeString(seatSource.agentId) ||
      null,
    displayName:
      normalizeString(onboardingSource.displayName) || normalizeString(seatSource.displayName) || null,
    role: normalizeString(onboardingSource.role) || normalizeString(seatSource.role) || null,
    instructions:
      normalizeString(onboardingSource.instructions) || normalizeString(seatSource.instructions) || null,
  };
  return Object.values(normalized).some(Boolean) ? normalized : null;
}

function renderOnboardingMarkdown({ sessionId, onboarding, claimedSeat, agentId }) {
  const lines = [
    "# Senti Session Onboarding",
    "",
    `Session: ${sessionId}`,
    `Agent: ${normalizeString(onboarding.agentId) || normalizeString(agentId) || "unknown"}`,
  ];
  if (onboarding.displayName) lines.push(`Display name: ${onboarding.displayName}`);
  if (onboarding.role) lines.push(`Role: ${onboarding.role}`);
  if (onboarding.seatKey) lines.push(`Seat key: ${onboarding.seatKey}`);
  if (claimedSeat?.seatType) lines.push(`Seat type: ${normalizeString(claimedSeat.seatType)}`);
  lines.push("", "## SOUL Instructions", "");
  lines.push(onboarding.instructions || "No seat-specific instructions were provided.");
  lines.push("", "## Session Etiquette", "", renderCoordinationBulletList());
  lines.push(
    "",
    "## First Actions",
    "",
    `- Read recent room context: \`sl session read ${sessionId} --remote --tail 50 --json\``,
    `- Start a quiet listener: \`sl session listen --session ${sessionId} --agent <your-name> --interval 60 --active-interval 5 --emit ndjson --no-presence\``,
    `- Post a short plan before editing: \`sl session say ${sessionId} \"plan: <scope>; files: <paths>\"\``,
    "- Review `AGENTS.md` / `CLAUDE.md`, then keep `tasks/todo.md` current for work status.",
    "- Add any Carter correction pattern to `tasks/lessons.md` before continuing the next slice.",
  );
  return `${lines.join("\n")}\n`;
}

export async function writeSessionOnboardingBrief(
  sessionId,
  {
    onboarding,
    claimedSeat = null,
    agentId = "",
    targetPath = process.cwd(),
  } = {},
) {
  const normalizedSessionId = normalizeString(sessionId);
  const normalizedOnboarding = normalizeSessionOnboarding(onboarding, claimedSeat);
  if (!normalizedSessionId || !normalizedOnboarding) {
    return null;
  }
  const paths = resolveSessionPaths(normalizedSessionId, { targetPath });
  const owner = safeFileToken(normalizedOnboarding.agentId || agentId || normalizedOnboarding.seatKey);
  const dir = path.join(paths.sentiDir, "onboarding");
  const jsonPath = path.join(dir, `${owner}.json`);
  const markdownPath = path.join(dir, `${owner}.md`);
  const payload = {
    schemaVersion: "1.0.0",
    sessionId: normalizedSessionId,
    agentId: normalizeString(agentId) || normalizedOnboarding.agentId || null,
    onboarding: normalizedOnboarding,
    claimedSeat: claimedSeat && typeof claimedSeat === "object" ? claimedSeat : null,
    writtenAt: new Date().toISOString(),
  };
  await fsp.mkdir(dir, { recursive: true });
  await Promise.all([
    fsp.writeFile(jsonPath, `${JSON.stringify(payload, null, 2)}\n`, "utf-8"),
    fsp.writeFile(
      markdownPath,
      renderOnboardingMarkdown({
        sessionId: normalizedSessionId,
        onboarding: normalizedOnboarding,
        claimedSeat,
        agentId,
      }),
      "utf-8",
    ),
  ]);
  return {
    jsonPath,
    markdownPath,
    onboarding: normalizedOnboarding,
  };
}
