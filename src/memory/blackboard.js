import fsp from "node:fs/promises";
import path from "node:path";

function normalizeString(value) {
  return String(value || "").trim();
}

function normalizeSeverity(value) {
  const severity = normalizeString(value).toUpperCase();
  if (severity === "P0" || severity === "P1" || severity === "P2" || severity === "P3") {
    return severity;
  }
  return "P3";
}

function tokenize(value) {
  return Array.from(
    new Set(
      normalizeString(value)
        .toLowerCase()
        .split(/[^a-z0-9_]+/g)
        .map((token) => token.trim())
        .filter((token) => token.length >= 2)
    )
  );
}

const AGENT_HINT_TOKENS = Object.freeze({
  security: ["security", "token", "secret", "credential", "auth", "injection", "xss"],
  architecture: ["architecture", "design", "dependency", "boundary", "module", "coupling"],
  testing: ["testing", "test", "coverage", "assertion", "regression", "e2e", "unit"],
  performance: ["performance", "latency", "throughput", "runtime", "query", "n+1", "cache"],
  compliance: ["compliance", "soc2", "hipaa", "gdpr", "privacy", "pii", "control"],
  documentation: ["documentation", "docs", "spec", "guide", "readme", "contract"],
});

const SEVERITY_SCORE = Object.freeze({
  P0: 1,
  P1: 0.9,
  P2: 0.65,
  P3: 0.4,
});

function normalizeNumber(value, fallback = 0) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }
  return parsed;
}

function toPosixPath(value) {
  return normalizeString(value).replace(/\\/g, "/");
}

function buildEntryText(entry = {}) {
  return [
    entry.agentId,
    entry.source,
    entry.severity,
    entry.file,
    entry.layer,
    entry.ruleId,
    entry.message,
    entry.note,
    entry.needleId,
  ]
    .filter(Boolean)
    .join(" ");
}

function buildEntryScore({ entry, queryTokens, hintTokens, newestSequence }) {
  const tokens = Array.isArray(entry.tokens) ? entry.tokens : [];
  const tokenSet = new Set(tokens);
  const queryHitCount = queryTokens.filter((token) => tokenSet.has(token)).length;
  const hintHitCount = hintTokens.filter((token) => tokenSet.has(token)).length;
  const querySignal = queryTokens.length > 0 ? queryHitCount / queryTokens.length : 0;
  const hintSignal = hintTokens.length > 0 ? hintHitCount / hintTokens.length : 0;
  const severitySignal = SEVERITY_SCORE[normalizeSeverity(entry.severity)] || 0.35;
  const recencySignal =
    newestSequence > 0 ? Math.max(0, Math.min(1, normalizeNumber(entry.sequence, 0) / newestSequence)) : 0;
  return querySignal * 0.55 + hintSignal * 0.15 + severitySignal * 0.2 + recencySignal * 0.1;
}

function nextEntryId(blackboard) {
  const nextSequence = normalizeNumber(blackboard.nextSequence, 1);
  blackboard.nextSequence = nextSequence + 1;
  return {
    entryId: `bb-${String(nextSequence).padStart(6, "0")}`,
    sequence: nextSequence,
  };
}

function asNeedleId(value) {
  return normalizeString(value).toLowerCase();
}

export function createBlackboard({ runId = "", scope = "audit-orchestrator" } = {}) {
  return {
    schemaVersion: "1.0.0",
    runId: normalizeString(runId),
    scope: normalizeString(scope) || "audit-orchestrator",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    nextSequence: 1,
    entries: [],
    queryEvents: [],
  };
}

export function appendBlackboardEntry(blackboard, entry = {}) {
  if (!blackboard || !Array.isArray(blackboard.entries)) {
    throw new Error("Invalid blackboard state.");
  }
  const { entryId, sequence } = nextEntryId(blackboard);
  const normalizedEntry = {
    entryId,
    sequence,
    timestamp: new Date().toISOString(),
    agentId: normalizeString(entry.agentId),
    source: normalizeString(entry.source) || "agent",
    severity: normalizeSeverity(entry.severity),
    file: toPosixPath(entry.file),
    line: Math.max(0, Math.floor(normalizeNumber(entry.line, 0))),
    layer: normalizeString(entry.layer),
    ruleId: normalizeString(entry.ruleId),
    message: normalizeString(entry.message),
    note: normalizeString(entry.note),
    confidence: Math.max(0, Math.min(1, normalizeNumber(entry.confidence, 0.7))),
    needleId: asNeedleId(entry.needleId),
  };
  normalizedEntry.tokens = tokenize(buildEntryText(normalizedEntry));
  blackboard.entries.push(normalizedEntry);
  blackboard.updatedAt = normalizedEntry.timestamp;
  return normalizedEntry;
}

export function appendBlackboardFindings(
  blackboard,
  { agentId = "", findings = [], source = "agent", note = "", confidence = 0.7 } = {}
) {
  const writtenEntries = [];
  for (const finding of findings || []) {
    writtenEntries.push(
      appendBlackboardEntry(blackboard, {
        agentId,
        source,
        severity: finding.severity,
        file: finding.file,
        line: finding.line,
        layer: finding.layer,
        ruleId: finding.ruleId || finding.code || "",
        message: finding.message || finding.title || "",
        note,
        confidence: normalizeNumber(finding.confidence, confidence),
        needleId: finding.needleId || "",
      })
    );
  }
  return writtenEntries;
}

