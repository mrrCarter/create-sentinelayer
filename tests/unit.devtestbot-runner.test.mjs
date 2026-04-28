import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";

import {
  findPlaywrightFfmpegExecutable,
  launch,
  redactText,
  resolvePlaywrightChromiumExecutable,
} from "../src/agents/devtestbot/runner.js";

test("devTestBot runner redacts explicit identity values", () => {
  const sensitiveValue = ["fixture", "devtestbot", "credential"].join("-");
  const result = redactText(`token=${sensitiveValue}`, [sensitiveValue]);
  assert.equal(result.includes(sensitiveValue), false);
  assert.match(result, /\[REDACTED\]/);
});

test("devTestBot runner locates Playwright ffmpeg in Linux CI cache layout", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "senti-devtestbot-ffmpeg-"));
  const ffmpegPath = path.join(root, "ffmpeg-1011", "ffmpeg-linux");
  try {
    await fs.mkdir(path.dirname(ffmpegPath), { recursive: true });
    await fs.writeFile(ffmpegPath, "");
    assert.equal(findPlaywrightFfmpegExecutable({ PLAYWRIGHT_BROWSERS_PATH: root }, "linux"), ffmpegPath);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("devTestBot runner records browser capture lanes against a local fixture", { timeout: 180000 }, async () => {
  assert.ok(resolvePlaywrightChromiumExecutable(), "Playwright Chromium must be installed");
  assert.ok(findPlaywrightFfmpegExecutable(), "Playwright ffmpeg must be installed for MP4 artifacts");

  const outputDir = await fs.mkdtemp(path.join(os.tmpdir(), "senti-devtestbot-"));
  const server = await startFixtureServer();
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const password = ["fixture", "pw", "value"].join("-");
  const token = ["fixture", "token", "value"].join("-");

  try {
    const runner = await launch({
      baseUrl,
      outputDir,
      identityCreds: {
        username: "devtestbot@aidenid.test",
        password,
        token,
      },
      lighthouseTimeoutMs: 120000,
    });

    const response = await runner.goto("/");
    assert.equal(response.ok(), true);
    await runner.page.click("#primary-action");
    await runner.page.waitForFunction(() => window.__fixtureNetworkDone === true);
    await runner.page.waitForTimeout(500);

    const result = await runner.finalize();
    assert.equal(path.extname(result.artifacts.videoMp4Path), ".mp4");
    await assertNonEmptyFile(result.artifacts.videoMp4Path);
    await assertNonEmptyFile(result.artifacts.a11yPath);
    await assertNonEmptyFile(result.artifacts.lighthousePath);

    const consolePayload = await readJson(result.artifacts.consolePath);
    assert.ok(consolePayload.events.some((event) => event.type === "log"));
    assert.ok(consolePayload.events.some((event) => event.type === "error"));

    const networkPayload = await readJson(result.artifacts.networkPath);
    assert.ok(networkPayload.events.some((event) => event.phase === "request" && event.url.includes("/api/ping")));
    assert.ok(networkPayload.events.some((event) => event.phase === "response" && event.status === 200));
    assert.equal(JSON.stringify(networkPayload).includes("browser-token-value"), false);

    const clickPayload = await readJson(result.artifacts.clickCoveragePath);
    assert.ok(clickPayload.clicks.some((click) => click.id === "primary-action"));

    const a11yPayload = await readJson(result.artifacts.a11yPath);
    assert.equal(a11yPayload.available, true);
    assert.ok(a11yPayload.violations.length > 0);

    const lighthousePayload = await readJson(result.artifacts.lighthousePath);
    assert.notEqual(lighthousePayload.available, false, lighthousePayload.reason || "Lighthouse should run");
    assert.ok(lighthousePayload.categories?.performance);

    const manifest = await readJson(result.artifacts.manifestPath);
    const serializedManifest = JSON.stringify(manifest);
    assert.equal(serializedManifest.includes(password), false);
    assert.equal(serializedManifest.includes(token), false);
  } finally {
    await closeServer(server);
    await fs.rm(outputDir, { recursive: true, force: true });
  }
});

async function startFixtureServer() {
  const server = http.createServer((request, response) => {
    const url = new URL(request.url, "http://127.0.0.1");
    if (url.pathname === "/api/ping") {
      response.writeHead(200, {
        "content-type": "application/json",
        "cache-control": "no-store",
      });
      response.end(JSON.stringify({ ok: true }));
      return;
    }
    if (url.pathname === "/api/click") {
      response.writeHead(204, { "cache-control": "no-store" });
      response.end();
      return;
    }
    if (url.pathname === "/pixel.png") {
      response.writeHead(200, {
        "content-type": "image/png",
        "cache-control": "max-age=60",
      });
      response.end(Buffer.from(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
        "base64",
      ));
      return;
    }
    response.writeHead(200, {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
    });
    response.end(`<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <title>devTestBot fixture</title>
    <script>
      console.log("devtestbot console lane ready");
      console.error("devtestbot console lane error");
      window.__fixtureNetworkDone = false;
      fetch("/api/ping?token=browser-token-value")
        .then((response) => response.json())
        .then(() => { window.__fixtureNetworkDone = true; });
      window.recordPrimaryClick = () => {
        console.log("primary action clicked");
        fetch("/api/click", { method: "POST", body: "clicked" });
      };
    </script>
  </head>
  <body>
    <main>
      <h1>devTestBot fixture</h1>
      <img src="/pixel.png">
      <button id="primary-action" onclick="window.recordPrimaryClick()">Run check</button>
      <button id="empty-button"></button>
    </main>
  </body>
</html>`);
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  return server;
}

async function closeServer(server) {
  await new Promise((resolve) => server.close(resolve));
}

async function readJson(filePath) {
  return JSON.parse(await fs.readFile(filePath, "utf-8"));
}

async function assertNonEmptyFile(filePath) {
  const stat = await fs.stat(filePath);
  assert.ok(stat.size > 0, `${filePath} should be non-empty`);
}
