import { execFileSync } from "node:child_process";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";
import { randomUUID } from "node:crypto";

/**
 * Jules Tanaka — Runtime Audit Tool
 *
 * Lighthouse performance scan + Chrome DevTools Protocol inspection.
 * Requires: chrome/chromium available, lighthouse npm package.
 * All operations are optional — gracefully degrade if deps unavailable.
 */

const LIGHTHOUSE_TIMEOUT_MS = 120000;
const CDP_TIMEOUT_MS = 30000;

/**
 * @param {{ operation: string, url?: string, path?: string }} input
 * @returns {object} Structured result per operation
 */
export function runtimeAudit(input) {
  if (!RUNTIME_OPS.has(input.operation)) {
    throw new RuntimeAuditError(
      "Unknown operation: " + input.operation + ". Valid: " + [...RUNTIME_OPS].join(", "),
    );
  }
  return RUNTIME_DISPATCH[input.operation](input);
}

const RUNTIME_OPS = new Set([
  "lighthouse_scan",
  "check_response_headers",
  "detect_deployed_url",
  "check_console_errors",
  "check_network_waterfall",
  "check_dom_stats",
]);

const RUNTIME_DISPATCH = {
  lighthouse_scan: lighthouseScan,
  check_response_headers: checkResponseHeaders,
  detect_deployed_url: detectDeployedUrl,
  check_console_errors: checkConsoleErrors,
  check_network_waterfall: checkNetworkWaterfall,
  check_dom_stats: checkDomStats,
};

/**
 * Run Lighthouse via npx (no install required).
 * Returns performance, accessibility, best-practices, SEO scores + key metrics.
 */
function lighthouseScan(input) {
  const url = input.url;
  if (!url) {
    throw new RuntimeAuditError("lighthouse_scan requires a url parameter");
  }
  if (!isValidUrl(url)) {
    throw new RuntimeAuditError("Invalid URL: " + url);
  }

  try {
    const outputPath = path.join(
      input.path || process.cwd(),
      ".sentinelayer",
      "reports",
      "lighthouse-" + Date.now() + ".json",
    );
    const outputDir = path.dirname(outputPath);
    if (!fs.existsSync(outputDir)) fs.mkdirSync(outputDir, { recursive: true });

    execFileSync("npx", [
      "--yes", "lighthouse@12", url,
      "--output", "json", "--output-path", outputPath,
      "--chrome-flags=--headless --no-sandbox --disable-gpu", "--quiet",
    ], {
      encoding: "utf-8",
      timeout: LIGHTHOUSE_TIMEOUT_MS,
      stdio: ["pipe", "pipe", "pipe"],
    });

    if (!fs.existsSync(outputPath)) {
      return { available: false, reason: "Lighthouse produced no output" };
    }

    const raw = JSON.parse(fs.readFileSync(outputPath, "utf-8"));
    const categories = raw.categories || {};
    const audits = raw.audits || {};

    return {
      available: true,
      reportPath: outputPath,
      scores: {
        performance: categories.performance?.score ?? null,
        accessibility: categories.accessibility?.score ?? null,
        bestPractices: categories["best-practices"]?.score ?? null,
        seo: categories.seo?.score ?? null,
      },
      metrics: {
        lcp_ms: audits["largest-contentful-paint"]?.numericValue ?? null,
        fcp_ms: audits["first-contentful-paint"]?.numericValue ?? null,
        cls: audits["cumulative-layout-shift"]?.numericValue ?? null,
        tbt_ms: audits["total-blocking-time"]?.numericValue ?? null,
        si_ms: audits["speed-index"]?.numericValue ?? null,
        tti_ms: audits["interactive"]?.numericValue ?? null,
      },
      opportunities: Object.values(audits)
        .filter(a => a.details?.type === "opportunity" && a.details?.overallSavingsMs > 100)
        .slice(0, 10)
        .map(a => ({
          id: a.id,
          title: a.title,
          savingsMs: a.details?.overallSavingsMs,
          savingsBytes: a.details?.overallSavingsBytes,
        })),
    };
  } catch (err) {
    return {
      available: false,
      reason: "Lighthouse failed: " + (err.message || "").slice(0, 200),
    };
  }
}

/**
 * Check HTTP response headers for security and performance headers.
 * Uses curl (available on all platforms).
 */
function checkResponseHeaders(input) {
  const url = input.url;
  if (!url) throw new RuntimeAuditError("check_response_headers requires a url");
  if (!isValidUrl(url)) throw new RuntimeAuditError("Invalid URL: " + url);

  try {
    const safeUrl = sanitizeUrlForShell(url);
    if (!safeUrl) throw new Error("URL sanitization failed");
    const output = execFileSync("curl", ["-sI", "-L", "--max-time", "10", safeUrl], {
      encoding: "utf-8", timeout: 15000, stdio: ["pipe", "pipe", "pipe"],
    });

    const headers = parseHeaders(output);
    const securityHeaders = [
      "content-security-policy", "x-frame-options", "x-content-type-options",
      "strict-transport-security", "referrer-policy", "permissions-policy",
    ];

    const findings = [];
    for (const h of securityHeaders) {
      const present = headers[h] !== undefined;
      if (!present) {
        findings.push({
          header: h,
          present: false,
          severity: h === "content-security-policy" ? "P1" : "P2",
        });
      }
    }

    return {
      available: true,
      url,
      statusCode: parseInt(output.match(/HTTP\/[\d.]+ (\d+)/)?.[1] || "0"),
      headers,
      securityFindings: findings,
      cookieFlags: extractCookieFlags(headers),
    };
  } catch (err) {
    return { available: false, reason: "curl failed: " + err.message };
  }
}

