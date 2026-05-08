import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import AxeBuilder from "@axe-core/playwright";
import { chromium } from "playwright";

const execFileAsync = promisify(execFile);

const DEFAULT_VIEWPORT = Object.freeze({ width: 1280, height: 720 });
const DEFAULT_TIMEOUT_MS = 30000;
const DEFAULT_LIGHTHOUSE_TIMEOUT_MS = 90000;
const SENSITIVE_KEY_PATTERN = /(?:authorization|cookie|set-cookie|token|secret|password|passwd|api[-_]?key|session|credential)/i;
const TOKEN_VALUE_PATTERN = /\b(?:bearer|token|password|secret|api[_-]?key|session)\s*[:=]\s*["']?[^"'\s&]+/gi;
const LONG_SECRET_PATTERN = /\b[A-Za-z0-9_-]{24,}\b/g;

export class DevTestBotRunnerError extends Error {
  constructor(message, options = {}) {
    super(message);
    this.name = "DevTestBotRunnerError";
    this.code = options.code || "DEVTESTBOT_RUNNER_ERROR";
    this.cause = options.cause;
  }
}

export async function launch({
  baseUrl,
  identityCreds = null,
  outputDir,
  headless = true,
  viewport = DEFAULT_VIEWPORT,
  recordVideo = true,
  runLighthouse = true,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  lighthouseTimeoutMs = DEFAULT_LIGHTHOUSE_TIMEOUT_MS,
  browserOptions = {},
} = {}) {
  const normalizedBaseUrl = normalizeBaseUrl(baseUrl);
  const runId = "devtestbot-" + new Date().toISOString().replace(/[:.]/g, "-") + "-" + randomUUID().slice(0, 8);
  const artifactRoot = path.resolve(outputDir || path.join(process.cwd(), ".sentinelayer", "runs", runId, "devtestbot"));
  const videoDir = path.join(artifactRoot, "video");
  await fsp.mkdir(videoDir, { recursive: true });

  const browserExecutable = resolvePlaywrightChromiumExecutable();
  const playwrightFfmpeg = findPlaywrightFfmpegExecutable();
  if (recordVideo && !playwrightFfmpeg) {
    throw new DevTestBotRunnerError(
      "devTestBot video recording requires Playwright's ffmpeg payload. Run `npm run devtestbot:install-browsers`.",
      { code: "DEVTESTBOT_FFMPEG_MISSING" },
    );
  }

  const sensitiveValues = collectSensitiveValues(identityCreds);
  const consoleEvents = [];
  const networkEvents = [];
  const videoFrames = [];
  const pendingCaptures = new Set();
  const artifacts = {};
  let finalized = false;

  const browser = await chromium.launch({
    headless,
    executablePath: browserExecutable,
    args: [
      "--disable-gpu",
      "--no-sandbox",
      ...(browserOptions.args || []),
    ],
    ...omit(browserOptions, ["args"]),
  });

  const context = await browser.newContext({
    baseURL: normalizedBaseUrl,
    viewport,
    httpCredentials: normalizeHttpCredentials(identityCreds),
    recordVideo: recordVideo
      ? {
          dir: videoDir,
          size: viewport,
        }
      : undefined,
  });
  context.setDefaultTimeout(timeoutMs);

  await context.addInitScript(() => {
    window.__sentinelayerClickCoverage = [];
    document.addEventListener(
      "click",
      (event) => {
        const target = event.target;
        if (!target || typeof target.closest !== "function") return;
        const element = target.closest("button,a,input,select,textarea,[role],[data-testid],[data-test]");
        if (!element) return;
        const rect = element.getBoundingClientRect();
        window.__sentinelayerClickCoverage.push({
          tagName: element.tagName ? element.tagName.toLowerCase() : "",
          id: element.id || "",
          role: element.getAttribute("role") || "",
          testId: element.getAttribute("data-testid") || element.getAttribute("data-test") || "",
          name: element.getAttribute("aria-label") || element.getAttribute("name") || "",
          text: (element.innerText || element.value || "").slice(0, 120),
          x: Math.round(rect.left + rect.width / 2),
          y: Math.round(rect.top + rect.height / 2),
          timestamp: new Date().toISOString(),
        });
      },
      true,
    );
  });

  const page = await context.newPage();
  page.on("console", (message) => {
    consoleEvents.push({
      type: message.type(),
      text: redactText(message.text(), sensitiveValues),
      location: sanitizeLocation(message.location(), sensitiveValues),
      timestamp: new Date().toISOString(),
    });
  });
  page.on("pageerror", (error) => {
    consoleEvents.push({
      type: "pageerror",
      text: redactText(error?.message || String(error), sensitiveValues),
      timestamp: new Date().toISOString(),
    });
  });
  page.on("request", (request) => {
    networkEvents.push({
      phase: "request",
      method: request.method(),
      resourceType: request.resourceType(),
      url: sanitizeUrl(request.url(), sensitiveValues),
      headers: redactHeaders(request.headers(), sensitiveValues),
      timestamp: new Date().toISOString(),
    });
  });
  page.on("response", (response) => {
    trackCapture(
      (async () => {
        networkEvents.push({
          phase: "response",
          method: response.request().method(),
          resourceType: response.request().resourceType(),
          url: sanitizeUrl(response.url(), sensitiveValues),
          status: response.status(),
          ok: response.ok(),
          headers: redactHeaders(await response.allHeaders().catch(() => ({})), sensitiveValues),
          timestamp: new Date().toISOString(),
        });
      })(),
      pendingCaptures,
    );
  });
  page.on("requestfailed", (request) => {
    networkEvents.push({
      phase: "requestfailed",
      method: request.method(),
      resourceType: request.resourceType(),
      url: sanitizeUrl(request.url(), sensitiveValues),
      failure: redactText(request.failure()?.errorText || "unknown", sensitiveValues),
      timestamp: new Date().toISOString(),
    });
  });

  async function goto(target = "/", options = {}) {
    const response = await page.goto(resolveNavigationUrl(target, normalizedBaseUrl), {
      waitUntil: "networkidle",
      timeout: timeoutMs,
      ...options,
    });
    await captureVideoFrame("after-goto").catch(() => {});
    return response;
  }

  async function captureVideoFrame(label) {
    const png = await page.screenshot({ type: "png", fullPage: false });
    videoFrames.push({
      label,
      pngBase64: png.toString("base64"),
      timestamp: new Date().toISOString(),
    });
  }

  async function writeConsoleCapture() {
    const outputPath = path.join(artifactRoot, "console.json");
    await writeJson(outputPath, {
      generatedAt: new Date().toISOString(),
      count: consoleEvents.length,
      events: consoleEvents,
    });
    artifacts.consolePath = outputPath;
    return outputPath;
  }

  async function writeNetworkCapture() {
    await settlePendingCaptures(pendingCaptures);
    const outputPath = path.join(artifactRoot, "network.json");
    await writeJson(outputPath, {
      generatedAt: new Date().toISOString(),
      count: networkEvents.length,
      events: networkEvents,
    });
    artifacts.networkPath = outputPath;
    return outputPath;
  }

  async function writeClickCoverage() {
    const clicks = await page.evaluate(() => window.__sentinelayerClickCoverage || []).catch(() => []);
    const sanitizedClicks = clicks.map((click) => sanitizeJson(click, sensitiveValues));
    const outputPath = path.join(artifactRoot, "click-coverage.json");
    await writeJson(outputPath, {
      generatedAt: new Date().toISOString(),
      count: sanitizedClicks.length,
      clicks: sanitizedClicks,
    });
    artifacts.clickCoveragePath = outputPath;
    return outputPath;
  }

  async function scanA11y(options = {}) {
    const outputPath = options.outputPath || path.join(artifactRoot, "a11y.json");
    const startedAt = new Date().toISOString();
    try {
      const result = await new AxeBuilder({ page }).analyze();
      const payload = sanitizeJson({
        available: true,
        generatedAt: new Date().toISOString(),
        startedAt,
        url: page.url(),
        violations: result.violations || [],
        passes: result.passes || [],
        incomplete: result.incomplete || [],
        inapplicable: result.inapplicable || [],
      }, sensitiveValues);
      await writeJson(outputPath, payload);
      artifacts.a11yPath = outputPath;
      return payload;
    } catch (error) {
      const payload = {
        available: false,
        generatedAt: new Date().toISOString(),
        startedAt,
        url: sanitizeUrl(page.url(), sensitiveValues),
        reason: redactText(error?.message || String(error), sensitiveValues),
      };
      await writeJson(outputPath, payload);
      artifacts.a11yPath = outputPath;
      return payload;
    }
  }

  async function runLighthouseCapture(options = {}) {
    const targetUrl = options.url || page.url() || normalizedBaseUrl;
    const outputPath = options.outputPath || path.join(artifactRoot, "lighthouse.json");
    const result = await runLighthouseCli({
      url: targetUrl,
      outputPath,
      chromePath: browserExecutable,
      timeoutMs: options.timeoutMs || lighthouseTimeoutMs,
      sensitiveValues,
    });
    artifacts.lighthousePath = outputPath;
    return result;
  }

  async function finalize() {
    if (finalized) {
      return buildFinalResult({ artifacts, artifactRoot, consoleEvents, networkEvents });
    }
    finalized = true;

    await settlePendingCaptures(pendingCaptures);
    await writeConsoleCapture();
    await writeNetworkCapture();
    await writeClickCoverage();
    if (!artifacts.a11yPath) await scanA11y();
    if (runLighthouse && !artifacts.lighthousePath) await runLighthouseCapture();
    let artifactError = null;
    try {
      await captureVideoFrame("final");
      if (videoFrames.length > 0) {
        const mp4Path = path.join(videoDir, "recording.mp4");
        await writeMp4FromPngFrames(page, videoFrames, mp4Path, viewport);
        artifacts.videoMp4Path = mp4Path;
      }
    } catch (error) {
      artifactError = error;
    }

    const video = page.video();
    let webmPath = null;
    let closeError = null;
    try {
      await context.close();
    } catch (error) {
      closeError = error;
    }
    if (video) {
      webmPath = await video.path().catch(() => null);
    }
    await browser.close();
    if (closeError) {
      throw new DevTestBotRunnerError("devTestBot failed to finalize browser context.", {
        code: "DEVTESTBOT_CONTEXT_CLOSE_FAILED",
        cause: closeError,
      });
    }

    if (webmPath && fs.existsSync(webmPath)) {
      artifacts.videoWebmPath = webmPath;
    }
    if (artifactError) {
      throw new DevTestBotRunnerError("devTestBot failed to write browser artifacts.", {
        code: "DEVTESTBOT_ARTIFACT_WRITE_FAILED",
        cause: artifactError,
      });
    }

    const manifestPath = path.join(artifactRoot, "manifest.json");
    artifacts.manifestPath = manifestPath;
    await writeJson(manifestPath, {
      runId,
      generatedAt: new Date().toISOString(),
      baseUrl: sanitizeUrl(normalizedBaseUrl, sensitiveValues),
      identity: summarizeIdentity(identityCreds, sensitiveValues),
      artifacts: Object.fromEntries(Object.entries(artifacts).map(([key, value]) => [key, value])),
      counts: {
        console: consoleEvents.length,
        network: networkEvents.length,
      },
    });

    return buildFinalResult({ artifacts, artifactRoot, consoleEvents, networkEvents });
  }

  return {
    page,
    browser,
    context,
    baseUrl: normalizedBaseUrl,
    outputDir: artifactRoot,
    artifacts,
    captures: {
      console: consoleEvents,
      network: networkEvents,
    },
    goto,
    scanA11y,
    runLighthouse: runLighthouseCapture,
    writeConsoleCapture,
    writeNetworkCapture,
    writeClickCoverage,
    finalize,
    close: finalize,
  };
}

export function resolvePlaywrightChromiumExecutable() {
  const executablePath = chromium.executablePath();
  if (executablePath && fs.existsSync(executablePath)) {
    return executablePath;
  }
  throw new DevTestBotRunnerError(
    "devTestBot requires Playwright Chromium. Run `npm run devtestbot:install-browsers`.",
    { code: "DEVTESTBOT_BROWSER_MISSING" },
  );
}

export function findPlaywrightFfmpegExecutable(env = process.env, platform = process.platform) {
  const roots = playwrightRegistryRoots(env, platform);
  const names = playwrightFfmpegExecutableNames(platform);
  for (const root of roots) {
    const found = findExecutableUnder(root, names, 4);
    if (found) return found;
  }
  return null;
}

export async function writeMp4FromPngFrames(page, frames, outputPath, viewport = DEFAULT_VIEWPORT) {
  if (!Array.isArray(frames) || frames.length === 0) {
    throw new DevTestBotRunnerError("devTestBot MP4 generation requires at least one frame.", {
      code: "DEVTESTBOT_MP4_NO_FRAMES",
    });
  }
  await page.addScriptTag({ path: await resolveMp4MuxerBundlePath() });
  const width = Number(viewport?.width || DEFAULT_VIEWPORT.width);
  const height = Number(viewport?.height || DEFAULT_VIEWPORT.height);
  const payloadFrames = frames.length === 1
    ? [frames[0], frames[0], frames[0], frames[0]]
    : frames.flatMap((frame) => [frame, frame]);
  const bytes = await page.evaluate(async ({ payloadFrames, width, height }) => {
    if (!("VideoEncoder" in window)) {
      throw new Error("WebCodecs VideoEncoder is unavailable in this browser context.");
    }
    if (!window.Mp4Muxer?.Muxer || !window.Mp4Muxer?.ArrayBufferTarget) {
      throw new Error("mp4-muxer did not initialize in the browser context.");
    }
    const candidates = [
      { encoderCodec: "avc1.42001f", muxerCodec: "avc" },
      { encoderCodec: "vp09.00.10.08", muxerCodec: "vp9" },
      { encoderCodec: "av01.0.04M.08", muxerCodec: "av1" },
    ];
    let selected = null;
    for (const candidate of candidates) {
      const support = await VideoEncoder.isConfigSupported({
        codec: candidate.encoderCodec,
        width,
        height,
        bitrate: 500000,
        framerate: 2,
      }).catch(() => ({ supported: false }));
      if (support.supported) {
        selected = candidate;
        break;
      }
    }
    if (!selected) {
      throw new Error("No browser-supported MP4 video codec was available.");
    }

    const target = new window.Mp4Muxer.ArrayBufferTarget();
    const muxer = new window.Mp4Muxer.Muxer({
      target,
      video: {
        codec: selected.muxerCodec,
        width,
        height,
        frameRate: 2,
      },
      fastStart: "in-memory",
    });
    let encoderError = null;
    const encoder = new VideoEncoder({
      output: (chunk, meta) => muxer.addVideoChunk(chunk, meta),
      error: (error) => { encoderError = error; },
    });
    encoder.configure({
      codec: selected.encoderCodec,
      width,
      height,
      bitrate: 500000,
      framerate: 2,
    });

    const canvas = new OffscreenCanvas(width, height);
    const context = canvas.getContext("2d", { alpha: false });
    const pngBlobFromBase64 = (pngBase64) => {
      const binary = atob(pngBase64);
      const bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i += 1) {
        bytes[i] = binary.charCodeAt(i);
      }
      return new Blob([bytes], { type: "image/png" });
    };
    const bitmaps = await Promise.all(
      payloadFrames.map((item) => createImageBitmap(pngBlobFromBase64(item.pngBase64)))
    );
    for (let index = 0; index < payloadFrames.length; index += 1) {
      const bitmap = bitmaps[index];
      context.fillStyle = "#ffffff";
      context.fillRect(0, 0, width, height);
      context.drawImage(bitmap, 0, 0, width, height);
      bitmap.close();
      const frame = new VideoFrame(canvas, {
        timestamp: index * 500000,
        duration: 500000,
      });
      encoder.encode(frame, { keyFrame: index === 0 });
      frame.close();
      if (encoderError) throw encoderError;
    }
    await encoder.flush();
    encoder.close();
    if (encoderError) throw encoderError;
    muxer.finalize();
    return Array.from(new Uint8Array(target.buffer));
  }, { payloadFrames, width, height });

  await fsp.mkdir(path.dirname(outputPath), { recursive: true });
  await fsp.writeFile(outputPath, Buffer.from(bytes));
  const stat = await fsp.stat(outputPath).catch(() => null);
  if (!stat || stat.size <= 0) {
    throw new DevTestBotRunnerError("devTestBot MP4 generation produced no output.", {
      code: "DEVTESTBOT_MP4_EMPTY",
    });
  }
  return outputPath;
}

