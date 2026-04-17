import { randomUUID } from "node:crypto";
import fsp from "node:fs/promises";
import path from "node:path";
import process from "node:process";

import { resolveOutputRoot } from "../config/service.js";
import { createAgentEvent } from "../events/schema.js";
import { collectCodebaseIngest } from "../ingest/engine.js";
import { appendToStream } from "../session/stream.js";
import { parseAstModuleSpecifiers } from "./ast-parser-layer.js";
import { buildCallgraphOverlay } from "./callgraph-overlay.js";

const SCOPE_ENGINE_AGENT_ID = "scope-engine";
const DEFAULT_MAX_CANDIDATE_FILES = 28;
const DEFAULT_MAX_SEMANTIC_FILES = 8;
const DEFAULT_SEMANTIC_SIGNAL_THRESHOLD = 10;
const DEFAULT_ALLOWED_TOOLS = Object.freeze(["file_read", "grep", "glob"]);
const DEFAULT_DENIED_PATTERNS = Object.freeze([
  ".git/**",
  "node_modules/**",
  ".sentinelayer/**",
  "dist/**",
  "build/**",
  "coverage/**",
]);
const INTAKE_TOKEN_STOP_WORDS = new Set([
  "api",
  "v1",
  "v2",
  "v3",
  "error",
  "service",
  "route",
  "handler",
  "request",
  "response",
  "timeout",
  "failed",
  "failure",
  "unknown",
]);
const SEVERITY_BUDGETS = Object.freeze({
  P0: Object.freeze({
    maxTokens: 9_000,
    maxCostUsd: 2.5,
    maxRuntimeMinutes: 25,
    maxToolCalls: 90,
  }),
  P1: Object.freeze({
    maxTokens: 7_500,
    maxCostUsd: 2.0,
    maxRuntimeMinutes: 20,
    maxToolCalls: 75,
  }),
  P2: Object.freeze({
    maxTokens: 6_000,
    maxCostUsd: 1.5,
    maxRuntimeMinutes: 15,
    maxToolCalls: 60,
  }),
  P3: Object.freeze({
    maxTokens: 4_000,
    maxCostUsd: 1.0,
    maxRuntimeMinutes: 12,
    maxToolCalls: 45,
  }),
  UNKNOWN: Object.freeze({
    maxTokens: 3_000,
    maxCostUsd: 0.7,
    maxRuntimeMinutes: 10,
    maxToolCalls: 35,
  }),
});
const ACTIVE_SCOPE_RUNS = new Map();

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function normalizeString(value) {
  return String(value || "").trim();
}

function normalizeIsoTimestamp(value, fallbackIso = new Date().toISOString()) {
  const normalized = normalizeString(value);
  if (!normalized) {
    return fallbackIso;
  }
  const epoch = Date.parse(normalized);
  if (!Number.isFinite(epoch)) {
    return fallbackIso;
  }
  return new Date(epoch).toISOString();
}

function normalizePositiveInteger(value, fallbackValue) {
  const normalized = Number(value);
  if (!Number.isFinite(normalized) || normalized <= 0) {
    return fallbackValue;
  }
  return Math.max(1, Math.floor(normalized));
}

function normalizeNonNegativeNumber(value, fallbackValue = 0) {
  const normalized = Number(value);
  if (!Number.isFinite(normalized) || normalized < 0) {
    return fallbackValue;
  }
  return normalized;
}

function normalizeSeverity(value) {
  const normalized = normalizeString(value).toUpperCase();
  if (normalized === "P0" || normalized === "P1" || normalized === "P2" || normalized === "P3") {
    return normalized;
  }
  return "UNKNOWN";
}

function toPosixPath(value = "") {
  return String(value || "").replace(/\\/g, "/");
}

function normalizeStringArray(values = []) {
  if (!Array.isArray(values)) {
    return [];
  }
  const deduped = new Set();
  for (const value of values) {
    const normalized = normalizeString(value);
    if (!normalized) {
      continue;
    }
    deduped.add(toPosixPath(normalized));
  }
  return [...deduped];
}

function normalizeDomainAllowlist(values = []) {
  if (!Array.isArray(values)) {
    return [];
  }
  const deduped = new Set();
  for (const value of values) {
    const normalized = normalizeString(value).toLowerCase();
    if (!normalized) {
      continue;
    }
    deduped.add(normalized);
  }
  return [...deduped];
}

function deepFreeze(value) {
  if (!value || typeof value !== "object") {
    return value;
  }
  Object.freeze(value);
  for (const child of Object.values(value)) {
    if (child && typeof child === "object" && !Object.isFrozen(child)) {
      deepFreeze(child);
    }
  }
  return value;
}

