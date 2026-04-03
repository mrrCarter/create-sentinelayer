import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";

import {
  clearStoredSession,
  readStoredSession,
  readStoredSessionMetadata,
  resolveCredentialsFilePath,
  StoredSessionError,
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

    const credentialsPath = resolveCredentialsFilePath({ homeDir: tempRoot });
    const rawCredentials = await readFile(credentialsPath, "utf-8");
    assert.ok(rawCredentials.includes("\"tokenCiphertext\""));
    assert.equal(rawCredentials.includes("api_token_example_1"), false);

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
    assert.equal(clearResult.clearedMetadata, true);

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

test("Unit auth session store: keyring metadata without keytar fails closed with remediation error", async () => {
  const previousDisableKeyring = process.env.SENTINELAYER_DISABLE_KEYRING;
  process.env.SENTINELAYER_DISABLE_KEYRING = "1";

  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "create-sentinelayer-session-store-"));
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

    await assert.rejects(
      () => readStoredSession({ homeDir: tempRoot }),
      (error) => {
        assert.ok(error instanceof StoredSessionError);
        assert.equal(error.code, "KEYRING_UNAVAILABLE");
        return true;
      }
    );

    const metadata = await readStoredSessionMetadata({ homeDir: tempRoot });
    assert.equal(metadata?.storage, "keyring");
    assert.equal(metadata?.user.githubUsername, "demo-user");
    assert.equal(metadata?.token, null);

    const clearResult = await clearStoredSession({ homeDir: tempRoot });
    assert.equal(clearResult.hadSession, true);
    assert.equal(clearResult.clearedMetadata, true);
  } finally {
    if (previousDisableKeyring === undefined) {
      delete process.env.SENTINELAYER_DISABLE_KEYRING;
    } else {
      process.env.SENTINELAYER_DISABLE_KEYRING = previousDisableKeyring;
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
