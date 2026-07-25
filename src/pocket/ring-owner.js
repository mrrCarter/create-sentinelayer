import process from "node:process";

import { requestJsonMutation } from "../auth/http.js";
import { resolveActiveAuthSession } from "../auth/service.js";

// The client half of Senti Pocket "ring the owner": an authed agent/CLI DESCRIBES a decision the owner must make and the
// pocket-gateway (POST /dial/ring-owner) builds the canonical NeedCarterSignal server-side + rings the owner's phone.
// SECURITY: this AUTHORS NOTHING — it only rings. The ring TARGET is the CALLER's own verified identity (the gateway
// derives it from the bearer, NEVER a body field), so a caller can only ring THEIR OWN phone. The answered-call write
// keeps its own governed confirm (dialing relaxes nothing).
export const RING_OWNER_KINDS = Object.freeze(["decisionYours", "pickOption", "go", "info", "checkpointReady"]);

function normalizeString(value) {
  return String(value || "").trim();
}

/**
 * Resolve the pocket-gateway base URL — DISTINCT from the senti apiUrl (do NOT reuse resolveApiUrl; that is the API host).
 * Precedence: env SENTI_POCKET_URL -> env POCKET_GATEWAY_URL -> a config value if the caller passed one. Absent -> "".
 * A present value MUST be an http(s) URL (fail-closed on a bogus scheme). Trailing slashes trimmed.
 */
export function resolvePocketGatewayUrl({ env = process.env, configUrl = "" } = {}) {
  const raw =
    normalizeString(env.SENTI_POCKET_URL) ||
    normalizeString(env.POCKET_GATEWAY_URL) ||
    normalizeString(configUrl);
  if (!raw) return "";
  if (!/^https?:\/\//i.test(raw)) throw new Error("pocket gateway URL must be an http(s) URL");
  return raw.replace(/\/+$/, "");
}

/**
 * Ring the owner about a session decision via the pocket-gateway POST /dial/ring-owner.
 * @param {string} question  the decision/question to put to the owner
 * @param {object} opts  kind/sessionId/options/whatWeNeed/checkpointId/requestedBy/idempotencyKey/gatewayUrl + injectable
 *                       resolveAuthSession + requestMutation (hermetic tests) + env
 * @returns the gateway result ({ dialId, dispatched, reason?, kind?, idempotent? }).
 */
export async function ringOwner(
  question,
  {
    kind = "decisionYours",
    sessionId = "",
    options = [],
    whatWeNeed = "",
    checkpointId = "",
    requestedBy = "",
    idempotencyKey = "",
    gatewayUrl = "",
    configUrl = "",
    env = process.env,
    cwd = process.cwd(),
    resolveAuthSession = resolveActiveAuthSession,
    requestMutation = requestJsonMutation,
  } = {},
) {
  const q = normalizeString(question);
  if (!q) throw new Error("question is required.");
  const sid = normalizeString(sessionId);
  if (!sid) throw new Error("session id is required (--session <id>).");
  const normKind = normalizeString(kind) || "decisionYours";
  if (!RING_OWNER_KINDS.includes(normKind)) {
    throw new Error(`kind must be one of: ${RING_OWNER_KINDS.join(", ")}`);
  }
  if (normKind === "pickOption" && (!Array.isArray(options) || options.length === 0)) {
    throw new Error("pickOption requires at least one --option.");
  }

  const gw = normalizeString(gatewayUrl)
    ? normalizeString(gatewayUrl).replace(/\/+$/, "")
    : resolvePocketGatewayUrl({ env, configUrl });
  if (!gw) {
    throw new Error("pocket gateway URL not configured. Set SENTI_POCKET_URL to the pocket-gateway base URL.");
  }

  const auth = await resolveAuthSession({ cwd, env, autoRotate: false });
  if (!auth?.token) {
    throw new Error("Not authenticated. Run `sl auth login` first.");
  }

  const context = { sessionId: sid };
  if (normalizeString(whatWeNeed)) context.whatWeNeed = normalizeString(whatWeNeed);
  if (normalizeString(checkpointId)) context.checkpointId = normalizeString(checkpointId);
  const body = { question: q, kind: normKind, context };
  if (normKind === "pickOption") body.options = options.map((o) => String(o));
  if (normalizeString(requestedBy)) body.requestedBy = normalizeString(requestedBy);
  if (normalizeString(idempotencyKey)) body.idempotencyKey = normalizeString(idempotencyKey);

  // requestJsonMutation auto-derives a transport Idempotency-Key from operationName (retry-safe at the wire); the
  // gateway's own ring-level dedupe (PR-B4) keys on body.idempotencyKey OR a content hash, so an identical retry rings once.
  return requestMutation(`${gw}/dial/ring-owner`, {
    method: "POST",
    operationName: "pocket.ring_owner",
    headers: { Authorization: `Bearer ${auth.token}` },
    body,
  });
}
