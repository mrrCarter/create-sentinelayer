import fsp from "node:fs/promises";
import path from "node:path";

import { collectCodebaseIngest } from "../ingest/engine.js";
import { listErrorQueue, resolveErrorDaemonStorage } from "./error-worker.js";

const HYBRID_MAP_SCHEMA_VERSION = "1.0.0";
const DEFAULT_MAX_SCOPE_FILES = 40;
const DEFAULT_GRAPH_DEPTH = 2;
const LANGUAGE_IMPORT_EXTENSIONS = [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".py"];

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

function normalizePositiveInteger(value, fieldName, fallbackValue) {
  if (value === undefined || value === null || normalizeString(value) === "") {
    return fallbackValue;
  }
  const normalized = Number(value);
  if (!Number.isFinite(normalized) || normalized <= 0) {
    throw new Error(`${fieldName} must be a positive integer.`);
  }
  return Math.floor(normalized);
}

function toPosixPath(value = "") {
  return String(value || "").replace(/\\/g, "/");
}

function normalizeMapIndex(index = {}, nowIso = new Date().toISOString()) {
  return {
    schemaVersion: HYBRID_MAP_SCHEMA_VERSION,
    generatedAt: normalizeIsoTimestamp(index.generatedAt, nowIso),
    maps: Array.isArray(index.maps)
      ? index.maps
          .map((entry) => ({
            ...entry,
            workItemId: normalizeString(entry.workItemId),
            runId: normalizeString(entry.runId),
            generatedAt: normalizeIsoTimestamp(entry.generatedAt, nowIso),
            mapPath: normalizeString(entry.mapPath),
          }))
          .filter((entry) => entry.workItemId && entry.runId && entry.mapPath)
      : [],
  };
}

function createInitialMapIndex(nowIso = new Date().toISOString()) {
  return {
    schemaVersion: HYBRID_MAP_SCHEMA_VERSION,
    generatedAt: normalizeIsoTimestamp(nowIso, nowIso),
    maps: [],
  };
}

async function readJsonFile(filePath, defaultFactory) {
  try {
    const raw = await fsp.readFile(filePath, "utf-8");
    return JSON.parse(raw);
  } catch (error) {
    if (error && typeof error === "object" && error.code === "ENOENT") {
      return defaultFactory();
    }
    throw error;
  }
}

async function writeJsonFile(filePath, payload = {}) {
  await fsp.mkdir(path.dirname(filePath), { recursive: true });
  await fsp.writeFile(filePath, `${JSON.stringify(payload, null, 2)}\n`, "utf-8");
}

async function appendJsonLine(filePath, payload = {}) {
  await fsp.mkdir(path.dirname(filePath), { recursive: true });
  await fsp.appendFile(filePath, `${JSON.stringify(payload)}\n`, "utf-8");
}

function tokenizeWorkItem(queueItem = {}) {
  const parts = [
    normalizeString(queueItem.endpoint),
    normalizeString(queueItem.errorCode),
    normalizeString(queueItem.service),
  ]
    .join("/")
    .split(/[^a-zA-Z0-9]+/)
    .map((token) => token.toLowerCase())
    .filter(Boolean);
  const unique = new Set();
  for (const token of parts) {
    if (token.length < 3) {
      continue;
    }
    if (["api", "v1", "v2", "err", "error", "svc", "service"].includes(token)) {
      continue;
    }
    unique.add(token);
  }
  return [...unique].slice(0, 24);
}

function scoreDeterministicPath(pathText, tokens = []) {
  const normalizedPath = normalizeString(pathText).toLowerCase();
  let score = 0;
  for (const token of tokens) {
    if (normalizedPath.includes(token)) {
      score += 1;
    }
  }
  if (/route|router|controller|handler/.test(normalizedPath)) {
    score += 2;
  }
  if (/service|runtime|daemon|worker/.test(normalizedPath)) {
    score += 1;
  }
  return score;
}