export const ISSUE_SCOPE_ENVELOPE_VERSION = "scope-envelope/v1";
export const ISSUE_SCOPE_ENVELOPE_V1_SCHEMA = deepFreeze({
  $id: "https://sentinelayer.com/schemas/issue-scope-envelope-v1.schema.json",
  $schema: "https://json-schema.org/draft/2020-12/schema",
  version: ISSUE_SCOPE_ENVELOPE_VERSION,
  required: Object.freeze([
    "workItemId",
    "deterministicPack",
    "candidateFiles",
    "endpointMapping",
    "budgetEnvelope",
    "allowedTools",
    "version",
  ]),
});

function buildDayKey(nowIso = new Date().toISOString()) {
  return normalizeIsoTimestamp(nowIso, new Date().toISOString()).slice(0, 10);
}

function deriveLocBucket(totalLoc = 0) {
  const normalized = normalizeNonNegativeNumber(totalLoc, 0);
  if (normalized < 2_500) return "small";
  if (normalized < 10_000) return "medium";
  if (normalized < 40_000) return "large";
  return "xlarge";
}

function splitTokens(value) {
  return normalizeString(value)
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .map((token) => token.trim())
    .filter(Boolean);
}

function buildIntakeTokens(intakeEvent = {}) {
  const tokens = new Set();
  for (const source of [
    intakeEvent.service,
    intakeEvent.endpoint,
    intakeEvent.errorCode,
    intakeEvent.message,
  ]) {
    for (const token of splitTokens(source)) {
      if (token.length < 3) {
        continue;
      }
      if (INTAKE_TOKEN_STOP_WORDS.has(token)) {
        continue;
      }
      tokens.add(token);
    }
  }
  return [...tokens];
}

function deriveEndpointTokens(endpoint = "") {
  return splitTokens(endpoint)
    .filter((token) => token.length >= 3 && !/^v[0-9]+$/.test(token))
    .slice(0, 8);
}

function normalizeIntakeEvent(intakeEvent = {}, nowIso = new Date().toISOString()) {
  const normalized = isPlainObject(intakeEvent) ? intakeEvent : {};
  return {
    workItemId: normalizeString(normalized.workItemId || normalized.work_item_id),
    service: normalizeString(normalized.service) || "unknown-service",
    endpoint: normalizeString(normalized.endpoint),
    errorCode: normalizeString(normalized.errorCode || normalized.error_code) || "UNKNOWN_ERROR",
    message: normalizeString(normalized.message),
    severity: normalizeSeverity(normalized.severity),
    metadata: isPlainObject(normalized.metadata) ? { ...normalized.metadata } : {},
    occurredAt: normalizeIsoTimestamp(
      normalized.occurredAt || normalized.occurred_at || normalized.first_seen_at,
      nowIso
    ),
  };
}

function createAbortError(reason = "manual_stop") {
  const normalizedReason = normalizeString(reason) || "manual_stop";
  const error = new Error(`Scope engine run aborted: ${normalizedReason}.`);
  error.name = "AbortError";
  error.code = "ABORT_ERR";
  error.reason = normalizedReason;
  return error;
}

function throwIfAborted(runState) {
  if (runState.controller.signal.aborted) {
    throw createAbortError(runState.stopReason);
  }
}

function buildRunKey(sessionId, workItemId, targetPath) {
  return `${path.resolve(String(targetPath || "."))}::${normalizeString(sessionId)}::${normalizeString(workItemId)}`;
}

function toRunSnapshot(runState) {
  return {
    runKey: runState.runKey,
    runId: runState.runId,
    sessionId: runState.sessionId || null,
    workItemId: runState.workItemId,
    targetPath: runState.targetPath,
    startedAt: runState.startedAt,
    running: runState.running,
    stopReason: runState.stopReason || null,
  };
}

function scoreCandidatePath(filePath, intakeTokens = [], endpointTokens = [], service = "") {
  const normalizedPath = toPosixPath(filePath).toLowerCase();
  if (!normalizedPath) {
    return { score: 0, reasons: [] };
  }

  let score = 0;
  const reasons = [];
  for (const token of intakeTokens) {
    if (normalizedPath.includes(token)) {
      score += 2;
      if (reasons.length < 3) {
        reasons.push(`path_token:${token}`);
      }
    }
  }
  for (const token of endpointTokens) {
    if (normalizedPath.includes(token)) {
      score += 3;
      if (reasons.length < 3) {
        reasons.push(`endpoint_token:${token}`);
      }
    }
  }
  const normalizedService = normalizeString(service).toLowerCase();
  if (normalizedService && normalizedPath.includes(normalizedService.replace(/[^a-z0-9]/g, ""))) {
    score += 2;
    if (reasons.length < 3) {
      reasons.push("service_hint");
    }
  }
  if (score > 0 && /(api|route|router|controller|handler|service|daemon|worker)/.test(normalizedPath)) {
    score += 1;
    if (reasons.length < 3) {
      reasons.push("runtime_surface");
    }
  }
  if (/\.test\.|\.spec\.|fixtures?|docs\//.test(normalizedPath)) {
    score = Math.max(0, score - 1);
  }
  return { score, reasons };
}

