import test from "node:test";
import assert from "node:assert/strict";

import { buildSessionLockDirective } from "../src/commands/session.js";

test("Unit lock directive: lock without intent", () => {
  assert.equal(buildSessionLockDirective("lock", "src/app.ts"), "lock: src/app.ts");
});

test("Unit lock directive: lock with intent", () => {
  assert.equal(
    buildSessionLockDirective("lock", "src/app.ts", "refactor auth"),
    "lock: src/app.ts - refactor auth",
  );
});

test("Unit lock directive: unlock defaults to 'done'", () => {
  assert.equal(buildSessionLockDirective("unlock", "src/app.ts"), "unlock: src/app.ts - done");
});

test("Unit lock directive: unlock keeps an explicit note", () => {
  assert.equal(
    buildSessionLockDirective("unlock", "src/app.ts", "handoff to codex"),
    "unlock: src/app.ts - handoff to codex",
  );
});

test("Unit lock directive: trims whitespace", () => {
  assert.equal(buildSessionLockDirective("lock", "  src/app.ts  ", "  scope  "), "lock: src/app.ts - scope");
});