export function redactText(value, sensitiveValues = []) {
  let text = String(value ?? "");
  for (const sensitiveValue of sensitiveValues) {
    if (!sensitiveValue) continue;
    text = text.split(sensitiveValue).join("[REDACTED]");
  }
  return text
    .replace(TOKEN_VALUE_PATTERN, (match) => match.replace(/[:=]\s*["']?.*$/u, "=[REDACTED]"))
    .replace(LONG_SECRET_PATTERN, "[REDACTED]");
}

function normalizeBaseUrl(baseUrl) {
  if (!baseUrl) {
    throw new DevTestBotRunnerError("launch({ baseUrl }) is required.", { code: "DEVTESTBOT_BASE_URL_REQUIRED" });
  }
  let parsed;
  try {
    parsed = new URL(baseUrl);
  } catch (error) {
    throw new DevTestBotRunnerError("launch({ baseUrl }) must be an absolute URL.", {
      code: "DEVTESTBOT_BASE_URL_INVALID",
      cause: error,
    });
  }
  if (!["http:", "https:"].includes(parsed.protocol)) {
    throw new DevTestBotRunnerError("launch({ baseUrl }) must use http or https.", {
      code: "DEVTESTBOT_BASE_URL_UNSUPPORTED",
    });
  }
  return parsed.href.replace(/\/+$/, "");
}

function resolveNavigationUrl(target, baseUrl) {
  return new URL(target || "/", baseUrl + "/").href;
}

function normalizeHttpCredentials(identityCreds) {
  if (!identityCreds || typeof identityCreds !== "object") return undefined;
  const username = identityCreds.username || identityCreds.email;
  const password = identityCreds.password;
  if (!username || !password) return undefined;
  return {
    username: String(username),
    password: String(password),
  };
}

function collectSensitiveValues(value, out = new Set()) {
  if (value == null) return [...out];
  if (typeof value === "string") {
    if (value.length >= 4) out.add(value);
    return [...out];
  }
  if (typeof value !== "object") return [...out];
  for (const item of Object.values(value)) {
    collectSensitiveValues(item, out);
  }
  return [...out];
}

function redactHeaders(headers, sensitiveValues) {
  const output = {};
  for (const [key, value] of Object.entries(headers || {})) {
    output[key] = SENSITIVE_KEY_PATTERN.test(key)
      ? "[REDACTED]"
      : redactText(value, sensitiveValues);
  }
  return output;
}

function sanitizeUrl(rawUrl, sensitiveValues) {
  try {
    const parsed = new URL(rawUrl);
    for (const key of [...parsed.searchParams.keys()]) {
      if (SENSITIVE_KEY_PATTERN.test(key)) {
        parsed.searchParams.set(key, "[REDACTED]");
      }
    }
    return redactText(parsed.href, sensitiveValues);
  } catch {
    return redactText(rawUrl, sensitiveValues);
  }
}

function sanitizeLocation(location, sensitiveValues) {
  if (!location || typeof location !== "object") return {};
  return sanitizeJson(location, sensitiveValues);
}

function sanitizeJson(value, sensitiveValues) {
  if (Array.isArray(value)) return value.map((item) => sanitizeJson(item, sensitiveValues));
  if (value && typeof value === "object") {
    const output = {};
    for (const [key, item] of Object.entries(value)) {
      output[key] = SENSITIVE_KEY_PATTERN.test(key)
        ? "[REDACTED]"
        : sanitizeJson(item, sensitiveValues);
    }
    return output;
  }
  if (typeof value === "string") return redactText(value, sensitiveValues);
  return value;
}

async function runLighthouseCli({ url, outputPath, chromePath, timeoutMs, sensitiveValues }) {
  const startedAt = new Date().toISOString();
  await fsp.mkdir(path.dirname(outputPath), { recursive: true });
  let cliPath;
  try {
    cliPath = await resolveLighthouseCliPath();
    await execFileAsync(process.execPath, [
      cliPath,
      url,
      "--output=json",
      "--output-path=" + outputPath,
      "--quiet",
      "--preset=desktop",
      "--throttling-method=provided",
      "--only-categories=performance,accessibility,best-practices,seo",
      "--chrome-flags=--headless=new --no-sandbox --disable-gpu",
    ], {
      env: {
        ...process.env,
        CHROME_PATH: chromePath,
      },
      timeout: timeoutMs,
      windowsHide: true,
    });
    const raw = JSON.parse(await fsp.readFile(outputPath, "utf-8"));
    const payload = sanitizeJson(raw, sensitiveValues);
    await writeJson(outputPath, payload);
    return {
      available: true,
      reportPath: outputPath,
      startedAt,
      scores: extractLighthouseScores(payload),
    };
  } catch (error) {
    const existingReport = await readJsonIfPresent(outputPath);
    if (existingReport && existingReport.categories) {
      const payload = sanitizeJson(existingReport, sensitiveValues);
      payload.devtestbotCaptureWarning = redactText(error?.message || String(error), sensitiveValues).slice(0, 500);
      await writeJson(outputPath, payload);
      return {
        available: true,
        reportPath: outputPath,
        startedAt,
        warning: payload.devtestbotCaptureWarning,
        scores: extractLighthouseScores(payload),
      };
    }
    const payload = {
      available: false,
      generatedAt: new Date().toISOString(),
      startedAt,
      url: sanitizeUrl(url, sensitiveValues),
      reason: redactText(error?.message || String(error), sensitiveValues),
    };
    await writeJson(outputPath, payload);
    return {
      available: false,
      reportPath: outputPath,
      reason: payload.reason,
    };
  }
}

async function readJsonIfPresent(filePath) {
  try {
    return JSON.parse(await fsp.readFile(filePath, "utf-8"));
  } catch {
    return null;
  }
}

async function resolveLighthouseCliPath() {
  const packagePath = await import.meta.resolve("lighthouse/package.json");
  return path.join(path.dirname(fileURLToPath(packagePath)), "cli", "index.js");
}

async function resolveMp4MuxerBundlePath() {
  const entryPath = fileURLToPath(await import.meta.resolve("mp4-muxer"));
  return entryPath.endsWith(".mjs") ? entryPath.replace(/\.mjs$/u, ".js") : entryPath;
}

function extractLighthouseScores(report) {
  const categories = report?.categories || {};
  return {
    performance: categories.performance?.score ?? null,
    accessibility: categories.accessibility?.score ?? null,
    bestPractices: categories["best-practices"]?.score ?? null,
    seo: categories.seo?.score ?? null,
  };
}

function summarizeIdentity(identityCreds, sensitiveValues) {
  if (!identityCreds || typeof identityCreds !== "object") {
    return { provided: false };
  }
  return {
    provided: true,
    username: identityCreds.username || identityCreds.email
      ? redactText(identityCreds.username || identityCreds.email, sensitiveValues)
      : null,
    fields: Object.keys(identityCreds).sort(),
  };
}

function playwrightRegistryRoots(env, platform = process.platform) {
  const roots = [];
  if (env.PLAYWRIGHT_BROWSERS_PATH && env.PLAYWRIGHT_BROWSERS_PATH !== "0") {
    roots.push(env.PLAYWRIGHT_BROWSERS_PATH);
  }
  if (env.PLAYWRIGHT_BROWSERS_PATH === "0") {
    roots.push(path.resolve("node_modules", "playwright-core", ".local-browsers"));
  }
  if (platform === "win32" && env.LOCALAPPDATA) {
    roots.push(path.join(env.LOCALAPPDATA, "ms-playwright"));
  } else if (platform === "darwin") {
    roots.push(path.join(os.homedir(), "Library", "Caches", "ms-playwright"));
  } else {
    roots.push(path.join(os.homedir(), ".cache", "ms-playwright"));
  }
  return [...new Set(roots.filter(Boolean))];
}

function playwrightFfmpegExecutableNames(platform = process.platform) {
  if (platform === "win32") return ["ffmpeg-win64.exe", "ffmpeg.exe"];
  if (platform === "darwin") return ["ffmpeg-mac", "ffmpeg"];
  return ["ffmpeg-linux", "ffmpeg"];
}

function findExecutableUnder(root, executableNames, maxDepth) {
  if (!root || !fs.existsSync(root) || maxDepth < 0) return null;
  const entries = fs.readdirSync(root, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(root, entry.name);
    if (entry.isFile() && executableNames.includes(entry.name)) {
      return fullPath;
    }
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const found = findExecutableUnder(path.join(root, entry.name), executableNames, maxDepth - 1);
    if (found) return found;
  }
  return null;
}

function trackCapture(promise, pendingCaptures) {
  const guarded = Promise.resolve(promise).catch(() => {});
  pendingCaptures.add(guarded);
  guarded.finally(() => pendingCaptures.delete(guarded));
}

async function settlePendingCaptures(pendingCaptures) {
  await Promise.allSettled([...pendingCaptures]);
}

async function writeJson(outputPath, payload) {
  await fsp.mkdir(path.dirname(outputPath), { recursive: true });
  await fsp.writeFile(outputPath, JSON.stringify(payload, null, 2) + "\n", "utf-8");
}

function buildFinalResult({ artifacts, artifactRoot, consoleEvents, networkEvents }) {
  return {
    outputDir: artifactRoot,
    artifacts: { ...artifacts },
    counts: {
      console: consoleEvents.length,
      network: networkEvents.length,
    },
  };
}

function omit(input, keys) {
  const output = {};
  for (const [key, value] of Object.entries(input || {})) {
    if (!keys.includes(key)) output[key] = value;
  }
  return output;
}