function createCandidateFiles({
  indexedFiles = [],
  intakeTokens = [],
  endpointTokens = [],
  intakeEvent = {},
  maxCandidateFiles = DEFAULT_MAX_CANDIDATE_FILES,
} = {}) {
  const scored = [];
  for (const file of indexedFiles) {
    const pathValue = toPosixPath(file.path);
    if (!pathValue) {
      continue;
    }
    const scoreResult = scoreCandidatePath(
      pathValue,
      intakeTokens,
      endpointTokens,
      intakeEvent.service
    );
    if (scoreResult.score <= 0) {
      continue;
    }
    scored.push({
      path: pathValue,
      score: scoreResult.score,
      reason: scoreResult.reasons.join(",") || "deterministic_path_match",
    });
  }

  scored.sort((left, right) => {
    if (right.score !== left.score) {
      return right.score - left.score;
    }
    return left.path.localeCompare(right.path);
  });
  return scored.slice(0, normalizePositiveInteger(maxCandidateFiles, DEFAULT_MAX_CANDIDATE_FILES));
}

function createEndpointMapping(endpoint = "", candidateFiles = []) {
  const normalizedEndpoint = normalizeString(endpoint);
  if (!normalizedEndpoint) {
    return [];
  }
  const endpointTokens = deriveEndpointTokens(normalizedEndpoint);
  let mapped = candidateFiles.filter((candidate) => {
    const normalizedPath = toPosixPath(candidate.path).toLowerCase();
    return endpointTokens.some((token) => normalizedPath.includes(token));
  });
  if (mapped.length === 0) {
    mapped = candidateFiles.slice(0, 3);
  }
  return [
    {
      endpoint: normalizedEndpoint,
      files: mapped.map((candidate) => toPosixPath(candidate.path)),
    },
  ];
}

function deriveAllowedAndDeniedPaths(candidateFiles = [], ingest = {}) {
  const allowedRoots = new Set();
  const allowedExactFiles = new Set();
  for (const candidate of candidateFiles.slice(0, 12)) {
    const normalizedPath = toPosixPath(candidate.path);
    if (!normalizedPath) {
      continue;
    }
    const slashIndex = normalizedPath.indexOf("/");
    if (slashIndex <= 0) {
      allowedExactFiles.add(normalizedPath);
      continue;
    }
    allowedRoots.add(normalizedPath.slice(0, slashIndex));
  }

  if (allowedRoots.size === 0 && allowedExactFiles.size === 0) {
    const fallbackEntryPoints = Array.isArray(ingest.entryPoints) ? ingest.entryPoints : [];
    for (const entryPoint of fallbackEntryPoints.slice(0, 3)) {
      const normalized = toPosixPath(entryPoint);
      const slashIndex = normalized.indexOf("/");
      if (slashIndex <= 0) {
        allowedExactFiles.add(normalized);
      } else {
        allowedRoots.add(normalized.slice(0, slashIndex));
      }
    }
  }

  const topLevelDirectories = normalizeStringArray(ingest?.topLevel?.directories || []);
  if (allowedRoots.size === 0 && topLevelDirectories.length > 0) {
    allowedRoots.add(topLevelDirectories[0]);
  }

  const allowedPaths = [
    ...[...allowedRoots].sort((left, right) => left.localeCompare(right)).map((root) => `${root}/**`),
    ...[...allowedExactFiles].sort((left, right) => left.localeCompare(right)),
  ];
  const deniedSet = new Set(DEFAULT_DENIED_PATTERNS);
  for (const directory of topLevelDirectories) {
    if (!allowedRoots.has(directory)) {
      deniedSet.add(`${directory}/**`);
    }
  }

  return {
    allowedPaths,
    deniedPaths: [...deniedSet].sort((left, right) => left.localeCompare(right)),
  };
}

