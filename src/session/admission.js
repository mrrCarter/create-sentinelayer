// admission.js — the agent side of goal-and-scope admission (API SPEC "Agent
// Admission Contract").
//
// Flow: request (goal + closed-enum scope + our public key) -> a human approves in
// the web UI -> poll -> claim by signing a server nonce with OUR private key ->
// receive a room-scoped, expiring credential plus a passport over our key.
//
// Invariants this module keeps:
//   - The private key is generated here and never leaves this machine. Only the
//     raw public key is sent. Files holding secrets are written 0600, atomically.
//   - We sign only a claim preimage that names OUR public key and OUR agent id.
//     A server response naming anything else is refused, not signed.
//   - The admission credential is never printed or logged. Callers get a storage
//     reference; the token lives only in the 0600 credential file.
//   - Waiting is bounded, honours the server's poll interval, and is resumable:
//     non-secret state is persisted per room so a re-run continues the same
//     request instead of filing a new one.

import { createPrivateKey, generateKeyPairSync, sign as signBytes } from "node:crypto";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { setTimeout as sleepMs } from "node:timers/promises";

import { requestJson, requestJsonMutation } from "../auth/http.js";
import { resolveActiveAuthSession } from "../auth/service.js";
import { canonicalPreimage } from "./admission-preimage.js";
import {
  SESSION_MUTATION_ORIGIN,
  createSessionMutationHeaders,
  createSessionMutationIdempotencyKey,
} from "./invitations.js";
import { resolveSessionPaths } from "./paths.js";

export const ADMISSION_ACTIONS = Object.freeze([
  "session.read",
  "session.post",
  "session.react",
  "tickets.read",
  "tickets.work",
]);
export const DEFAULT_ADMISSION_ACTIONS = Object.freeze(["session.read", "session.post"]);
export const CLAIM_DOMAIN = "sentinelayer.admission.claim.v1";
export const CLAIM_FIELDS = Object.freeze([
  "admissionId",
  "sessionId",
  "agentId",
  "publicKey",
  "keyThumbprint",
  "nonce",
]);
const ROUTE = {
  request: "POST /api/v1/sessions/{session_id}/admissions",
  claim: "POST /api/v1/sessions/{session_id}/admissions/{admission_id}/claim",
  cancel: "POST /api/v1/sessions/{session_id}/admissions/{admission_id}/cancel",
};
const TERMINAL = new Set(["denied", "cancelled", "expired", "revoked"]);
const TTL_MIN_SECONDS = 300;
const TTL_MAX_SECONDS = 86_400;

function normalizeString(value) {
  return String(value ?? "").trim();
}

function safeSegment(value, label) {
  const text = normalizeString(value);
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/.test(text)) {
    throw new Error(`${label} is not a valid identifier.`);
  }
  return text.replace(/:/g, "_");
}

function sentinelayerHome(homeDir) {
  return path.join(homeDir || os.homedir(), ".sentinelayer");
}

async function writeSecretFile(filePath, data) {
  await fsp.mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
  const tmp = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  await fsp.writeFile(tmp, `${JSON.stringify(data, null, 2)}\n`, { mode: 0o600 });
  await fsp.rename(tmp, filePath);
  // rename preserves the tmp file's mode; chmod again in case the file pre-existed
  // with a looser mode on a platform where rename replaced only the contents.
  await fsp.chmod(filePath, 0o600).catch(() => {});
}

async function readJsonFile(filePath) {
  try {
    return JSON.parse(await fsp.readFile(filePath, "utf8"));
  } catch (error) {
    if (error && error.code === "ENOENT") return null;
    throw error;
  }
}

/** Parse "90m", "2h", "1d" or seconds into bounded TTL seconds. */
export function parseTtlSeconds(value, fallback = 7200) {
  const raw = normalizeString(value);
  if (!raw) return fallback;
  const match = /^(\d+)\s*(s|m|h|d)?$/i.exec(raw);
  if (!match) throw new Error(`--ttl must look like 300, 90m, 2h or 1d (got "${raw}").`);
  const scale = { s: 1, m: 60, h: 3600, d: 86_400 }[(match[2] || "s").toLowerCase()];
  const seconds = Number(match[1]) * scale;
  if (seconds < TTL_MIN_SECONDS || seconds > TTL_MAX_SECONDS) {
    throw new Error(`--ttl must be between 5m and 24h (got ${seconds}s).`);
  }
  return seconds;
}

