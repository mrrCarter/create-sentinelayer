import "./setup-env.mjs";
// The CLI entry (runCli) freezes the trust context before any command runs. Its own test file:
// freezing is process-wide.
import test from "node:test";
import assert from "node:assert/strict";

import { resolveTrustContext } from "../src/auth/credential-destinations.js";
import { runCli } from "../src/cli.js";

test("runCli fixes the trust context at start, so a later change to process.env does not move it", async () => {
  process.env.SENTINELAYER_API_URL = "https://api.entry.example";
  const log = console.log;
  console.log = () => {};
  try {
    await runCli(["--version"]);
  } finally {
    console.log = log;
  }
  process.env.SENTINELAYER_API_URL = "https://api.later.example";
  assert.equal((await resolveTrustContext()).apiOrigin, "https://api.entry.example");
});
