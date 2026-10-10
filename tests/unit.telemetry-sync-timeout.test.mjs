import "./setup-env.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

test("Unit telemetry sync: outbound upload uses explicit timeout wrapper", () => {
  const source = fs.readFileSync(new URL("../src/telemetry/sync.js", import.meta.url), "utf-8");
  assert.ok(source.includes("async function fetchWithTimeout(url, options, timeoutMs)"));
  // the upload is a credentialed request whose transport is the timeout wrapper
  assert.ok(source.includes("credentialedRequest("));
  assert.ok(source.includes("fetchWithTimeout(target, init, SYNC_TIMEOUT_MS)"));
  assert.ok(source.includes("SYNC_TIMEOUT_MS"));
});