/** Validate a --scope list against the closed action enum. */
export function parseScope(value) {
  const raw = normalizeString(value);
  if (!raw) return [...DEFAULT_ADMISSION_ACTIONS];
  const actions = [...new Set(raw.split(",").map((item) => item.trim()).filter(Boolean))];
  const unknown = actions.filter((action) => !ADMISSION_ACTIONS.includes(action));
  if (unknown.length) {
    throw new Error(`Unknown --scope action(s): ${unknown.join(", ")}. Allowed: ${ADMISSION_ACTIONS.join(", ")}.`);
  }
  if (!actions.length) throw new Error("--scope must name at least one action.");
  return actions;
}

// ---------------------------------------------------------------------- keys

export function agentKeyPath(agentId, { homeDir } = {}) {
  return path.join(sentinelayerHome(homeDir), "agents", safeSegment(agentId, "agentId"), "identity-ed25519.json");
}

/** Load this agent's Ed25519 key, creating it on first use. The private half never leaves disk. */
export async function loadOrCreateAgentKey(agentId, { homeDir } = {}) {
  const keyPath = agentKeyPath(agentId, { homeDir });
  const existing = await readJsonFile(keyPath);
  if (existing?.privateKeyPkcs8 && existing?.publicKey) {
    return {
      publicKey: existing.publicKey,
      privateKey: createPrivateKey({
        key: Buffer.from(existing.privateKeyPkcs8, "base64url"),
        format: "der",
        type: "pkcs8",
      }),
      keyPath,
      created: false,
    };
  }
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const rawPublic = publicKey.export({ format: "jwk" }).x; // base64url, 32 raw bytes
  await writeSecretFile(keyPath, {
    version: 1,
    agentId: normalizeString(agentId),
    algorithm: "Ed25519",
    publicKey: rawPublic,
    privateKeyPkcs8: privateKey.export({ format: "der", type: "pkcs8" }).toString("base64url"),
    createdAt: new Date().toISOString(),
  });
  return { publicKey: rawPublic, privateKey, keyPath, created: true };
}

// ---------------------------------------------------------------- state files

function admissionStatePath(targetPath, sessionId) {
  const paths = resolveSessionPaths(sessionId, { targetPath });
  return path.join(paths.sessionDir, "admission.json");
}

export function admissionCredentialPath(sessionId, agentId, { homeDir } = {}) {
  return path.join(
    sentinelayerHome(homeDir),
    "agents",
    safeSegment(agentId, "agentId"),
    "admissions",
    `${safeSegment(sessionId, "sessionId")}.json`
  );
}

/** A live admission credential for (session, agent), or null. */
export async function loadAdmissionCredential(sessionId, agentId, { homeDir, now = Date.now() } = {}) {
  const stored = await readJsonFile(admissionCredentialPath(sessionId, agentId, { homeDir }));
  if (!stored?.token || !Number.isFinite(stored?.expiresAt)) return null;
  if (stored.expiresAt * 1000 <= now) return null;
  return stored;
}

// ---------------------------------------------------------------------- API

async function authContext({ targetPath, resolveAuthSession }) {
  const auth = await resolveAuthSession({ cwd: targetPath, env: process.env, autoRotate: false });
  if (!auth?.token || !auth?.apiUrl) {
    throw new Error("Not authenticated. Run `sl auth login` first.");
  }
  return { token: auth.token, apiUrl: normalizeString(auth.apiUrl).replace(/\/+$/, "") };
}

function admissionUrl(apiUrl, sessionId, suffix = "") {
  return `${apiUrl}/api/v1/sessions/${encodeURIComponent(sessionId)}/admissions${suffix}`;
}

async function mutate(auth, sessionId, routeId, url, body, { requestMutation, operationName, origin }) {
  const idempotencyKey = createSessionMutationIdempotencyKey(operationName);
  return requestMutation(url, {
    method: "POST",
    operationName,
    idempotencyKey,
    headers: createSessionMutationHeaders({
      bearerToken: auth.token,
      sessionId,
      routeId,
      idempotencyKey,
      origin,
    }),
    body,
  });
}

/**
 * Request admission, wait for a human decision, and claim the grant.
 * Returns a REDACTED result: the credential token is never included.
 */