function deriveAllowedTools(intakeEvent = {}, ingest = {}) {
  const metadata = intakeEvent.metadata || {};
  const fromMetadata = normalizeStringArray(metadata.allowed_tools || metadata.allowedTools || []);
  if (fromMetadata.length > 0) {
    return fromMetadata;
  }

  const tools = new Set(DEFAULT_ALLOWED_TOOLS);
  const riskSurfaces = Array.isArray(ingest.riskSurfaces) ? ingest.riskSurfaces : [];
  if (riskSurfaces.includes("ci_cd_pipeline")) {
    tools.add("file_read");
    tools.add("grep");
  }
  return [...tools];
}

function deriveBudgetEnvelope({
  intakeEvent = {},
  candidateFiles = [],
  allowedPaths = [],
  deniedPaths = [],
} = {}) {
  const severity = normalizeSeverity(intakeEvent.severity);
  const baseBudget = SEVERITY_BUDGETS[severity] || SEVERITY_BUDGETS.UNKNOWN;
  const candidateCount = Math.max(1, candidateFiles.length);
  const tokenBoost = Math.min(4_000, candidateCount * 120);
  const toolCallBoost = Math.min(40, Math.ceil(candidateCount / 2));
  const metadata = intakeEvent.metadata || {};
  return {
    maxTokens: baseBudget.maxTokens + tokenBoost,
    maxCostUsd: Number((baseBudget.maxCostUsd + Math.min(0.75, candidateCount * 0.01)).toFixed(3)),
    maxRuntimeMinutes: baseBudget.maxRuntimeMinutes + Math.min(10, Math.ceil(candidateCount / 4)),
    maxToolCalls: baseBudget.maxToolCalls + toolCallBoost,
    networkDomainAllowlist: normalizeDomainAllowlist(
      metadata.networkDomainAllowlist || metadata.network_domain_allowlist || []
    ),
    allowedPaths: normalizeStringArray(allowedPaths),
    deniedPaths: normalizeStringArray(deniedPaths),
  };
}

function computeSemanticSignalScore(candidateFiles = [], intakeEvent = {}) {
  const topCandidates = candidateFiles.slice(0, 5);
  const candidateScore = topCandidates.reduce(
    (sum, candidate) => sum + normalizeNonNegativeNumber(candidate.score, 0),
    0
  );
  const endpointBoost = normalizeString(intakeEvent.endpoint) ? 2 : 0;
  const serviceBoost = normalizeString(intakeEvent.service) ? 1 : 0;
  return candidateScore + endpointBoost + serviceBoost;
}

function shouldAttachSemanticOverlay({
  candidateFiles = [],
  signalScore = 0,
  semanticSignalThreshold = DEFAULT_SEMANTIC_SIGNAL_THRESHOLD,
  maxSemanticFiles = DEFAULT_MAX_SEMANTIC_FILES,
} = {}) {
  if (!Array.isArray(candidateFiles) || candidateFiles.length === 0) {
    return false;
  }
  if (candidateFiles.length > normalizePositiveInteger(maxSemanticFiles, DEFAULT_MAX_SEMANTIC_FILES)) {
    return false;
  }
  return signalScore >= normalizePositiveInteger(
    semanticSignalThreshold,
    DEFAULT_SEMANTIC_SIGNAL_THRESHOLD
  );
}

async function collectSemanticOverlay({
  rootPath,
  indexedFilesByPath,
  candidateFiles,
  maxSemanticFiles = DEFAULT_MAX_SEMANTIC_FILES,
  signalScore = 0,
  semanticSignalThreshold = DEFAULT_SEMANTIC_SIGNAL_THRESHOLD,
  runState,
} = {}) {
  const scopedPaths = candidateFiles
    .slice(0, normalizePositiveInteger(maxSemanticFiles, DEFAULT_MAX_SEMANTIC_FILES))
    .map((candidate) => toPosixPath(candidate.path))
    .filter(Boolean);
  const astEvidence = [];

  for (const scopedPath of scopedPaths) {
    throwIfAborted(runState);
    const metadata = indexedFilesByPath.get(scopedPath);
    if (!metadata) {
      continue;
    }
    const absolutePath = path.join(rootPath, scopedPath);
    let content = "";
    try {
      content = await fsp.readFile(absolutePath, "utf-8");
    } catch {
      continue;
    }
    const parsed = await parseAstModuleSpecifiers({
      absolutePath,
      content,
      language: metadata.language,
    });
    astEvidence.push({
      path: scopedPath,
      parserMode: normalizeString(parsed.parserMode) || "unknown",
      parseError: normalizeString(parsed.parseError),
      specifierCount: Array.isArray(parsed.specifiers) ? parsed.specifiers.length : 0,
      specifiers: Array.isArray(parsed.specifiers) ? parsed.specifiers.slice(0, 8) : [],
    });
  }

  throwIfAborted(runState);
  const callgraph = await buildCallgraphOverlay({
    rootPath,
    indexedFilesByPath,
    scopedPaths,
  });
  const symbols = [...new Set(callgraph.nodes.map((node) => normalizeString(node.symbol)).filter(Boolean))]
    .sort((left, right) => left.localeCompare(right))
    .slice(0, 180);
  const callHierarchy = callgraph.edges.slice(0, 220).map((edge) => ({
    from: normalizeString(edge.from),
    to: normalizeString(edge.to),
    callee: normalizeString(edge.callee),
  }));

  return {
    mode: "on_demand_ast_callgraph",
    signalScore,
    signalThreshold: normalizePositiveInteger(
      semanticSignalThreshold,
      DEFAULT_SEMANTIC_SIGNAL_THRESHOLD
    ),
    symbols,
    callHierarchy,
    astEvidence,
    callgraphSummary: callgraph.summary,
  };
}