export function queryBlackboard(
  blackboard,
  { query = "", agentId = "", limit = 20, minScore = 0 } = {}
) {
  if (!blackboard || !Array.isArray(blackboard.entries)) {
    throw new Error("Invalid blackboard state.");
  }
  const normalizedAgentId = normalizeString(agentId).toLowerCase();
  const queryTokens = tokenize(query);
  const hintTokens = AGENT_HINT_TOKENS[normalizedAgentId] || [];
  const normalizedLimit = Math.max(1, Math.floor(normalizeNumber(limit, 20)));
  const normalizedMinScore = Math.max(0, Math.min(1, normalizeNumber(minScore, 0)));
  const newestSequence = blackboard.entries.reduce(
    (max, entry) => Math.max(max, normalizeNumber(entry.sequence, 0)),
    0
  );
  const scored = blackboard.entries
    .map((entry) => ({
      entry,
      score: buildEntryScore({
        entry,
        queryTokens,
        hintTokens,
        newestSequence,
      }),
    }))
    .filter((item) => item.score >= normalizedMinScore)
    .sort((left, right) => {
      if (right.score !== left.score) {
        return right.score - left.score;
      }
      return left.entry.sequence - right.entry.sequence;
    })
    .slice(0, normalizedLimit)
    .map((item) => ({
      ...item.entry,
      score: Number(item.score.toFixed(6)),
    }));

  blackboard.queryEvents.push({
    timestamp: new Date().toISOString(),
    query: normalizeString(query),
    agentId: normalizedAgentId,
    limit: normalizedLimit,
    minScore: normalizedMinScore,
    queryTokenCount: queryTokens.length,
    hintTokenCount: hintTokens.length,
    returnedCount: scored.length,
  });
  blackboard.updatedAt = new Date().toISOString();

  return {
    query: normalizeString(query),
    agentId: normalizedAgentId,
    limit: normalizedLimit,
    queryTokens,
    hintTokens,
    entries: scored,
  };
}

export function benchmarkBlackboardNeedleRecall(
  blackboard,
  { query = "", agentId = "", needleIds = [], limit = 20 } = {}
) {
  const expectedNeedles = Array.from(
    new Set(
      (needleIds || [])
        .map((needleId) => asNeedleId(needleId))
        .filter(Boolean)
    )
  );
  const result = queryBlackboard(blackboard, {
    query,
    agentId,
    limit: Math.max(limit, expectedNeedles.length, 1),
  });
  const matched = new Set();
  for (const entry of result.entries) {
    const needleId = asNeedleId(entry.needleId);
    if (needleId && expectedNeedles.includes(needleId)) {
      matched.add(needleId);
    }
  }
  const recall = expectedNeedles.length > 0 ? matched.size / expectedNeedles.length : 1;
  return {
    expectedCount: expectedNeedles.length,
    matchedCount: matched.size,
    recall: Number(recall.toFixed(6)),
    pass: recall >= 0.95,
    missingNeedles: expectedNeedles.filter((needleId) => !matched.has(needleId)),
    retrievedEntryIds: result.entries.map((entry) => entry.entryId),
    query: result.query,
  };
}

export function summarizeBlackboard(blackboard) {
  if (!blackboard || !Array.isArray(blackboard.entries)) {
    throw new Error("Invalid blackboard state.");
  }
  const severity = { P0: 0, P1: 0, P2: 0, P3: 0 };
  for (const entry of blackboard.entries) {
    const normalizedSeverity = normalizeSeverity(entry.severity);
    severity[normalizedSeverity] += 1;
  }
  return {
    entryCount: blackboard.entries.length,
    queryCount: Array.isArray(blackboard.queryEvents) ? blackboard.queryEvents.length : 0,
    severity,
    createdAt: blackboard.createdAt,
    updatedAt: blackboard.updatedAt,
  };
}

export async function writeBlackboardArtifact(blackboard, { outputRoot = "" } = {}) {
  if (!blackboard || !Array.isArray(blackboard.entries)) {
    throw new Error("Invalid blackboard state.");
  }
  const resolvedOutputRoot = path.resolve(String(outputRoot || "."));
  const memoryDirectory = path.join(resolvedOutputRoot, "memory");
  await fsp.mkdir(memoryDirectory, { recursive: true });
  const runId = normalizeString(blackboard.runId) || "run";
  const artifactPath = path.join(memoryDirectory, `blackboard-${runId}.json`);
  const summary = summarizeBlackboard(blackboard);
  const payload = {
    schemaVersion: "1.0.0",
    runId,
    scope: blackboard.scope,
    generatedAt: new Date().toISOString(),
    summary,
    entries: blackboard.entries,
    queryEvents: blackboard.queryEvents,
  };
  await fsp.writeFile(artifactPath, `${JSON.stringify(payload, null, 2)}\n`, "utf-8");
  return {
    artifactPath,
    summary,
  };
}
