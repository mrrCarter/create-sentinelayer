// credential-destinations.js — the user's credentials, and the one way to send them.
//
// A credential is an object, { token, origin, source }, and only this module makes one. Its
// origin is fixed when it is minted or loaded, from ONE trust context (resolveTrustContext) built
// from the environment and the user's global config:
//
//   - the configured API: SENTINELAYER_API_URL, else `apiUrl` in ~/.sentinelayer/config.yml,
//     else the default API
//   - the pocket gateway: SENTI_POCKET_URL, when set
//
// Login, auth resolution and the request check all use that context, with the same injected
// env and homeDir. Nothing a command is given (an option, an argument, an MCP tool input, a
// workspace's .sentinelayer.yml) can change where a credential goes. An agent's admission
// credential is bound to the API that issued it (src/auth/admission-scope.js).
//
// credentialedRequest(credential, url, init, { fetchImpl }) is the one way to send a credential.
// It refuses a URL on any other origin, sets the Authorization header itself, and never follows
// a redirect. An injected transport (fetchImpl) is what it calls once those checks pass, never a
// way around them. A token that reaches a request site without a credential (an injected auth
// resolver) is bound to the configured API origin by credentialFor, never to an origin the caller
// names. tests/unit.credential-census.test.mjs fails on any other place in src/ that builds an
// Authorization header or otherwise sends a token.

import process from "node:process";

import { readConfigFile } from "../config/io.js";
import { getGlobalConfigPath } from "../config/paths.js";

export const DEFAULT_API_URL = "https://api.sentinelayer.com";

const minted = new WeakSet();

export class CredentialDestinationRefused extends Error {
  constructor(origin, trusted = []) {
    super(
      `Refusing to send your SentinelLayer credential to ${origin}: it is only sent to ` +
        `${trusted.filter(Boolean).join(", ") || "the configured API"}. Custom API origins must be configured: set ` +
        `SENTINELAYER_API_URL or SENTI_POCKET_URL (or \`apiUrl\` in ~/.sentinelayer/config.yml).`,
    );
    this.name = "CredentialDestinationRefused";
    this.code = "CREDENTIAL_DESTINATION_REFUSED";
    this.origin = origin;
  }
}

function originOf(value) {
  try {
    const parsed = new URL(String(value || "").trim());
    return parsed.protocol === "http:" || parsed.protocol === "https:" ? parsed.origin : "";
  } catch {
    return "";
  }
}

function mint(token, origin, source) {
  const value = String(token ?? "").trim();
  if (!value || !origin) return null;
  const credential = Object.freeze({ token: value, origin, source });
  minted.add(credential);
  return credential;
}

/** Whether a value is a credential this module minted. */
export function isCredential(value) {
  return minted.has(value);
}

/**
 * THE trust context: where the user's credentials may be sent. Built from the environment and
 * the global config only, with the env and homeDir the caller resolves everything else with.
 */
export async function resolveTrustContext({ env = process.env, homeDir } = {}) {
  let apiUrl = String(env.SENTINELAYER_API_URL || "").trim();
  if (!apiUrl) {
    const globalConfig = await readConfigFile(getGlobalConfigPath({ homeDir })).catch(() => ({}));
    apiUrl = String(globalConfig?.apiUrl || "").trim() || DEFAULT_API_URL;
  }
  return Object.freeze({
    apiOrigin: originOf(apiUrl),
    gatewayOrigin: originOf(env.SENTI_POCKET_URL),
  });
}

/** A credential for one of the user's tokens, bound to the configured API. */
export async function userCredential(token, { context, env, homeDir, source = "user" } = {}) {
  const trust = context || (await resolveTrustContext({ env, homeDir }));
  return mint(token, trust.apiOrigin, source);
}

/** The same token, bound to the configured pocket gateway instead; null when none is configured. */
export async function gatewayCredential(credential, { context, env, homeDir } = {}) {
  if (!isCredential(credential)) throw new TypeError("gatewayCredential needs a credential.");
  const trust = context || (await resolveTrustContext({ env, homeDir }));
  return mint(credential.token, trust.gatewayOrigin, "pocket_gateway");
}

/** An agent's admission credential, bound to the API that issued it. */
export function admissionCredential({ token, apiUrl } = {}) {
  return mint(token, originOf(apiUrl), "session_admission");
}

/**
 * The credential for an auth result: its own, or, for a bare token from an injected resolver,
 * the token bound to the configured API. Never bound to an origin the caller supplies.
 */
export async function credentialFor(auth, { context, env, homeDir } = {}) {
  if (isCredential(auth?.credential)) return auth.credential;
  if (!auth?.token) return null;
  return userCredential(auth.token, { context, env, homeDir, source: auth.source || "user" });
}

/** Refuse an API URL outside the trust context, before any credential is minted for it. */
export async function assertTrustedApiUrl(url, { context, env, homeDir } = {}) {
  const trust = context || (await resolveTrustContext({ env, homeDir }));
  const origin = originOf(url) || String(url);
  if (origin !== trust.apiOrigin) throw new CredentialDestinationRefused(origin, [trust.apiOrigin]);
}

/** Refuse sending `credential` anywhere but its own origin. */
export function assertCredentialDestination(credential, url) {
  if (!isCredential(credential)) throw new TypeError("A credential from src/auth/credential-destinations.js is required.");
  const origin = originOf(url);
  if (origin !== credential.origin) throw new CredentialDestinationRefused(origin || String(url), [credential.origin]);
}

/**
 * An injectable request function (requestJson-shaped: (url, options)), checked first: a
 * credential in its options goes nowhere but its own origin, whichever implementation runs.
 */
export function checkedTransport(requestImpl) {
  return async (url, options, ...rest) => {
    if (options?.credential) assertCredentialDestination(options.credential, url);
    return requestImpl(url, options, ...rest);
  };
}

function headersWithout(headers, name) {
  const entries = headers instanceof Headers ? [...headers.entries()] : Object.entries(headers || {});
  return Object.fromEntries(entries.filter(([key]) => String(key).toLowerCase() !== name));
}

/**
 * Send a request carrying `credential`: only to the credential's own origin, with the
 * Authorization header set here, and without following redirects. `fetchImpl` is the transport
 * it calls once those checks pass.
 */
export async function credentialedRequest(credential, url, init = {}, { fetchImpl = globalThis.fetch } = {}) {
  assertCredentialDestination(credential, url);
  return fetchImpl(String(url), {
    ...init,
    headers: { ...headersWithout(init.headers, "authorization"), Authorization: `Bearer ${credential.token}` },
    redirect: "error",
  });
}
