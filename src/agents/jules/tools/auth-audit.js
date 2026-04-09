import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { randomUUID } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import { assertPermittedAuditTarget } from "./url-policy.js";

/**
 * Jules Tanaka — Authenticated Page Audit
 *
 * Provisions an AIdenID ephemeral identity, uses Playwright to log in,
 * then inspects authenticated pages (DevTools console, DOM, headers).
 * Falls back gracefully when AIdenID or Playwright unavailable.
 */

export function authAudit(input) {
  if (!AUTH_OPS.has(input.operation)) {
    throw new AuthAuditError("Unknown operation: " + input.operation + ". Valid: " + [...AUTH_OPS].join(", "));
  }
  return AUTH_DISPATCH[input.operation](input);
}

const AUTH_OPS = new Set([
  "provision_test_identity",
  "authenticated_page_check",
  "check_auth_flow_security",
]);

const AUTH_DISPATCH = {
  provision_test_identity: provisionTestIdentity,
  authenticated_page_check: authenticatedPageCheck,
  check_auth_flow_security: checkAuthFlowSecurity,
};

const AUTH_PLAYWRIGHT_EXEC_TIMEOUT_MS = 60_000;
const AUTH_PLAYWRIGHT_EXEC_MAX_RETRIES = 2;
const AUTH_PLAYWRIGHT_EXEC_BASE_BACKOFF_MS = 250;

async function provisionTestIdentity(input) {
  try {
    const executeRequested = input.execute === true;
    const allowLiveProvision = input.allowProvisioning === true || process.env.SENTINELAYER_ALLOW_LIVE_IDENTITY_PROVISION === "1";
    if (executeRequested && !allowLiveProvision) {
      return {
        available: false,
        reason: "Live AIdenID provisioning requires explicit allowProvisioning=true (or SENTINELAYER_ALLOW_LIVE_IDENTITY_PROVISION=1).",
      };
    }

    const { provisionEmailIdentity, resolveAidenIdCredentials } = await import("../../../ai/aidenid.js");
    const creds = await resolveAidenIdCredentials();
    if (!creds.apiKey) {
      return { available: false, reason: "AIdenID API key not configured (set AIDENID_API_KEY)" };
    }
    const result = await provisionEmailIdentity({
      apiUrl: creds.apiUrl, apiKey: creds.apiKey,
      tags: ["jules-audit", "frontend-test"],
      ttlSeconds: 3600, dryRun: !executeRequested,
    });
    return { available: true, dryRun: !executeRequested, identity: result.identity || result };
  } catch (err) {
    return { available: false, reason: "AIdenID provisioning failed: " + err.message };
  }
}

/**
 * Run Playwright to authenticate and inspect the page.
 * - Runtime values loaded from a secure temp context file (credentials not exposed in process env)
 * - Auth verification checks URL change + cookie presence (not just click success)
 * - Console errors redacted to prevent sensitive data leakage
 * - Cookie values never captured (names + flags only)
 * - Temp script/context cleanup in finally block (not just success path)
 */
async function authenticatedPageCheck(input) {
  const url = input.url;
  if (!url) throw new AuthAuditError("authenticated_page_check requires url");
  const targetUrl = resolveAuthAuditTarget(url, input, "authenticated_page_check.target");

  const loginUrlCandidate = input.loginUrl || targetUrl + "/login";
  const loginUrl = resolveAuthAuditTarget(loginUrlCandidate, input, "authenticated_page_check.login");
  let scriptPath = null;
  let contextPath = null;

  try {
    scriptPath = secureTempFile("sl-auth-audit-" + randomUUID().slice(0, 8) + ".cjs");
    fs.writeFileSync(scriptPath, PLAYWRIGHT_AUTH_SCRIPT);
    contextPath = secureTempFile("sl-auth-context-" + randomUUID().slice(0, 8) + ".json");
    fs.writeFileSync(
      contextPath,
      JSON.stringify({
        email: input.email || "",
        password: input.password || "",
        emailField: input.emailField || "",
        passwordField: input.passwordField || "",
        submitSelector: input.submitSelector || "",
      }),
      { encoding: "utf-8", mode: 0o600 },
    );

    // Use scrubbed env — strip API keys/tokens from child process
    const { buildScrubbedEnv } = await import("./shell.js");
    const env = {
      ...buildScrubbedEnv(),
      SL_AUDIT_TARGET_URL: targetUrl,
      SL_AUDIT_LOGIN_URL: loginUrl,
      SL_AUDIT_CONTEXT_FILE: contextPath,
    };

    const output = await runPlaywrightAuditScriptWithRetry(scriptPath, env);

    const result = JSON.parse(output.trim());
    const findings = [];
    for (const cookie of (result.cookies || [])) {
      if (cookie.sensitive && !cookie.httpOnly) {
        findings.push({ severity: "P1", title: "Sensitive cookie '" + cookie.name + "' missing httpOnly flag", file: targetUrl });
      }
      if (cookie.sensitive && !cookie.secure) {
        findings.push({ severity: "P1", title: "Sensitive cookie '" + cookie.name + "' missing Secure flag", file: targetUrl });
      }
      if (cookie.sensitive && cookie.sameSite === "None") {
        findings.push({ severity: "P2", title: "Sensitive cookie '" + cookie.name + "' has SameSite=None", file: targetUrl });
      }
    }
    return { available: true, method: "playwright", findings, ...result };
  } catch (err) {
    if (err instanceof AuthAuditError) {
      return { available: false, reason: err.message };
    }
    return { available: false, reason: "Playwright auth audit failed: " + err.message };
  } finally {
    cleanupTempFile(scriptPath);
    cleanupTempFile(contextPath);
  }
}

