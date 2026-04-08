import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { randomUUID } from "node:crypto";

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

async function provisionTestIdentity(input) {
  try {
    const { provisionEmailIdentity, resolveAidenIdCredentials } = await import("../../../ai/aidenid.js");
    const creds = await resolveAidenIdCredentials();
    if (!creds.apiKey) {
      return { available: false, reason: "AIdenID API key not configured (set AIDENID_API_KEY)" };
    }
    const result = await provisionEmailIdentity({
      apiUrl: creds.apiUrl, apiKey: creds.apiKey,
      tags: ["jules-audit", "frontend-test"],
      ttlSeconds: 3600, dryRun: input.execute !== true,
    });
    return { available: true, dryRun: input.execute !== true, identity: result.identity || result };
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
  if (!isValidUrl(url)) throw new AuthAuditError("Invalid URL: " + url);

  const loginUrl = input.loginUrl || url + "/login";
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
      SL_AUDIT_TARGET_URL: url,
      SL_AUDIT_LOGIN_URL: loginUrl,
      SL_AUDIT_CONTEXT_FILE: contextPath,
    };

    const output = execFileSync("node", [scriptPath], {
      encoding: "utf-8", timeout: 60000,
      stdio: ["pipe", "pipe", "pipe"],
      env,
    });

    const result = JSON.parse(output.trim());
    const findings = [];
    for (const cookie of (result.cookies || [])) {
      if (cookie.sensitive && !cookie.httpOnly) {
        findings.push({ severity: "P1", title: "Sensitive cookie '" + cookie.name + "' missing httpOnly flag", file: url });
      }
      if (cookie.sensitive && !cookie.secure) {
        findings.push({ severity: "P1", title: "Sensitive cookie '" + cookie.name + "' missing Secure flag", file: url });
      }
      if (cookie.sensitive && cookie.sameSite === "None") {
        findings.push({ severity: "P2", title: "Sensitive cookie '" + cookie.name + "' has SameSite=None", file: url });
      }
    }
    return { available: true, method: "playwright", findings, ...result };
  } catch (err) {
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

  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  const results = { authenticated: false, errors: [], cookies: [], headers: {}, domStats: {} };

  try {
    if (email && password && loginUrl) {
      await page.goto(loginUrl, { waitUntil: 'networkidle', timeout: 30000 });
      await page.fill(emailSelector, email);
      await page.fill(passwordSelector, password);
      await page.click(submitSelector);
      await page.waitForNavigation({ waitUntil: 'networkidle', timeout: 15000 }).catch(() => {});
      const currentUrl = page.url();
      const postCookies = await page.context().cookies();
      results.authenticated = currentUrl !== loginUrl || postCookies.some(c => /session|token|auth/i.test(c.name));
    }

    await page.goto(targetUrl, { waitUntil: 'networkidle', timeout: 30000 });

    page.on('console', msg => {
      if (msg.type() === 'error') {
        const text = (msg.text() || '').slice(0, 200).replace(/Bearer\\s+\\S+/gi, 'Bearer [REDACTED]').replace(/token[=:]\\S+/gi, 'token=[REDACTED]');
        results.errors.push({ text });
      }
    });

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

    const response = await page.goto(targetUrl, { waitUntil: 'commit', timeout: 10000 }).catch(() => null);
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
    results.errors.push({ text: 'Navigation error: ' + (err.message || '').slice(0, 100) });
  } finally {
    try { console.log(JSON.stringify(results)); } catch {}
    await browser.close();
  }
})();
`;

const MAX_AUTH_REDIRECT_HOPS = 5;

async function checkAuthFlowSecurity(input) {
  const loginUrl = input.loginUrl || input.url;
  if (!loginUrl) throw new AuthAuditError("check_auth_flow_security requires loginUrl or url");
  if (!isValidUrl(loginUrl)) throw new AuthAuditError("Invalid URL: " + loginUrl);

  const findings = [];
  try {
    const { headers, finalUrl, crossOriginRedirect } = await fetchLoginHeaders(loginUrl);

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
    return { available: false, loginUrl, findings, reason: "auth flow check failed: " + err.message };
  }
  return { available: true, loginUrl, findings };
}

async function fetchLoginHeaders(loginUrl) {
  let currentUrl = loginUrl;
  const visited = new Set();

  for (let hop = 0; hop < MAX_AUTH_REDIRECT_HOPS; hop++) {
    if (visited.has(currentUrl)) {
      throw new AuthAuditError("Redirect loop detected while checking auth headers");
    }
    visited.add(currentUrl);

    const response = await fetch(currentUrl, {
      method: "GET",
      redirect: "manual",
      signal: AbortSignal.timeout(10000),
    });
    const headers = Object.fromEntries(response.headers.entries());

    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get("location");
      if (!location) {
        return { headers, finalUrl: currentUrl, crossOriginRedirect: false };
      }
      const nextUrl = new URL(location, currentUrl).toString();
      if (new URL(nextUrl).origin !== new URL(currentUrl).origin) {
        return { headers, finalUrl: currentUrl, crossOriginRedirect: true };
      }
      currentUrl = nextUrl;
      continue;
    }

    return { headers, finalUrl: currentUrl, crossOriginRedirect: false };
  }

  throw new AuthAuditError(`Exceeded ${MAX_AUTH_REDIRECT_HOPS} redirects while checking auth flow`);
}

function isValidUrl(url) {
  try { const p = new URL(url); return p.protocol === "http:" || p.protocol === "https:"; } catch { return false; }
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
