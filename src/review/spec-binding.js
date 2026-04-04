import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fsp from "node:fs/promises";
import path from "node:path";

const SOURCE_EXTENSIONS = new Set([
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
  ".ts",
  ".tsx",
  ".py",
  ".go",
  ".rs",
  ".java",
  ".kt",
  ".cs",
  ".rb",
  ".php",
  ".sql",
]);

const TOKEN_STOPWORDS = new Set([
  "src",
  "app",
  "apps",
  "index",
  "main",
  "lib",
  "libs",
  "api",
  "service",
  "services",
  "controller",
  "controllers",
  "route",
  "routes",
  "test",
  "tests",
  "spec",
  "docs",
  "doc",
  "config",
  "utils",
  "shared",
  "core",
  "client",
  "server",
  "web",
  "worker",
  "jobs",
  "task",
  "tasks",
  "feature",
  "features",
]);

function normalizeString(value) {
  return String(value || "").trim();
}

function toPosixPath(value) {
  return String(value || "").replace(/\\/g, "/");
}

function normalizeEndpoint(rawEndpoint) {
  let normalized = normalizeString(rawEndpoint).toLowerCase();
  if (!normalized || !normalized.startsWith("/")) {
    return "";
  }
  normalized = normalized.replace(/\s+/g, "");
  normalized = normalized.replace(/\/+/g, "/");
  if (normalized.length > 1 && normalized.endsWith("/")) {
    normalized = normalized.slice(0, -1);
  }
  return normalized;
}

function sectionBody(markdown, headingTitle) {
  const source = String(markdown || "");
  if (!source.trim()) {
    return "";
  }

  const escapedTitle = headingTitle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = new RegExp(`##\\s+${escapedTitle}\\s*\\n([\\s\\S]*?)(?=\\n##\\s+|$)`, "i");
  const match = source.match(pattern);
  return match ? String(match[1] || "").trim() : "";
}

function parseAcceptanceCriteria(markdown) {
  return sectionBody(markdown, "Acceptance Criteria")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => /^\d+\.\s+/.test(line))
    .map((line) => line.replace(/^\d+\.\s+/, "").trim())
    .filter(Boolean);
}