export async function runAdmissionJoin(
  sessionId,
  {
    agentId,
    displayName = "",
    model = "cli",
    provider = "unknown",
    goal,
    deliverables = [],
    stopConditions = [],
    actions = DEFAULT_ADMISSION_ACTIONS,
    ttlSeconds = 7200,
    wait = true,
    waitTimeoutMs = 15 * 60_000,
    targetPath = process.cwd(),
    homeDir,
    origin = SESSION_MUTATION_ORIGIN,
    onPending = () => {},
    resolveAuthSession = resolveActiveAuthSession,
    requestMutation = requestJsonMutation,
    requestRead = requestJson,
    sleep = sleepMs,
    now = () => Date.now(),
  } = {}
) {
  const sid = normalizeString(sessionId);
  const agent = normalizeString(agentId).toLowerCase();
  if (!sid) throw new Error("session id is required.");
  if (!agent) throw new Error("--agent is required for admission.");
  const goalSummary = normalizeString(goal);
  if (!goalSummary) throw new Error("--goal is required: say what this agent is coming to do.");

  const deps = { requestMutation, origin };
  const auth = await authContext({ targetPath, resolveAuthSession });
  const key = await loadOrCreateAgentKey(agent, { homeDir });

  const live = await loadAdmissionCredential(sid, agent, { homeDir, now: now() });
  if (live && actions.every((action) => (live.grantedActions || []).includes(action))) {
    return redacted({ status: "active", reused: true, stored: live, sid, agent, homeDir });
  }

  const statePath = admissionStatePath(targetPath, sid);
  let state = await readJsonFile(statePath);
  const resumable =
    state?.admissionId &&
    state.agentId === agent &&
    state.publicKey === key.publicKey &&
    ["pending", "approved"].includes(state.status);

  if (!resumable) {
    const created = await mutate(
      auth,
      sid,
      ROUTE.request,
      admissionUrl(auth.apiUrl, sid),
      {
        agentId: agent,
        displayName: normalizeString(displayName) || null,
        model: normalizeString(model) || "cli",
        provider: normalizeString(provider) || "unknown",
        clientKind: "cli",
        publicKey: key.publicKey,
        popAssurance: "agent_held_key",
        goal: {
          summary: goalSummary,
          deliverables: deliverables.map(normalizeString).filter(Boolean),
          stopConditions: stopConditions.map(normalizeString).filter(Boolean),
        },
        requestedScope: { actions: [...actions], ttlSeconds },
      },
      { ...deps, operationName: "session.admission_request" }
    );
    if (created?.status === "active" && created?.reused) {
      // The server already holds a live grant for this key, but we have no stored
      // credential for it (e.g. a different machine). It cannot be re-issued.
      throw new Error(
        "This agent already holds an active admission here, but no credential is stored " +
          "on this machine. Ask the room owner to revoke it, then join again."
      );
    }
    state = {
      admissionId: created.admissionId,
      agentId: agent,
      publicKey: key.publicKey,
      status: created.status,
      approveUrl: created.approveUrl || null,
      pendingExpiresAt: created.pendingExpiresAt || null,
      requestedAt: new Date(now()).toISOString(),
    };
    await fsp.mkdir(path.dirname(statePath), { recursive: true });
    await fsp.writeFile(statePath, `${JSON.stringify(state, null, 2)}\n`);
  }

  if (!wait) {
    return { status: state.status, admissionId: state.admissionId, approveUrl: state.approveUrl, waited: false };
  }

  const deadline = now() + Math.max(0, waitTimeoutMs);
  let polled;
  for (;;) {
    polled = await requestRead(admissionUrl(auth.apiUrl, sid, `/${encodeURIComponent(state.admissionId)}`), {
      method: "GET",
      headers: { Authorization: `Bearer ${auth.token}` },
    });
    state.status = polled.status;
    if (polled.status === "approved" || TERMINAL.has(polled.status) || polled.status === "active") break;
    onPending({ admissionId: state.admissionId, approveUrl: polled.approveUrl || state.approveUrl });
    if (now() >= deadline) {
      await fsp.writeFile(statePath, `${JSON.stringify(state, null, 2)}\n`);
      return {
        status: "pending",
        admissionId: state.admissionId,
        approveUrl: polled.approveUrl || state.approveUrl,
        waited: true,
        timedOut: true,
      };
    }
    const interval = Math.min(Math.max(Number(polled.pollAfterSeconds) || 5, 2), 30) * 1000;
    await sleep(Math.min(interval, Math.max(0, deadline - now())));
  }

  if (TERMINAL.has(polled.status)) {
    await fsp.rm(statePath, { force: true });
    return { status: polled.status, admissionId: state.admissionId, waited: true };
  }
  if (polled.status === "active") {
    throw new Error("Admission is already active but this machine holds no credential for it.");
  }

  const fields = polled?.claim?.preimage;
  if (!fields || polled.claim.domain !== CLAIM_DOMAIN) {
    throw new Error("Approved admission did not include a valid claim challenge.");
  }
  // Never sign a claim for a key or agent that is not ours.
  if (fields.publicKey !== key.publicKey || fields.agentId !== agent || fields.sessionId !== sid) {
    throw new Error("Refusing to sign: the claim challenge does not name this agent's key.");
  }
  const signature = signBytes(null, canonicalPreimage(fields, { domain: CLAIM_DOMAIN, fields: [...CLAIM_FIELDS] }), key.privateKey);
  const claimed = await mutate(
    auth,
    sid,
    ROUTE.claim,
    admissionUrl(auth.apiUrl, sid, `/${encodeURIComponent(state.admissionId)}/claim`),
    { nonce: fields.nonce, signature: signature.toString("base64url") },
    { ...deps, operationName: "session.admission_claim" }
  );

  const stored = {
    version: 1,
    sessionId: sid,
    agentId: agent,
    admissionId: claimed.admissionId,
    token: claimed.credential.token,
    expiresAt: claimed.grant.expiresAt,
    grantedActions: claimed.grant.actions,
    passportId: claimed.identity.passportId,
    subject: claimed.identity.subject,
    storedAt: new Date(now()).toISOString(),
  };
  await writeSecretFile(admissionCredentialPath(sid, agent, { homeDir }), stored);
  await fsp.rm(statePath, { force: true });
  return redacted({ status: "active", reused: false, stored, claimed, sid, agent, homeDir });
}

