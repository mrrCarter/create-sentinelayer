import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import test from "node:test";

import { loadConfig, setConfigValue } from "../src/config/service.js";
import { configSchema, getRuntimeSecretSchema, SECRET_CONFIG_KEYS } from "../src/config/schema.js";

test("Unit config security: reject plaintext secrets in project config by default", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "create-sentinelayer-config-unit-"));
  try {
    await writeFile(path.join(tempRoot, ".sentinelayer.yml"), "sentinelayerToken: project_token\n", "utf-8");

    await assert.rejects(
      () =>
        loadConfig({
          cwd: tempRoot,
          env: {},
          homeDir: tempRoot,
        }),
      /plaintext secrets .* blocked/i
    );
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("Unit config security: environment secrets still resolve without file persistence", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "create-sentinelayer-config-unit-"));
  try {
    const loaded = await loadConfig({
      cwd: tempRoot,
      env: {
        SENTINELAYER_TOKEN: "env_token",
        OPENAI_API_KEY: "sk-env",
      },
      homeDir: tempRoot,
    });
    assert.equal(loaded.resolved.sentinelayerToken, "env_token");
    assert.equal(loaded.resolved.openaiApiKey, "sk-env");
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("Unit config security: reject config set secret keys", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "create-sentinelayer-config-unit-"));
  try {
    for (const secretKey of SECRET_CONFIG_KEYS) {
      await assert.rejects(
        () =>
          setConfigValue({
            key: secretKey,
            value: "secret-test-value",
            scope: "project",
            cwd: tempRoot,
            homeDir: tempRoot,
          }),
        /blocked for plaintext persistence/i
      );
    }
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("Unit config security: setConfigValue fails closed when persisted payload contains secret keys", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "create-sentinelayer-config-unit-"));
  try {
    await writeFile(path.join(tempRoot, ".sentinelayer.yml"), "sentinelayerToken: stale_secret\n", "utf-8");
    await assert.rejects(
      () =>
        setConfigValue({
          key: "defaultPolicyPack",
          value: "enterprise-dd",
          scope: "project",
          cwd: tempRoot,
          homeDir: tempRoot,
        }),
      /plaintext secrets .* are blocked/i
    );
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("Unit config security: allow config set for non-secret keys", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "create-sentinelayer-config-unit-"));
  try {
    const result = await setConfigValue({
      key: "defaultPolicyPack",
      value: "enterprise-dd",
      scope: "project",
      cwd: tempRoot,
      homeDir: tempRoot,
    });
    assert.equal(result.key, "defaultPolicyPack");
    assert.equal(result.value, "enterprise-dd");
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("Unit config security: persisted config schema excludes secret keys while runtime secret schema validates env secrets", () => {
  assert.throws(
    () => configSchema.parse({ openaiApiKey: "sk-test" }),
    /unrecognized key/i
  );

  const parsed = getRuntimeSecretSchema().partial().parse({ openaiApiKey: "sk-test" });
  assert.equal(parsed.openaiApiKey, "sk-test");
});
