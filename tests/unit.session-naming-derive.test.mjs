import test from "node:test";
import assert from "node:assert/strict";

import { deriveSessionTitle } from "../src/session/senti-naming.js";

const FIXED = new Date("2026-04-28T03:14:15Z");

test("Unit deriveSessionTitle: basename + UTC date for a unix path", () => {
  assert.equal(
    deriveSessionTitle("/Users/carter/projects/create-sentinelayer", { now: FIXED }),
    "create-sentinelayer-2026-04-28",
  );
});

test("Unit deriveSessionTitle: handles Windows-style backslashes", () => {
  assert.equal(
    deriveSessionTitle("C:\\Users\\carter\\Desktop\\SentinelLayer\\create-sentinelayer-pr176", {
      now: FIXED,
    }),
    "create-sentinelayer-pr176-2026-04-28",
  );
});

test("Unit deriveSessionTitle: sanitizes unsafe characters and lowercases", () => {
  assert.equal(
    deriveSessionTitle("/some/path/My Project!", { now: FIXED }),
    "my-project-2026-04-28",
  );
});

test("Unit deriveSessionTitle: trailing slash still picks the last segment", () => {
  assert.equal(
    deriveSessionTitle("/repo/foo-bar/", { now: FIXED }),
    "foo-bar-2026-04-28",
  );
});

test("Unit deriveSessionTitle: empty / unknown path uses session-<date> fallback", () => {
  assert.equal(deriveSessionTitle("", { now: FIXED }), "session-2026-04-28");
  assert.equal(deriveSessionTitle(null, { now: FIXED }), "session-2026-04-28");
  assert.equal(deriveSessionTitle("/", { now: FIXED }), "session-2026-04-28");
});

test("Unit deriveSessionTitle: caps long basenames at 60 chars before the date", () => {
  const long = `/x/${"a".repeat(120)}`;
  const out = deriveSessionTitle(long, { now: FIXED });
  // 60 chars of slug + "-" + 10 chars of YYYY-MM-DD = 71
  assert.equal(out.length, 71);
  assert.equal(out.endsWith("-2026-04-28"), true);
});

test("Unit deriveSessionTitle: invalid `now` falls back to current date string", () => {
  const out = deriveSessionTitle("/x/repo", { now: new Date("not-a-date") });
  // Should still produce a YYYY-MM-DD suffix from a real Date.
  assert.match(out, /^repo-\d{4}-\d{2}-\d{2}$/);
});
