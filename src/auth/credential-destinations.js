// credential-destinations.js — the user's credentials, and the one way to send them.
//
// A credential is an opaque object, { origin, source }, and only this module makes one. The
// token it carries is held here, out of reach: it is not a property of the credential or of any
// auth result, so code elsewhere cannot read it, copy it into a header, a URL, a body or a
// cookie, or hand it to a child process. credentialedRequest is the one thing that uses it.
//
// Its origin is fixed when it is minted, from ONE trust context (resolveTrustContext) built from
// the environment and the user's global config:
//
//   - the configured API: SENTINELAYER_API_URL, else `apiUrl` in ~/.sentinelayer/config.yml,
//     else the default API
//   - the pocket gateway: SENTI_POCKET_URL, when set (POCKET_GATEWAY_URL is not read)
//
// The CLI entry resolves that context once, at start, and freezes it (freezeProcessTrustContext),
// so nothing that changes process.env later can move it. Login, auth resolution and the request
// check all use it; tests inject their own env and homeDir. Nothing a command is given (an
// option, an argument, an MCP tool input, a workspace's .sentinelayer.yml) can change where a
// credential goes. An agent's admission credential is bound to the API that issued it
// (src/auth/admission-scope.js) and is never re-bound to the pocket gateway.
//
// credentialedRequest(credential, url, init, { fetchImpl }) is the one way to send a credential.
// It takes the URL as a string, refuses one on any other origin or one whose path is not plain
// segments, sets the Authorization header itself, and never follows a redirect. An injected
// transport (fetchImpl) is what it calls once those checks pass. A bare token from an injected
// auth resolver (tests) is bound to the configured API by credentialFor.
// tests/unit.credential-census.test.mjs fails on any other place in src/ that builds an
// Authorization header, reads a raw token, or writes a trust-source variable into process.env.

import { createHmac } from "node:crypto";
import os from "node:os";
import process from "node:process";

import { readConfigFile } from "../config/io.js";
import { getGlobalConfigPath } from "../config/paths.js";

export const DEFAULT_API_URL = "https://api.sentinelayer.com";

const tokens = new WeakMap(); // credential -> token; the only place a token is kept
const contexts = new WeakSet(); // trust contexts this module built
const USER_SOURCES = new Set(["user", "env", "config", "session"]); // the person's own token
let processContext = null; // frozen at the CLI entry

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

/**
 * A URL on the credential's own origin whose path is not plain segments: a segment that is, or
 * decodes to, "." or "..", that decodes to something containing "/" or "\", or that does not
 * decode. Nothing is sent.
 */
export class CredentialPathRefused extends CredentialDestinationRefused {
  constructor(origin) {
    super(origin);
    this.message =
      "Refusing to send your SentinelLayer credential to a URL whose path is not plain segments: " +
      "each identifier in a URL path must be one segment.";
    this.name = "CredentialPathRefused";
    this.code = "CREDENTIAL_PATH_REFUSED";
  }
}

/** One raw path segment, decoded once: refused when it is "." or "..", holds "/" or "\", or does not decode. */
function isUnsafePathSegment(segment) {
  let decoded;
  try {
    decoded = decodeURIComponent(segment);
  } catch {
    return true;
  }
  return decoded === "." || decoded === ".." || /[/\\]/.test(decoded);
}

/**
 * Whether the raw URL string has a path segment that is not plain, read the way the URL parser
 * reads an http(s) URL, before it normalizes anything: tabs and newlines dropped, leading and
 * trailing C0 controls and spaces trimmed, the path after the scheme and authority up to "?" or
 * "#", and "\" a separator like "/". Each segment is then decoded once (isUnsafePathSegment).
 */
