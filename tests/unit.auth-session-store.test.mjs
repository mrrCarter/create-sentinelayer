import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";

import {
  clearStoredSession,
  readStoredSession,
  readStoredSessionMetadata,
  resetSessionWarningsForTests,
  resolveCredentialsFilePath,
  setKeytarClientForTests,
  writeStoredSession,
} from "../src/auth/session-store.js";

test("Unit auth session store: file storage round-trip is deterministic when keyring is disabled", async () => {
  const previousDisableKeyring = process.env.SENTINELAYER_DISABLE_KEYRING;
  process.env.SENTINELAYER_DISABLE_KEYRING = "1";

  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "create-sentinelayer-session-store-"));
  try {
    const persisted = await writeStoredSession(
      {
        apiUrl: "https://api.sentinelayer.dev",
        token: "api_token_example_1",
        tokenId: "token_1",
        tokenPrefix: "api_token_",
        tokenExpiresAt: "2027-01-01T00:00:00.000Z",
        user: {
          id: "user_1",
          githubUsername: "demo-user",
          email: "demo@example.com",
          isAdmin: true,
        },
      },
      { homeDir: tempRoot }
    );

    assert.equal(persisted.storage, "file");
    assert.equal(persisted.token, "api_token_example_1");
    assert.equal(persisted.user.githubUsername, "demo-user");
    assert.equal(persisted.user.isAdmin, true);

    const stored = await readStoredSession({ homeDir: tempRoot });
    assert.equal(stored?.token, "api_token_example_1");
    assert.equal(stored?.tokenId, "token_1");
    assert.equal(stored?.storage, "file");

    const metadata = await readStoredSessionMetadata({ homeDir: tempRoot });
    assert.equal(metadata?.token, null);
    assert.equal(metadata?.tokenId, "token_1");
    assert.equal(metadata?.user.email, "demo@example.com");

    const clearResult = await clearStoredSession({ homeDir: tempRoot });
    assert.equal(clearResult.hadSession, true);

    const postClear = await readStoredSession({ homeDir: tempRoot });
    assert.equal(postClear, null);
  } finally {
    if (previousDisableKeyring === undefined) {
      delete process.env.SENTINELAYER_DISABLE_KEYRING;
    } else {
      process.env.SENTINELAYER_DISABLE_KEYRING = previousDisableKeyring;
    }
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("Unit auth session store: keyring metadata without keytar returns null and clears locally", async () => {
  const previousDisableKeyring = process.env.SENTINELAYER_DISABLE_KEYRING;
  process.env.SENTINELAYER_DISABLE_KEYRING = "1";
  resetSessionWarningsForTests();

  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "create-sentinelayer-session-store-"));
  const warnings = [];
  const previousStderrWrite = process.stderr.write;
  process.stderr.write = (chunk, ...args) => {
    warnings.push(String(chunk || ""));
    const callback = args.find((arg) => typeof arg === "function");
    if (callback) callback();
    return true;
  };
  try {
    const credentialsPath = resolveCredentialsFilePath({ homeDir: tempRoot });
    await mkdir(path.dirname(credentialsPath), { recursive: true });
    await writeFile(
      credentialsPath,
      `${JSON.stringify(
        {
          version: 1,
          apiUrl: "https://api.sentinelayer.dev",
          storage: "keyring",
          keyringService: "sentinelayer-cli",
          keyringAccount: "default-simulated",
          user: {
            id: "user_1",
            github_username: "demo-user",
            email: "demo@example.com",
            is_admin: false,
          },
          createdAt: "2026-04-02T00:00:00.000Z",
          updatedAt: "2026-04-02T00:00:00.000Z",
        },
        null,
        2
      )}\n`,
      "utf-8"
    );

    const stored = await readStoredSession({ homeDir: tempRoot });
    assert.equal(stored, null);

    const metadata = await readStoredSessionMetadata({ homeDir: tempRoot });
    assert.equal(metadata?.storage, "keyring");
    assert.equal(metadata?.user.githubUsername, "demo-user");
    assert.equal(metadata?.token, null);

    const clearResult = await clearStoredSession({ homeDir: tempRoot });
    assert.equal(clearResult.hadSession, true);
    assert.equal(
      warnings.filter((entry) => entry.includes('"code":"KEYRING_FALLBACK_UNAVAILABLE"')).length,
      1,
    );
  } finally {
    process.stderr.write = previousStderrWrite;
    if (previousDisableKeyring === undefined) {
      delete process.env.SENTINELAYER_DISABLE_KEYRING;
    } else {
      process.env.SENTINELAYER_DISABLE_KEYRING = previousDisableKeyring;
    }
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("Unit auth session store: warning payload writes to stderr once and omits token-like values", async () => {
  const previousDisableKeyring = process.env.SENTINELAYER_DISABLE_KEYRING;
  process.env.SENTINELAYER_DISABLE_KEYRING = "1";
  resetSessionWarningsForTests();

  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "create-sentinelayer-session-store-"));
  const warnings = [];
  const previousStderrWrite = process.stderr.write;
  process.stderr.write = (chunk, ...args) => {
    warnings.push(String(chunk || ""));
    const callback = args.find((arg) => typeof arg === "function");
    if (callback) callback();
    return true;
  };
  try {
    const credentialsPath = resolveCredentialsFilePath({ homeDir: tempRoot });
    await mkdir(path.dirname(credentialsPath), { recursive: true });
    await writeFile(
      credentialsPath,
      `${JSON.stringify(
        {
          version: 1,
          apiUrl: "https://api.sentinelayer.dev",
          storage: "keyring",
          keyringService: "sentinelayer-cli",
          keyringAccount: "default-simulated",
          user: {
            id: "user_1",
            github_username: "demo-user",
            email: "demo@example.com",
            is_admin: false,
          },
          createdAt: "2026-04-02T00:00:00.000Z",
          updatedAt: "2026-04-02T00:00:00.000Z",
        },
        null,
        2
      )}\n`,
      "utf-8"
    );

    assert.equal(await readStoredSession({ homeDir: tempRoot }), null);
    assert.equal(await readStoredSession({ homeDir: tempRoot }), null);

    const warningLine = warnings.find((entry) => entry.startsWith("sentinelayer.auth.session "));
    assert.equal(Boolean(warningLine), true);
    assert.equal(
      warnings.filter((entry) => entry.startsWith("sentinelayer.auth.session ")).length,
      1,
    );
    const payload = JSON.parse(warningLine.replace("sentinelayer.auth.session ", ""));
    assert.equal(typeof payload.code, "string");
    assert.equal(typeof payload.reason, "string");
    assert.equal(typeof payload.source, "string");
    const serialized = JSON.stringify(payload).toLowerCase();
    assert.equal(serialized.includes("api_token"), false);
    assert.equal(serialized.includes("authorization"), false);
    assert.equal(serialized.includes("password"), false);
  } finally {
    process.stderr.write = previousStderrWrite;
    if (previousDisableKeyring === undefined) {
      delete process.env.SENTINELAYER_DISABLE_KEYRING;
    } else {
      process.env.SENTINELAYER_DISABLE_KEYRING = previousDisableKeyring;
    }
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("Unit auth session store: keyring writes retain encrypted file fallback for updates", async () => {
  const previousDisableKeyring = process.env.SENTINELAYER_DISABLE_KEYRING;
  const previousKeyringMode = process.env.SENTINELAYER_KEYRING_MODE;
  delete process.env.SENTINELAYER_DISABLE_KEYRING;
  process.env.SENTINELAYER_KEYRING_MODE = "keyring";
  resetSessionWarningsForTests();

  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "create-sentinelayer-session-store-keyring-"));
  const fallbackToken = ["api", "token", "keyring", "with", "fallback"].join("_");
  const keyringPasswords = new Map();
  const restoreKeytar = setKeytarClientForTests({
    getPassword: async (service, account) => keyringPasswords.get(`${service}:${account}`) || null,
    setPassword: async (service, account, token) => {
      keyringPasswords.set(`${service}:${account}`, token);
    },
    deletePassword: async (service, account) => {
      keyringPasswords.delete(`${service}:${account}`);
    },
  });
  try {
    const persisted = await writeStoredSession(
      {
        apiUrl: "https://api.sentinelayer.dev",
        token: fallbackToken,
        tokenId: "token_keyring",
        tokenPrefix: "api_token_",
        tokenExpiresAt: "2027-01-01T00:00:00.000Z",
        user: { id: "user_1", githubUsername: "demo-user" },
      },
      { homeDir: tempRoot },
    );
    assert.equal(persisted.storage, "keyring");

    const credentialsPath = resolveCredentialsFilePath({ homeDir: tempRoot });
    const rawMetadata = JSON.parse(await readFile(credentialsPath, "utf-8"));
    assert.equal(rawMetadata.storage, "keyring");
    assert.equal(rawMetadata.token, null);
    assert.equal(typeof rawMetadata.tokenEncrypted, "string");
    assert.equal(typeof rawMetadata.tokenIv, "string");
    assert.equal(typeof rawMetadata.tokenTag, "string");
  } finally {
    restoreKeytar();
  }

  const warnings = [];
  const previousStderrWrite = process.stderr.write;
  const restoreUnavailableKeytar = setKeytarClientForTests(null);
  process.stderr.write = (chunk, ...args) => {
    warnings.push(String(chunk || ""));
    const callback = args.find((arg) => typeof arg === "function");
    if (callback) callback();
    return true;
  };
  try {
    const stored = await readStoredSession({ homeDir: tempRoot });
    assert.equal(stored?.token, fallbackToken);
    assert.equal(stored?.storage, "file");

    const storedAgain = await readStoredSession({ homeDir: tempRoot });
    assert.equal(storedAgain?.token, fallbackToken);
    assert.equal(
      warnings.filter((entry) => entry.includes('"code":"KEYRING_FALLBACK_USED"')).length,
      1,
    );
  } finally {
    process.stderr.write = previousStderrWrite;
    restoreUnavailableKeytar();
    if (previousDisableKeyring === undefined) {
      delete process.env.SENTINELAYER_DISABLE_KEYRING;
    } else {
      process.env.SENTINELAYER_DISABLE_KEYRING = previousDisableKeyring;
    }
    if (previousKeyringMode === undefined) {
      delete process.env.SENTINELAYER_KEYRING_MODE;
    } else {
      process.env.SENTINELAYER_KEYRING_MODE = previousKeyringMode;
    }
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("Unit auth session store: invalid metadata payload fails closed", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "create-sentinelayer-session-store-"));
  try {
    const credentialsPath = resolveCredentialsFilePath({ homeDir: tempRoot });
    await mkdir(path.dirname(credentialsPath), { recursive: true });
    await writeFile(credentialsPath, "[1,2,3]\n", "utf-8");

    const stored = await readStoredSession({ homeDir: tempRoot });
    assert.equal(stored, null);

    const metadata = await readStoredSessionMetadata({ homeDir: tempRoot });
    assert.equal(metadata, null);

    const raw = await readFile(credentialsPath, "utf-8");
    assert.match(raw, /^\[1,2,3\]/);
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});
