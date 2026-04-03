import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import test from "node:test";

import { loadConfig, setConfigValue } from "../src/config/service.js";

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

test("Unit config security: explicit opt-in enables legacy plaintext secret loading", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "create-sentinelayer-config-unit-"));
  try {
    await writeFile(path.join(tempRoot, ".sentinelayer.yml"), "sentinelayerToken: project_token\n", "utf-8");

    const loaded = await loadConfig({
      cwd: tempRoot,
      env: {
        SENTINELAYER_ALLOW_PLAINTEXT_CONFIG_SECRETS: "1",
      },
      homeDir: tempRoot,
    });
    assert.equal(loaded.resolved.sentinelayerToken, "project_token");
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("Unit config security: reject config set secret keys without explicit opt-in", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "create-sentinelayer-config-unit-"));
  try {
    await assert.rejects(
      () =>
        setConfigValue({
          key: "openaiApiKey",
          value: "sk-test",
          scope: "project",
          cwd: tempRoot,
          env: {},
          homeDir: tempRoot,
        }),
      /blocked for plaintext persistence/i
    );
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("Unit config security: allow config set secret keys only under explicit override", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "create-sentinelayer-config-unit-"));
  try {
    await setConfigValue({
      key: "openaiApiKey",
      value: "sk-test",
      scope: "project",
      cwd: tempRoot,
      env: {
        SENTINELAYER_ALLOW_PLAINTEXT_CONFIG_SECRETS: "true",
      },
      homeDir: tempRoot,
    });

    const configText = await readFile(path.join(tempRoot, ".sentinelayer.yml"), "utf-8");
    assert.match(configText, /openaiApiKey:\s*sk-test/);
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});
