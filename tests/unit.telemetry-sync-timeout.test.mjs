import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

test("Unit telemetry sync: outbound upload uses explicit timeout wrapper", () => {
  const source = fs.readFileSync(new URL("../src/telemetry/sync.js", import.meta.url), "utf-8");
  assert.ok(source.includes("async function fetchWithTimeout(url, options, timeoutMs)"));
  assert.ok(source.includes("fetchWithTimeout(apiUrl + \"/api/v1/telemetry\", {"));
  assert.ok(source.includes("SYNC_TIMEOUT_MS"));
});
