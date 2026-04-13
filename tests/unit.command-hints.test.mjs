import test from "node:test";
import assert from "node:assert/strict";

import { authLoginHint, preferredCliCommand } from "../src/ui/command-hints.js";

test("Unit command hints: defaults to sentinelayer-cli on win32", () => {
  const command = preferredCliCommand({ platform: "win32", env: {} });
  assert.equal(command, "sentinelayer-cli");
  assert.equal(authLoginHint({ platform: "win32", env: {} }), "sentinelayer-cli auth login");
});

test("Unit command hints: defaults to sl on non-win32", () => {
  const command = preferredCliCommand({ platform: "linux", env: {} });
  assert.equal(command, "sl");
  assert.equal(authLoginHint({ platform: "linux", env: {} }), "sl auth login");
});

test("Unit command hints: honors explicit SENTINELAYER_CLI_COMMAND override", () => {
  const command = preferredCliCommand({ platform: "win32", env: { SENTINELAYER_CLI_COMMAND: "slc" } });
  assert.equal(command, "slc");
  assert.equal(
    authLoginHint({ platform: "linux", env: { SENTINELAYER_CLI_COMMAND: "my-sl" } }),
    "my-sl auth login"
  );
});
