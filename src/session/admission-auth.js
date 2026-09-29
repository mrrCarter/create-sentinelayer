// admission-auth.js — which credential a session command runs on.
//
// An admitted agent must act with ITS admission credential: room-scoped, expiring,
// revocable, and limited to what the owner approved. The human's own token is
// broader (every room they belong to, owner rights where they have them), so
// quietly falling back to it would let an agent step around its grant.
//
// A command that knows its (session, agent) wraps its work in withAgentAdmission:
//
//   - nothing stored for that pair  -> the legacy path, unchanged (human token)
//   - a live credential             -> every session API call made inside the
//                                      callback resolves to that credential, sent
//                                      only to the API that issued it
//   - a tombstone (expired, malformed, bound elsewhere) -> refused before any
//                                      request is made; never treated as absence
//
// The scope is an AsyncLocalStorage context (src/auth/admission-scope.js) that
// resolveActiveAuthSession consults first. It therefore covers every helper a
// command calls, however deep, and every credential lookup, not only the session
// transport's.
// A revoked credential looks live here; the API refuses it (401) and the command
// fails. There is no retry with another credential anywhere on this path.

import { admittedAgentScope } from "../auth/admission-scope.js";
import { readAdmissionCredentialState } from "./admission.js";

export class AdmissionCredentialRefused extends Error {
  constructor(message, { reason, sessionId, agentId } = {}) {
    super(message);
    this.name = "AdmissionCredentialRefused";
    this.code = "ADMISSION_CREDENTIAL_REFUSED";
    this.reason = reason;
    this.sessionId = sessionId;
    this.agentId = agentId;
  }
}

const REFUSAL_HINT = {
  expired: "its admission has expired",
  malformed: "its stored admission credential is unreadable",
  bound_to_another_session_or_agent: "its stored admission credential names a different session or agent",
  no_issuing_authority: "its stored admission credential does not record the API that issued it",
};

/** Run `fn` with the right credential for (sessionId, agentId). See the module header. */
export async function withAgentAdmission(sessionId, agentId, fn, { homeDir, now } = {}) {
  const held = await readAdmissionCredentialState(sessionId, agentId, { homeDir, now });
  if (held.state === "none") return fn({ admitted: false });
  if (held.state !== "live") {
    const why = REFUSAL_HINT[held.reason] || `its stored admission is unusable (${held.reason})`;
    throw new AdmissionCredentialRefused(
      `Agent "${agentId}" cannot act in session ${sessionId}: ${why}. ` +
        `It will not fall back to your own credentials. Request a new admission with ` +
        `\`sl session join ${sessionId} --agent ${agentId} --goal "<what it is here to do>"\`.`,
      { reason: held.reason, sessionId, agentId }
    );
  }
  const credential = Object.freeze({ ...held.credential });
  try {
    return await admittedAgentScope.run(credential, () =>
      fn({ admitted: true, admissionId: credential.admissionId, agentId: credential.agentId })
    );
  } catch (error) {
    if (error instanceof Error && /\bapi_401\b|not_authenticated/.test(error.message)) {
      error.message +=
        ` The API no longer accepts agent "${agentId}"'s admission for this room (revoked, expired,` +
        ` or outside its grant). It did not fall back to your own credentials.`;
    }
    throw error;
  }
}

/** The admission this code is running under, without the token, or null. */
export function currentAdmittedAgent() {
  const credential = admittedAgentScope.getStore();
  if (!credential) return null;
  return {
    admissionId: credential.admissionId,
    sessionId: credential.sessionId,
    agentId: credential.agentId,
    expiresAt: credential.expiresAt,
  };
}
