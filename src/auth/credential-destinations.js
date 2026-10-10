// credential-destinations.js — where this machine's own SentinelLayer token may be sent.
//
// The user's token (SENTINELAYER_TOKEN / SENTINELAYER_API_TOKEN, the `sentinelayerToken`
// config value, or the session stored by `sl auth login`) is sent only to a fixed set of
// origins, built from the environment and the user's global config alone:
//
//   - the configured API: SENTINELAYER_API_URL, else `apiUrl` in ~/.sentinelayer/config.yml,
//     else the default API
//   - the pocket gateway: SENTI_POCKET_URL or POCKET_GATEWAY_URL, when set
//
// Nothing a command is given (an option, an argument, an MCP tool input, a workspace's
// .sentinelayer.yml) can add to that set. An option that names another origin may still be
// used for requests that carry no token; a request that carries the token to any other origin
// is refused before it is sent.
//
// The check sits on the transport: this module wraps globalThis.fetch, through which every
// request in src/ is made (auth/http.js and the direct fetch call sites alike), so a new call
// site cannot skip it. Admission credentials are bound the same way, to the API that issued
// them (src/auth/admission-scope.js).

import process from "node:process";

import { readConfigFile } from "../config/io.js";
import { getGlobalConfigPath } from "../config/paths.js";

export const DEFAULT_API_URL = "https://api.sentinelayer.com";

const GUARD_MARKER = Symbol.for("sentinelayer.credentialDestinationGuard");
const TOKEN_ENV_VARS = ["SENTINELAYER_TOKEN", "SENTINELAYER_API_TOKEN"];
const GATEWAY_ENV_VARS = ["SENTI_POCKET_URL", "POCKET_GATEWAY_URL"];
const MIN_TOKEN_LENGTH = 16; // shorter strings are not credentials worth matching
const noted = new Set();

export class CredentialDestinationRefused extends Error {
  constructor(origin, trusted = []) {
    super(
      `Refusing to send your SentinelLayer credential to ${origin}: it is only sent to ` +
        `${trusted.join(", ") || "the configured API"}. To use another API or pocket gateway, set ` +
        `SENTINELAYER_API_URL or SENTI_POCKET_URL (or \`apiUrl\` in ~/.sentinelayer/config.yml).`,
    );
    this.name = "CredentialDestinationRefused";
    this.code = "CREDENTIAL_DESTINATION_REFUSED";
    this.origin = origin;
  }
}

/** Record a token read from the user's own credential store, so the transport recognises it. */
export function noteUserCredential(token) {
  const value = String(token || "").trim();
  if (value.length >= MIN_TOKEN_LENGTH) noted.add(value);
}

function userCredentials(env) {
  const tokens = new Set(noted);
  for (const name of TOKEN_ENV_VARS) {
    const value = String(env[name] || "").trim();
    if (value.length >= MIN_TOKEN_LENGTH) tokens.add(value);
  }
  return tokens;
}

function originOf(value) {
  try {
    const parsed = new URL(String(value || "").trim());
    return parsed.protocol === "http:" || parsed.protocol === "https:" ? parsed.origin : "";
  } catch {
    return "";
  }
}

/** The origins the user's token may be sent to: environment and global config only. */
export async function trustedCredentialOrigins({ env = process.env, homeDir } = {}) {
  let configured = String(env.SENTINELAYER_API_URL || "").trim();
  if (!configured) {
    const globalConfig = await readConfigFile(getGlobalConfigPath({ homeDir })).catch(() => ({}));
    configured = String(globalConfig?.apiUrl || "").trim() || DEFAULT_API_URL;
  }
  const origins = [configured, ...GATEWAY_ENV_VARS.map((name) => env[name])].map(originOf).filter(Boolean);
  return [...new Set(origins)];
}

/** Whether a request carries one of the user's tokens: in any header value or in its URL. */
function carriesUserCredential(request, env) {
  const tokens = userCredentials(env);
  if (tokens.size === 0) return false;
  const carried = [request.url];
  request.headers.forEach((value) => carried.push(value));
  return carried.some((text) => [...tokens].some((token) => String(text).includes(token)));
}

/**
 * Refuse a request that carries the user's token to an origin outside the trusted set.
 * Exported for tests and for transports that do not go through globalThis.fetch.
 */
export async function assertCredentialDestination(request, { env = process.env, homeDir } = {}) {
  if (!carriesUserCredential(request, env)) return;
  const origin = new URL(request.url).origin;
  const trusted = await trustedCredentialOrigins({ env, homeDir });
  if (!trusted.includes(origin)) throw new CredentialDestinationRefused(origin, trusted);
}

/** Wrap globalThis.fetch with the destination check. Idempotent. */
export function installCredentialDestinationGuard() {
  const innerFetch = globalThis.fetch;
  const NativeRequest = globalThis.Request;
  if (typeof innerFetch !== "function" || typeof NativeRequest !== "function") return false;
  if (innerFetch[GUARD_MARKER]) return true;
  const guarded = async function credentialDestinationFetch(input, init) {
    // One conversion, checked and dispatched: the Request that is checked is the one sent.
    const request = new NativeRequest(input, init);
    await assertCredentialDestination(request);
    return innerFetch.call(this, request);
  };
  // Keep the markers of what it wraps (such as the test egress guard's), so each guard still
  // sees itself installed and none is stacked twice.
  for (const marker of Object.getOwnPropertySymbols(innerFetch)) {
    Object.defineProperty(guarded, marker, { value: innerFetch[marker] });
  }
  Object.defineProperty(guarded, GUARD_MARKER, { value: true });
  globalThis.fetch = guarded;
  return true;
}

export function isCredentialDestinationGuardInstalled() {
  return Boolean(typeof globalThis.fetch === "function" && globalThis.fetch[GUARD_MARKER]);
}

installCredentialDestinationGuard();
