import "./setup-env.mjs";
// A workspace .sentinelayer.yml does not set the user's API, token, provider keys or alert channels. When it tries,
// the CLI says so once on stderr, and the value is not used: a provider request never carries a
// workspace key.
import test from "node:test";
import assert from "node:assert/strict";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { loadConfig } from "../src/config/service.js";
import { runAiReviewLayer } from "../src/review/ai-review.js";

async function workspace(lines) {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "sl-workspace-values-"));
  await fsp.writeFile(path.join(dir, ".sentinelayer.yml"), `${lines.join("\n")}\n`);
  return dir;
}

async function captureStderr(fn) {
  const lines = [];
  const write = process.stderr.write;
  process.stderr.write = (chunk, ...rest) => {
    lines.push(String(chunk));
    return true;
  };
  try {
    await fn();
  } finally {
    process.stderr.write = write;
  }
  return lines.join("");
}

test("a workspace config that sets the API or the token gets one notice; one that does not stays silent", async () => {
  const setting = await workspace(["apiUrl: https://api.workspace.example", "sentinelayerToken: workspace-token-0000"]);
  const plain = await workspace(["outputDir: .out"]);
  try {
    const first = await captureStderr(() => loadConfig({ cwd: setting }));
    assert.equal(
      first,
      "NOTICE: workspace .sentinelayer.yml apiUrl, sentinelayerToken ignored; set SENTINELAYER_API_URL, SENTINELAYER_TOKEN or the global config (~/.sentinelayer/config.yml).\n",
    );
    assert.equal(first.includes("workspace-token-0000"), false, "the notice never prints the value");
    assert.equal(await captureStderr(() => loadConfig({ cwd: setting })), "", "once per workspace");
    assert.equal(await captureStderr(() => loadConfig({ cwd: plain })), "");
  } finally {
    await fsp.rm(setting, { recursive: true, force: true });
    await fsp.rm(plain, { recursive: true, force: true });
  }
});

test("a workspace config that sets alert channels gets the same notice", async () => {
  const setting = await workspace(["alerts:", "  channels:", "    - type: slack", "      webhook_url: https://hooks.slack.com/services/x"]);
  const eventsOnly = await workspace(["alerts:", "  events:", "    - agent_stuck"]);
  try {
    assert.equal(
      await captureStderr(() => loadConfig({ cwd: setting })),
      "NOTICE: workspace .sentinelayer.yml alerts.channels ignored; set them in the global config (~/.sentinelayer/config.yml).\n",
    );
    assert.equal(await captureStderr(() => loadConfig({ cwd: eventsOnly })), "", "choosing which events alert is the workspace's");
  } finally {
    await fsp.rm(setting, { recursive: true, force: true });
    await fsp.rm(eventsOnly, { recursive: true, force: true });
  }
});

test("a provider request never carries a key from the workspace config", async () => {
  const root = await workspace(["openaiApiKey: workspace-provider-key-0000"]);
  const sent = [];
  const previousFetch = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => {
    sent.push({ url: String(url), authorization: String(new Headers(init.headers || {}).get("authorization") || "") });
    return new Response(JSON.stringify({ choices: [{ message: { content: "{\"findings\":[]}" } }], usage: {} }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  };
  const review = (env) =>
    runAiReviewLayer({
      targetPath: root,
      runDirectory: path.join(root, "runs", "review-ai"),
      runId: "review-ai-keys",
      mode: "diff",
      provider: "openai",
      model: "gpt-5.3-codex",
      maxFindings: 1,
      deterministic: { summary: { P0: 0, P1: 0, P2: 0, P3: 0 }, findings: [], scope: { scannedRelativeFiles: [] } },
      env,
    }).catch((error) => error);
  try {
    await captureStderr(() => review({}));
    assert.equal(sent.some((request) => request.authorization.includes("workspace-provider-key-0000")), false);
    assert.equal(sent.length, 0, "with no key of the user's own, nothing is sent");

    // the user's own key (environment) is used as before
    await captureStderr(() => review({ OPENAI_API_KEY: "user-provider-key-0000" }));
    assert.ok(sent.length >= 1);
    assert.ok(sent.every((request) => request.url.startsWith("https://api.openai.com/")), "the provider's fixed endpoint");
    assert.ok(sent.every((request) => request.authorization === "Bearer user-provider-key-0000"));
  } finally {
    globalThis.fetch = previousFetch;
    await fsp.rm(root, { recursive: true, force: true });
  }
});
