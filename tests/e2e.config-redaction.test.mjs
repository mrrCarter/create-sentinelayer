import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CLI_PATH = path.resolve(__dirname, "..", "bin", "create-sentinelayer.js");

async function runCli({ cwd, env, args = [] }) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CLI_PATH, ...args], {
      cwd,
      env: {
        ...process.env,
        NODE_ENV: "test",
        SENTINELAYER_CLI_TEST_MODE: "1",
        SENTINELAYER_CLI_TEST_BYPASS_NONCE: "e2e-bypass-nonce",
        SENTINELAYER_CLI_SKIP_AUTH: "1",
        SENTINELAYER_TOKEN: "api_token_e2e_test_session",
        ...(env || {}),
      },
      stdio: ["pipe", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (chunk) => {
      stdout += String(chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });

    child.on("error", (error) => reject(error));
    child.on("close", (code) => {
      resolve({ code: Number(code || 0), stdout, stderr });
    });
  });
}

function assertNoSecretOutput(label, output, secrets) {
  for (const secret of secrets) {
    assert.equal(String(output || "").includes(secret), false, `${label} leaked secret ${secret}`);
  }
}

test("CLI config commands redact secrets from text and JSON output", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "create-sentinelayer-config-redact-"));
  const secrets = [
    "sk-ant-test-secret-never-print-1234567890",
    "sly-test-token-never-print-1234567890",
    "bot-token-never-print-1234567890",
    "https://hooks.example.test/services/secret-never-print-1234567890",
    "sk-openai-test-secret-never-print-1234567890",
  ];

  try {
    await writeFile(
      path.join(tempRoot, ".sentinelayer.yml"),
      [
        `anthropicApiKey: ${secrets[0]}`,
        `sentinelayerToken: ${secrets[1]}`,
        "alerts:",
        "  channels:",
        "    - type: slack",
        `      webhook_url: ${secrets[3]}`,
        `      botToken: ${secrets[2]}`,
        "",
      ].join("\n"),
      "utf-8"
    );

    const textGet = await runCli({
      cwd: tempRoot,
      env: { ...process.env },
      args: ["config", "get", "anthropicApiKey", "--scope", "project", "--path", tempRoot],
    });
    assert.equal(textGet.code, 0, textGet.stderr || textGet.stdout);
    assertNoSecretOutput("text get", textGet.stdout + textGet.stderr, secrets);
    assert.match(textGet.stdout, /\[REDACTED\]/);

    const jsonGet = await runCli({
      cwd: tempRoot,
      env: { ...process.env },
      args: ["config", "get", "anthropicApiKey", "--scope", "project", "--path", tempRoot, "--json"],
    });
    assert.equal(jsonGet.code, 0, jsonGet.stderr || jsonGet.stdout);
    assertNoSecretOutput("json get", jsonGet.stdout + jsonGet.stderr, secrets);
    const jsonGetPayload = JSON.parse(String(jsonGet.stdout || "").trim());
    assert.equal(jsonGetPayload.value, "[REDACTED]");

    const textList = await runCli({
      cwd: tempRoot,
      env: { ...process.env },
      args: ["config", "list", "--scope", "project", "--path", tempRoot],
    });
    assert.equal(textList.code, 0, textList.stderr || textList.stdout);
    assertNoSecretOutput("text list", textList.stdout + textList.stderr, secrets);
    assert.match(textList.stdout, /\[REDACTED\]/);

    const jsonList = await runCli({
      cwd: tempRoot,
      env: { ...process.env },
      args: ["config", "list", "--scope", "project", "--path", tempRoot, "--json"],
    });
    assert.equal(jsonList.code, 0, jsonList.stderr || jsonList.stdout);
    assertNoSecretOutput("json list", jsonList.stdout + jsonList.stderr, secrets);
    const jsonListPayload = JSON.parse(String(jsonList.stdout || "").trim());
    assert.equal(jsonListPayload.config.anthropicApiKey, "[REDACTED]");
    assert.equal(jsonListPayload.config.sentinelayerToken, "[REDACTED]");
    assert.equal(jsonListPayload.config.alerts.channels[0].botToken, "[REDACTED]");
    assert.equal(jsonListPayload.config.alerts.channels[0].webhook_url, "[REDACTED]");

    const jsonSet = await runCli({
      cwd: tempRoot,
      env: { ...process.env },
      args: [
        "config",
        "set",
        "openaiApiKey",
        secrets[4],
        "--scope",
        "project",
        "--path",
        tempRoot,
        "--json",
      ],
    });
    assert.equal(jsonSet.code, 0, jsonSet.stderr || jsonSet.stdout);
    assertNoSecretOutput("json set", jsonSet.stdout + jsonSet.stderr, secrets);
    const jsonSetPayload = JSON.parse(String(jsonSet.stdout || "").trim());
    assert.equal(jsonSetPayload.value, "[REDACTED]");

    const persistedConfigText = await readFile(path.join(tempRoot, ".sentinelayer.yml"), "utf-8");
    assert.match(persistedConfigText, /openaiApiKey:/);
    assert.equal(persistedConfigText.includes(secrets[4]), true);
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});