export function validateIssueScopeEnvelope(envelope, { throwOnError = false } = {}) {
  const errors = [];
  if (!isPlainObject(envelope)) {
    errors.push("Envelope must be an object.");
  }

  const version = normalizeString(envelope?.version);
  if (version !== ISSUE_SCOPE_ENVELOPE_VERSION) {
    errors.push(`version must be '${ISSUE_SCOPE_ENVELOPE_VERSION}'.`);
  }

  if (!normalizeString(envelope?.workItemId)) {
    errors.push("workItemId is required.");
  }

  const deterministicPack = envelope?.deterministicPack;
  if (!isPlainObject(deterministicPack)) {
    errors.push("deterministicPack must be an object.");
  } else {
    if (!Array.isArray(deterministicPack.frameworks)) {
      errors.push("deterministicPack.frameworks must be an array.");
    }
    if (!Array.isArray(deterministicPack.riskSurfaces)) {
      errors.push("deterministicPack.riskSurfaces must be an array.");
    }
    if (!normalizeString(deterministicPack.locBucket)) {
      errors.push("deterministicPack.locBucket is required.");
    }
  }

  if (!Array.isArray(envelope?.candidateFiles)) {
    errors.push("candidateFiles must be an array.");
  } else {
    for (const candidate of envelope.candidateFiles) {
      if (!normalizeString(candidate?.path)) {
        errors.push("candidateFiles[*].path is required.");
        break;
      }
      if (!Number.isFinite(Number(candidate?.score)) || Number(candidate.score) < 0) {
        errors.push("candidateFiles[*].score must be a non-negative number.");
        break;
      }
      if (!normalizeString(candidate?.reason)) {
        errors.push("candidateFiles[*].reason is required.");
        break;
      }
    }
  }

  if (!Array.isArray(envelope?.endpointMapping)) {
    errors.push("endpointMapping must be an array.");
  }

  const budgetEnvelope = envelope?.budgetEnvelope;
  if (!isPlainObject(budgetEnvelope)) {
    errors.push("budgetEnvelope must be an object.");
  } else {
    if (!Number.isFinite(Number(budgetEnvelope.maxTokens)) || Number(budgetEnvelope.maxTokens) <= 0) {
      errors.push("budgetEnvelope.maxTokens must be > 0.");
    }
    if (!Number.isFinite(Number(budgetEnvelope.maxCostUsd)) || Number(budgetEnvelope.maxCostUsd) <= 0) {
      errors.push("budgetEnvelope.maxCostUsd must be > 0.");
    }
    if (
      !Number.isFinite(Number(budgetEnvelope.maxRuntimeMinutes)) ||
      Number(budgetEnvelope.maxRuntimeMinutes) <= 0
    ) {
      errors.push("budgetEnvelope.maxRuntimeMinutes must be > 0.");
    }
    if (!Number.isFinite(Number(budgetEnvelope.maxToolCalls)) || Number(budgetEnvelope.maxToolCalls) <= 0) {
      errors.push("budgetEnvelope.maxToolCalls must be > 0.");
    }
    if (!Array.isArray(budgetEnvelope.allowedPaths)) {
      errors.push("budgetEnvelope.allowedPaths must be an array.");
    }
    if (!Array.isArray(budgetEnvelope.deniedPaths)) {
      errors.push("budgetEnvelope.deniedPaths must be an array.");
    }
  }

  if (!Array.isArray(envelope?.allowedTools) || envelope.allowedTools.length === 0) {
    errors.push("allowedTools must contain at least one tool.");
  }

  if (envelope?.semanticOverlay !== undefined && envelope?.semanticOverlay !== null) {
    if (!isPlainObject(envelope.semanticOverlay)) {
      errors.push("semanticOverlay must be an object when present.");
    } else {
      if (!Array.isArray(envelope.semanticOverlay.symbols)) {
        errors.push("semanticOverlay.symbols must be an array.");
      }
      if (!Array.isArray(envelope.semanticOverlay.callHierarchy)) {
        errors.push("semanticOverlay.callHierarchy must be an array.");
      }
    }
  }

  if (errors.length > 0 && throwOnError) {
    throw new Error(`Invalid IssueScopeEnvelope: ${errors[0]}`);
  }
  return errors.length === 0;
}

