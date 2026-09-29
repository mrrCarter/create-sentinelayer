// Fail-closed network egress guard for test processes.
//
// Why: on 2026-09-29 raw unit-test runs on a logged-in developer machine synced
// tens of thousands of junk sessions to the production API, and a later audit
// found read paths (fetchSessionFromApi, listSessionsFromApi, pollSessionEvents,
// ...) that ignore SENTINELAYER_SKIP_REMOTE_SYNC entirely. An env flag that each
// call site must remember to check is not a safety boundary. This guard sits
// under every call site instead: in a test process, `globalThis.fetch` refuses
// any destination that is not loopback or a reserved test TLD, before a socket
// is opened.
//
// Activation: NODE_TEST_CONTEXT (set by `node --test` for test files) or
// SENTINELAYER_TEST_EGRESS_GUARD=1 (set by tests/setup-env.mjs, and inherited by
// spawned children). Production processes never set either, so this is a no-op
// there.
//
// Tests that install their own `globalThis.fetch` mock replace the wrapper and are
// unaffected; restoring the saved original puts the guard back. Injected
// `fetchImpl` transports are unaffected.

const GUARD_MARKER = Symbol.for("sentinelayer.testEgressGuard");
const ALLOWED_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);
const ALLOWED_SUFFIXES = [".localhost", ".invalid", ".test"];

export class TestEgressBlockedError extends Error {
  constructor(target) {
    super(`test egress blocked: ${target} (tests may only reach loopback or .invalid/.test/.localhost hosts)`);
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
  const host = url.hostname.toLowerCase();
  if (ALLOWED_HOSTS.has(host)) return true;
  return ALLOWED_SUFFIXES.some((suffix) => host.endsWith(suffix));
}

const blockedForTests = [];

export function getBlockedTestEgress() {
  return blockedForTests.slice();
}

export function installTestEgressGuard({ env = process.env, force = false } = {}) {
  if (!force && !isTestEgressGuardRequested(env)) return false;
  const current = globalThis.fetch;
  if (typeof current !== "function") return false;
  if (current[GUARD_MARKER]) return true; // idempotent
  const guarded = function guardedTestFetch(input, init) {
    if (!isAllowedTestDestination(input)) {
      let target = "<unparseable>";
      try {
        target = new URL(requestUrl(input)).origin;
      } catch {
        // keep the placeholder
      }
      blockedForTests.push(target);
      return Promise.reject(new TestEgressBlockedError(target));
    }
    return current.call(this, input, init);
  };
  Object.defineProperty(guarded, GUARD_MARKER, { value: true });
  globalThis.fetch = guarded;
  return true;
}

export function isTestEgressGuardInstalled() {
  return Boolean(typeof globalThis.fetch === "function" && globalThis.fetch[GUARD_MARKER]);
}