function countTokenMatches(content, token) {
  if (!content || !token) {
    return 0;
  }
  const expression = new RegExp(`\\b${token.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "gi");
  const matches = String(content).match(expression);
  return matches ? matches.length : 0;
}

function scoreSemanticContent({ content = "", endpoint = "", tokens = [] } = {}) {
  const normalizedContent = String(content || "");
  let score = 0;
  for (const token of tokens) {
    score += Math.min(4, countTokenMatches(normalizedContent, token));
  }
  if (endpoint && normalizedContent.includes(endpoint)) {
    score += 8;
  }
  if (/(router\.|app\.(get|post|put|patch|delete)|def\s+[a-zA-Z0-9_]+|class\s+[A-Z])/.test(normalizedContent)) {
    score += 2;
  }
  return score;
}

function parseModuleSpecifiers(content = "", language = "") {
  const raw = String(content || "");
  const normalizedLanguage = normalizeString(language).toLowerCase();
  const specifiers = new Set();
  if (normalizedLanguage.includes("javascript") || normalizedLanguage.includes("typescript")) {
    const pattern =
      /(?:import\s+[^'"]*from\s*|export\s+[^'"]*from\s*|import\s*\(\s*|require\s*\()\s*['"]([^'"]+)['"]/g;
    let match;
    while ((match = pattern.exec(raw))) {
      if (match[1]) {
        specifiers.add(match[1]);
      }
    }
  }
  if (normalizedLanguage === "python") {
    const fromPattern = /^\s*from\s+([a-zA-Z0-9_\.]+)\s+import\s+/gm;
    let fromMatch;
    while ((fromMatch = fromPattern.exec(raw))) {
      if (fromMatch[1]) {
        specifiers.add(fromMatch[1]);
      }
    }
    const importPattern = /^\s*import\s+([a-zA-Z0-9_\.]+)/gm;
    let importMatch;
    while ((importMatch = importPattern.exec(raw))) {
      if (importMatch[1]) {
        specifiers.add(importMatch[1]);
      }
    }
  }
  return [...specifiers];
}

function resolveSpecifierToIndexedPath(fromPath, specifier, indexedPathsSet) {
  const normalizedSpecifier = normalizeString(specifier);
  if (!normalizedSpecifier) {
    return null;
  }
  const posixFromPath = toPosixPath(fromPath);
  if (normalizedSpecifier.startsWith(".")) {
    const fromDir = path.posix.dirname(posixFromPath);
    const baseCandidate = path.posix.normalize(path.posix.join(fromDir, normalizedSpecifier));
    const directCandidates = [baseCandidate];
    for (const extension of LANGUAGE_IMPORT_EXTENSIONS) {
      directCandidates.push(`${baseCandidate}${extension}`);
    }
    for (const extension of LANGUAGE_IMPORT_EXTENSIONS) {
      directCandidates.push(path.posix.join(baseCandidate, `index${extension}`));
    }
    for (const candidate of directCandidates) {
      if (indexedPathsSet.has(candidate)) {
        return candidate;
      }
    }
    return null;
  }
  if (/^[a-zA-Z0-9_\.]+$/.test(normalizedSpecifier)) {
    const dottedCandidate = normalizedSpecifier.replace(/\./g, "/");
    const pythonCandidates = [dottedCandidate, `${dottedCandidate}.py`, `${dottedCandidate}/__init__.py`];
    for (const candidate of pythonCandidates) {
      if (indexedPathsSet.has(candidate)) {
        return candidate;
      }
    }
  }
  return null;
}

async function buildImportGraph({ rootPath, indexedFilesByPath, seedPaths = [], maxDepth = 2 }) {
  const indexedPathsSet = new Set(indexedFilesByPath.keys());
  const importCache = new Map();
  const distances = new Map();
  const queue = [];
  for (const seed of seedPaths) {
    if (!indexedPathsSet.has(seed)) {
      continue;
    }
    if (!distances.has(seed)) {
      distances.set(seed, 0);
      queue.push(seed);
    }
  }

  async function getResolvedImports(filePath) {
    if (importCache.has(filePath)) {
      return importCache.get(filePath);
    }
    const metadata = indexedFilesByPath.get(filePath);
    if (!metadata) {
      importCache.set(filePath, []);
      return [];
    }
    const absolutePath = path.join(rootPath, filePath);
    let content = "";
    try {
      content = await fsp.readFile(absolutePath, "utf-8");
    } catch {
      importCache.set(filePath, []);
      return [];
    }
    const specifiers = parseModuleSpecifiers(content, metadata.language);
    const resolved = specifiers
      .map((specifier) => resolveSpecifierToIndexedPath(filePath, specifier, indexedPathsSet))
      .filter(Boolean);
    importCache.set(filePath, resolved);
    return resolved;
  }

  while (queue.length > 0) {
    const current = queue.shift();
    const distance = distances.get(current) ?? maxDepth + 1;
    if (distance >= maxDepth) {
      continue;
    }
    const imports = await getResolvedImports(current);
    for (const importedPath of imports) {
      const existing = distances.get(importedPath);
      if (existing === undefined || distance + 1 < existing) {
        distances.set(importedPath, distance + 1);
        queue.push(importedPath);
      }
    }
  }

  const edges = [];
  for (const source of distances.keys()) {
    const imports = await getResolvedImports(source);
    for (const target of imports) {
      if (distances.has(target)) {
        edges.push({
          from: source,
          to: target,
        });
      }
    }
  }

  return {
    distances,
    edges,
  };
}

function createHybridMapRunId(nowIso, workItemId) {
  const normalizedWorkItem = normalizeString(workItemId).replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 48);
  return `hybrid-map-${normalizedWorkItem}-${nowIso.replace(/[:.]/g, "-")}`;
}

export async function resolveHybridMappingStorage({
  targetPath = ".",
  outputDir = "",
  env,
  homeDir,
} = {}) {
  const daemonStorage = await resolveErrorDaemonStorage({
    targetPath,
    outputDir,
    env,
    homeDir,
  });
  const mappingDir = path.join(daemonStorage.baseDir, "mapping");
  return {
    ...daemonStorage,
    mappingDir,
    mapIndexPath: path.join(mappingDir, "hybrid-map-index.json"),
    mapEventsPath: path.join(mappingDir, "hybrid-map-events.ndjson"),
    mapRunsDir: path.join(mappingDir, "runs"),
  };
}

export async function buildHybridScopeMap({
  targetPath = ".",
  outputDir = "",
  workItemId,
  maxFiles = DEFAULT_MAX_SCOPE_FILES,
  graphDepth = DEFAULT_GRAPH_DEPTH,
  env,
  homeDir,
  nowIso = new Date().toISOString(),
} = {}) {
  const normalizedNow = normalizeIsoTimestamp(nowIso, new Date().toISOString());
  const normalizedWorkItemId = normalizeString(workItemId);
  if (!normalizedWorkItemId) {
    throw new Error("workItemId is required.");
  }
  const normalizedMaxFiles = normalizePositiveInteger(maxFiles, "maxFiles", DEFAULT_MAX_SCOPE_FILES);
  const normalizedGraphDepth = normalizePositiveInteger(
    graphDepth,
    "graphDepth",
    DEFAULT_GRAPH_DEPTH
  );

  const storage = await resolveHybridMappingStorage({
    targetPath,
    outputDir,
    env,
    homeDir,
  });
  const queue = await listErrorQueue({
    targetPath,
    outputDir,
    limit: 5000,
    env,
    homeDir,
  });
  const queueItem = queue.items.find((item) => normalizeString(item.workItemId) === normalizedWorkItemId);
  if (!queueItem) {
    throw new Error(`Work item '${normalizedWorkItemId}' was not found in daemon queue.`);
  }

  const ingest = await collectCodebaseIngest({ rootPath: targetPath });
  const indexedFiles = Array.isArray(ingest.indexedFiles?.files) ? ingest.indexedFiles.files : [];
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

  const tokens = tokenizeWorkItem(queueItem);
  const deterministicCandidates = [];
  for (const file of indexedFilesByPath.values()) {
    const deterministicScore = scoreDeterministicPath(file.path, tokens);
    if (deterministicScore <= 0) {
      continue;
    }
    deterministicCandidates.push({
      path: file.path,
      deterministicScore,
    });
  }
  deterministicCandidates.sort((left, right) => {
    if (right.deterministicScore !== left.deterministicScore) {
      return right.deterministicScore - left.deterministicScore;
    }
    return left.path.localeCompare(right.path);
  });

  const seedPaths = deterministicCandidates.slice(0, 20).map((candidate) => candidate.path);
  const importGraph = await buildImportGraph({
    rootPath: targetPath,
    indexedFilesByPath,
    seedPaths,
    maxDepth: normalizedGraphDepth,
  });

  const deterministicScoreMap = new Map(
    deterministicCandidates.map((candidate) => [candidate.path, candidate.deterministicScore])
  );
  const selectedPaths = new Set([...importGraph.distances.keys(), ...seedPaths]);
  const scoredFiles = [];
  for (const filePath of selectedPaths) {
    const metadata = indexedFilesByPath.get(filePath);
    if (!metadata) {
      continue;
    }
    const absolutePath = path.join(targetPath, filePath);
    let content = "";
    try {
      content = await fsp.readFile(absolutePath, "utf-8");
    } catch {
      content = "";
    }
    const deterministicScore = deterministicScoreMap.get(filePath) || 0;
    const semanticScore = scoreSemanticContent({
      content,
      endpoint: normalizeString(queueItem.endpoint),
      tokens,
    });
    const graphDistance = importGraph.distances.get(filePath);
    const graphScore =
      graphDistance === undefined ? 0 : Math.max(1, normalizedGraphDepth - graphDistance + 1);
    const totalScore = deterministicScore * 3 + semanticScore + graphScore;
    const reasons = [];
    if (deterministicScore > 0) {
      reasons.push(`deterministic_path_match:${deterministicScore}`);
    }
    if (semanticScore > 0) {
      reasons.push(`semantic_content_match:${semanticScore}`);
    }
    if (graphDistance !== undefined) {
      reasons.push(`import_graph_distance:${graphDistance}`);
    }
    scoredFiles.push({
      path: filePath,
      language: metadata.language,
      loc: metadata.loc,
      sizeBytes: metadata.sizeBytes,
      deterministicScore,
      semanticScore,
      graphDistance: graphDistance === undefined ? null : graphDistance,
      graphScore,
      totalScore,
      reasons,
    });
  }

  scoredFiles.sort((left, right) => {
    if (right.totalScore !== left.totalScore) {
      return right.totalScore - left.totalScore;
    }
    return left.path.localeCompare(right.path);
  });

  const scopedFiles = scoredFiles.slice(0, normalizedMaxFiles);
  const scopedPathSet = new Set(scopedFiles.map((file) => file.path));
  const scopedEdges = importGraph.edges.filter(
    (edge) => scopedPathSet.has(edge.from) && scopedPathSet.has(edge.to)
  );

  const runId = createHybridMapRunId(normalizedNow, normalizedWorkItemId);
  const runPath = path.join(storage.mapRunsDir, `${runId}.json`);
  const runPayload = {
    schemaVersion: HYBRID_MAP_SCHEMA_VERSION,
    generatedAt: normalizedNow,
    runId,
    workItem: {
      workItemId: queueItem.workItemId,
      severity: queueItem.severity,
      status: queueItem.status,
      service: queueItem.service,
      endpoint: queueItem.endpoint,
      errorCode: queueItem.errorCode,
      message: queueItem.message,
    },
    strategy: {
      mode: "hybrid_deterministic_semantic_overlay",
      tokenizedSignals: tokens,
      deterministicSeeds: deterministicCandidates.slice(0, 20),
      graphDepth: normalizedGraphDepth,
      maxFiles: normalizedMaxFiles,
    },
    summary: {
      indexedFileCount: indexedFilesByPath.size,
      deterministicCandidateCount: deterministicCandidates.length,
      graphNodeCount: importGraph.distances.size,
      graphEdgeCount: importGraph.edges.length,
      scopedFileCount: scopedFiles.length,
    },
    scopedFiles,
    importGraph: {
      nodes: [...scopedPathSet].sort((left, right) => left.localeCompare(right)),
      edges: scopedEdges,
    },
  };

  await fsp.mkdir(storage.mapRunsDir, { recursive: true });
  await writeJsonFile(runPath, runPayload);

  const rawIndex = await readJsonFile(storage.mapIndexPath, () => createInitialMapIndex(normalizedNow));
  const index = normalizeMapIndex(rawIndex, normalizedNow);
  index.generatedAt = normalizedNow;
  index.maps = [
    {
      workItemId: queueItem.workItemId,
      runId,
      generatedAt: normalizedNow,
      mapPath: toPosixPath(path.relative(storage.outputRoot, runPath)),
      service: queueItem.service,
      endpoint: queueItem.endpoint,
      errorCode: queueItem.errorCode,
      status: queueItem.status,
      tokenizedSignals: tokens,
      deterministicSeedCount: deterministicCandidates.slice(0, 20).length,
      scopedFileCount: scopedFiles.length,
    },
    ...index.maps.filter((entry) => entry.runId !== runId),
  ].slice(0, 2000);
  await Promise.all([
    writeJsonFile(storage.mapIndexPath, index),
    appendJsonLine(storage.mapEventsPath, {
      timestamp: normalizedNow,
      eventType: "hybrid_scope_map",
      runId,
      workItemId: queueItem.workItemId,
      deterministicSeedCount: deterministicCandidates.slice(0, 20).length,
      graphNodeCount: importGraph.distances.size,
      graphEdgeCount: importGraph.edges.length,
      scopedFileCount: scopedFiles.length,
    }),
  ]);

  return {
    ...storage,
    runId,
    runPath,
    summary: runPayload.summary,
    strategy: runPayload.strategy,
    scopedFiles: runPayload.scopedFiles,
    importGraph: runPayload.importGraph,
    workItem: runPayload.workItem,
  };
}

export async function listHybridScopeMaps({
  targetPath = ".",
  outputDir = "",
  workItemId = "",
  limit = 50,
  env,
  homeDir,
  nowIso = new Date().toISOString(),
} = {}) {
  const normalizedNow = normalizeIsoTimestamp(nowIso, new Date().toISOString());
  const normalizedLimit = normalizePositiveInteger(limit, "limit", 50);
  const normalizedWorkItemId = normalizeString(workItemId);
  const storage = await resolveHybridMappingStorage({
    targetPath,
    outputDir,
    env,
    homeDir,
  });
  const rawIndex = await readJsonFile(storage.mapIndexPath, () => createInitialMapIndex(normalizedNow));
  const index = normalizeMapIndex(rawIndex, normalizedNow);
  const filtered = index.maps
    .filter((entry) => {
      if (normalizedWorkItemId && normalizeString(entry.workItemId) !== normalizedWorkItemId) {
        return false;
      }
      return true;
    })
    .sort((left, right) => {
      const leftEpoch = Date.parse(String(left.generatedAt || "")) || 0;
      const rightEpoch = Date.parse(String(right.generatedAt || "")) || 0;
      return rightEpoch - leftEpoch;
    });
  return {
    ...storage,
    generatedAt: index.generatedAt,
    totalCount: index.maps.length,
    visibleCount: filtered.length,
    maps: filtered.slice(0, normalizedLimit),
  };
}

export async function showHybridScopeMap({
  targetPath = ".",
  outputDir = "",
  workItemId = "",
  runId = "",
  env,
  homeDir,
  nowIso = new Date().toISOString(),
} = {}) {
  const normalizedNow = normalizeIsoTimestamp(nowIso, new Date().toISOString());
  const storage = await resolveHybridMappingStorage({
    targetPath,
    outputDir,
    env,
    homeDir,
  });
  const listed = await listHybridScopeMaps({
    targetPath,
    outputDir,
    workItemId,
    limit: 500,
    env,
    homeDir,
    nowIso: normalizedNow,
  });
  const normalizedRunId = normalizeString(runId);
  const selected = listed.maps.find((entry) => {
    if (normalizedRunId && normalizeString(entry.runId) !== normalizedRunId) {
      return false;
    }
    if (workItemId && normalizeString(entry.workItemId) !== normalizeString(workItemId)) {
      return false;
    }
    return true;
  });
  if (!selected) {
    throw new Error(
      `No hybrid scope map found for work item '${normalizeString(workItemId) || "n/a"}' and run '${normalizedRunId || "latest"}'.`
    );
  }
  const absoluteMapPath = path.join(storage.outputRoot, selected.mapPath);
  const payload = await readJsonFile(absoluteMapPath, () => null);
  if (!payload || typeof payload !== "object") {
    throw new Error(`Hybrid scope map artifact not found: ${absoluteMapPath}`);
  }
  return {
    ...storage,
    map: selected,
    mapPath: absoluteMapPath,
    payload,
  };
}