// Playwright script as a constant — no string interpolation of URLs/credentials.
// Dynamic auth context is read from a secure temp JSON file at runtime.
const PLAYWRIGHT_AUTH_SCRIPT = `
const { chromium } = require('playwright');
const fs = require('node:fs');

(async () => {
  const targetUrl = process.env.SL_AUDIT_TARGET_URL;
  const loginUrl = process.env.SL_AUDIT_LOGIN_URL;
  const contextPath = process.env.SL_AUDIT_CONTEXT_FILE;
  let context = {};
  if (contextPath) {
    try {
      context = JSON.parse(fs.readFileSync(contextPath, 'utf-8')) || {};
    } catch {
      context = {};
    }
  }

  const email = context.email || '';
  const password = context.password || '';
  const emailSelector = context.emailField || 'input[type="email"]';
  const passwordSelector = context.passwordField || 'input[type="password"]';
  const submitSelector = context.submitSelector || 'button[type="submit"]';

  let browser = null;
  const results = { authenticated: false, authSignals: {}, errors: [], cookies: [], headers: {}, domStats: {} };
  function normalizePath(value) {
    const normalized = String(value || '/').replace(/\\/+$/, '');
    return normalized || '/';
  }
  function didLeaveLoginSurface(currentValue, loginValue) {
    try {
      const currentUrl = new URL(currentValue);
      const loginParsed = new URL(loginValue);
      return (
        currentUrl.origin !== loginParsed.origin ||
        normalizePath(currentUrl.pathname) !== normalizePath(loginParsed.pathname)
      );
    } catch {
      return String(currentValue || '') !== String(loginValue || '');
    }
  }
  function sanitizeErrorText(value) {
    return String(value || '')
      .replace(/\\s+/g, ' ')
      .replace(/Bearer\\s+[^\\s,;]+/gi, 'Bearer [REDACTED]')
      .replace(/\\b(?:authorization|x-api-key|api-key|token|access_token|refresh_token|id_token|session|cookie|set-cookie|secret|password|passwd)\\b\\s*[:=]\\s*["']?[^"'\\s,;]+/gi, '$1=[REDACTED]')
      .replace(/\\b[A-Za-z0-9_-]{16,}\\.[A-Za-z0-9_-]{16,}\\.[A-Za-z0-9_-]{8,}\\b/g, '[REDACTED_JWT]')
      .replace(/\\b(?:gh[pousr]_[A-Za-z0-9]{20,}|sk-[A-Za-z0-9]{16,}|AIza[0-9A-Za-z-_]{20,}|xox[baprs]-[0-9A-Za-z-]{10,})\\b/g, '[REDACTED_TOKEN]')
      .replace(/\\b[A-Fa-f0-9]{32,}\\b/g, '[REDACTED_HEX]')
      .replace(/\\b[A-Za-z0-9_-]{40,}\\b/g, '[REDACTED_TOKEN]')
      .slice(0, 200);
  }

  try {
    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();
    page.on('console', msg => {
      if (msg.type() === 'error') {
        const text = sanitizeErrorText(msg.text());
        results.errors.push({ type: 'console', text });
      }
    });
    page.on('pageerror', err => {
      const text = sanitizeErrorText(err && err.message ? err.message : String(err || ''));
      results.errors.push({ type: 'pageerror', text });
    });

    if (email && password && loginUrl) {
      await page.goto(loginUrl, { waitUntil: 'networkidle', timeout: 30000 });
      await page.fill(emailSelector, email);
      await page.fill(passwordSelector, password);
      await page.click(submitSelector);
      await page.waitForNavigation({ waitUntil: 'networkidle', timeout: 15000 }).catch(() => {});
      const currentUrl = page.url();
      const postCookies = await page.context().cookies();
      const urlChanged = didLeaveLoginSurface(currentUrl, loginUrl);
      const authCookiePresent = postCookies.some(c => /(?:^|[-_])(session|token|auth|jwt)(?:$|[-_])/i.test(c.name) && (c.httpOnly || c.secure));
      const loginFormVisible = await page.evaluate((emailSel, passwordSel) => (
        Boolean(document.querySelector(emailSel) && document.querySelector(passwordSel))
      ), emailSelector, passwordSelector).catch(() => false);
      results.authSignals = { urlChanged, authCookiePresent, loginFormVisible };
      results.authenticated = !loginFormVisible && (urlChanged || authCookiePresent);
    }

    const targetResponse = await page.goto(targetUrl, { waitUntil: 'networkidle', timeout: 30000 });

    const cookies = await page.context().cookies();
    results.cookies = cookies.map(c => ({
      name: c.name, domain: c.domain,
      httpOnly: c.httpOnly, secure: c.secure,
      sameSite: c.sameSite,
      sensitive: /session|token|auth|jwt/i.test(c.name),
    }));

    results.domStats = await page.evaluate(() => ({
      title: document.title,
      nodeCount: document.querySelectorAll('*').length,
      formCount: document.querySelectorAll('form').length,
      inputCount: document.querySelectorAll('input').length,
    }));

    const response = targetResponse || null;
    if (response) {
      const h = response.headers();
      results.headers = {
        'content-security-policy': h['content-security-policy'] || null,
        'x-frame-options': h['x-frame-options'] || null,
        'strict-transport-security': h['strict-transport-security'] || null,
        'cache-control': h['cache-control'] || null,
      };
    }
  } catch (err) {
    const text = sanitizeErrorText('Playwright error: ' + (err && err.message ? err.message : ''));
    results.errors.push({ type: 'playwright', text });
  } finally {
    try { console.log(JSON.stringify(results)); } catch {}
    if (browser) {
      await browser.close().catch(() => {});
    }
  }
})();
`;

