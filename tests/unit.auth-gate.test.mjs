import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { mkdtemp, rm, unlink, writeFile } from "node:fs/promises";

import { checkAuthGate } from "../src/auth/gate.js";
import { writeStoredSession } from "../src/auth/session-store.js";

const TEST_BYPASS_NONCE_FILENAME_PREFIX = "sentinelayer-cli-test-bypass";

async function createTrustedBypassFixture({ nonce, secret }) {
  const ts = Date.now();
  const pid = process.pid;
  const noncePath = path.join(os.tmpdir(), `${TEST_BYPASS_NONCE_FILENAME_PREFIX}-${nonce}.nonce`);
  const token = crypto.createHmac("sha256", secret).update(`${nonce}|${pid}|${ts}`).digest("hex");
  await writeFile(noncePath, `${JSON.stringify({ nonce, pid, ts })}\n`, "utf-8");
  return { noncePath, token };
}

test("Unit auth gate: CI=true alone does not bypass auth", async () => {
  const tempHome = await mkdtemp(path.join(os.tmpdir(), "create-sentinelayer-auth-gate-"));
  const previousHome = process.env.HOME;
  const previousUserProfile = process.env.USERPROFILE;
  const previousCi = process.env.CI;
  const previousSkipAuth = process.env.SENTINELAYER_CLI_SKIP_AUTH;
  const previousTestMode = process.env.SENTINELAYER_CLI_TEST_MODE;
  const previousBypassNonce = process.env.SENTINELAYER_CLI_TEST_BYPASS_NONCE;
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
    if (previousTestMode === undefined) delete process.env.SENTINELAYER_CLI_TEST_MODE;
    else process.env.SENTINELAYER_CLI_TEST_MODE = previousTestMode;
    if (previousBypassNonce === undefined) delete process.env.SENTINELAYER_CLI_TEST_BYPASS_NONCE;
    else process.env.SENTINELAYER_CLI_TEST_BYPASS_NONCE = previousBypassNonce;
    await rm(tempHome, { recursive: true, force: true });
  }
});

