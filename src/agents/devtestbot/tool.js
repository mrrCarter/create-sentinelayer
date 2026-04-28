import { randomUUID } from "node:crypto";
import fsp from "node:fs/promises";
import path from "node:path";

import { getIdentityById } from "../../ai/identity-store.js";
import { resolveOutputRoot } from "../../config/service.js";
import { createAgentEvent } from "../../events/schema.js";
import { DEVTESTBOT_DEFINITION, DEVTESTBOT_LANES } from "./config/definition.js";
import { launch } from "./runner.js";

const RUNTIME_FILE = "runtime://browser";
const EXTRA_SECRET_PATTERN =
  /\b(?:otp|one[-_ ]?time[-_ ]?code|reset[-_ ]?link|verification[-_ ]?url|magic[-_ ]?link)\s*[:=]\s*["']?[^"'\s&]+/gi;
const SENSITIVE_KEY_PATTERN =
  /(?:authorization|cookie|set-cookie|token|secret|password|passwd|api[-_]?key|session|credential|otp|reset|verification)/i;
const SENSITIVE_FIELD_PATTERN =
  /^(?:authorization|cookie|set-cookie|token|secret|password|passwd|api[-_]?key|session|credential|otp|resetLink|verificationUrl)$/i;

export const DEVTESTBOT_RUN_SESSION_TOOL = Object.freeze({
  name: "devtestbot.run_session",
  description:
    "Run a scan-only browser system-test session and return redacted artifact paths plus normalized findings.",
  parameters: {
    type: "object",
    properties: {
      scope: {
        type: "string",
        description: "smoke, auth, full, password-reset, or a named scenario",
      },
      identityId: {
        type: "string",
        description: "AIdenID identity id from the local registry",
      },
      baseUrl: {
        type: "string",
        description: "Approved absolute http/https target URL",
      },
      recordVideo: {
        type: "boolean",
        default: true,
      },
      outputDir: {
        type: "string",
        description: "Optional devTestBot artifact output directory",
      },
    },
    required: ["scope"],
  },
});

export class DevTestBotToolError extends Error {
  constructor(message, options = {}) {
    super(message);
    this.name = "DevTestBotToolError";
    this.code = options.code || "DEVTESTBOT_TOOL_ERROR";
    this.cause = options.cause;
  }
}

export async function executeDevTestBotRunSessionTool(input = {}, ctx = {}) {
  return runDevTestBotSession(input, ctx);
}

export async function runDevTestBotSession(input = {}, ctx = {}) {
  const targetPath = path.resolve(String(input.targetPath || ctx.targetPath || process.cwd()));
  const outputRoot = await resolveOutputRoot({
    cwd: targetPath,
    outputDirOverride: input.outputRoot || ctx.outputRoot || "",
    env: ctx.env || process.env,
  });
  const runId = normalizeString(input.runId || ctx.runId) || createRunId();
  const scope = normalizeScope(input.scope || ctx.scope || "smoke");
  const execute = input.execute !== undefined ? Boolean(input.execute) : ctx.execute !== undefined ? Boolean(ctx.execute) : true;
  const recordVideo = input.recordVideo !== undefined ? Boolean(input.recordVideo) : true;
  const baseUrl = normalizeString(input.baseUrl || ctx.baseUrl);
  const identityId = normalizeString(input.identityId || ctx.identityId);
  const artifactRoot = path.resolve(
    input.outputDir || ctx.outputDir || path.join(outputRoot, "runs", runId, "devtestbot")
  );
  await fsp.mkdir(artifactRoot, { recursive: true });

  const { registryPath, identity } = await resolveIdentity({
    outputRoot,
    identityId,
    requireIdentity: requiresIdentity(scope) && execute,
  });
  const identityCreds = buildInternalIdentityCreds({
    identity,
    identityId,
    privateIdentityCreds: ctx.identityCreds,
  });
  const sensitiveValues = collectSensitiveValues(ctx.identityCreds);
  if (identity?.emailAddress) sensitiveValues.push(identity.emailAddress);

  const events = [];
  const emit = (event, payload, usage = {}) => {
    const envelope = createAgentEvent({
      event,
      agent: {
        id: DEVTESTBOT_DEFINITION.id,
        persona: DEVTESTBOT_DEFINITION.persona,
        color: DEVTESTBOT_DEFINITION.color,
        avatar: DEVTESTBOT_DEFINITION.avatar,
      },
      payload: sanitizeJson(payload, sensitiveValues),
      usage,
      runId,
      sessionId: ctx.sessionId,
    });
    events.push(envelope);
    if (typeof ctx.onEvent === "function") {
      ctx.onEvent(envelope);
    }
    return envelope;
  };

  const startedAt = Date.now();
  emit("agent_start", {
    runId,
    scope,
    execute,
    lanes: DEVTESTBOT_LANES,
    identity: summarizeIdentity(identity, identityId, registryPath),
  });

  emit("tool_call", {
    tool: DEVTESTBOT_RUN_SESSION_TOOL.name,
    input: {
      scope,
      identityId: identityId || null,
      baseUrl: safeUrlForOutput(baseUrl, sensitiveValues),
      recordVideo,
      execute,
    },
  });

  let runner = null;
  try {
    if (!execute) {
      const dryRun = await buildDryRunResult({
        runId,
        scope,
        baseUrl,
        artifactRoot,
        sensitiveValues,
      });
      for (const finding of dryRun.findings) {
        emit("finding", { finding });
      }
      emit("tool_result", {
        tool: DEVTESTBOT_RUN_SESSION_TOOL.name,
        success: true,
        dryRun: true,
        artifactBundle: dryRun.artifactBundle,
        findingCount: dryRun.findings.length,
      }, usageSnapshot(startedAt, 1));
      emit("agent_complete", {
        runId,
        scope,
        completed: true,
        dryRun: true,
        artifactBundle: dryRun.artifactBundle,
        findingCount: dryRun.findings.length,
      }, usageSnapshot(startedAt, 1));
      return writeDevTestBotResult({
        runId,
        scope,
        completed: true,
        dryRun: true,
        artifactRoot,
        artifactBundle: dryRun.artifactBundle,
        artifacts: dryRun.artifacts,
        findings: dryRun.findings,
        laneSummaries: dryRun.laneSummaries,
        events,
        sensitiveValues,
      });
    }

    const normalizedBaseUrl = normalizeBaseUrl(baseUrl);
    const launchImpl = ctx.launchImpl || input.launchImpl || launch;
    runner = await launchImpl({
      baseUrl: normalizedBaseUrl,
      identityCreds,
      outputDir: artifactRoot,
      recordVideo,
      runLighthouse: input.runLighthouse !== undefined ? Boolean(input.runLighthouse) : true,
      lighthouseTimeoutMs: input.lighthouseTimeoutMs,
      headless: input.headless !== undefined ? Boolean(input.headless) : true,
    });

    await driveScope({ runner, scope });
    const runnerResult = await runner.finalize();
    runner = null;
    const artifacts = sanitizeArtifacts(runnerResult.artifacts || {}, sensitiveValues);
    const laneSummaries = await summarizeArtifactLanes({ artifacts, sensitiveValues, scope });
    const findings = buildFindingsFromLaneSummaries({
      scope,
      artifacts,
      laneSummaries,
      sensitiveValues,
    });

    for (const finding of findings) {
      emit("finding", { finding });
    }
    emit("tool_result", {
      tool: DEVTESTBOT_RUN_SESSION_TOOL.name,
      success: true,
      dryRun: false,
      artifactBundle: {
        root: artifactRoot,
        artifacts,
      },
      findingCount: findings.length,
      laneSummaries,
    }, usageSnapshot(startedAt, 1));
    emit("agent_complete", {
      runId,
      scope,
      completed: true,
      dryRun: false,
      findingCount: findings.length,
    }, usageSnapshot(startedAt, 1));

    return writeDevTestBotResult({
      runId,
      scope,
      completed: true,
      dryRun: false,
      artifactRoot,
      artifacts,
      findings,
      laneSummaries,
      events,
      sensitiveValues,
    });
  } catch (error) {
    const safeMessage = redactSessionText(error?.message || String(error), sensitiveValues);
    emit("agent_error", {
      runId,
      scope,
      error: safeMessage,
      code: error?.code || "DEVTESTBOT_SESSION_FAILED",
    }, usageSnapshot(startedAt, 1));
    await writeDevTestBotResult({
      runId,
      scope,
      completed: false,
      dryRun: !execute,
      artifactRoot,
      artifacts: {},
      findings: [],
      laneSummaries: {},
      events,
      sensitiveValues,
      error: safeMessage,
    }).catch(() => null);
    throw new DevTestBotToolError(`devtestbot.run_session failed: ${safeMessage}`, {
      code: error?.code || "DEVTESTBOT_SESSION_FAILED",
      cause: error,
    });
  } finally {
    if (runner && typeof runner.close === "function") {
      await runner.close().catch(() => {});
    }
  }
}

function createRunId() {
  return "devtestbot-session-" + new Date().toISOString().replace(/[:.]/g, "-") + "-" + randomUUID().slice(0, 8);
}

function normalizeString(value) {
  return String(value || "").trim();
}

function normalizeScope(value) {
  const normalized = normalizeString(value).toLowerCase().replace(/\s+/g, "-");
  return normalized || "smoke";
}

function requiresIdentity(scope) {
  return /auth|password|reset|otp|email/.test(scope);
}

function normalizeBaseUrl(value) {
  const normalized = normalizeString(value);
  if (!normalized) {
    throw new DevTestBotToolError("baseUrl is required when devtestbot.run_session executes browser lanes.", {
      code: "DEVTESTBOT_BASE_URL_REQUIRED",
    });
  }
  let parsed;
  try {
    parsed = new URL(normalized);
  } catch (error) {
    throw new DevTestBotToolError("baseUrl must be an absolute URL.", {
      code: "DEVTESTBOT_BASE_URL_INVALID",
      cause: error,
    });
  }
  if (!["http:", "https:"].includes(parsed.protocol)) {
    throw new DevTestBotToolError("baseUrl must use http or https.", {
      code: "DEVTESTBOT_BASE_URL_UNSUPPORTED",
    });
  }
  return parsed.href.replace(/\/+$/, "");
}

async function resolveIdentity({ outputRoot, identityId, requireIdentity }) {
  if (!identityId) {
    if (requireIdentity) {
      throw new DevTestBotToolError("identityId is required for auth/password-reset devTestBot scopes.", {
        code: "DEVTESTBOT_IDENTITY_REQUIRED",
      });
    }
    return { registryPath: "", identity: null };
  }
  const result = await getIdentityById({ outputRoot, identityId });
  if (!result.identity && requireIdentity) {
    throw new DevTestBotToolError(`Identity '${identityId}' is not present in local registry.`, {
      code: "DEVTESTBOT_IDENTITY_NOT_FOUND",
    });
  }
  return result;
}

function buildInternalIdentityCreds({ identity, identityId, privateIdentityCreds }) {
  const privateCreds = privateIdentityCreds && typeof privateIdentityCreds === "object" ? privateIdentityCreds : {};
  return {
    ...privateCreds,
    identityId: identity?.identityId || identityId || privateCreds.identityId || null,
    email: identity?.emailAddress || privateCreds.email || privateCreds.username || null,
  };
}

function summarizeIdentity(identity, identityId, registryPath) {
  return {
    provided: Boolean(identityId),
    identityId: identity?.identityId || identityId || null,
    status: identity?.status || null,
    registryPath: registryPath || "",
  };
}

async function driveScope({ runner, scope }) {
  await runner.goto("/");
  if (/auth|password|reset|otp|email|full/.test(scope)) {
    await runner.page?.waitForTimeout?.(250).catch(() => {});
  }
}

async function buildDryRunResult({ runId, scope, baseUrl, artifactRoot, sensitiveValues }) {
  const artifacts = {
    manifestPath: path.join(artifactRoot, "manifest.json"),
  };
  const laneSummaries = Object.fromEntries(
    DEVTESTBOT_LANES.map((lane) => [
      lane,
      {
        status: "not_executed",
        dryRun: true,
      },
    ])
  );
  const findings = [
    normalizeFinding({
      severity: "P3",
      title: "devTestBot browser lanes were not executed",
      evidence: "swarm run was invoked without --execute, so devTestBot wrote a dry-run artifact bundle only.",
      rootCause: "Runtime execution was disabled.",
      recommendedFix: "Run with --execute --start-url <approved URL> to collect browser evidence.",
      trafficLight: "yellow",
      confidence: 0.82,
      lane: "dry_run",
      artifacts,
      reproduction: {
        type: "runtime_probe",
        steps: ["Run devtestbot.run_session with execute=true and an approved baseUrl."],
      },
      user_impact: "Operators do not receive browser runtime evidence until execution is enabled.",
    }, sensitiveValues),
  ];
  await writeJson(artifacts.manifestPath, {
    runId,
    scope,
    generatedAt: new Date().toISOString(),
    dryRun: true,
    baseUrl: safeUrlForOutput(baseUrl, sensitiveValues),
    lanes: laneSummaries,
  });
  return {
    artifacts,
    laneSummaries,
    findings,
    artifactBundle: {
      root: artifactRoot,
      manifestPath: artifacts.manifestPath,
      artifacts,
    },
  };
}

async function summarizeArtifactLanes({ artifacts, sensitiveValues, scope }) {
  const consolePayload = await readJsonIfPresent(artifacts.consolePath);
  const networkPayload = await readJsonIfPresent(artifacts.networkPath);
  const a11yPayload = await readJsonIfPresent(artifacts.a11yPath);
  const lighthousePayload = await readJsonIfPresent(artifacts.lighthousePath);
  const clickPayload = await readJsonIfPresent(artifacts.clickCoveragePath);

  const consoleEvents = Array.isArray(consolePayload?.events) ? consolePayload.events : [];
  const networkEvents = Array.isArray(networkPayload?.events) ? networkPayload.events : [];
  const a11yViolations = Array.isArray(a11yPayload?.violations) ? a11yPayload.violations : [];
  const clicks = Array.isArray(clickPayload?.clicks) ? clickPayload.clicks : [];
  const scores = extractLighthouseScores(lighthousePayload);

  return sanitizeJson({
    console_errors: {
      status: "executed",
      count: consoleEvents.filter((event) => ["error", "pageerror"].includes(String(event.type || ""))).length,
      total: consoleEvents.length,
      artifactPath: artifacts.consolePath || "",
    },
    network_errors: {
      status: "executed",
      failedRequests: networkEvents.filter((event) => event.phase === "requestfailed").length,
      serverErrors: networkEvents.filter((event) => Number(event.status || 0) >= 500).length,
      clientErrors: networkEvents.filter((event) => Number(event.status || 0) >= 400 && Number(event.status || 0) < 500).length,
      total: networkEvents.length,
      artifactPath: artifacts.networkPath || "",
    },
    a11y: {
      status: a11yPayload?.available === false ? "unavailable" : "executed",
      violations: a11yViolations.length,
      critical: a11yViolations.filter((item) => item.impact === "critical" || item.impact === "serious").length,
      artifactPath: artifacts.a11yPath || "",
    },
    lighthouse: {
      status: lighthousePayload?.available === false ? "unavailable" : "executed",
      scores,
      artifactPath: artifacts.lighthousePath || "",
    },
    click_coverage: {
      status: "executed",
      clicks: clicks.length,
      artifactPath: artifacts.clickCoveragePath || "",
    },
    password_reset_e2e: {
      status: /password|reset|otp|email|auth/.test(scope) ? "not_configured" : "not_in_scope",
      artifactPath: "",
    },
  }, sensitiveValues);
}

function buildFindingsFromLaneSummaries({ scope, artifacts, laneSummaries, sensitiveValues }) {
  const findings = [];
  if (laneSummaries.console_errors?.count > 0) {
    findings.push(normalizeFinding({
      severity: "P1",
      title: "Browser console errors detected during devTestBot run",
      evidence: `console.json records ${laneSummaries.console_errors.count} redacted error event(s).`,
      rootCause: "Runtime JavaScript emitted console errors or page errors during the configured scope.",
      recommendedFix: "Inspect the failing runtime path and add browser regression coverage.",
      trafficLight: "yellow",
      confidence: 0.88,
      lane: "console_errors",
      artifacts,
      user_impact: "Users may encounter broken or degraded browser behavior on the tested path.",
    }, sensitiveValues));
  }

  const network = laneSummaries.network_errors || {};
  const networkFailureCount = Number(network.failedRequests || 0) + Number(network.serverErrors || 0) + Number(network.clientErrors || 0);
  if (networkFailureCount > 0) {
    findings.push(normalizeFinding({
      severity: Number(network.serverErrors || 0) > 0 || Number(network.failedRequests || 0) > 0 ? "P1" : "P2",
      title: "Network failures detected during devTestBot run",
      evidence: `network.json records ${networkFailureCount} redacted failed, 4xx, or 5xx request(s).`,
      rootCause: "The tested browser path encountered unsuccessful network responses.",
      recommendedFix: "Inspect the failing endpoint path and add a regression test for the user flow.",
      trafficLight: Number(network.serverErrors || 0) > 0 ? "yellow" : "green",
      confidence: 0.86,
      lane: "network_errors",
      artifacts,
      user_impact: "Users may see failed actions, missing content, or degraded runtime behavior.",
    }, sensitiveValues));
  }

  const a11y = laneSummaries.a11y || {};
  if (Number(a11y.violations || 0) > 0) {
    findings.push(normalizeFinding({
      severity: Number(a11y.critical || 0) > 0 ? "P1" : "P2",
      title: "Accessibility violations detected during devTestBot run",
      evidence: `a11y.json records ${a11y.violations} axe violation(s), ${a11y.critical || 0} serious or critical.`,
      rootCause: "The tested page violates automated accessibility rules.",
      recommendedFix: "Fix the axe-reported elements and add accessibility regression coverage.",
      trafficLight: Number(a11y.critical || 0) > 0 ? "yellow" : "green",
      confidence: 0.84,
      lane: "a11y",
      artifacts,
      user_impact: "Keyboard, screen-reader, or assistive-technology users may be blocked or degraded.",
    }, sensitiveValues));
  }

  const lighthouse = laneSummaries.lighthouse || {};
  const poorScores = Object.entries(lighthouse.scores || {})
    .filter(([, score]) => typeof score === "number" && score < DEVTESTBOT_DEFINITION.thresholds.lighthouseNeedsWorkScore);
  if (poorScores.length > 0) {
    findings.push(normalizeFinding({
      severity: poorScores.some(([, score]) => score < DEVTESTBOT_DEFINITION.thresholds.lighthousePoorScore) ? "P1" : "P2",
      title: "Lighthouse scores need attention",
      evidence: `lighthouse.json records score(s) below ${DEVTESTBOT_DEFINITION.thresholds.lighthouseNeedsWorkScore}: ${poorScores.map(([key, score]) => `${key}=${score}`).join(", ")}.`,
      rootCause: "The tested page misses one or more Lighthouse runtime quality thresholds.",
      recommendedFix: "Inspect the Lighthouse report and prioritize user-visible performance/accessibility regressions.",
      trafficLight: "green",
      confidence: 0.8,
      lane: "lighthouse",
      artifacts,
      user_impact: "Users may experience slower, less accessible, or less robust page behavior.",
    }, sensitiveValues));
  }

  if (/password|reset|otp|email|auth/.test(scope) && laneSummaries.password_reset_e2e?.status === "not_configured") {
    findings.push(normalizeFinding({
      severity: "P3",
      title: "Password reset E2E scope has no configured playbook",
      evidence: "devTestBot captured baseline browser lanes but no password-reset scenario actions were configured.",
      rootCause: "The runtime scope requested an auth/password-reset lane before a scenario playbook was attached.",
      recommendedFix: "Provide a scoped password-reset playbook or let the DD orchestrator attach one in PR-E3.",
      trafficLight: "yellow",
      confidence: 0.82,
      lane: "password_reset_e2e",
      artifacts,
      user_impact: "Operators do not yet have end-to-end password reset evidence for this run.",
    }, sensitiveValues));
  }

  return findings;
}

function normalizeFinding(input, sensitiveValues) {
  return sanitizeJson({
    severity: input.severity || "P3",
    file: input.file || RUNTIME_FILE,
    line: Number(input.line || 1),
    title: input.title || "devTestBot runtime finding",
    evidence: input.evidence || "devTestBot artifact bundle contains runtime evidence.",
    rootCause: input.rootCause || "Runtime evidence requires review.",
    recommendedFix: input.recommendedFix || "Inspect the referenced artifact bundle.",
    trafficLight: input.trafficLight || "yellow",
    reproduction: input.reproduction || {
      type: "runtime_probe",
      steps: ["Run devtestbot.run_session with the same scope and identityId."],
    },
    user_impact: input.user_impact || input.userImpact || "Users may experience degraded runtime behavior.",
    confidence: Math.max(0, Math.min(1, Number(input.confidence || DEVTESTBOT_DEFINITION.confidenceFloor))),
    lane: input.lane || "runtime",
    artifacts: sanitizeArtifacts(input.artifacts || {}, sensitiveValues),
  }, sensitiveValues);
}

async function writeDevTestBotResult({
  runId,
  scope,
  completed,
  dryRun,
  artifactRoot,
  artifacts,
  artifactBundle,
  findings,
  laneSummaries,
  events,
  sensitiveValues,
  error = "",
}) {
  const findingsPath = path.join(artifactRoot, "findings.json");
  const eventsPath = path.join(artifactRoot, "events.ndjson");
  const resultPath = path.join(artifactRoot, "devtestbot-result.json");
  const fullArtifactBundle = {
    root: artifactRoot,
    ...(artifactBundle || {}),
    findingsPath,
    eventsPath,
    resultPath,
    artifacts: sanitizeArtifacts(artifacts || artifactBundle?.artifacts || {}, sensitiveValues),
  };
  await writeJson(findingsPath, findings);
  await fsp.writeFile(eventsPath, `${events.map((event) => JSON.stringify(event)).join("\n")}\n`, "utf-8");
  const result = sanitizeJson({
    schemaVersion: 1,
    runId,
    generatedAt: new Date().toISOString(),
    agentId: DEVTESTBOT_DEFINITION.id,
    scope,
    completed,
    dryRun,
    findingCount: findings.length,
    findings,
    laneSummaries,
    artifactBundle: fullArtifactBundle,
    artifacts: fullArtifactBundle.artifacts,
    events,
    error: error || undefined,
  }, sensitiveValues);
  await writeJson(resultPath, result);
  return result;
}

function sanitizeArtifacts(artifacts = {}, sensitiveValues = []) {
  const output = {};
  for (const [key, value] of Object.entries(artifacts || {})) {
    if (typeof value === "string") {
      output[key] = redactSessionText(value, sensitiveValues);
    }
  }
  return output;
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

function safeUrlForOutput(rawUrl, sensitiveValues) {
  if (!rawUrl) return "";
  try {
    const parsed = new URL(rawUrl);
    for (const key of [...parsed.searchParams.keys()]) {
      if (SENSITIVE_KEY_PATTERN.test(key)) {
        parsed.searchParams.set(key, "[REDACTED]");
      }
    }
    return redactSessionText(parsed.href, sensitiveValues);
  } catch {
    return redactSessionText(rawUrl, sensitiveValues);
  }
}

function sanitizeJson(value, sensitiveValues = []) {
  if (Array.isArray(value)) return value.map((item) => sanitizeJson(item, sensitiveValues));
  if (value && typeof value === "object") {
    const output = {};
    for (const [key, item] of Object.entries(value)) {
      output[key] = SENSITIVE_FIELD_PATTERN.test(key)
        ? "[REDACTED]"
        : sanitizeJson(item, sensitiveValues);
    }
    return output;
  }
  if (typeof value === "string") return redactSessionText(value, sensitiveValues);
  return value;
}

function redactSessionText(value, sensitiveValues = []) {
  let text = String(value ?? "");
  for (const sensitiveValue of sensitiveValues) {
    if (!sensitiveValue) continue;
    text = text.split(sensitiveValue).join("[REDACTED]");
  }
  return text
    .replace(/\b(?:bearer|token|password|secret|api[_-]?key|session)\s*[:=]\s*["']?[^"'\s&]+/gi, (match) =>
      match.replace(/[:=]\s*["']?.*$/u, "=[REDACTED]")
    )
    .replace(EXTRA_SECRET_PATTERN, (match) => match.replace(/[:=]\s*["']?.*$/u, "=[REDACTED]"));
}

function collectSensitiveValues(value, out = []) {
  if (value == null) return out;
  if (typeof value === "string") {
    if (value.length >= 4) out.push(value);
    return out;
  }
  if (typeof value !== "object") return out;
  for (const item of Object.values(value)) {
    collectSensitiveValues(item, out);
  }
  return out;
}

function usageSnapshot(startedAt, toolCalls) {
  return {
    costUsd: 0,
    outputTokens: 0,
    toolCalls,
    durationMs: Date.now() - startedAt,
  };
}

async function readJsonIfPresent(filePath) {
  if (!filePath) return null;
  try {
    return JSON.parse(await fsp.readFile(filePath, "utf-8"));
  } catch {
    return null;
  }
}

async function writeJson(filePath, payload) {
  await fsp.mkdir(path.dirname(filePath), { recursive: true });
  await fsp.writeFile(filePath, `${JSON.stringify(payload, null, 2)}\n`, "utf-8");
}