const MAX_AUTH_REDIRECT_HOPS = 5;
const AUTH_FLOW_FETCH_TIMEOUT_MS = 10_000;
const AUTH_FLOW_FETCH_MAX_RETRIES = 2;
const AUTH_FLOW_FETCH_BASE_BACKOFF_MS = 200;
const RETRYABLE_AUTH_FLOW_STATUS_CODES = new Set([408, 425, 429, 500, 502, 503, 504]);
const RETRYABLE_AUTH_FLOW_ERROR_CODES = new Set([
  "ECONNRESET",
  "EAI_AGAIN",
  "ENOTFOUND",
  "ECONNREFUSED",
  "ETIMEDOUT",
  "ECONNABORTED",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_HEADERS_TIMEOUT",
  "UND_ERR_BODY_TIMEOUT",
]);
const RETRYABLE_AUTH_FLOW_MESSAGE_PATTERNS = [
  /\bfetch failed\b/i,
  /\bnetwork(?:\s+|-)error\b/i,
  /\bsocket hang up\b/i,
  /\btimed?\s*out\b/i,
  /\b(?:econnreset|eai_again|enotfound|econnrefused|etimedout)\b/i,
  /\btemporary(?:\s+|-)failure\b/i,
  /\bconnection\b.*\b(?:reset|terminated|closed)\b/i,
];
const AUTH_FLOW_LOCAL_TEST_HOSTS = new Set(["localhost", "127.0.0.1", "::1"]);

function computePlaywrightBackoffMs(attempt, baseBackoffMs = AUTH_PLAYWRIGHT_EXEC_BASE_BACKOFF_MS) {
  const computed = Math.max(1, baseBackoffMs) * Math.pow(2, Math.max(0, attempt));
  return Math.min(1000, computed);
}

function isRetryablePlaywrightExecutionError(error) {
  if (!(error instanceof Error)) {
    return false;
  }
  const code = String(error.code || "").toUpperCase();
  if (code === "ETIMEDOUT" || code === "ECONNRESET" || code === "EPIPE" || code === "EAI_AGAIN") {
    return true;
  }
  if (error.killed === true || error.signal === "SIGTERM") {
    return true;
  }
  const message = (error.name + " " + (error.message || "")).toLowerCase();
  return message.includes("timeout") || message.includes("timed out") || message.includes("socket hang up");
}

function normalizeAuthAuditErrorMessage(error, fallbackMessage) {
  if (error instanceof Error && error.message) {
    return error.message;
  }
  const normalized = String(error || "").trim();
  return normalized || fallbackMessage;
}