function redacted({ status, reused, stored, claimed, sid, agent, homeDir }) {
  return {
    status,
    reused,
    admissionId: stored.admissionId,
    identity: claimed
      ? {
          subject: claimed.identity.subject,
          passportId: claimed.identity.passportId,
          passportStatus: claimed.identity.passportStatus,
          keyThumbprint: claimed.identity.keyThumbprint,
          popAssurance: claimed.identity.popAssurance,
          email: claimed.identity.email,
          passport: claimed.identity.passport,
        }
      : { subject: stored.subject, passportId: stored.passportId },
    grant: claimed
      ? {
          grantId: claimed.grant.grantId,
          sessionId: claimed.grant.sessionId,
          actions: claimed.grant.actions,
          expiresAt: claimed.grant.expiresAt,
          goalDigest: claimed.grant.goalDigest,
          document: claimed.grant.document,
        }
      : { sessionId: sid, actions: stored.grantedActions, expiresAt: stored.expiresAt },
    correlation: claimed ? claimed.correlation : { actorRef: `adm:${stored.admissionId}` },
    jev: claimed ? claimed.jev : undefined,
    // A reference only. The token itself never appears in output.
    credential: { storage: admissionCredentialPath(sid, agent, { homeDir }), redacted: true },
  };
}

/** Cancel a pending admission request filed from this workspace. */
export async function cancelAdmission(
  sessionId,
  {
    targetPath = process.cwd(),
    origin = SESSION_MUTATION_ORIGIN,
    resolveAuthSession = resolveActiveAuthSession,
    requestMutation = requestJsonMutation,
  } = {}
) {
  const sid = normalizeString(sessionId);
  const statePath = admissionStatePath(targetPath, sid);
  const state = await readJsonFile(statePath);
  if (!state?.admissionId) throw new Error("No pending admission request in this workspace.");
  const auth = await authContext({ targetPath, resolveAuthSession });
  const result = await mutate(
    auth,
    sid,
    ROUTE.cancel,
    admissionUrl(auth.apiUrl, sid, `/${encodeURIComponent(state.admissionId)}/cancel`),
    undefined,
    { requestMutation, origin, operationName: "session.admission_cancel" }
  );
  await fsp.rm(statePath, { force: true });
  return result;
}
