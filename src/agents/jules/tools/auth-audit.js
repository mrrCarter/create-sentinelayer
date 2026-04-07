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
    const creds = resolveAidenIdCredentials();
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
 * - URLs and credentials passed ONLY via env vars (no string interpolation)
 * - Auth verification checks URL change + cookie presence (not just click success)
 * - Console errors redacted to prevent sensitive data leakage
 * - Cookie values never captured (names + flags only)
 * - Temp script cleanup in finally block (not just success path)
 */
async function authenticatedPageCheck(input) {
  const url = input.url;
  if (!url) throw new AuthAuditError("authenticated_page_check requires url");
  if (!isValidUrl(url)) throw new AuthAuditError("Invalid URL: " + url);

  const loginUrl = input.loginUrl || url + "/login";
  let scriptPath = null;

  try {
    scriptPath = secureTempFile("sl-auth-audit-" + randomUUID().slice(0, 8) + ".cjs");
    fs.writeFileSync(scriptPath, PLAYWRIGHT_AUTH_SCRIPT);

    // Use scrubbed env — strip API keys/tokens from child process
    const { buildScrubbedEnv } = await import("./shell.js");
    const env = {
      ...buildScrubbedEnv(),
      SL_AUDIT_TARGET_URL: url,
      SL_AUDIT_LOGIN_URL: loginUrl,
      SL_AUDIT_TEST_EMAIL: input.email || "",
      SL_AUDIT_TEST_PASSWORD: input.password || "",
      SL_AUDIT_EMAIL_FIELD: input.emailField || "",
      SL_AUDIT_PASSWORD_FIELD: input.passwordField || "",
      SL_AUDIT_SUBMIT_SELECTOR: input.submitSelector || "",
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
    // Clean up temp script AND its mkdtemp parent directory
    if (scriptPath) {
      try { fs.unlinkSync(scriptPath); } catch { /* best effort */ }
      try { fs.rmdirSync(path.dirname(scriptPath)); } catch { /* best effort — dir may not be empty */ }
    }
  }
}

// Playwright script as a constant — no string interpolation of URLs/credentials.
// All dynamic values come from environment variables at runtime.
const PLAYWRIGHT_AUTH_SCRIPT = `
const { chromium } = require('playwright');
(async () => {
  const targetUrl = process.env.SL_AUDIT_TARGET_URL;
  const loginUrl = process.env.SL_AUDIT_LOGIN_URL;
  const email = process.env.SL_AUDIT_TEST_EMAIL;
  const password = process.env.SL_AUDIT_TEST_PASSWORD;
  const emailSelector = process.env.SL_AUDIT_EMAIL_FIELD || 'input[type="email"]';
  const passwordSelector = process.env.SL_AUDIT_PASSWORD_FIELD || 'input[type="password"]';
  const submitSelector = process.env.SL_AUDIT_SUBMIT_SELECTOR || 'button[type="submit"]';

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
      // P2 fix: verify auth by checking URL change + session cookie presence
      const currentUrl = page.url();
      const postCookies = await page.context().cookies();
      results.authenticated = currentUrl !== loginUrl || postCookies.some(c => /session|token|auth/i.test(c.name));
    }

    await page.goto(targetUrl, { waitUntil: 'networkidle', timeout: 30000 });

    // P2 fix: redact sensitive content from console errors
    page.on('console', msg => {
      if (msg.type() === 'error') {
        const text = (msg.text() || '').slice(0, 200).replace(/Bearer\\s+\\S+/gi, 'Bearer [REDACTED]').replace(/token[=:]\\S+/gi, 'token=[REDACTED]');
        results.errors.push({ text });
      }
    });

    // P2 fix: capture cookie names + flags only, never values
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
    try { console.log(JSON.stringify(results)); } catch { /* output failure non-blocking */ }
    await browser.close();
  }
})();
`;

function checkAuthFlowSecurity(input) {
  const loginUrl = input.loginUrl || input.url;
  if (!loginUrl) throw new AuthAuditError("check_auth_flow_security requires loginUrl or url");
  if (!isValidUrl(loginUrl)) throw new AuthAuditError("Invalid URL: " + loginUrl);

  const findings = [];
  try {
    const output = execFileSync("curl", ["-sI", "-L", "--max-time", "10", loginUrl], {
      encoding: "utf-8", timeout: 15000, stdio: ["pipe", "pipe", "pipe"],
    });
    const headers = {};
    for (const line of output.split("\n")) {
      const idx = line.indexOf(":");
      if (idx > 0) headers[line.slice(0, idx).trim().toLowerCase()] = line.slice(idx + 1).trim();
    }
    if (!headers["strict-transport-security"]) findings.push({ severity: "P1", title: "Login page missing HSTS header", file: loginUrl });
    if (!headers["content-security-policy"]) findings.push({ severity: "P2", title: "Login page missing CSP header", file: loginUrl });
    if (headers["x-powered-by"]) findings.push({ severity: "P2", title: "Login page exposes X-Powered-By: " + headers["x-powered-by"], file: loginUrl });
  } catch (err) {
    return { available: false, loginUrl, findings, reason: "curl failed: " + err.message };
  }
  return { available: true, loginUrl, findings };
}

function isValidUrl(url) {
  try { const p = new URL(url); return p.protocol === "http:" || p.protocol === "https:"; } catch { return false; }
}

function secureTempFile(name) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sl-auth-"));
  return path.join(dir, name);
}

export class AuthAuditError extends Error {
  constructor(message) { super(message); this.name = "AuthAuditError"; }
}
