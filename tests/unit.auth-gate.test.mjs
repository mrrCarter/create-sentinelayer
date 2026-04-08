import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp, rm } from "node:fs/promises";

import { checkAuthGate } from "../src/auth/gate.js";

test("Unit auth gate: CI=true alone does not bypass auth", async () => {
  const tempHome = await mkdtemp(path.join(os.tmpdir(), "create-sentinelayer-auth-gate-"));
  const previousHome = process.env.HOME;
  const previousUserProfile = process.env.USERPROFILE;
  const previousCi = process.env.CI;
  const previousSkipAuth = process.env.SENTINELAYER_CLI_SKIP_AUTH;
  try {
    process.env.HOME = tempHome;
    process.env.USERPROFILE = tempHome;
    process.env.CI = "true";
    delete process.env.SENTINELAYER_CLI_SKIP_AUTH;

    const result = await checkAuthGate(["audit"]);
    assert.equal(result.authenticated, false);
    assert.equal(result.bypassReason, null);
  } finally {
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    if (previousUserProfile === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = previousUserProfile;
    if (previousCi === undefined) delete process.env.CI;
    else process.env.CI = previousCi;
    if (previousSkipAuth === undefined) delete process.env.SENTINELAYER_CLI_SKIP_AUTH;
    else process.env.SENTINELAYER_CLI_SKIP_AUTH = previousSkipAuth;
    await rm(tempHome, { recursive: true, force: true });
  }
});

test("Unit auth gate: explicit SENTINELAYER_CLI_SKIP_AUTH bypass remains supported", async () => {
  const tempHome = await mkdtemp(path.join(os.tmpdir(), "create-sentinelayer-auth-gate-"));
  const previousHome = process.env.HOME;
  const previousUserProfile = process.env.USERPROFILE;
  const previousCi = process.env.CI;
  const previousSkipAuth = process.env.SENTINELAYER_CLI_SKIP_AUTH;
  try {
    process.env.HOME = tempHome;
    process.env.USERPROFILE = tempHome;
    process.env.CI = "true";
    process.env.SENTINELAYER_CLI_SKIP_AUTH = "1";

    const result = await checkAuthGate(["audit"]);
    assert.equal(result.authenticated, true);
    assert.equal(result.bypassReason, "env_bypass");
  } finally {
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    if (previousUserProfile === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = previousUserProfile;
    if (previousCi === undefined) delete process.env.CI;
    else process.env.CI = previousCi;
    if (previousSkipAuth === undefined) delete process.env.SENTINELAYER_CLI_SKIP_AUTH;
    else process.env.SENTINELAYER_CLI_SKIP_AUTH = previousSkipAuth;
    await rm(tempHome, { recursive: true, force: true });
  }
});
