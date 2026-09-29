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
// One normalization, validated AND dispatched: every call is converted ONCE with
// native Request semantics (`new Request(input, init)`, the same conversion fetch
// itself performs), then that exact Request's URL is checked and that exact
// Request is what reaches the network. The guard never validates one URL
// representation and dispatches another (e.g. an object whose .url and
// toString() disagree, or a getter that answers differently on a second read).
//
// Policy, inside a test process:
// - natively, only numeric loopback: 127.0.0.1 or [::1]. Host names (localhost,
//   *.test, *.invalid, *.localhost) are refused: a name is not proof of loopback
//   routing, and tests that use fixture names replace globalThis.fetch with a mock.
// - redirects in the default "follow" mode are walked manually and EVERY hop is
//   checked against the same policy. Only 301/302/303/307/308 are followed. A
//   303, or a 301/302 after POST, becomes GET (body headers dropped); a 307/308
//   that would re-send a body is refused (use redirect: "manual" in such a test).
//   On an origin change Authorization/Proxy-Authorization/Cookie are dropped, as
//   native fetch does. Explicit "manual"/"error" modes pass through unchanged.
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
// Only these are redirects (as in native fetch); a 300/304/305/306 with a Location header is returned as-is.
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
// Dropped when a redirect changes origin (as native undici does), so credentials never cross origins.
const CROSS_ORIGIN_STRIPPED_HEADERS = ["authorization", "proxy-authorization", "cookie"];
// Dropped when a redirect turns the request into a body-less GET (fetch spec request-body-header names).
const BODY_HEADERS = ["content-type", "content-length", "content-encoding", "content-language", "content-location"];

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

// Policy on an already-canonical URL string (a Request's .url, or a redirect target resolved with new URL()).
export function isAllowedTestDestination(url) {
  let parsed;
  try {
    parsed = new URL(String(url));
  } catch {
    return false; // unparseable: refuse rather than guess
  }
  if (parsed.protocol === "data:" || parsed.protocol === "blob:") return true; // never leaves the process
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return false;
  // WHATWG URL canonicalizes IPv4 forms (127.1, 0x7f.0.0.1) to dotted decimal.
  return NUMERIC_LOOPBACK_HOSTS.has(parsed.hostname.toLowerCase());
}

const blockedForTests = [];

export function getBlockedTestEgress() {
  return blockedForTests.slice();
}

function originOf(url) {
  try {
    return new URL(String(url)).origin;
  } catch {
    return "<unparseable>";
  }
}

function block(url, detail) {
  const origin = originOf(url);
  blockedForTests.push(origin);
  return new TestEgressBlockedError(origin, detail);
}

export function installTestEgressGuard({ env = process.env, force = false } = {}) {
  if (!force && !isTestEgressGuardRequested(env)) return false;
  const nativeFetch = globalThis.fetch;
  const NativeRequest = globalThis.Request;
  if (typeof nativeFetch !== "function" || typeof NativeRequest !== "function") return false;
  if (nativeFetch[GUARD_MARKER]) return true; // idempotent

  async function followChecked(thisArg, request, hops) {
    const response = await nativeFetch.call(thisArg, new NativeRequest(request, { redirect: "manual" }));
    const location = response.headers.get("location");
    if (!REDIRECT_STATUSES.has(response.status) || location === null) return response;
    let next;
    try {
      next = new URL(location, request.url).href;
    } catch {
      throw block(location, "unparseable redirect location");
    }
    if (!isAllowedTestDestination(next)) throw block(next, `redirect hop ${hops + 1}`);
    if (hops + 1 > MAX_REDIRECTS) throw new TypeError("test fetch: too many redirects");
    const method = request.method.toUpperCase();
    const toGet = response.status === 303 ? method !== "HEAD"
      : (response.status === 301 || response.status === 302) && method === "POST";
    if (!toGet && request.body !== null && method !== "GET" && method !== "HEAD") {
      throw block(next, `redirect ${response.status} would re-send a request body; use redirect: "manual"`);
    }
    const headers = new Headers(request.headers);
    if (new URL(next).origin !== new URL(request.url).origin) {
      for (const name of CROSS_ORIGIN_STRIPPED_HEADERS) headers.delete(name);
    }
    if (toGet) {
      for (const name of BODY_HEADERS) headers.delete(name);
    }
    const nextRequest = new NativeRequest(next, {
      method: toGet ? "GET" : method,
      headers,
      signal: request.signal,
      redirect: "manual",
    });
    return followChecked(thisArg, nextRequest, hops + 1);
  }

  const guarded = function guardedTestFetch(input, init) {
    let request;
    try {
      request = new NativeRequest(input, init); // the ONE conversion; exactly what fetch would do
    } catch (error) {
      return Promise.reject(error); // the same TypeError native fetch would raise
    }
    if (!isAllowedTestDestination(request.url)) return Promise.reject(block(request.url));
    if (request.redirect !== "follow") return nativeFetch.call(this, request);
    return followChecked(this, request, 0);
  };
  Object.defineProperty(guarded, GUARD_MARKER, { value: true });
  globalThis.fetch = guarded;
  return true;
}

export function isTestEgressGuardInstalled() {
  return Boolean(typeof globalThis.fetch === "function" && globalThis.fetch[GUARD_MARKER]);
}