function hasUnsafePathSegment(target) {
  const text = target.replace(/[\t\n\r]/g, "").replace(/^[\u0000-\u0020]+|[\u0000-\u0020]+$/g, "");
  const afterAuthority = text.replace(/^[a-z][a-z0-9+.-]*:[/\\]*[^/\\?#]*/i, "");
  return afterAuthority.split(/[?#]/, 1)[0].split(/[/\\]/).some(isUnsafePathSegment);
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
  const credential = Object.freeze({ origin, source });
  tokens.set(credential, value);
  return credential;
}

/** Whether a value is a credential this module minted. */
export function isCredential(value) {
  return tokens.has(value);
}

/** Whether an auth result carries a credential (or, from an injected resolver, a bare token). */
export function isAuthenticated(auth) {
  return isCredential(auth?.credential) || Boolean(String(auth?.token ?? "").trim());
}

async function buildTrustContext({ env, homeDir }) {
  let apiUrl = String(env.SENTINELAYER_API_URL || "").trim();
  if (!apiUrl) {
    const globalConfig = await readConfigFile(getGlobalConfigPath({ homeDir })).catch(() => ({}));
    apiUrl = String(globalConfig?.apiUrl || "").trim() || DEFAULT_API_URL;
  }
  const context = Object.freeze({
    apiOrigin: originOf(apiUrl),
    gatewayOrigin: originOf(env.SENTI_POCKET_URL),
  });
  contexts.add(context);
  return context;
}

/**
 * Resolve the process trust context once, from the real environment and global config, and
 * freeze it: from then on, process.env changes do not move it. Called first by the CLI entry.
 */
export async function freezeProcessTrustContext() {
  if (!processContext) {
    const env = { SENTINELAYER_API_URL: process.env.SENTINELAYER_API_URL, SENTI_POCKET_URL: process.env.SENTI_POCKET_URL };
    processContext = await buildTrustContext({ env, homeDir: os.homedir() });
  }
  return processContext;
}

/**
 * THE trust context: where the user's credentials may be sent. Built from the environment and
 * the global config only. For the process environment, once frozen, it is the frozen context.
 */
export async function resolveTrustContext({ env = process.env, homeDir } = {}) {
  if (processContext && env === process.env && homeDir === undefined) return processContext;
  return buildTrustContext({ env, homeDir });
}

async function trustOf({ context, env, homeDir }) {
  if (context === undefined) return resolveTrustContext({ env, homeDir });
  if (!contexts.has(context)) throw new TypeError("A trust context from resolveTrustContext is required.");
  return context;
}

/** A credential for one of the user's tokens, bound to the configured API. */
export async function userCredential(token, { context, env, homeDir, source = "user" } = {}) {
  return mint(token, (await trustOf({ context, env, homeDir })).apiOrigin, source);
}

/**
 * The person's own token bound to the configured pocket gateway; null when none is configured.
 * An agent's admission credential, or any token minted for one purpose, is never re-bound.
 */
export async function gatewayCredential(credential, { context, env, homeDir } = {}) {
  if (!isCredential(credential)) throw new TypeError("gatewayCredential needs a credential.");
  const trust = await trustOf({ context, env, homeDir });
  if (!USER_SOURCES.has(credential.source)) {
    throw new CredentialDestinationRefused(trust.gatewayOrigin || "the pocket gateway", [credential.origin]);
  }
  return mint(tokens.get(credential), trust.gatewayOrigin, "pocket_gateway");
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
  if (!String(auth?.token ?? "").trim()) return null;
  return userCredential(auth.token, { context, env, homeDir, source: auth.source || "user" });
}

/** Refuse an API URL outside the trust context, before any credential is minted for it. */
export async function assertTrustedApiUrl(url, { context, env, homeDir } = {}) {
  const trust = await trustOf({ context, env, homeDir });
  const origin = originOf(url) || String(url);
  if (origin !== trust.apiOrigin) throw new CredentialDestinationRefused(origin, [trust.apiOrigin]);
}

/**
 * Refuse sending `credential` anywhere but its own origin, or to a path that is not plain
 * segments. `target` is the exact URL string sent; a URL object is refused, because its path has
 * already been normalized and the string that was built can no longer be checked.
 */
export function assertCredentialDestination(credential, target) {
  if (!isCredential(credential)) throw new TypeError("A credential from src/auth/credential-destinations.js is required.");
  if (typeof target !== "string") throw new TypeError("A credentialed request takes its URL as a string, not a URL object.");
  const origin = originOf(target);
  if (origin !== credential.origin) throw new CredentialDestinationRefused(origin || target, [credential.origin]);
  if (hasUnsafePathSegment(target)) throw new CredentialPathRefused(origin);
}

/**
 * An injectable request function (requestJson-shaped: (url, options)), checked first: a
 * credential in its options goes nowhere but its own origin, whichever implementation runs.
 */
export function checkedTransport(requestImpl) {
  return async (url, options, ...rest) => {
    if (!options?.credential) return requestImpl(String(url), options, ...rest);
    assertCredentialDestination(options.credential, url); // a string, checked and passed on as is
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
 * it calls once those checks pass. The URL is a string, and that string is both checked and sent.
 */
export async function credentialedRequest(credential, url, init = {}, { fetchImpl = globalThis.fetch } = {}) {
  assertCredentialDestination(credential, url);
  return fetchImpl(url, {
    ...init,
    headers: { ...headersWithout(init.headers, "authorization"), Authorization: `Bearer ${tokens.get(credential)}` },
    redirect: "error",
  });
}

/** An HMAC-SHA256 of `message` keyed by the credential's token (a request proof; never the token). */
export function credentialHmac(credential, message) {
  if (!isCredential(credential)) throw new TypeError("A credential from src/auth/credential-destinations.js is required.");
  return createHmac("sha256", tokens.get(credential)).update(String(message), "utf8").digest("hex");
}

/**
 * The token itself, for the one reviewed export: the operator command `sl scan setup-secrets`,
 * which writes it to a GitHub Actions secret through the gh CLI. Nothing else may call this
 * (tests/unit.credential-census.test.mjs).
 */
export function exportCredentialToken(credential, { purpose } = {}) {
  if (purpose !== "github-actions-secret") throw new TypeError("exportCredentialToken: unknown purpose.");
  if (!isCredential(credential) || !USER_SOURCES.has(credential.source)) {
    throw new TypeError("exportCredentialToken needs the person's own credential.");
  }
  return tokens.get(credential);
}