async function emitScopeSessionEvent(
  sessionId,
  event,
  payload = {},
  {
    targetPath = process.cwd(),
    workItemId = "",
    nowIso = new Date().toISOString(),
  } = {}
) {
  const normalizedSessionId = normalizeString(sessionId);
  if (!normalizedSessionId) {
    return null;
  }
  const envelope = createAgentEvent({
    event,
    agentId: SCOPE_ENGINE_AGENT_ID,
    sessionId: normalizedSessionId,
    workItemId: normalizeString(workItemId) || undefined,
    ts: normalizeIsoTimestamp(nowIso, new Date().toISOString()),
    payload,
  });
  await appendToStream(normalizedSessionId, envelope, {
    targetPath,
  });
  return envelope;
}

export async function resolveScopeEngineStorage({
  targetPath = ".",
  outputDir = "",
  env,
  homeDir,
} = {}) {
  const outputRoot = await resolveOutputRoot({
    cwd: path.resolve(String(targetPath || ".")),
    outputDirOverride: outputDir,
    env,
    homeDir,
  });
  const observabilityRoot = path.join(outputRoot, "observability");
  const baseDir = path.join(observabilityRoot, "scope-engine");
  return {
    outputRoot,
    observabilityRoot,
    baseDir,
    runsDir: path.join(baseDir, "runs"),
  };
}

async function writeScopeEnvelopeArtifact(storage, workItemId, envelope, nowIso) {
  const artifactPath = path.join(
    storage.observabilityRoot,
    buildDayKey(nowIso),
    normalizeString(workItemId),
    "scope_envelope.json"
  );
  await fsp.mkdir(path.dirname(artifactPath), { recursive: true });
  await fsp.writeFile(artifactPath, `${JSON.stringify(envelope, null, 2)}\n`, "utf-8");
  return artifactPath;
}

function buildRunMetadataPath(storage, runId) {
  return path.join(storage.runsDir, `${runId}.json`);
}

async function persistRunMetadata(storage, payload) {
  const runPath = buildRunMetadataPath(storage, payload.runId);
  await fsp.mkdir(path.dirname(runPath), { recursive: true });
  await fsp.writeFile(runPath, `${JSON.stringify(payload, null, 2)}\n`, "utf-8");
  return runPath;
}

export function getScopeEngineRun(
  sessionId,
  { workItemId = "", targetPath = process.cwd() } = {}
) {
  const normalizedSessionId = normalizeString(sessionId);
  const normalizedWorkItemId = normalizeString(workItemId);
  const resolvedTargetPath = path.resolve(String(targetPath || "."));

  if (normalizedSessionId && normalizedWorkItemId) {
    const runKey = buildRunKey(normalizedSessionId, normalizedWorkItemId, resolvedTargetPath);
    const runState = ACTIVE_SCOPE_RUNS.get(runKey);
    return runState ? toRunSnapshot(runState) : null;
  }

  for (const runState of ACTIVE_SCOPE_RUNS.values()) {
    if (runState.targetPath !== resolvedTargetPath) {
      continue;
    }
    if (normalizedSessionId && runState.sessionId !== normalizedSessionId) {
      continue;
    }
    if (normalizedWorkItemId && runState.workItemId !== normalizedWorkItemId) {
      continue;
    }
    return toRunSnapshot(runState);
  }
  return null;
}

