// Test helper: what a credential carries is only observable by sending it. These probes send it
// through credentialedRequest to its own origin, with a transport that answers locally, so
// nothing leaves the process.
import { credentialedRequest } from "../src/auth/credential-destinations.js";

/** The Authorization header the credential produces on a request to its own origin. */
export async function authorizationOf(credential) {
  let header = null;
  await credentialedRequest(credential, `${credential.origin}/probe`, {}, {
    fetchImpl: async (_url, init) => {
      header = init.headers.Authorization;
      return { ok: true, status: 200 };
    },
  });
  return header;
}

/** The token the credential carries, as the server would see it. */
export async function bearerOf(credential) {
  return String((await authorizationOf(credential)) || "").replace(/^Bearer /, "");
}