test("Unit auth gate: accepts env token without stored session", async () => {
  const tempHome = await mkdtemp(path.join(os.tmpdir(), "create-sentinelayer-auth-gate-"));
  const previousHome = process.env.HOME;
  const previousUserProfile = process.env.USERPROFILE;
  const previousToken = process.env.SENTINELAYER_TOKEN;
  try {
    process.env.HOME = tempHome;
    process.env.USERPROFILE = tempHome;
    process.env.SENTINELAYER_TOKEN = "env_token_live";

    const result = await checkAuthGate(["audit"]);
    assert.equal(result.authenticated, true);
    assert.equal(result.bypassReason, null);
    assert.equal(result.session?.source, "env");
    assert.equal(result.session?.token, "env_token_live");
  } finally {
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    if (previousUserProfile === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = previousUserProfile;
    if (previousToken === undefined) delete process.env.SENTINELAYER_TOKEN;
    else process.env.SENTINELAYER_TOKEN = previousToken;
    await rm(tempHome, { recursive: true, force: true });
  }
});

test("Unit auth gate: explicit SENTINELAYER_CLI_SKIP_AUTH bypass remains supported", async () => {
  const tempHome = await mkdtemp(path.join(os.tmpdir(), "create-sentinelayer-auth-gate-"));
  const nonce = "unit-test-nonce";
  const secret = "unit-test-secret";
  const fixture = await createTrustedBypassFixture({ nonce, secret });
  const previousHome = process.env.HOME;
  const previousUserProfile = process.env.USERPROFILE;
  const previousCi = process.env.CI;
  const previousNodeEnv = process.env.NODE_ENV;
  const previousSkipAuth = process.env.SENTINELAYER_CLI_SKIP_AUTH;
  const previousTestMode = process.env.SENTINELAYER_CLI_TEST_MODE;
  const previousBypassNonce = process.env.SENTINELAYER_CLI_TEST_BYPASS_NONCE;
  const previousBypassSecret = process.env.SENTINELAYER_CLI_TEST_BYPASS_SECRET;
  const previousBypassToken = process.env.SENTINELAYER_CLI_TEST_BYPASS_TOKEN;
  const previousArgv1 = process.argv[1];
  try {
    process.argv[1] = path.join(process.cwd(), "bin", "create-sentinelayer.js");
    process.env.HOME = tempHome;
    process.env.USERPROFILE = tempHome;
    delete process.env.CI;
    process.env.NODE_ENV = "test";
    process.env.SENTINELAYER_CLI_TEST_MODE = "1";
    process.env.SENTINELAYER_CLI_TEST_BYPASS_NONCE = nonce;
    process.env.SENTINELAYER_CLI_TEST_BYPASS_SECRET = secret;
    process.env.SENTINELAYER_CLI_TEST_BYPASS_TOKEN = `sha256:${fixture.token}`;
    process.env.SENTINELAYER_CLI_SKIP_AUTH = "1";

    const result = await checkAuthGate(["audit"]);
    assert.equal(result.authenticated, true);
    assert.equal(result.bypassReason, "env_bypass_guarded");
  } finally {
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    if (previousUserProfile === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = previousUserProfile;
    if (previousCi === undefined) delete process.env.CI;
    else process.env.CI = previousCi;
    if (previousNodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = previousNodeEnv;
    if (previousSkipAuth === undefined) delete process.env.SENTINELAYER_CLI_SKIP_AUTH;
    else process.env.SENTINELAYER_CLI_SKIP_AUTH = previousSkipAuth;
    if (previousTestMode === undefined) delete process.env.SENTINELAYER_CLI_TEST_MODE;
    else process.env.SENTINELAYER_CLI_TEST_MODE = previousTestMode;
    if (previousBypassNonce === undefined) delete process.env.SENTINELAYER_CLI_TEST_BYPASS_NONCE;
    else process.env.SENTINELAYER_CLI_TEST_BYPASS_NONCE = previousBypassNonce;
    if (previousBypassSecret === undefined) delete process.env.SENTINELAYER_CLI_TEST_BYPASS_SECRET;
    else process.env.SENTINELAYER_CLI_TEST_BYPASS_SECRET = previousBypassSecret;
    if (previousBypassToken === undefined) delete process.env.SENTINELAYER_CLI_TEST_BYPASS_TOKEN;
    else process.env.SENTINELAYER_CLI_TEST_BYPASS_TOKEN = previousBypassToken;
    await unlink(fixture.noncePath).catch(() => {});
    await rm(tempHome, { recursive: true, force: true });
  }
});

test("Unit auth gate: CI mode blocks signed test bypass context", async () => {
  const tempHome = await mkdtemp(path.join(os.tmpdir(), "create-sentinelayer-auth-gate-"));
  const nonce = "unit-test-ci-block";
  const secret = "unit-test-secret";
  const fixture = await createTrustedBypassFixture({ nonce, secret });
  const previousHome = process.env.HOME;
  const previousUserProfile = process.env.USERPROFILE;
  const previousCi = process.env.CI;
  const previousNodeEnv = process.env.NODE_ENV;
  const previousSkipAuth = process.env.SENTINELAYER_CLI_SKIP_AUTH;
  const previousTestMode = process.env.SENTINELAYER_CLI_TEST_MODE;
  const previousBypassNonce = process.env.SENTINELAYER_CLI_TEST_BYPASS_NONCE;
  const previousBypassSecret = process.env.SENTINELAYER_CLI_TEST_BYPASS_SECRET;
  const previousBypassToken = process.env.SENTINELAYER_CLI_TEST_BYPASS_TOKEN;
  try {
    process.env.HOME = tempHome;
    process.env.USERPROFILE = tempHome;
    process.env.CI = "true";
    process.env.NODE_ENV = "test";
    process.env.SENTINELAYER_CLI_TEST_MODE = "1";
    process.env.SENTINELAYER_CLI_TEST_BYPASS_NONCE = nonce;
    process.env.SENTINELAYER_CLI_TEST_BYPASS_SECRET = secret;
    process.env.SENTINELAYER_CLI_TEST_BYPASS_TOKEN = fixture.token;
    process.env.SENTINELAYER_CLI_SKIP_AUTH = "1";

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
    if (previousNodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = previousNodeEnv;
    if (previousSkipAuth === undefined) delete process.env.SENTINELAYER_CLI_SKIP_AUTH;
    else process.env.SENTINELAYER_CLI_SKIP_AUTH = previousSkipAuth;
    if (previousTestMode === undefined) delete process.env.SENTINELAYER_CLI_TEST_MODE;
    else process.env.SENTINELAYER_CLI_TEST_MODE = previousTestMode;
    if (previousBypassNonce === undefined) delete process.env.SENTINELAYER_CLI_TEST_BYPASS_NONCE;
    else process.env.SENTINELAYER_CLI_TEST_BYPASS_NONCE = previousBypassNonce;
    if (previousBypassSecret === undefined) delete process.env.SENTINELAYER_CLI_TEST_BYPASS_SECRET;
    else process.env.SENTINELAYER_CLI_TEST_BYPASS_SECRET = previousBypassSecret;
    if (previousBypassToken === undefined) delete process.env.SENTINELAYER_CLI_TEST_BYPASS_TOKEN;
    else process.env.SENTINELAYER_CLI_TEST_BYPASS_TOKEN = previousBypassToken;
    await unlink(fixture.noncePath).catch(() => {});
    await rm(tempHome, { recursive: true, force: true });
  }
});

test("Unit auth gate: SENTINELAYER_CLI_SKIP_AUTH alone is ignored outside trusted bypass contexts", async () => {
  const tempHome = await mkdtemp(path.join(os.tmpdir(), "create-sentinelayer-auth-gate-"));
  const previousHome = process.env.HOME;
  const previousUserProfile = process.env.USERPROFILE;
  const previousCi = process.env.CI;
  const previousNodeEnv = process.env.NODE_ENV;
  const previousSkipAuth = process.env.SENTINELAYER_CLI_SKIP_AUTH;
  const previousTestMode = process.env.SENTINELAYER_CLI_TEST_MODE;
  const previousBypassNonce = process.env.SENTINELAYER_CLI_TEST_BYPASS_NONCE;
  const previousUnsafeBypass = process.env.SENTINELAYER_CLI_ALLOW_UNSAFE_AUTH_BYPASS;
  try {
    process.env.HOME = tempHome;
    process.env.USERPROFILE = tempHome;
    process.env.CI = "true";
    process.env.NODE_ENV = "production";
    process.env.SENTINELAYER_CLI_TEST_MODE = "1";
    process.env.SENTINELAYER_CLI_TEST_BYPASS_NONCE = "unit-test-nonce";
    process.env.SENTINELAYER_CLI_SKIP_AUTH = "1";
    delete process.env.SENTINELAYER_CLI_ALLOW_UNSAFE_AUTH_BYPASS;

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
    if (previousNodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = previousNodeEnv;
    if (previousSkipAuth === undefined) delete process.env.SENTINELAYER_CLI_SKIP_AUTH;
    else process.env.SENTINELAYER_CLI_SKIP_AUTH = previousSkipAuth;
    if (previousTestMode === undefined) delete process.env.SENTINELAYER_CLI_TEST_MODE;
    else process.env.SENTINELAYER_CLI_TEST_MODE = previousTestMode;
    if (previousBypassNonce === undefined) delete process.env.SENTINELAYER_CLI_TEST_BYPASS_NONCE;
    else process.env.SENTINELAYER_CLI_TEST_BYPASS_NONCE = previousBypassNonce;
    if (previousUnsafeBypass === undefined) delete process.env.SENTINELAYER_CLI_ALLOW_UNSAFE_AUTH_BYPASS;
    else process.env.SENTINELAYER_CLI_ALLOW_UNSAFE_AUTH_BYPASS = previousUnsafeBypass;
    await rm(tempHome, { recursive: true, force: true });
  }
});

test("Unit auth gate: unsafe override flag does not bypass outside test contexts", async () => {
  const tempHome = await mkdtemp(path.join(os.tmpdir(), "create-sentinelayer-auth-gate-"));
  const previousHome = process.env.HOME;
  const previousUserProfile = process.env.USERPROFILE;
  const previousCi = process.env.CI;
  const previousNodeEnv = process.env.NODE_ENV;
  const previousSkipAuth = process.env.SENTINELAYER_CLI_SKIP_AUTH;
  const previousTestMode = process.env.SENTINELAYER_CLI_TEST_MODE;
  const previousBypassNonce = process.env.SENTINELAYER_CLI_TEST_BYPASS_NONCE;
  const previousUnsafeBypass = process.env.SENTINELAYER_CLI_ALLOW_UNSAFE_AUTH_BYPASS;
  try {
    process.env.HOME = tempHome;
    process.env.USERPROFILE = tempHome;
    process.env.CI = "true";
    process.env.NODE_ENV = "production";
    process.env.SENTINELAYER_CLI_TEST_MODE = "1";
    process.env.SENTINELAYER_CLI_TEST_BYPASS_NONCE = "unit-test-nonce";
    process.env.SENTINELAYER_CLI_SKIP_AUTH = "1";
    process.env.SENTINELAYER_CLI_ALLOW_UNSAFE_AUTH_BYPASS = "1";

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
    if (previousNodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = previousNodeEnv;
    if (previousSkipAuth === undefined) delete process.env.SENTINELAYER_CLI_SKIP_AUTH;
    else process.env.SENTINELAYER_CLI_SKIP_AUTH = previousSkipAuth;
    if (previousTestMode === undefined) delete process.env.SENTINELAYER_CLI_TEST_MODE;
    else process.env.SENTINELAYER_CLI_TEST_MODE = previousTestMode;
    if (previousBypassNonce === undefined) delete process.env.SENTINELAYER_CLI_TEST_BYPASS_NONCE;
    else process.env.SENTINELAYER_CLI_TEST_BYPASS_NONCE = previousBypassNonce;
    if (previousUnsafeBypass === undefined) delete process.env.SENTINELAYER_CLI_ALLOW_UNSAFE_AUTH_BYPASS;
    else process.env.SENTINELAYER_CLI_ALLOW_UNSAFE_AUTH_BYPASS = previousUnsafeBypass;
    await rm(tempHome, { recursive: true, force: true });
  }
});

test("Unit auth gate: rejects stored session when token prefix does not match token", async () => {
  const tempHome = await mkdtemp(path.join(os.tmpdir(), "create-sentinelayer-auth-gate-"));
  const previousHome = process.env.HOME;
  const previousUserProfile = process.env.USERPROFILE;
  const previousDisableKeyring = process.env.SENTINELAYER_DISABLE_KEYRING;
  try {
    process.env.HOME = tempHome;
    process.env.USERPROFILE = tempHome;
    process.env.SENTINELAYER_DISABLE_KEYRING = "1";

    await writeStoredSession({
      apiUrl: "https://api.sentinelayer.com",
      token: "token_without_expected_prefix",
      tokenPrefix: "api_token_",
      tokenExpiresAt: new Date(Date.now() + 60_000).toISOString(),
      user: { id: "user_1", github_username: "demo-user" },
    }, { homeDir: tempHome });

    const result = await checkAuthGate(["audit"]);
    assert.equal(result.authenticated, false);
    assert.equal(result.bypassReason, null);
  } finally {
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    if (previousUserProfile === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = previousUserProfile;
    if (previousDisableKeyring === undefined) delete process.env.SENTINELAYER_DISABLE_KEYRING;
    else process.env.SENTINELAYER_DISABLE_KEYRING = previousDisableKeyring;
    await rm(tempHome, { recursive: true, force: true });
  }
});

test("Unit auth gate: rejects stored session when token expiry timestamp is invalid", async () => {
  const tempHome = await mkdtemp(path.join(os.tmpdir(), "create-sentinelayer-auth-gate-"));
  const previousHome = process.env.HOME;
  const previousUserProfile = process.env.USERPROFILE;
  const previousDisableKeyring = process.env.SENTINELAYER_DISABLE_KEYRING;
  try {
    process.env.HOME = tempHome;
    process.env.USERPROFILE = tempHome;
    process.env.SENTINELAYER_DISABLE_KEYRING = "1";

    await writeStoredSession({
      apiUrl: "https://api.sentinelayer.com",
      token: "api_token_validish",
      tokenPrefix: "api_token_",
      tokenExpiresAt: "not-a-date",
      user: { id: "user_1", github_username: "demo-user" },
    }, { homeDir: tempHome });

    const result = await checkAuthGate(["audit"]);
    assert.equal(result.authenticated, false);
    assert.equal(result.bypassReason, null);
  } finally {
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    if (previousUserProfile === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = previousUserProfile;
    if (previousDisableKeyring === undefined) delete process.env.SENTINELAYER_DISABLE_KEYRING;
    else process.env.SENTINELAYER_DISABLE_KEYRING = previousDisableKeyring;
    await rm(tempHome, { recursive: true, force: true });
  }
});

test("Unit auth gate: rejects stored session when token expiry is missing", async () => {
  const tempHome = await mkdtemp(path.join(os.tmpdir(), "create-sentinelayer-auth-gate-"));
  const previousHome = process.env.HOME;
  const previousUserProfile = process.env.USERPROFILE;
  const previousDisableKeyring = process.env.SENTINELAYER_DISABLE_KEYRING;
  try {
    process.env.HOME = tempHome;
    process.env.USERPROFILE = tempHome;
    process.env.SENTINELAYER_DISABLE_KEYRING = "1";

    await writeStoredSession({
      apiUrl: "https://api.sentinelayer.com",
      token: "api_token_validish",
      tokenPrefix: "api_token_",
      tokenExpiresAt: null,
      user: { id: "user_1", github_username: "demo-user" },
    }, { homeDir: tempHome });

    const result = await checkAuthGate(["audit"]);
    assert.equal(result.authenticated, false);
    assert.equal(result.bypassReason, null);
  } finally {
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    if (previousUserProfile === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = previousUserProfile;
    if (previousDisableKeyring === undefined) delete process.env.SENTINELAYER_DISABLE_KEYRING;
    else process.env.SENTINELAYER_DISABLE_KEYRING = previousDisableKeyring;
    await rm(tempHome, { recursive: true, force: true });
  }
});