export async function stopScopeEngine({
  targetPath = ".",
  sessionId = "",
  workItemId = "",
  reason = "manual_stop",
} = {}) {
  const resolvedTargetPath = path.resolve(String(targetPath || "."));
  const normalizedSessionId = normalizeString(sessionId);
  const normalizedWorkItemId = normalizeString(workItemId);
  const normalizedReason = normalizeString(reason) || "manual_stop";

  const matchingRuns = [];
  for (const [runKey, runState] of ACTIVE_SCOPE_RUNS.entries()) {
    if (runState.targetPath !== resolvedTargetPath) {
      continue;
    }
    if (normalizedSessionId && runState.sessionId !== normalizedSessionId) {
      continue;
    }
    if (normalizedWorkItemId && runState.workItemId !== normalizedWorkItemId) {
      continue;
    }
    matchingRuns.push([runKey, runState]);
  }

  if (matchingRuns.length === 0) {
    return {
      stopped: false,
      count: 0,
      targetPath: resolvedTargetPath,
      sessionId: normalizedSessionId || null,
      workItemId: normalizedWorkItemId || null,
      reason: normalizedReason,
      runs: [],
    };
  }

  const stoppedRuns = [];
  for (const [runKey, runState] of matchingRuns) {
    runState.running = false;
    runState.stopReason = normalizedReason;
    ACTIVE_SCOPE_RUNS.delete(runKey);
    runState.controller.abort(createAbortError(normalizedReason));
    const event = await emitScopeSessionEvent(
      runState.sessionId,
      "agent_killed",
      {
        target: SCOPE_ENGINE_AGENT_ID,
        reason: normalizedReason,
        runId: runState.runId,
        workItemId: runState.workItemId,
      },
      {
        targetPath: runState.targetPath,
        workItemId: runState.workItemId,
      }
    );
    stoppedRuns.push({
      runKey,
      runId: runState.runId,
      workItemId: runState.workItemId,
      sessionId: runState.sessionId || null,
      reason: normalizedReason,
      event,
    });
  }

  return {
    stopped: true,
    count: stoppedRuns.length,
    targetPath: resolvedTargetPath,
    sessionId: normalizedSessionId || null,
    workItemId: normalizedWorkItemId || null,
    reason: normalizedReason,
    runs: stoppedRuns,
  };
}

