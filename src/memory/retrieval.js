import fsp from "node:fs/promises";
import path from "node:path";

function normalizeString(value) {
  return String(value || "").trim();
}

function normalizeNumber(value, fallback = 0) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }
  return parsed;
}

function normalizeSeverity(value) {
  const severity = normalizeString(value).toUpperCase();
  if (severity === "P0" || severity === "P1" || severity === "P2" || severity === "P3") {
    return severity;
  }
  return "P3";
}

export function tokenize(value) {
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

function tokenizeWithFrequency(value) {
  const tokens = normalizeString(value)
    .toLowerCase()
    .split(/[^a-z0-9_]+/g)
    .map((token) => token.trim())
    .filter((token) => token.length >= 2);
  const frequency = new Map();
  for (const token of tokens) {
    frequency.set(token, (frequency.get(token) || 0) + 1);
  }
  return {
    tokens,
    uniqueTokens: Array.from(new Set(tokens)),
    frequency,
  };
}

function toPosixPath(value) {
  return normalizeString(value).replace(/\\/g, "/");
}

function clipSnippet(text, maxLength = 180) {
  const normalized = normalizeString(text).replace(/\s+/g, " ");
  if (normalized.length <= maxLength) {
    return normalized;
  }
  return `${normalized.slice(0, maxLength - 3)}...`;
}

const SEVERITY_SCORE = Object.freeze({
  P0: 1,
  P1: 0.9,
  P2: 0.65,
  P3: 0.4,
});

function parseTimestamp(value) {
  const millis = Date.parse(value);
  if (!Number.isFinite(millis)) {
    return 0;
  }
  return millis;
}

function buildDocumentVector({ frequency, tokenCount, idfByToken }) {
  const vector = new Map();
  const denominator = Math.max(1, tokenCount);
  for (const [token, count] of frequency.entries()) {
    const idf = idfByToken.get(token) || 0;
    const tf = count / denominator;
    const weight = tf * idf;
    if (weight > 0) {
      vector.set(token, weight);
    }
  }
  return vector;
}

function vectorMagnitude(vector) {
  let sum = 0;
  for (const value of vector.values()) {
    sum += value * value;
  }
  return Math.sqrt(sum);
}

function cosineSimilarity(leftVector, leftMagnitude, rightVector, rightMagnitude) {
  if (!leftVector || !rightVector || leftMagnitude <= 0 || rightMagnitude <= 0) {
    return 0;
  }
  const [smaller, larger] =
    leftVector.size <= rightVector.size ? [leftVector, rightVector] : [rightVector, leftVector];
  let dot = 0;
  for (const [token, value] of smaller.entries()) {
    const counterpart = larger.get(token);
    if (counterpart) {
      dot += value * counterpart;
    }
  }
  if (dot <= 0) {
    return 0;
  }
  return dot / (leftMagnitude * rightMagnitude);
}

function buildDeterministicScore({ document, queryTokens, cosine, recency }) {
  const tokenSet = document.tokenSet;
  const overlapCount = queryTokens.filter((token) => tokenSet.has(token)).length;
  const tokenOverlap = queryTokens.length > 0 ? overlapCount / queryTokens.length : 0;
  const queryText = normalizeString(document.queryTextForExact).toLowerCase();
  const exactMatch =
    queryTokens.length > 0 &&
    queryTokens.every((token) => queryText.includes(token))
      ? 1
      : 0;
  const severityScore = SEVERITY_SCORE[normalizeSeverity(document.severity)] || 0.35;
  return {
    exactMatch,
    tokenOverlap,
    cosine,
    recency,
    severityScore,
    score:
      exactMatch * 0.25 +
      tokenOverlap * 0.25 +
      cosine * 0.3 +
      recency * 0.1 +
      severityScore * 0.1,
  };
}

function resolveSpecCandidates({ targetPath, specFile }) {
  if (normalizeString(specFile)) {
    const absoluteCandidate = path.isAbsolute(specFile)
      ? specFile
      : path.join(targetPath, specFile);
    return [absoluteCandidate];
  }
  return [path.join(targetPath, "SPEC.md"), path.join(targetPath, "docs", "spec.md")];
}

async function loadSpecDocument({ targetPath, specFile = "" }) {
  const candidates = resolveSpecCandidates({ targetPath, specFile });
  for (const candidate of candidates) {
    try {
      const text = await fsp.readFile(candidate, "utf-8");
      const normalizedPath = toPosixPath(path.resolve(candidate));
      return {
        documentId: `spec:${normalizedPath}`,
        sourceType: "spec",
        sourcePath: normalizedPath,
        severity: "P3",
        updatedAt: new Date().toISOString(),
        text,
        metadata: {
          category: "spec",
        },
      };
    } catch {
      // Continue to next candidate.
    }
  }
  return null;
}

async function loadAuditHistoryDocuments({ outputRoot, excludeRunId = "", maxAuditRuns = 3 }) {
  const auditsDirectory = path.join(outputRoot, "audits");
  let runEntries = [];
  try {
    runEntries = await fsp.readdir(auditsDirectory, { withFileTypes: true });
  } catch {
    return [];
  }
  const runIds = runEntries
    .filter((entry) => entry.isDirectory() && entry.name.startsWith("audit-"))
    .map((entry) => entry.name)
    .filter((runId) => runId !== normalizeString(excludeRunId))
    .sort((left, right) => right.localeCompare(left))
    .slice(0, Math.max(0, Math.floor(Number(maxAuditRuns || 0))));

  const documents = [];
  for (const runId of runIds) {
    const reportPath = path.join(auditsDirectory, runId, "AUDIT_REPORT.json");
    try {
      const report = JSON.parse(await fsp.readFile(reportPath, "utf-8"));
      documents.push({
        documentId: `audit:${runId}:summary`,
        sourceType: "audit-history",
        sourcePath: toPosixPath(reportPath),
        severity: report.summary?.blocking ? "P1" : "P3",
        updatedAt: normalizeString(report.generatedAt) || new Date().toISOString(),
        text: [
          `run_id ${runId}`,
          `summary p0 ${report.summary?.P0 || 0}`,
          `p1 ${report.summary?.P1 || 0}`,
          `p2 ${report.summary?.P2 || 0}`,
          `p3 ${report.summary?.P3 || 0}`,
          `risk_surfaces ${(report.ingest?.riskSurfaces || []).join(" ")}`,
        ].join(" "),
        metadata: {
          category: "audit-summary",
          runId,
        },
      });

      let findingIndex = 0;
      for (const agent of report.agentResults || []) {
        for (const finding of agent.findings || []) {
          if (findingIndex >= 60) {
            break;
          }
          findingIndex += 1;
          documents.push({
            documentId: `audit:${runId}:finding:${findingIndex}`,
            sourceType: "audit-history",
            sourcePath: toPosixPath(reportPath),
            severity: normalizeSeverity(finding.severity),
            updatedAt: normalizeString(report.generatedAt) || new Date().toISOString(),
            text: [finding.file, finding.layer, finding.ruleId, finding.message].filter(Boolean).join(" "),
            metadata: {
              category: "audit-finding",
              runId,
              agentId: agent.agentId,
              file: toPosixPath(finding.file),
              line: normalizeNumber(finding.line, 0),
            },
          });
        }
      }
    } catch {
      // Ignore malformed historical run artifacts.
    }
  }
  return documents;
}

function buildIngestDocuments(ingest = {}) {
  const summary = ingest.summary || {};
  const frameworkList = Array.isArray(ingest.frameworks) ? ingest.frameworks : [];
  const riskSurfaces = Array.isArray(ingest.riskSurfaces) ? ingest.riskSurfaces : [];
  const documents = [
    {
      documentId: "ingest:summary",
      sourceType: "ingest",
      sourcePath: "",
      severity: "P3",
      updatedAt: new Date().toISOString(),
      text: [
        `files_scanned ${summary.filesScanned || 0}`,
        `total_loc ${summary.totalLoc || 0}`,
        `frameworks ${frameworkList.join(" ")}`,
      ].join(" "),
      metadata: {
        category: "ingest-summary",
      },
    },
  ];
  for (const [index, surface] of riskSurfaces.entries()) {
    const surfaceName = normalizeString(surface?.surface || surface);
    if (!surfaceName) {
      continue;
    }
    documents.push({
      documentId: `ingest:surface:${index + 1}`,
      sourceType: "ingest",
      sourcePath: "",
      severity: "P2",
      updatedAt: new Date().toISOString(),
      text: `risk_surface ${surfaceName}`,
      metadata: {
        category: "ingest-risk-surface",
        surface: surfaceName,
      },
    });
  }
  return documents;
}

function buildLocalDocument(raw = {}, index = 0) {
  const text = normalizeString(raw.text);
  const tokenized = tokenizeWithFrequency(text);
  const updatedAt = normalizeString(raw.updatedAt) || new Date().toISOString();
  const sequence = index + 1;
  return {
    documentId: normalizeString(raw.documentId) || `doc-${String(sequence).padStart(6, "0")}`,
    sourceType: normalizeString(raw.sourceType) || "memory",
    sourcePath: toPosixPath(raw.sourcePath),
    severity: normalizeSeverity(raw.severity),
    updatedAt,
    text,
    snippet: clipSnippet(text),
    metadata: raw.metadata && typeof raw.metadata === "object" ? raw.metadata : {},
    sequence,
    tokenSet: new Set(tokenized.uniqueTokens),
    tokenFrequency: tokenized.frequency,
    tokenCount: tokenized.tokens.length,
    queryTextForExact: text,
    timestampMs: parseTimestamp(updatedAt),
  };
}

export function buildDocumentsFromBlackboardEntries(entries = []) {
  return (entries || []).map((entry, index) => ({
    documentId: `blackboard:${normalizeString(entry.entryId) || index + 1}`,
    sourceType: "blackboard",
    sourcePath: "",
    severity: normalizeSeverity(entry.severity),
    updatedAt: normalizeString(entry.timestamp) || new Date().toISOString(),
    text: [
      entry.agentId,
      entry.source,
      entry.file,
      entry.layer,
      entry.ruleId,
      entry.message,
      entry.note,
    ]
      .filter(Boolean)
      .join(" "),
    metadata: {
      category: "blackboard-entry",
      entryId: entry.entryId || "",
      line: normalizeNumber(entry.line, 0),
      file: toPosixPath(entry.file),
    },
  }));
}

export async function buildSharedMemoryCorpus({
  outputRoot = "",
  targetPath = "",
  ingest = {},
  specFile = "",
  excludeRunId = "",
  maxAuditRuns = 3,
} = {}) {
  const resolvedOutputRoot = path.resolve(String(outputRoot || "."));
  const resolvedTargetPath = path.resolve(String(targetPath || "."));

  const [historyDocuments, specDocument] = await Promise.all([
    loadAuditHistoryDocuments({
      outputRoot: resolvedOutputRoot,
      excludeRunId,
      maxAuditRuns,
    }),
    loadSpecDocument({
      targetPath: resolvedTargetPath,
      specFile,
    }),
  ]);

  const documents = [
    ...buildIngestDocuments(ingest),
    ...historyDocuments,
    ...(specDocument ? [specDocument] : []),
  ];

  const sourceCounts = documents.reduce(
    (counts, document) => {
      const key = normalizeString(document.sourceType) || "unknown";
      counts[key] = (counts[key] || 0) + 1;
      return counts;
    },
    {}
  );

  return {
    documents,
    sourceCounts,
    hasSpecDocument: Boolean(specDocument),
    historyRunDocumentCount: historyDocuments.length,
  };
}

export function buildLocalHybridIndex(documents = []) {
  const preparedDocuments = (documents || [])
    .map((document, index) => buildLocalDocument(document, index))
    .filter((document) => document.text.length > 0);

  const documentCount = preparedDocuments.length;
  const docFrequency = new Map();
  for (const document of preparedDocuments) {
    for (const token of document.tokenSet.values()) {
      docFrequency.set(token, (docFrequency.get(token) || 0) + 1);
    }
  }

  const idfByToken = new Map();
  for (const [token, frequency] of docFrequency.entries()) {
    const idf = Math.log((documentCount + 1) / (frequency + 1)) + 1;
    idfByToken.set(token, idf);
  }

  const timestampValues = preparedDocuments
    .map((document) => document.timestampMs)
    .filter((value) => Number.isFinite(value) && value > 0);
  const minTimestamp = timestampValues.length > 0 ? Math.min(...timestampValues) : 0;
  const maxTimestamp = timestampValues.length > 0 ? Math.max(...timestampValues) : 0;

  const entries = preparedDocuments.map((document) => {
    const vector = buildDocumentVector({
      frequency: document.tokenFrequency,
      tokenCount: document.tokenCount,
      idfByToken,
    });
    const magnitude = vectorMagnitude(vector);
    let recency = 0.5;
    if (maxTimestamp > minTimestamp && document.timestampMs > 0) {
      recency = (document.timestampMs - minTimestamp) / (maxTimestamp - minTimestamp);
    }
    return {
      ...document,
      vector,
      magnitude,
      recency,
    };
  });

  return {
    schemaVersion: "1.0.0",
    generatedAt: new Date().toISOString(),
    documentCount,
    vocabularySize: idfByToken.size,
    idfByToken,
    entries,
  };
}

export function queryLocalHybridIndex(index, { query = "", limit = 12, minScore = 0 } = {}) {
  const queryText = normalizeString(query);
  const queryTokenized = tokenizeWithFrequency(queryText);
  const queryTokens = queryTokenized.uniqueTokens;
  const queryVector = buildDocumentVector({
    frequency: queryTokenized.frequency,
    tokenCount: queryTokenized.tokens.length,
    idfByToken: index.idfByToken || new Map(),
  });
  const queryMagnitude = vectorMagnitude(queryVector);

  const normalizedLimit = Math.max(1, Math.floor(normalizeNumber(limit, 12)));
  const normalizedMinScore = Math.max(0, Math.min(1, normalizeNumber(minScore, 0)));
  const results = (index.entries || [])
    .map((document) => {
      const cosine = cosineSimilarity(queryVector, queryMagnitude, document.vector, document.magnitude);
      const signals = buildDeterministicScore({
        document,
        queryTokens,
        cosine,
        recency: document.recency,
      });
      return {
        documentId: document.documentId,
        sourceType: document.sourceType,
        sourcePath: document.sourcePath,
        severity: document.severity,
        updatedAt: document.updatedAt,
        snippet: document.snippet,
        metadata: document.metadata,
        score: Number(signals.score.toFixed(6)),
        scoreBreakdown: {
          exactMatch: Number(signals.exactMatch.toFixed(6)),
          tokenOverlap: Number(signals.tokenOverlap.toFixed(6)),
          cosine: Number(signals.cosine.toFixed(6)),
          recency: Number(signals.recency.toFixed(6)),
          severity: Number(signals.severityScore.toFixed(6)),
        },
      };
    })
    .filter((result) => result.score >= normalizedMinScore)
    .sort((left, right) => {
      if (right.score !== left.score) {
        return right.score - left.score;
      }
      return left.documentId.localeCompare(right.documentId);
    })
    .slice(0, normalizedLimit);

  return {
    query: queryText,
    limit: normalizedLimit,
    minScore: normalizedMinScore,
    queryTokenCount: queryTokens.length,
    results,
  };
}

export async function queryHybridRetriever({
  query = "",
  documents = [],
  limit = 12,
  provider = "local",
  apiEndpoint = "",
  apiKey = "",
  fetchImpl = globalThis.fetch,
} = {}) {
  const normalizedProvider = normalizeString(provider).toLowerCase() || "local";
  const localIndex = buildLocalHybridIndex(documents);
  const localQuery = queryLocalHybridIndex(localIndex, {
    query,
    limit,
  });

  const canUseApi =
    (normalizedProvider === "api" || normalizedProvider === "auto") &&
    normalizeString(apiEndpoint) &&
    typeof fetchImpl === "function";
  if (!canUseApi) {
    return {
      providerRequested: normalizedProvider,
      providerUsed: "local",
      apiFallback: false,
      apiError: "",
      indexSummary: {
        documentCount: localIndex.documentCount,
        vocabularySize: localIndex.vocabularySize,
      },
      results: localQuery.results,
    };
  }

  try {
    const response = await fetchImpl(String(apiEndpoint), {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(normalizeString(apiKey) ? { authorization: `Bearer ${apiKey}` } : {}),
      },
      body: JSON.stringify({
        query: normalizeString(query),
        limit: Math.max(1, Math.floor(normalizeNumber(limit, 12))),
        documents,
      }),
    });
    if (!response.ok) {
      throw new Error(`Memory API request failed (${response.status}).`);
    }
    const payload = await response.json();
    const apiResults = Array.isArray(payload?.results) ? payload.results : [];
    if (apiResults.length === 0) {
      throw new Error("Memory API response missing results.");
    }
    return {
      providerRequested: normalizedProvider,
      providerUsed: "api",
      apiFallback: false,
      apiError: "",
      indexSummary: {
        documentCount: localIndex.documentCount,
        vocabularySize: localIndex.vocabularySize,
      },
      results: apiResults.slice(0, Math.max(1, Math.floor(normalizeNumber(limit, 12)))),
    };
  } catch (error) {
    return {
      providerRequested: normalizedProvider,
      providerUsed: "local",
      apiFallback: true,
      apiError: normalizeString(error?.message || error),
      indexSummary: {
        documentCount: localIndex.documentCount,
        vocabularySize: localIndex.vocabularySize,
      },
      results: localQuery.results,
    };
  }
}