export async function runPlaywrightAuditScriptWithRetry(scriptPath, env, options = {}) {
  if (!scriptPath) {
    throw new AuthAuditError("Playwright auth audit failed: missing script path");
  }
  const timeoutMs = Number.isFinite(options.timeoutMs) && options.timeoutMs > 0
    ? Math.trunc(options.timeoutMs)
    : AUTH_PLAYWRIGHT_EXEC_TIMEOUT_MS;
  const maxRetries = Number.isInteger(options.maxRetries) && options.maxRetries >= 0
    ? options.maxRetries
    : AUTH_PLAYWRIGHT_EXEC_MAX_RETRIES;
  const baseBackoffMs = Number.isFinite(options.baseBackoffMs) && options.baseBackoffMs > 0
    ? Math.trunc(options.baseBackoffMs)
    : AUTH_PLAYWRIGHT_EXEC_BASE_BACKOFF_MS;
  const execute = typeof options.exec === "function" ? options.exec : execFileSync;

  for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
    try {
      return execute(process.execPath, [scriptPath], {
        encoding: "utf-8",
        timeout: timeoutMs,
        stdio: ["pipe", "pipe", "pipe"],
        env,
      });
    } catch (error) {
      if (!isRetryablePlaywrightExecutionError(error) || attempt >= maxRetries) {
        const reason = normalizeAuthAuditErrorMessage(error, "Playwright execution failed");
        throw new AuthAuditError(`Playwright auth audit failed after ${attempt + 1} attempt(s): ${reason}`);
      }
    }
    await sleep(computePlaywrightBackoffMs(attempt, baseBackoffMs));
  }

  throw new AuthAuditError("Playwright auth audit failed after retry budget was exhausted");
}

function computeAuthFlowBackoffMs(attempt) {
  const computed = AUTH_FLOW_FETCH_BASE_BACKOFF_MS * Math.pow(2, Math.max(0, attempt));
  return Math.min(1000, computed);
}

function resolveAuthFlowErrorCode(error) {
  if (!(error instanceof Error)) {
    return "";
  }
  const directCode = String(error.code || "").toUpperCase();
  if (directCode) {
    return directCode;
  }
  const cause = error.cause;
  if (!cause || typeof cause !== "object") {
    return "";
  }
  return String(cause.code || cause.errno || "").toUpperCase();
}

function isRetryableAuthFlowError(error) {
  if (!(error instanceof Error)) {
    return false;
  }
  if (error.name === "AbortError" || error.name === "TimeoutError") {
    return true;
  }
  const code = resolveAuthFlowErrorCode(error);
  if (RETRYABLE_AUTH_FLOW_ERROR_CODES.has(code)) {
    return true;
  }
  const normalized = `${error.name} ${error.message || ""}`.toLowerCase();
  if (error.name === "TypeError") {
    return RETRYABLE_AUTH_FLOW_MESSAGE_PATTERNS.some((pattern) => pattern.test(normalized));
  }
  return RETRYABLE_AUTH_FLOW_MESSAGE_PATTERNS.some((pattern) => pattern.test(normalized));
}

function isAllowedHttpAuthFlowTarget(urlObject) {
  if (urlObject.protocol !== "http:") {
    return true;
  }
  if (process.env.NODE_ENV !== "test") {
    return false;
  }
  return AUTH_FLOW_LOCAL_TEST_HOSTS.has(urlObject.hostname);
}

function assertSecureAuthFlowTarget(urlValue, options = {}) {
  let parsed;
  try {
    parsed = assertPermittedAuditTarget(urlValue, {
      operation: "check_auth_flow_security",
      allowPrivateTargets: options.allowPrivateTargets === true,
    });
  } catch (error) {
    throw new AuthAuditError(error.message);
  }
  if (!isAllowedHttpAuthFlowTarget(parsed)) {
    throw new AuthAuditError(
      `HTTPS downgrade detected in auth flow target: ${parsed.toString()}`
    );
  }
  return parsed;
}

async function fetchWithTimeout(url, options, timeoutMs) {
  const controller = new AbortController();
  const timeoutHandle = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timeoutHandle);
  }
}

