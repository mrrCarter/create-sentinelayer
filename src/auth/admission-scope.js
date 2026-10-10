// admission-scope.js — the admitted-agent scope, as a leaf module.
//
// While a command runs as an admitted agent (see src/session/admission-auth.js),
// this AsyncLocalStorage holds its admission credential. resolveActiveAuthSession
// consults it FIRST, so every credential lookup made anywhere inside the command --
// session transport, remote verification, confirmation reads, helpers of helpers --
// gets the admission credential or nothing. The human's own token is unreachable
// from inside the scope, so no human-authenticated subrequest can hide behind a
// scoped main request.
//
// It imports only the credential module, so the auth service can depend on it without an
// import cycle.

import { AsyncLocalStorage } from "node:async_hooks";

import { admissionCredential } from "./credential-destinations.js";

export const admittedAgentScope = new AsyncLocalStorage();

/**
 * undefined -> not inside an admitted-agent scope (resolve auth normally)
 * null      -> inside one, but the credential has expired: nothing to send
 * object    -> the admission credential, bound to the API that issued it
 */
export function scopedAdmissionAuth() {
  const credential = admittedAgentScope.getStore();
  if (!credential) return undefined;
  if (!(credential.expiresAt * 1000 > Date.now())) return null;
  return {
    apiUrl: credential.apiUrl,
    token: credential.token,
    credential: admissionCredential(credential), // bound to the API that issued it
    source: "session_admission",
    user: null,
    admissionId: credential.admissionId,
  };
}