function parseEndpointsFromLine(line) {
  const endpoints = [];
  const normalizedLine = String(line || "");
  if (!normalizedLine.trim()) {
    return endpoints;
  }

  const tableMatch = normalizedLine.match(/\|\s*(\/[^\s|]+)\s*\|\s*(GET|POST|PUT|PATCH|DELETE|OPTIONS|HEAD)\b/i);
  if (tableMatch) {
    const endpoint = normalizeEndpoint(tableMatch[1]);
    if (endpoint) {
      endpoints.push(endpoint);
    }
  }

  const verbPattern = /\b(GET|POST|PUT|PATCH|DELETE|OPTIONS|HEAD)\b[^\n]*?\s(\/[A-Za-z0-9\-._~/:{}]+)\b/g;
  for (const match of normalizedLine.matchAll(verbPattern)) {
    const endpoint = normalizeEndpoint(match[2]);
    if (endpoint) {
      endpoints.push(endpoint);
    }
  }

  const genericPathPattern = /(^|[\s(`"'=:,])\/[A-Za-z0-9][A-Za-z0-9\-._~/:{}]*/g;
  for (const match of normalizedLine.matchAll(genericPathPattern)) {
    const endpoint = normalizeEndpoint(match[0]);
    if (endpoint && endpoint !== "/") {
      endpoints.push(endpoint);
    }
  }

  return endpoints;
}

export function extractSpecContractSignals(markdown = "") {
  const endpointSet = new Set();
  const lines = String(markdown || "").split(/\r?\n/);
  for (const line of lines) {
    for (const endpoint of parseEndpointsFromLine(line)) {
      endpointSet.add(endpoint);
    }
  }

  return {
    endpoints: [...endpointSet].sort((left, right) => left.localeCompare(right)),
    acceptanceCriteria: parseAcceptanceCriteria(markdown),
  };
}

export function collectRouteLiteralsFromSource(source = "") {
  const text = String(source || "");
  const endpointSet = new Set();

  const directRoutePattern =
    /\b(?:app|router|route|fastify|server|hono)\s*\.\s*(?:get|post|put|patch|delete|options|head|all)\s*\(\s*["'`](\/[^"'`)\s?#]+(?:\/[^"'`)\s?#]+)*)/gi;
  for (const match of text.matchAll(directRoutePattern)) {
    const endpoint = normalizeEndpoint(match[1]);
    if (endpoint) {
      endpointSet.add(endpoint);
    }
  }

  const clientRoutePattern =
    /\b(?:fetch|axios\.(?:get|post|put|patch|delete)|apiClient\.(?:get|post|put|patch|delete))\s*\(\s*["'`](\/[^"'`)\s?#]+(?:\/[^"'`)\s?#]+)*)/gi;
  for (const match of text.matchAll(clientRoutePattern)) {
    const endpoint = normalizeEndpoint(match[1]);
    if (endpoint) {
      endpointSet.add(endpoint);
    }
  }

  return [...endpointSet].sort((left, right) => left.localeCompare(right));
}

function buildSpecFinding({ ruleId, file, line = 1, message, excerpt, suggestedFix }) {
  return {
    severity: "P2",
    file,
    line,
    message,
    excerpt,
    ruleId,
    suggestedFix,
    layer: "spec_binding",
  };
}

function tokenizePath(relativePath) {
  const normalized = toPosixPath(relativePath).toLowerCase();
  const rawTokens = normalized.split(/[^a-z0-9]+/g).filter(Boolean);
  const tokens = new Set();
  for (const token of rawTokens) {
    if (token.length < 3) {
      continue;
    }
    if (TOKEN_STOPWORDS.has(token)) {
      continue;
    }
    tokens.add(token);
  }
  return [...tokens];
}

function isSourceFile(relativePath) {
  return SOURCE_EXTENSIONS.has(path.extname(String(relativePath || "")).toLowerCase());
}

function isScopeExemptPath(relativePath, specRelativePath) {
  const normalized = toPosixPath(relativePath).toLowerCase();
  if (!normalized) {
    return true;
  }
  if (specRelativePath && normalized === specRelativePath.toLowerCase()) {
    return true;
  }
  if (
    normalized.startsWith("docs/") ||
    normalized.startsWith(".github/") ||
    normalized.startsWith("tasks/") ||
    normalized.startsWith("tests/") ||
    normalized.includes("/__tests__/") ||
    normalized.includes(".test.") ||
    normalized.includes(".spec.")
  ) {
    return true;
  }
  return false;
}

function detectEndpointLine(text, endpoint) {
  const idx = String(text || "").indexOf(endpoint);
  if (idx < 0) {
    return 1;
  }
  return String(text || "")
    .slice(0, idx)
    .split(/\r?\n/).length;
}

function runGitList(cwd, args) {
  const result = spawnSync("git", args, {
    cwd,
    encoding: "utf-8",
  });
  if (result.status !== 0) {
    return [];
  }
  return String(result.stdout || "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

function collectChangedStatusMap(targetPath, mode) {
  const map = new Map();
  if (mode !== "diff" && mode !== "staged") {
    return map;
  }

  const revParse = spawnSync("git", ["rev-parse", "--is-inside-work-tree"], {
    cwd: targetPath,
    encoding: "utf-8",
  });
  if (revParse.status !== 0 || !String(revParse.stdout || "").trim().toLowerCase().includes("true")) {
    return map;
  }

  const applyNameStatus = (rows) => {
    for (const row of rows) {
      const parts = row.split(/\s+/).filter(Boolean);
      if (parts.length < 2) {
        continue;
      }
      const status = String(parts[0] || "").toUpperCase();
      const relativePath = toPosixPath(parts[parts.length - 1]);
      if (!relativePath) {
        continue;
      }
      if (!map.has(relativePath)) {
        map.set(relativePath, status);
      }
    }
  };

  if (mode === "diff") {
    applyNameStatus(runGitList(targetPath, ["diff", "--name-status", "--diff-filter=ACMRTUXB"]));
  }
  applyNameStatus(runGitList(targetPath, ["diff", "--name-status", "--cached", "--diff-filter=ACMRTUXB"]));

  if (mode === "diff") {
    const untracked = runGitList(targetPath, ["ls-files", "--others", "--exclude-standard"]);
    for (const relativePath of untracked) {
      if (!map.has(relativePath)) {
        map.set(toPosixPath(relativePath), "A");
      }
    }
  }

  return map;
}

async function resolveSpecArtifact({ targetPath, specFile = "" } = {}) {
  const resolvedTargetPath = path.resolve(targetPath);
  const candidates = [];
  const explicit = normalizeString(specFile);
  if (explicit) {
    candidates.push(path.resolve(resolvedTargetPath, explicit));
  }
  candidates.push(path.join(resolvedTargetPath, "SPEC.md"));
  candidates.push(path.join(resolvedTargetPath, "docs", "spec.md"));

  for (const candidate of candidates) {
    try {
      const markdown = await fsp.readFile(candidate, "utf-8");
      return {
        exists: true,
        path: candidate,
        relativePath: toPosixPath(path.relative(resolvedTargetPath, candidate)),
        markdown,
        sha256: createHash("sha256").update(markdown).digest("hex"),
      };
    } catch {
      continue;
    }
  }

  return {
    exists: false,
    path: "",
    relativePath: "",
    markdown: "",
    sha256: "",
  };
}

export async function runSpecBindingChecks({
  targetPath,
  mode = "full",
  scopedFilePaths = [],
  maxFindings = 40,
  specFile = "",
} = {}) {
  const resolvedTargetPath = path.resolve(String(targetPath || "."));
  const spec = await resolveSpecArtifact({
    targetPath: resolvedTargetPath,
    specFile,
  });

  if (!spec.exists) {
    return {
      findings: [],
      metadata: {
        enabled: false,
        specPath: "",
        specHashSha256: "",
        endpointCount: 0,
        acceptanceCriteriaCount: 0,
      },
    };
  }

  const specSignals = extractSpecContractSignals(spec.markdown);
  const specEndpoints = new Set(specSignals.endpoints);
  const normalizedSpecText = spec.markdown.toLowerCase();
  const changedStatus = collectChangedStatusMap(resolvedTargetPath, String(mode || "full").toLowerCase());
  const findings = [];
  const dedupe = new Set();
  const tokenMatchesByPath = new Map();

  const scopedRelativePaths = scopedFilePaths.map((filePath) =>
    toPosixPath(path.relative(resolvedTargetPath, filePath))
  );

  const pushFinding = (finding) => {
    if (findings.length >= maxFindings) {
      return;
    }
    const key = `${finding.ruleId}:${finding.file}:${finding.line}:${finding.message}`;
    if (dedupe.has(key)) {
      return;
    }
    dedupe.add(key);
    findings.push(finding);
  };

  const evaluateScopeDrift = String(mode || "full").toLowerCase() === "diff" || String(mode || "full").toLowerCase() === "staged";

  for (const relativePath of scopedRelativePaths) {
    if (!isSourceFile(relativePath)) {
      continue;
    }
    if (isScopeExemptPath(relativePath, spec.relativePath)) {
      tokenMatchesByPath.set(relativePath, true);
      continue;
    }
    const tokenMatches = tokenizePath(relativePath).some((token) => normalizedSpecText.includes(token));
    tokenMatchesByPath.set(relativePath, tokenMatches);
    if (evaluateScopeDrift && !tokenMatches) {
      pushFinding(
        buildSpecFinding({
          ruleId: "SL-SPEC-001",
          file: relativePath,
          line: 1,
          message: "Change appears outside declared spec scope.",
          excerpt: `File '${relativePath}' has no strong token overlap with the active spec.`,
          suggestedFix: "Update the spec scope or move this change to a spec-aligned PR.",
        })
      );
    }
  }

  for (const filePath of scopedFilePaths) {
    if (findings.length >= maxFindings) {
      break;
    }
    const relativePath = toPosixPath(path.relative(resolvedTargetPath, filePath));
    if (!isSourceFile(relativePath) || isScopeExemptPath(relativePath, spec.relativePath)) {
      continue;
    }

    let source = "";
    try {
      source = await fsp.readFile(filePath, "utf-8");
    } catch {
      continue;
    }

    for (const endpoint of collectRouteLiteralsFromSource(source)) {
      if (findings.length >= maxFindings) {
        break;
      }
      if (!specEndpoints.has(endpoint)) {
        pushFinding(
          buildSpecFinding({
            ruleId: "SL-SPEC-002",
            file: relativePath,
            line: detectEndpointLine(source, endpoint),
            message: "Endpoint change is missing from spec coverage.",
            excerpt: `Endpoint '${endpoint}' is present in code but not in the active spec.`,
            suggestedFix: "Add the endpoint and acceptance criteria to the spec before merge.",
          })
        );
      }
    }
  }

  if (evaluateScopeDrift) {
    for (const relativePath of scopedRelativePaths) {
      if (findings.length >= maxFindings) {
        break;
      }
      if (!isSourceFile(relativePath) || isScopeExemptPath(relativePath, spec.relativePath)) {
        continue;
      }
      const status = String(changedStatus.get(relativePath) || "");
      const isAdded = status.startsWith("A");
      if (!isAdded) {
        continue;
      }
      const tokenMatches = Boolean(tokenMatchesByPath.get(relativePath));
      if (!tokenMatches) {
        pushFinding(
          buildSpecFinding({
            ruleId: "SL-SPEC-002",
            file: relativePath,
            line: 1,
            message: "New source file is not represented in spec scope.",
            excerpt: `Added file '${relativePath}' is outside declared spec coverage.`,
            suggestedFix: "Extend spec scope and acceptance criteria for this new file surface.",
          })
        );
      }
    }
  }

  return {
    findings,
    metadata: {
      enabled: true,
      specPath: spec.path,
      specHashSha256: spec.sha256,
      endpointCount: specSignals.endpoints.length,
      acceptanceCriteriaCount: specSignals.acceptanceCriteria.length,
      endpointsPreview: specSignals.endpoints.slice(0, 10),
    },
  };
}