export async function buildIssueScopeEnvelope({
  workItemId = "",
  intakeEvent = {},
  sessionId = "",
  targetPath = ".",
  outputDir = "",
  maxCandidateFiles = DEFAULT_MAX_CANDIDATE_FILES,
  maxSemanticFiles = DEFAULT_MAX_SEMANTIC_FILES,
  semanticSignalThreshold = DEFAULT_SEMANTIC_SIGNAL_THRESHOLD,
  signal,
  env,
  homeDir,
  nowIso = new Date().toISOString(),
} = {}) {
  const normalizedNow = normalizeIsoTimestamp(nowIso, new Date().toISOString());
  const normalizedSessionId = normalizeString(sessionId);
  const resolvedTargetPath = path.resolve(String(targetPath || "."));
  const normalizedIntake = normalizeIntakeEvent(intakeEvent, normalizedNow);
  const normalizedWorkItemId = normalizeString(workItemId) || normalizedIntake.workItemId;
  if (!normalizedWorkItemId) {
    throw new Error("workItemId is required.");
  }

  const runId = `scope-${normalizedWorkItemId.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 48)}-${randomUUID().slice(0, 8)}`;
  const runKey = buildRunKey(normalizedSessionId, normalizedWorkItemId, resolvedTargetPath);
  if (ACTIVE_SCOPE_RUNS.has(runKey)) {
    throw new Error(`Scope engine run already active for work item '${normalizedWorkItemId}'.`);
  }

  const controller = new AbortController();
  const runState = {
    runId,
    runKey,
    sessionId: normalizedSessionId,
    workItemId: normalizedWorkItemId,
    targetPath: resolvedTargetPath,
    startedAt: normalizedNow,
    running: true,
    stopReason: "",
    controller,
    externalAbortListener: null,
  };
  if (signal && typeof signal.addEventListener === "function") {
    if (signal.aborted) {
      controller.abort(createAbortError("manual_stop"));
    } else {
      runState.externalAbortListener = () => {
        runState.stopReason = "manual_stop";
        controller.abort(createAbortError("manual_stop"));
      };
      signal.addEventListener("abort", runState.externalAbortListener, { once: true });
    }
  }
  ACTIVE_SCOPE_RUNS.set(runKey, runState);

  try {
    throwIfAborted(runState);
    const ingest = await collectCodebaseIngest({
      rootPath: resolvedTargetPath,
    });
    throwIfAborted(runState);

    const indexedFiles = Array.isArray(ingest?.indexedFiles?.files) ? ingest.indexedFiles.files : [];
    const indexedFilesByPath = new Map();
    for (const file of indexedFiles) {
      const filePath = toPosixPath(file.path);
      if (!filePath) {
        continue;
      }
      indexedFilesByPath.set(filePath, {
        ...file,
        path: filePath,
      });
    }

    const intakeTokens = buildIntakeTokens(normalizedIntake);
    const endpointTokens = deriveEndpointTokens(normalizedIntake.endpoint);
    const candidateFiles = createCandidateFiles({
      indexedFiles: [...indexedFilesByPath.values()],
      intakeTokens,
      endpointTokens,
      intakeEvent: normalizedIntake,
      maxCandidateFiles,
    });
    const endpointMapping = createEndpointMapping(normalizedIntake.endpoint, candidateFiles);
    const { allowedPaths, deniedPaths } = deriveAllowedAndDeniedPaths(candidateFiles, ingest);
    const budgetEnvelope = deriveBudgetEnvelope({
      intakeEvent: normalizedIntake,
      candidateFiles,
      allowedPaths,
      deniedPaths,
    });
    const allowedTools = deriveAllowedTools(normalizedIntake, ingest);
    const signalScore = computeSemanticSignalScore(candidateFiles, normalizedIntake);
    let semanticOverlay;
    if (
      shouldAttachSemanticOverlay({
        candidateFiles,
        signalScore,
        semanticSignalThreshold,
        maxSemanticFiles,
      })
    ) {
      semanticOverlay = await collectSemanticOverlay({
        rootPath: resolvedTargetPath,
        indexedFilesByPath,
        candidateFiles,
        maxSemanticFiles,
        signalScore,
        semanticSignalThreshold,
        runState,
      });
    }
    throwIfAborted(runState);

    const envelope = {
      workItemId: normalizedWorkItemId,
      deterministicPack: {
        riskSurfaces: Array.isArray(ingest.riskSurfaces) ? ingest.riskSurfaces : [],
        frameworks: Array.isArray(ingest.frameworks) ? ingest.frameworks : [],
        locBucket: deriveLocBucket(ingest?.summary?.totalLoc),
      },
      candidateFiles: candidateFiles.map((candidate) => ({
        path: toPosixPath(candidate.path),
        score: normalizeNonNegativeNumber(candidate.score, 0),
        reason: normalizeString(candidate.reason) || "deterministic_path_match",
      })),
      endpointMapping,
      semanticOverlay: semanticOverlay || undefined,
      budgetEnvelope,
      allowedTools,
      version: ISSUE_SCOPE_ENVELOPE_VERSION,
      generatedAt: normalizedNow,
      intake: {
        service: normalizedIntake.service,
        endpoint: normalizedIntake.endpoint,
        errorCode: normalizedIntake.errorCode,
        severity: normalizedIntake.severity,
        occurredAt: normalizedIntake.occurredAt,
      },
    };
    validateIssueScopeEnvelope(envelope, { throwOnError: true });

    const storage = await resolveScopeEngineStorage({
      targetPath: resolvedTargetPath,
      outputDir,
      env,
      homeDir,
    });
    const artifactPath = await writeScopeEnvelopeArtifact(
      storage,
      normalizedWorkItemId,
      envelope,
      normalizedNow
    );
    const runMetadataPath = await persistRunMetadata(storage, {
      schemaVersion: "1.0.0",
      generatedAt: normalizedNow,
      runId,
      runKey,
      sessionId: normalizedSessionId || null,
      workItemId: normalizedWorkItemId,
      targetPath: resolvedTargetPath,
      artifactPath: toPosixPath(path.relative(storage.outputRoot, artifactPath)),
      semanticOverlayAttached: Boolean(semanticOverlay),
      candidateFileCount: envelope.candidateFiles.length,
      allowedPathCount: budgetEnvelope.allowedPaths.length,
      deniedPathCount: budgetEnvelope.deniedPaths.length,
      signalScore,
      signalThreshold: normalizePositiveInteger(
        semanticSignalThreshold,
        DEFAULT_SEMANTIC_SIGNAL_THRESHOLD
      ),
    });

    const event = await emitScopeSessionEvent(
      normalizedSessionId,
      "scope_envelope_built",
      {
        runId,
        workItemId: normalizedWorkItemId,
        version: envelope.version,
        artifactPath: toPosixPath(path.relative(storage.outputRoot, artifactPath)),
        candidateFileCount: envelope.candidateFiles.length,
        semanticOverlayAttached: Boolean(semanticOverlay),
      },
      {
        targetPath: resolvedTargetPath,
        workItemId: normalizedWorkItemId,
        nowIso: normalizedNow,
      }
    );

    return {
      runId,
      runKey,
      workItemId: normalizedWorkItemId,
      envelope,
      artifactPath,
      runMetadataPath,
      outputRoot: storage.outputRoot,
      observabilityRoot: storage.observabilityRoot,
      semanticOverlayAttached: Boolean(semanticOverlay),
      event,
    };
  } finally {
    ACTIVE_SCOPE_RUNS.delete(runKey);
    runState.running = false;
    if (signal && runState.externalAbortListener && typeof signal.removeEventListener === "function") {
      signal.removeEventListener("abort", runState.externalAbortListener);
    }
  }
}
