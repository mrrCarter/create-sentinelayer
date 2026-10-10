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

import {
  createHash,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  randomUUID,
  sign as signBytes,
} from "node:crypto";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { setTimeout as sleepMs } from "node:timers/promises";

import { requestJson, requestJsonMutation } from "../auth/http.js";
import { resolveActiveAuthSession } from "../auth/service.js";
import { canonicalize } from "../engram/canonical.js";
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

// One identity, one path, on every filesystem. Ids are case-folded (the API folds
// agent ids to lowercase, and Windows paths fold case anyway), and ":" -- legal in
// an id, illegal in a Windows file name -- becomes "%3a". "%" can never appear in
// an id, so the mapping is injective: "agent:one" and "agent_one" stay distinct.
function safeSegment(value, label) {
  const text = normalizeString(value).toLowerCase();
  if (!/^[a-z0-9][a-z0-9._:-]{0,63}$/.test(text)) {
    throw new Error(`${label} is not a valid identifier.`);
  }
  return text.replace(/:/g, "%3a");
}

function sentinelayerHome(homeDir) {
  return path.join(homeDir || os.homedir(), ".sentinelayer");
}

async function writeSecretFile(filePath, data) {
  await fsp.mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
  const tmp = `${filePath}.${randomUUID()}.tmp`;
  await fsp.writeFile(tmp, `${JSON.stringify(data, null, 2)}\n`, { mode: 0o600, flag: "wx" });
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

const LINK_UNSUPPORTED = new Set(["ENOTSUP", "ENOSYS", "EXDEV", "EPERM"]);

/** The key on disk for this agent, or null. Refuses a file that is not this agent's. */
async function readAgentKey(keyPath, agent) {
  // A reader can only race a writer on filesystems without hard links (see
  // publishKeyFile), where the file may be seen part-written. Retry briefly.
  for (let attempt = 0; ; attempt += 1) {
    let stored;
    try {
      stored = await readJsonFile(keyPath);
    } catch (error) {
      if (error instanceof SyntaxError && attempt < 5) {
        await sleepMs(20);
        continue;
      }
      throw error;
    }
    if (stored === null) return null;
    if (stored.agentId !== agent || !stored.privateKeyPkcs8 || !stored.publicKey) {
      throw new Error(`The key file at ${keyPath} does not belong to agent "${agent}"; refusing to use it.`);
    }
    const privateKey = createPrivateKey({
      key: Buffer.from(stored.privateKeyPkcs8, "base64url"),
      format: "der",
      type: "pkcs8",
    });
    if (createPublicKey(privateKey).export({ format: "jwk" }).x !== stored.publicKey) {
      throw new Error(`The key file at ${keyPath} is inconsistent (public key does not match); refusing to use it.`);
    }
    return { publicKey: stored.publicKey, privateKey, keyPath, created: false };
  }
}

/**
 * Publish a new key file exactly once. link() is atomic and fails with EEXIST when
 * the name is taken, so of any number of concurrent first uses -- threads or
 * processes -- one wins and nobody overwrites anybody. The file is complete
 * before it has its final name.
 */
export async function publishKeyFile(keyPath, record) {
  await fsp.mkdir(path.dirname(keyPath), { recursive: true, mode: 0o700 });
  const body = `${JSON.stringify(record, null, 2)}\n`;
  const tmp = `${keyPath}.${randomUUID()}.tmp`;
  await fsp.writeFile(tmp, body, { mode: 0o600, flag: "wx" });
  try {
    await fsp.link(tmp, keyPath);
  } catch (error) {
    if (error?.code === "EEXIST") return;
    if (!LINK_UNSUPPORTED.has(error?.code)) throw error;
    // No hard links here: an exclusive create still guarantees a single winner.
    try {
      await fsp.writeFile(keyPath, body, { mode: 0o600, flag: "wx" });
    } catch (fallbackError) {
      if (fallbackError?.code !== "EEXIST") throw fallbackError;
    }
  } finally {
    await fsp.rm(tmp, { force: true });
  }
}

/**
 * Load this agent's Ed25519 key, creating it on first use. The private half never
 * leaves disk. Every caller, however many race, gets the key that is persisted.
 */
export async function loadOrCreateAgentKey(agentId, { homeDir } = {}) {
  const agent = normalizeString(agentId).toLowerCase();
  const keyPath = agentKeyPath(agent, { homeDir });
  const existing = await readAgentKey(keyPath, agent);
  if (existing) return existing;
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const rawPublic = publicKey.export({ format: "jwk" }).x; // base64url, 32 raw bytes
  await publishKeyFile(keyPath, {
    version: 1,
    agentId: agent,
    algorithm: "Ed25519",
    publicKey: rawPublic,
    privateKeyPkcs8: privateKey.export({ format: "der", type: "pkcs8" }).toString("base64url"),
    createdAt: new Date().toISOString(),
  });
  const persisted = await readAgentKey(keyPath, agent);
  if (!persisted) throw new Error(`Could not create the agent key at ${keyPath}.`);
  return { ...persisted, created: persisted.publicKey === rawPublic };
}

// ---------------------------------------------------------------- state files

// One in-flight request per (session, agent): two agents joining from the same
// workspace never read or overwrite each other's pending request.
function admissionStatePath(targetPath, sessionId, agentId) {
  const paths = resolveSessionPaths(sessionId, { targetPath });
  return path.join(paths.sessionDir, "admissions", `${safeSegment(agentId, "agentId")}.json`);
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

/**
 * Whether this machine stores ANY agent admission credential (usable or not, any
 * session): `<home>/.sentinelayer/agents/<agent>/admissions/<session>.json`. Agent keys
 * alone do not count. An unreadable directory counts as present, never as absence.
 */
export async function hasStoredAdmissionCredentials({ homeDir } = {}) {
  const agentsDir = path.join(sentinelayerHome(homeDir), "agents");
  let agents;
  try {
    agents = await fsp.readdir(agentsDir, { withFileTypes: true });
  } catch (error) {
    if (error && error.code === "ENOENT") return false;
    return true;
  }
  for (const agent of agents) {
    if (!agent.isDirectory()) continue;
    let files;
    try {
      files = await fsp.readdir(path.join(agentsDir, agent.name, "admissions"));
    } catch (error) {
      if (error && error.code === "ENOENT") continue;
      return true;
    }
    if (files.some((name) => name.endsWith(".json"))) return true;
  }
  return false;
}

/**
 * What this machine holds for (session, agent):
 *   { state: "none" }                        -- never admitted here: the legacy path applies
 *   { state: "live", credential }            -- use it, and only it
 *   { state: "refused", reason, credential } -- a TOMBSTONE: expired, malformed, or bound
 *                                               to another session, agent or authority
 * A refused credential is never read as absence. Absence is the only state that lets a
 * command fall back to the human's own token.
 */
export async function readAdmissionCredentialState(sessionId, agentId, { homeDir, now = Date.now() } = {}) {
  const sid = normalizeString(sessionId).toLowerCase();
  const agent = normalizeString(agentId).toLowerCase();
  let filePath;
  try {
    filePath = admissionCredentialPath(sid, agent, { homeDir });
  } catch {
    return { state: "none" }; // not a storable identity, so nothing can be stored for it
  }
  // Only a MISSING file is absence. A present file that is unreadable, or parses to
  // null, an array or a scalar, is a tombstone: it never permits the legacy path.
  let raw;
  try {
    raw = await fsp.readFile(filePath, "utf8");
  } catch (error) {
    if (error && error.code === "ENOENT") return { state: "none" };
    return { state: "refused", reason: "malformed", credential: null };
  }
  let stored;
  try {
    stored = JSON.parse(raw);
  } catch {
    return { state: "refused", reason: "malformed", credential: null };
  }
  const refused = (reason) => ({ state: "refused", reason, credential: stored });
  if (stored === null || typeof stored !== "object" || Array.isArray(stored)) return refused("malformed");
  if (!String(stored.token || "").startsWith("sladm_")) return refused("malformed");
  if (!Number.isFinite(stored.expiresAt)) return refused("malformed");
  if (normalizeString(stored.sessionId).toLowerCase() !== sid || stored.agentId !== agent) {
    return refused("bound_to_another_session_or_agent");
  }
  if (!/^https?:\/\/[^\s/]+/i.test(normalizeString(stored.apiUrl))) return refused("no_issuing_authority");
  if (stored.expiresAt * 1000 <= now) return refused("expired");
  return { state: "live", credential: stored };
}

/** The canonical digest of what an agent asked for. Any change means a new decision. */
function requestFingerprint({ apiUrl, agentId, publicKey, goal, actions, ttlSeconds }) {
  const body = canonicalize({
    apiUrl,
    agentId,
    publicKey,
    goal,
    actions: [...actions].sort(),
    ttlSeconds,
  });
  return createHash("sha256").update(body, "utf8").digest("hex");
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
  // Every entry path, not only the flags the dispatcher sees: admission is never
  // requested for a spelling that later commands would resolve to another identity.
  // Imported lazily: admission-auth imports this module.
  const { assertCanonicalAgentId } = await import("./admission-auth.js");
  assertCanonicalAgentId(agent, "the admission agent id");
  const goalSummary = normalizeString(goal);
  if (!goalSummary) throw new Error("--goal is required: say what this agent is coming to do.");

  const deps = { requestMutation, origin };
  const auth = await authContext({ targetPath, resolveAuthSession });
  const key = await loadOrCreateAgentKey(agent, { homeDir });
  const goalContract = {
    summary: goalSummary,
    deliverables: deliverables.map(normalizeString).filter(Boolean),
    stopConditions: stopConditions.map(normalizeString).filter(Boolean),
  };
  const fingerprint = requestFingerprint({
    apiUrl: auth.apiUrl,
    agentId: agent,
    publicKey: key.publicKey,
    goal: goalContract,
    actions,
    ttlSeconds,
  });

  // Reuse locally ONLY for the identical request against the same API with the
  // same key. A different goal, scope or duration is a question for the server,
  // which answers with the existing grant (same purpose) or a conflict (new one).
  const held = await readAdmissionCredentialState(sid, agent, { homeDir, now: now() });
  if (held.state === "live" && held.credential.requestFingerprint === fingerprint) {
    return redacted({ status: "active", reused: true, stored: held.credential, sid, agent, homeDir });
  }

  const statePath = admissionStatePath(targetPath, sid, agent);
  let state = await readJsonFile(statePath);
  const inFlight = state?.admissionId && state.agentId === agent && ["pending", "approved"].includes(state.status);
  if (inFlight && state.requestFingerprint !== fingerprint) {
    throw new Error(
      `A different admission request (${state.admissionId}) for "${agent}" is already waiting in this room. ` +
        `Cancel it with \`sl session join ${sid} --agent ${agent} --cancel-admission\`, then request again.`
    );
  }
  const resumable = inFlight && state.publicKey === key.publicKey;

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
        goal: goalContract,
        requestedScope: { actions: [...actions], ttlSeconds },
      },
      { ...deps, operationName: "session.admission_request" }
    );
    if (
      created?.status === "active" &&
      created?.reused &&
      held.state === "live" &&
      held.credential.admissionId === created.admissionId
    ) {
      // The server judged this request covered by the grant we already hold.
      return redacted({ status: "active", reused: true, stored: held.credential, sid, agent, homeDir });
    }
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
      apiUrl: auth.apiUrl,
      requestFingerprint: fingerprint,
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
    const claimReady =
      polled.status === "approved" &&
      polled.identityReady === true &&
      polled?.claim?.domain === CLAIM_DOMAIN &&
      polled?.claim?.preimage;
    if (polled.status === "approved" && polled.identityReady === true && !claimReady) {
      throw new Error("Identity-ready admission did not include a valid claim challenge.");
    }
    if (polled.status === "approved" && polled.identityReady !== true && polled?.claim) {
      throw new Error("Admission exposed a claim challenge before AIdenID identity evidence was ready.");
    }
    if (claimReady || TERMINAL.has(polled.status) || polled.status === "active") break;
    const phase = polled.status === "approved" ? "identity" : "approval";
    onPending({
      admissionId: state.admissionId,
      approveUrl: polled.approveUrl || state.approveUrl,
      phase,
      identityReady: polled.identityReady === true,
      identity: polled.identity || null,
    });
    if (now() >= deadline) {
      await fsp.writeFile(statePath, `${JSON.stringify(state, null, 2)}\n`);
      return {
        status: polled.status === "approved" ? "approved" : "pending",
        phase,
        identityReady: polled.identityReady === true,
        identity: polled.identity || null,
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
    version: 2,
    sessionId: sid,
    agentId: agent,
    // The credential is only ever sent to the API that issued it.
    apiUrl: auth.apiUrl,
    publicKey: key.publicKey,
    requestFingerprint: fingerprint,
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

/**
 * The grant's own live receipt (GET /admissions/self). Call it INSIDE the agent's
 * admission scope: it then goes out on the admission credential, never the human
 * token, and a narrow grant (no session.read) can still prove it is live. Throws
 * when the API does not accept the admission (revoked, expired, wrong room).
 */
export async function fetchOwnAdmissionReceipt(
  sessionId,
  { targetPath = process.cwd(), resolveAuthSession = resolveActiveAuthSession, requestRead = requestJson } = {}
) {
  const sid = normalizeString(sessionId);
  const auth = await resolveAuthSession({ cwd: targetPath, env: process.env, autoRotate: false });
  if (!auth?.token || auth.source !== "session_admission") {
    throw new Error("The admission receipt must be fetched with the admission credential.");
  }
  const apiUrl = normalizeString(auth.apiUrl).replace(/\/+$/, "");
  return requestRead(admissionUrl(apiUrl, sid, "/self"), {
    method: "GET",
    headers: { Authorization: `Bearer ${auth.token}` },
  });
}

/** Cancel this agent's pending admission request filed from this workspace. */
export async function cancelAdmission(
  sessionId,
  {
    agentId,
    targetPath = process.cwd(),
    origin = SESSION_MUTATION_ORIGIN,
    resolveAuthSession = resolveActiveAuthSession,
    requestMutation = requestJsonMutation,
  } = {}
) {
  const sid = normalizeString(sessionId);
  const agent = normalizeString(agentId).toLowerCase();
  if (!agent) throw new Error("--agent is required to cancel its admission request.");
  const statePath = admissionStatePath(targetPath, sid, agent);
  const state = await readJsonFile(statePath);
  if (!state?.admissionId) throw new Error(`No pending admission request for "${agent}" in this workspace.`);
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