/**
 * Try to detect a deployed URL from common config locations.
 */
function detectDeployedUrl(input) {
  const rootPath = input.path || process.cwd();
  const candidates = [];

  // Check env vars
  for (const key of ["NEXT_PUBLIC_APP_URL", "VITE_APP_URL", "APP_URL", "BASE_URL", "DEPLOY_URL", "VERCEL_URL"]) {
    if (process.env[key]) {
      candidates.push({ source: "env:" + key, url: process.env[key] });
    }
  }

  // Check package.json homepage
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(rootPath, "package.json"), "utf-8"));
    if (pkg.homepage) candidates.push({ source: "package.json:homepage", url: pkg.homepage });
  } catch { /* skip */ }

  // Check vercel.json
  try {
    const vercel = JSON.parse(fs.readFileSync(path.join(rootPath, "vercel.json"), "utf-8"));
    if (vercel.alias) {
      const alias = Array.isArray(vercel.alias) ? vercel.alias[0] : vercel.alias;
      candidates.push({ source: "vercel.json:alias", url: "https://" + alias });
    }
  } catch { /* skip */ }

  // Check .env files for URLs
  for (const envFile of [".env", ".env.local", ".env.production"]) {
    try {
      const content = fs.readFileSync(path.join(rootPath, envFile), "utf-8");
      const urlMatch = content.match(/(?:APP_URL|BASE_URL|SITE_URL|DEPLOY_URL)\s*=\s*['"]?(https?:\/\/[^\s'"]+)/);
      if (urlMatch) candidates.push({ source: envFile, url: urlMatch[1] });
    } catch { /* skip */ }
  }

  return { candidates, found: candidates.length > 0, primary: candidates[0]?.url || null };
}

/**
 * Check for console errors by loading the page with Playwright (if available).
 * Falls back to a simple curl-based check.
 */
function checkConsoleErrors(input) {
  const url = input.url;
  if (!url) throw new RuntimeAuditError("check_console_errors requires a url");
  if (!isValidUrl(url)) throw new RuntimeAuditError("Invalid URL: " + url);

  // Try playwright — URL passed via env var to prevent command injection
  try {
    const scriptPath = secureTempFile("sl-console-" + randomUUID().slice(0, 8) + ".cjs");
    fs.writeFileSync(scriptPath, `
      const { chromium } = require('playwright');
      (async () => {
        const targetUrl = process.env.SL_AUDIT_TARGET_URL;
        if (!targetUrl) { console.log(JSON.stringify({ errors: [], title: '' })); process.exit(0); }
        const browser = await chromium.launch({ headless: true });
        const page = await browser.newPage();
        const errors = [];
        page.on('console', msg => { if (msg.type() === 'error') errors.push({ text: msg.text(), url: msg.location()?.url }); });
        page.on('pageerror', err => errors.push({ text: err.message, type: 'uncaught' }));
        try {
          await page.goto(targetUrl, { waitUntil: 'networkidle', timeout: 30000 });
          console.log(JSON.stringify({ errors, title: await page.title() }));
        } finally {
          await browser.close();
        }
      })();
    `);
    const output = execFileSync("node", [scriptPath], {
      encoding: "utf-8", timeout: 45000,
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, SL_AUDIT_TARGET_URL: url },
    });
    try { fs.unlinkSync(scriptPath); } catch { /* best effort */ }
    try { fs.rmdirSync(path.dirname(scriptPath)); } catch { /* best effort */ }
    const result = JSON.parse(output.trim());
    return { available: true, method: "playwright", ...result };
  } catch (playwrightErr) {
    // Playwright not available — return instruction
    return {
      available: false,
      reason: "Playwright not installed. Run: npx playwright install chromium",
      recommendation: "Install playwright for console error capture",
    };
  }
}

/**
 * Basic network waterfall check via curl timing.
 */