async function fetchLoginResponseWithRetry(currentUrl) {
  for (let attempt = 0; attempt <= AUTH_FLOW_FETCH_MAX_RETRIES; attempt += 1) {
    try {
      const response = await fetchWithTimeout(currentUrl, {
        method: "GET",
        redirect: "manual",
      }, AUTH_FLOW_FETCH_TIMEOUT_MS);
      if (!RETRYABLE_AUTH_FLOW_STATUS_CODES.has(response.status)) {
        return response;
      }
      if (attempt >= AUTH_FLOW_FETCH_MAX_RETRIES) {
        throw new AuthAuditError(
          `Auth flow header fetch failed after ${attempt + 1} attempt(s): HTTP ${response.status}`
        );
      }
    } catch (error) {
      if (error instanceof AuthAuditError) {
        throw error;
      }
      if (!isRetryableAuthFlowError(error) || attempt >= AUTH_FLOW_FETCH_MAX_RETRIES) {
        const message = error instanceof Error ? error.message : String(error || "request failed");
        throw new AuthAuditError(`Auth flow header fetch failed after ${attempt + 1} attempt(s): ${message}`);
      }
    }
    await sleep(computeAuthFlowBackoffMs(attempt));
  }
  throw new AuthAuditError("Auth flow header fetch failed after retry budget was exhausted");
}

async function checkAuthFlowSecurity(input) {
  const loginUrlCandidate = input.loginUrl || input.url;
  if (!loginUrlCandidate) throw new AuthAuditError("check_auth_flow_security requires loginUrl or url");
  const allowPrivateTargets = input.allowPrivateTargets === true;
  const loginUrl = assertSecureAuthFlowTarget(loginUrlCandidate, { allowPrivateTargets }).toString();

  const findings = [];
  try {
    const { headers, finalUrl, crossOriginRedirect } = await fetchLoginHeaders(loginUrl, { allowPrivateTargets });

    if (crossOriginRedirect) {
      findings.push({
        severity: "P1",
        title: "Login flow redirects cross-origin before header checks",
        file: loginUrl,
      });
    }

    if (!headers["strict-transport-security"]) {
      findings.push({ severity: "P1", title: "Login page missing HSTS header", file: finalUrl || loginUrl });
    }
    if (!headers["content-security-policy"]) {
      findings.push({ severity: "P2", title: "Login page missing CSP header", file: finalUrl || loginUrl });
    }
    if (headers["x-powered-by"]) {
      findings.push({
        severity: "P2",
        title: "Login page exposes X-Powered-By: " + headers["x-powered-by"],
        file: finalUrl || loginUrl,
      });
    }
  } catch (err) {
    if (err instanceof AuthAuditError && /HTTPS downgrade detected/.test(err.message)) {
      findings.push({
        severity: "P1",
        title: err.message,
        file: loginUrl,
      });
    }
    return { available: false, loginUrl, findings, reason: "auth flow check failed: " + err.message };
  }
  return { available: true, loginUrl, findings };
}

async function fetchLoginHeaders(loginUrl, options = {}) {
  let currentUrl = loginUrl;
  const visited = new Set();

  for (let hop = 0; hop < MAX_AUTH_REDIRECT_HOPS; hop++) {
    const currentParsedUrl = assertSecureAuthFlowTarget(currentUrl, options);
    if (visited.has(currentUrl)) {
      throw new AuthAuditError("Redirect loop detected while checking auth headers");
    }
    visited.add(currentUrl);

    const response = await fetchLoginResponseWithRetry(currentUrl);
    const headers = Object.fromEntries(response.headers.entries());

    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get("location");
      if (!location) {
        return { headers, finalUrl: currentUrl, crossOriginRedirect: false };
      }
      const nextParsedUrl = assertSecureAuthFlowTarget(new URL(location, currentParsedUrl).toString(), options);
      if (nextParsedUrl.origin !== currentParsedUrl.origin) {
        return { headers, finalUrl: currentUrl, crossOriginRedirect: true };
      }
      currentUrl = nextParsedUrl.toString();
      continue;
    }

    return { headers, finalUrl: currentUrl, crossOriginRedirect: false };
  }

  throw new AuthAuditError(`Exceeded ${MAX_AUTH_REDIRECT_HOPS} redirects while checking auth flow`);
}

function resolveAuthAuditTarget(urlValue, input, operation) {
  try {
    const parsed = assertPermittedAuditTarget(urlValue, {
      operation,
      allowPrivateTargets: input.allowPrivateTargets === true,
    });
    return parsed.toString();
  } catch (error) {
    throw new AuthAuditError(error.message);
  }
}

function cleanupTempFile(filePath) {
  if (!filePath) {
    return;
  }
  try { fs.unlinkSync(filePath); } catch {}
  try { fs.rmdirSync(path.dirname(filePath)); } catch {}
}

function secureTempFile(name) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sl-auth-"));
  return path.join(dir, name);
}

export class AuthAuditError extends Error {
  constructor(message) { super(message); this.name = "AuthAuditError"; }
}
