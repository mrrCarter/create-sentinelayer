// Fail-closed network egress guard for test processes.
//
// Why: on 2026-09-29 raw unit-test runs on a logged-in developer machine synced
// tens of thousands of junk sessions to the production API, and a later audit
// found read paths (fetchSessionFromApi, listSessionsFromApi, pollSessionEvents,
// ...) that ignore SENTINELAYER_SKIP_REMOTE_SYNC entirely. An env flag that each
// call site must remember to check is not a safety boundary.
//
// SCOPE (stated exactly): this wraps `globalThis.fetch` only. It does not cover
// node:http/https/net, a separately imported undici, or child tools (git, curl).
// At the time of writing, src/ makes its network calls through globalThis.fetch
// (and injected fetchImpl defaults to it).
//
// Policy, inside a test process:
// - a native request may go ONLY to numeric loopback: 127.0.0.1 or [::1].
//   Hostnames (localhost, *.test, *.invalid, *.localhost) are refused natively:
//   a name is not proof of loopback routing, and tests that use fixture names
//   replace globalThis.fetch with a mock anyway.
// - redirects in the default "follow" mode are walked manually, and EVERY hop is
//   checked against the same policy. A 307/308 that would re-send a body is
//   refused (use redirect: "manual" in such a test). Explicit "manual" and
//   "error" modes pass through unchanged (fetch does not auto-follow them).
// - data: and blob: never leave the process and are allowed.
//
// Activation: NODE_TEST_CONTEXT (set by `node --test` for test files) or
// SENTINELAYER_TEST_EGRESS_GUARD=1 (set by tests/setup-env.mjs and inherited by
// spawned children). Production processes set neither, so there it is a no-op.
// A test that installs its own `globalThis.fetch` mock replaces the wrapper, and
// restoring the saved original puts the guard back.

const GUARD_MARKER = Symbol.for("sentinelayer.testEgressGuard");
const NUMERIC_LOOPBACK_HOSTS = new Set(["127.0.0.1", "[::1]"]);
const MAX_REDIRECTS = 20;

export class TestEgressBlockedError extends Error {
  constructor(target, detail = "") {
    super(
      `test egress blocked: ${target}${detail ? ` (${detail})` : ""} ` +
        "(tests may only reach 127.0.0.1 or [::1] natively; mock fetch for anything else)",
    );
    this.name = "TestEgressBlockedError";
    this.code = "TEST_EGRESS_BLOCKED";
  }
}

export function isTestEgressGuardRequested(env = process.env) {
  return Boolean(String(env.NODE_TEST_CONTEXT || "").trim()) ||
    String(env.SENTINELAYER_TEST_EGRESS_GUARD || "").trim() === "1";
}

function requestUrl(input) {
  if (input && typeof input === "object" && "url" in input) return String(input.url);
  return String(input);
}

export function isAllowedTestDestination(input) {
  let url;
  try {
    url = new URL(requestUrl(input));
  } catch {
    return false; // unparseable: refuse rather than guess
  }
  if (url.protocol === "data:" || url.protocol === "blob:") return true; // never leaves the process
  if (url.protocol !== "http:" && url.protocol !== "https:") return false;
  // WHATWG URL canonicalizes IPv4 forms (127.1, 0x7f.0.0.1) to dotted decimal.
  return NUMERIC_LOOPBACK_HOSTS.has(url.hostname.toLowerCase());
}

const blockedForTests = [];

export function getBlockedTestEgress() {
  return blockedForTests.slice();
}

function originOf(target) {
  try {
    return new URL(requestUrl(target)).origin;
  } catch {
    return "<unparseable>";
  }
}

function block(target, detail) {
  const origin = originOf(target);
  blockedForTests.push(origin);
  return new TestEgressBlockedError(origin, detail);
}

function redirectModeOf(input, init) {
  if (init && init.redirect) return String(init.redirect);
  if (input && typeof input === "object" && typeof input.redirect === "string") return input.redirect;
  return "follow";
}

function methodOf(input, init) {
  if (init && init.method) return String(init.method).toUpperCase();
  if (input && typeof input === "object" && typeof input.method === "string") return input.method.toUpperCase();
  return "GET";
}

function hasBody(input, init) {
  if (init && init.body !== undefined && init.body !== null) return true;
  return Boolean(input && typeof input === "object" && "body" in input && input.body);
}

export function installTestEgressGuard({ env = process.env, force = false } = {}) {
  if (!force && !isTestEgressGuardRequested(env)) return false;
  const nativeFetch = globalThis.fetch;
  if (typeof nativeFetch !== "function") return false;
  if (nativeFetch[GUARD_MARKER]) return true; // idempotent

  async function followChecked(thisArg, input, init, hops) {
    const response = await nativeFetch.call(thisArg, input, { ...(init || {}), redirect: "manual" });
    const location = response.headers.get("location");
    if (response.status < 300 || response.status > 399 || !location) return response;
    const base = response.url || requestUrl(input);
    let next;
    try {
      next = new URL(location, base).href;
    } catch {
      throw block(location, "unparseable redirect location");
    }
    if (!isAllowedTestDestination(next)) throw block(next, `redirect hop ${hops + 1}`);
    if (hops + 1 > MAX_REDIRECTS) throw new TypeError("test fetch: too many redirects");
    const method = methodOf(input, init);
    const headers = (init && init.headers) || (input && typeof input === "object" ? input.headers : undefined);
    const toGet = response.status === 303 ? method !== "HEAD"
      : (response.status === 301 || response.status === 302) && method === "POST";
    if (toGet) {
      return followChecked(thisArg, next, { ...(init || {}), method: "GET", body: undefined, headers }, hops + 1);
    }
    if (hasBody(input, init) && method !== "GET" && method !== "HEAD") {
      throw block(next, `redirect ${response.status} would re-send a request body; use redirect: "manual"`);
    }
    return followChecked(thisArg, next, { ...(init || {}), method, headers }, hops + 1);
  }

  const guarded = function guardedTestFetch(input, init) {
    if (!isAllowedTestDestination(input)) return Promise.reject(block(input));
    if (redirectModeOf(input, init) !== "follow") return nativeFetch.call(this, input, init);
    return followChecked(this, input, init, 0);
  };
  Object.defineProperty(guarded, GUARD_MARKER, { value: true });
  globalThis.fetch = guarded;
  return true;
}

export function isTestEgressGuardInstalled() {
  return Boolean(typeof globalThis.fetch === "function" && globalThis.fetch[GUARD_MARKER]);
}