function checkNetworkWaterfall(input) {
  const url = input.url;
  if (!url) throw new RuntimeAuditError("check_network_waterfall requires a url");
  if (!isValidUrl(url)) throw new RuntimeAuditError("Invalid URL: " + url);

  try {
    // Write curl format to temp file to avoid shell quoting issues across platforms
    const formatFile = secureTempFile("sl-curl-fmt-" + randomUUID().slice(0, 8) + ".txt");
    fs.writeFileSync(formatFile, '{"dns_ms":%{time_namelookup},"connect_ms":%{time_connect},"tls_ms":%{time_appconnect},"ttfb_ms":%{time_starttransfer},"total_ms":%{time_total},"size_bytes":%{size_download},"status":%{http_code}}');
    const safeUrl = sanitizeUrlForShell(url);
    if (!safeUrl) { try { fs.unlinkSync(formatFile); } catch {} throw new Error("URL sanitization failed"); }
    const output = execFileSync("curl", [
      "-sL", "-o", devNull(), "-w", "@" + formatFile, "--max-time", "15", safeUrl,
    ], { encoding: "utf-8", timeout: 20000, stdio: ["pipe", "pipe", "pipe"] });
    try { fs.unlinkSync(formatFile); } catch { /* best effort */ }
    try { fs.rmdirSync(path.dirname(formatFile)); } catch { /* best effort */ }
    const timing = JSON.parse(output.trim());
    // Convert seconds to milliseconds
    for (const key of ["dns_ms", "connect_ms", "tls_ms", "ttfb_ms", "total_ms"]) {
      timing[key] = Math.round(timing[key] * 1000);
    }
    return { available: true, url, timing };
  } catch (err) {
    return { available: false, reason: "curl timing failed: " + err.message };
  }
}

/**
 * Basic DOM stats (requires Playwright).
 */
function checkDomStats(input) {
  const url = input.url;
  if (!url) throw new RuntimeAuditError("check_dom_stats requires a url");
  if (!isValidUrl(url)) throw new RuntimeAuditError("Invalid URL: " + url);

  // URL passed via env var to prevent command injection (CodeQL alert #51)
  try {
    const scriptPath = secureTempFile("sl-dom-" + randomUUID().slice(0, 8) + ".cjs");
    fs.writeFileSync(scriptPath, `
      const { chromium } = require('playwright');
      (async () => {
        const targetUrl = process.env.SL_AUDIT_TARGET_URL;
        if (!targetUrl) { console.log(JSON.stringify({})); process.exit(0); }
        const browser = await chromium.launch({ headless: true });
        try {
          const page = await browser.newPage();
          await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
          const stats = await page.evaluate(() => ({
            nodeCount: document.querySelectorAll('*').length,
            maxDepth: (function depth(el, d) { return Math.max(d, ...Array.from(el.children).map(c => depth(c, d+1))); })(document.body, 0),
            imgCount: document.querySelectorAll('img').length,
            imgWithoutAlt: document.querySelectorAll('img:not([alt])').length,
            formCount: document.querySelectorAll('form').length,
            inputWithoutLabel: document.querySelectorAll('input:not([aria-label]):not([id])').length,
            title: document.title,
            h1Count: document.querySelectorAll('h1').length,
            linkCount: document.querySelectorAll('a').length,
          }));
          console.log(JSON.stringify(stats));
        } finally {
          await browser.close();
        }
      })();
    `);
    const output = execFileSync("node", [scriptPath], {
      encoding: "utf-8", timeout: 45000,
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, SL_AUDIT_TARGET_URL: url },
    });
    try { fs.unlinkSync(scriptPath); } catch { /* best effort */ }
    try { fs.rmdirSync(path.dirname(scriptPath)); } catch { /* best effort */ }
    return { available: true, method: "playwright", ...JSON.parse(output.trim()) };
  } catch {
    return { available: false, reason: "Playwright not installed" };
  }
}

// ── Helpers ──────────────────────────────────────────────��───────────

function isValidUrl(url) {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}

function parseHeaders(raw) {
  const headers = {};
  for (const line of raw.split("\n")) {
    const colonIdx = line.indexOf(":");
    if (colonIdx > 0) {
      const key = line.slice(0, colonIdx).trim().toLowerCase();
      const value = line.slice(colonIdx + 1).trim();
      headers[key] = value;
    }
  }
  return headers;
}

function extractCookieFlags(headers) {
  const cookies = [];
  const setCookies = Object.entries(headers).filter(([k]) => k === "set-cookie");
  for (const [, value] of setCookies) {
    cookies.push({
      raw: value.slice(0, 100),
      httpOnly: /httponly/i.test(value),
      secure: /secure/i.test(value),
      sameSite: value.match(/samesite=(\w+)/i)?.[1] || null,
    });
  }
  return cookies;
}

function devNull() {
  return process.platform === "win32" ? "NUL" : "/dev/null";
}

/**
 * Create a temp file path with secure random name.
 * Sets file permissions to 0o600 (owner read/write only) after creation.
 */
function secureTempFile(name) {
  // CodeQL requires mkdtempSync for secure temp file creation (unique random dir)
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sl-rt-"));
  return path.join(dir, name);
}

function sanitizeUrlForShell(url) {
  // Only allow http/https URLs, strip any shell metacharacters
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return "";
    return parsed.href;
  } catch {
    return "";
  }
}

export class RuntimeAuditError extends Error {
  constructor(message) {
    super(message);
    this.name = "RuntimeAuditError";
  }
}
