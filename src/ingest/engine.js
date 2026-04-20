import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { promisify } from "node:util";

import ignore from "ignore";

import { resolveOutputRoot } from "../config/service.js";

const DEFAULT_IGNORED_DIRS = new Set([
  ".git",
  "node_modules",
  ".venv",
  ".next",
  "dist",
  "build",
  "coverage",
  ".sentinelayer",
  ".turbo",
  ".idea",
  ".vscode",
]);

const MAX_FILE_SIZE_BYTES = 1024 * 1024;
const FILE_INDEX_LIMIT = 5000;
const execFileAsync = promisify(execFile);
const INGEST_CACHE_SCHEMA = "path-size-mtime-sha256-v1";

const LANGUAGE_BY_EXTENSION = {
  ".js": "JavaScript",
  ".cjs": "JavaScript",
  ".mjs": "JavaScript",
  ".ts": "TypeScript",
  ".tsx": "TypeScript",
  ".jsx": "JavaScript",
  ".py": "Python",
  ".go": "Go",
  ".rs": "Rust",
  ".java": "Java",
  ".kt": "Kotlin",
  ".swift": "Swift",
  ".rb": "Ruby",
  ".php": "PHP",
  ".cs": "C#",
  ".cpp": "C++",
  ".cc": "C++",
  ".c": "C",
  ".h": "C/C++ Header",
  ".hpp": "C/C++ Header",
  ".sql": "SQL",
  ".md": "Markdown",
  ".yml": "YAML",
  ".yaml": "YAML",
  ".json": "JSON",
  ".toml": "TOML",
  ".tf": "Terraform",
  ".sh": "Shell",
  ".bash": "Shell",
  ".ps1": "PowerShell",
  ".dockerfile": "Docker",
};

const MANIFEST_CANDIDATES = new Set([
  "package.json",
  "requirements.txt",
  "pyproject.toml",
  "go.mod",
  "Cargo.toml",
  "Gemfile",
  "pom.xml",
  "build.gradle",
  "build.gradle.kts",
  "composer.json",
]);

const ENTRY_POINT_CANDIDATES = [
  "src/index.ts",
  "src/index.tsx",
  "src/index.js",
  "src/main.ts",
  "src/main.js",
  "src/server.ts",
  "src/server.js",
  "index.ts",
  "index.js",
  "main.ts",
  "main.js",
  "main.py",
  "app.py",
  "server.py",
  "cmd/main.go",
  "src/main.rs",
];

function toPosixPath(value) {
  return String(value || "").replace(/\\/g, "/");
}

function parseIsoToEpoch(value) {
  const normalized = String(value || "").trim();
  if (!normalized) {
    return null;
  }
  const epoch = Date.parse(normalized);
  if (!Number.isFinite(epoch)) {
    return null;
  }
  return epoch;
}

function normalizeMtimeMs(value) {
  const normalized = Number(value || 0);
  if (!Number.isFinite(normalized) || normalized < 0) {
    return 0;
  }
  return Math.floor(normalized);
}

function appendFingerprintInput(hasher, relativePath, sizeBytes, mtimeMs) {
  hasher.update(
    `${toPosixPath(relativePath)}\u001f${String(Number(sizeBytes || 0))}\u001f${normalizeMtimeMs(
      mtimeMs
    )}\n`,
    "utf-8"
  );
}

function countLoc(text) {
  return String(text || "")
    .split(/\r?\n/)
    .filter((line) => line.trim().length > 0).length;
}

function detectLanguage(relativePath) {
  const normalized = toPosixPath(relativePath);
  const baseName = path.basename(normalized).toLowerCase();
  if (baseName === "dockerfile") {
    return "Docker";
  }
  const extension = path.extname(baseName);
  return LANGUAGE_BY_EXTENSION[extension] || "Other";
}

async function readIgnorePatterns(filePath) {
  try {
    const raw = await fsp.readFile(filePath, "utf-8");
    return String(raw || "")
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith("#"));
  } catch (error) {
    if (error && error.code === "ENOENT") {
      return [];
    }
    throw error;
  }
}

async function createIgnoreMatcher(rootPath) {
  const matcher = ignore();
  const gitignorePatterns = await readIgnorePatterns(path.join(rootPath, ".gitignore"));
  const sentinelPatterns = await readIgnorePatterns(path.join(rootPath, ".sentinelayerignore"));
  matcher.add([...gitignorePatterns, ...sentinelPatterns]);

  return {
    ignores(relativePath, isDirectory) {
      const normalized = toPosixPath(relativePath);
      if (!normalized) {
        return false;
      }
      const candidate = isDirectory ? `${normalized}/` : normalized;
      return matcher.ignores(candidate);
    },
  };
}

async function computeCodebaseContentFingerprint({ rootPath }) {
  const resolvedRoot = path.resolve(rootPath || process.cwd());
  const ignoreMatcher = await createIgnoreMatcher(resolvedRoot);
  const stack = [resolvedRoot];
  const hasher = createHash("sha256");
  let filesCount = 0;
  let latestFileMtimeMs = 0;

  while (stack.length > 0) {
    const current = stack.pop();
    if (!current) {
      continue;
    }

    let entries = [];
    try {
      entries = await fsp.readdir(current, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const entry of entries) {
      const fullPath = path.join(current, entry.name);
      const relativePath = toPosixPath(path.relative(resolvedRoot, fullPath));

      if (entry.isDirectory()) {
        if (!relativePath) {
          continue;
        }
        if (DEFAULT_IGNORED_DIRS.has(entry.name)) {
          continue;
        }
        if (ignoreMatcher.ignores(relativePath, true)) {
          continue;
        }
        stack.push(fullPath);
        continue;
      }

      if (!entry.isFile()) {
        continue;
      }
      if (ignoreMatcher.ignores(relativePath, false)) {
        continue;
      }

      let stat = null;
      try {
        stat = await fsp.stat(fullPath);
      } catch {
        stat = null;
      }
      if (!stat || stat.size > MAX_FILE_SIZE_BYTES) {
        continue;
      }

      filesCount += 1;
      latestFileMtimeMs = Math.max(latestFileMtimeMs, normalizeMtimeMs(stat.mtimeMs));
      appendFingerprintInput(hasher, relativePath, stat.size, stat.mtimeMs);
    }
  }

  return {
    schema: INGEST_CACHE_SCHEMA,
    contentHash: hasher.digest("hex"),
    filesCount,
    latestFileMtimeMs,
  };
}

async function readExistingIngest(outputPath) {
  try {
    const parsed = JSON.parse(await fsp.readFile(outputPath, "utf-8"));
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch (error) {
    if (error && error.code === "ENOENT") {
      return null;
    }
    throw error;
  }
}

async function resolveIngestOutputPath({ rootPath, outputFile = "", outputDir = "" }) {
  const resolvedRoot = path.resolve(rootPath || process.cwd());
  const explicitOutputFile = String(outputFile || "").trim();
  if (explicitOutputFile) {
    return path.resolve(resolvedRoot, explicitOutputFile);
  }
  const outputRoot = await resolveOutputRoot({
    cwd: resolvedRoot,
    outputDirOverride: outputDir,
  });
  return path.join(outputRoot, "CODEBASE_INGEST.json");
}

async function readGitLastCommitAt(rootPath) {
  const resolvedRoot = path.resolve(rootPath || process.cwd());
  try {
    const { stdout } = await execFileAsync("git", [
      "-C",
      resolvedRoot,
      "log",
      "-1",
      "--format=%cI",
    ]);
    const normalized = String(stdout || "").trim();
    return parseIsoToEpoch(normalized) === null ? "" : normalized;
  } catch {
    return "";
  }
}

function buildIngestStaleness({ existingIngest, fingerprint, lastCommitAt }) {
  if (!existingIngest) {
    return {
      stale: true,
      reasons: ["missing_ingest"],
    };
  }

  const reasons = [];
  const generatedAtEpoch = parseIsoToEpoch(existingIngest.generatedAt);
  const lastCommitEpoch = parseIsoToEpoch(lastCommitAt);
  if (generatedAtEpoch === null) {
    reasons.push("invalid_generated_at");
  } else if (lastCommitEpoch !== null && generatedAtEpoch < lastCommitEpoch) {
    reasons.push("older_than_last_commit");
  }

  const existingContentHash = String(existingIngest.cache?.contentHash || "").trim();
  if (existingContentHash && existingContentHash !== fingerprint.contentHash) {
    reasons.push("content_hash_mismatch");
  } else if (!existingContentHash) {
    reasons.push("missing_content_hash");
  }

  return {
    stale: reasons.length > 0,
    reasons,
  };
}

export function formatIngestResolutionNotice(resolution = {}) {
  const reasons = Array.isArray(resolution.reasons) ? resolution.reasons : [];
  if (resolution.refreshed) {
    return `ingest refreshed (${reasons.join(", ") || "requested"})`;
  }
  if (resolution.stale) {
    return `ingest stale (${reasons.join(", ") || "unknown"}); re-run with --refresh`;
  }
  return "ingest cache hit";
}

function safeJsonParse(raw) {
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function normalizeDependencySet(dependencies) {
  if (!dependencies || typeof dependencies !== "object") {
    return new Set();
  }
  return new Set(Object.keys(dependencies).map((value) => String(value || "").toLowerCase()));
}

function detectFrameworks(manifests) {
  const frameworks = new Set();

  const packageJson = manifests["package.json"] ? safeJsonParse(manifests["package.json"]) : null;
  if (packageJson) {
    const deps = normalizeDependencySet({
      ...(packageJson.dependencies || {}),
      ...(packageJson.devDependencies || {}),
      ...(packageJson.peerDependencies || {}),
    });
    if (deps.has("next")) frameworks.add("nextjs");
    if (deps.has("react")) frameworks.add("react");
    if (deps.has("vue")) frameworks.add("vue");
    if (deps.has("svelte")) frameworks.add("svelte");
    if (deps.has("express")) frameworks.add("express");
    if (deps.has("fastify")) frameworks.add("fastify");
    if (deps.has("hono")) frameworks.add("hono");
    if (deps.has("@nestjs/core")) frameworks.add("nestjs");
    if (deps.has("prisma")) frameworks.add("prisma");
    if (deps.has("typeorm")) frameworks.add("typeorm");
    if (deps.has("drizzle-orm")) frameworks.add("drizzle");
    if (deps.has("playwright")) frameworks.add("playwright");
    if (deps.has("jest")) frameworks.add("jest");
    if (deps.has("vitest")) frameworks.add("vitest");
    if (deps.has("@opentelemetry/api") || deps.has("@sentry/node")) frameworks.add("observability-js");
  }

  const requirementsText = String(manifests["requirements.txt"] || "").toLowerCase();
  if (/\bfastapi\b/.test(requirementsText)) frameworks.add("fastapi");
  if (/\bdjango\b/.test(requirementsText)) frameworks.add("django");
  if (/\bflask\b/.test(requirementsText)) frameworks.add("flask");

  const pyprojectText = String(manifests["pyproject.toml"] || "").toLowerCase();
  if (/\bfastapi\b/.test(pyprojectText)) frameworks.add("fastapi");
  if (/\bdjango\b/.test(pyprojectText)) frameworks.add("django");
  if (/\bflask\b/.test(pyprojectText)) frameworks.add("flask");

  const goModText = String(manifests["go.mod"] || "").toLowerCase();
  if (/gin-gonic\/gin/.test(goModText)) frameworks.add("gin");
  if (/gofiber\/fiber/.test(goModText)) frameworks.add("fiber");
  if (/labstack\/echo/.test(goModText)) frameworks.add("echo");

  const cargoText = String(manifests["Cargo.toml"] || "").toLowerCase();
  if (/\baxum\b/.test(cargoText)) frameworks.add("axum");
  if (/\bactix-web\b/.test(cargoText)) frameworks.add("actix-web");

  const gemfileText = String(manifests.Gemfile || "").toLowerCase();
  if (/\brails\b/.test(gemfileText)) frameworks.add("rails");

  return [...frameworks].sort((left, right) => left.localeCompare(right));
}

function derivePackageMetadata(manifests) {
  const packageJson = manifests["package.json"] ? safeJsonParse(manifests["package.json"]) : null;
  if (!packageJson || typeof packageJson !== "object") {
    return {
      name: "",
      scripts: [],
    };
  }

  const scripts =
    packageJson.scripts && typeof packageJson.scripts === "object"
      ? Object.keys(packageJson.scripts)
          .map((value) => String(value || "").trim())
          .filter(Boolean)
          .sort((left, right) => left.localeCompare(right))
      : [];

  return {
    name: String(packageJson.name || "").trim(),
    scripts,
  };
}

function deriveEntryPoints(fileSet, manifests) {
  const entryPoints = new Set();
  for (const candidate of ENTRY_POINT_CANDIDATES) {
    if (fileSet.has(candidate)) {
      entryPoints.add(candidate);
    }
  }

  const packageJson = manifests["package.json"] ? safeJsonParse(manifests["package.json"]) : null;
  if (packageJson) {
    if (typeof packageJson.main === "string" && packageJson.main.trim()) {
      entryPoints.add(packageJson.main.trim());
    }
    if (packageJson.bin && typeof packageJson.bin === "object") {
      for (const value of Object.values(packageJson.bin)) {
        const normalized = String(value || "").trim();
        if (normalized) {
          entryPoints.add(normalized);
        }
      }
    }
  }

  return [...entryPoints].sort((left, right) => left.localeCompare(right));
}

function deriveRiskSurfaces({ fileSet, frameworks, manifests, languageStats }) {
  const surfaces = new Map();

  const addSurface = (surface, reason) => {
    if (!surfaces.has(surface)) {
      surfaces.set(surface, reason);
    }
  };

  const hasFile = (predicate) => [...fileSet].some(predicate);
  const hasFramework = (name) => frameworks.includes(name);

  addSurface("code_quality", "Source files detected.");
  addSurface("security_overlay", "Credential/policy scanning is applicable for any repository ingest.");

  const hasTests = hasFile((file) => /(^|\/)(test|tests|__tests__)\//.test(file) || /\.(test|spec)\./.test(file));
  if (hasTests || hasFramework("jest") || hasFramework("vitest") || hasFramework("playwright")) {
    addSurface("testing_correctness", "Test assets detected.");
  }

  const hasFrontend =
    hasFramework("nextjs") ||
    hasFramework("react") ||
    hasFramework("vue") ||
    hasFramework("svelte") ||
    languageStats.JavaScript ||
    languageStats.TypeScript;
  if (hasFrontend) {
    addSurface("frontend_runtime", "Frontend/runtime JavaScript stack detected.");
  }

  const hasBackend =
    hasFramework("express") ||
    hasFramework("nestjs") ||
    hasFramework("fastify") ||
    hasFramework("hono") ||
    hasFramework("fastapi") ||
    hasFramework("django") ||
    hasFramework("flask") ||
    hasFramework("gin") ||
    hasFramework("fiber") ||
    hasFramework("echo");
  if (hasBackend) {
    addSurface("backend_runtime", "Backend framework/runtime hints detected.");
  }

  const hasData =
    hasFramework("prisma") ||
    hasFramework("typeorm") ||
    hasFramework("drizzle") ||
    hasFile((file) => /(^|\/)(migrations|db|database|sql)\//.test(file) || file.endsWith(".sql"));
  if (hasData) {
    addSurface("data_layer", "Data-model or migration assets detected.");
  }

  const hasInfra =
    hasFile(
      (file) =>
        file.endsWith(".tf") ||
        file.includes("docker-compose") ||
        file.endsWith("Dockerfile") ||
        /(^|\/)(k8s|helm|terraform)\//.test(file)
    );
  if (hasInfra) {
    addSurface("infrastructure", "Infrastructure-as-code or container orchestration assets detected.");
  }

  const hasRelease = hasFile((file) => file.startsWith(".github/workflows/") || file.startsWith(".gitlab-ci"));
  if (hasRelease) {
    addSurface("release_engineering", "CI/CD workflow definitions detected.");
  }

  const hasSupplyChain =
    Object.keys(manifests).length > 0 ||
    hasFile((file) =>
      [
        "package-lock.json",
        "pnpm-lock.yaml",
        "yarn.lock",
        "poetry.lock",
        "Pipfile.lock",
        "Cargo.lock",
      ].some((candidate) => file.endsWith(candidate))
    );
  if (hasSupplyChain) {
    addSurface("supply_chain", "Dependency manifests/lockfiles detected.");
  }

  const hasObservability =
    hasFramework("observability-js") ||
    hasFile((file) => /sentry|opentelemetry|prometheus|grafana/i.test(file));
  if (hasObservability) {
    addSurface("observability", "Observability tooling indicators detected.");
  }

  const hasAiPipeline = hasFile((file) => /(^|\/)(prompts|models|llm|agents?)\//i.test(file));
  if (hasAiPipeline) {
    addSurface("ai_pipeline", "AI/agent pipeline assets detected.");
  }

  const hasDocs = hasFile((file) => file.endsWith(".md") || file.startsWith("docs/"));
  if (hasDocs) {
    addSurface("docs_knowledge", "Documentation assets detected.");
  }

  if (hasInfra || hasObservability || hasRelease) {
    addSurface("reliability_sre", "Operational and deployment assets detected.");
  }

  return [...surfaces.entries()]
    .map(([surface, reason]) => ({ surface, reason }))
    .sort((left, right) => left.surface.localeCompare(right.surface));
}

function summarizeLanguageStats(languageStats, totalLoc) {
  return Object.entries(languageStats)
    .map(([language, stats]) => ({
      language,
      files: stats.files,
      loc: stats.loc,
      locShare: totalLoc > 0 ? Number((stats.loc / totalLoc).toFixed(4)) : 0,
    }))
    .sort((left, right) => right.loc - left.loc || left.language.localeCompare(right.language));
}

async function listTopLevel(rootPath, ignoreMatcher) {
  const dirs = [];
  const files = [];
  let entries = [];
  try {
    entries = await fsp.readdir(rootPath, { withFileTypes: true });
  } catch {
    return { directories: dirs, files };
  }

  for (const entry of entries) {
    const name = String(entry.name || "");
    if (!name) continue;
    if (DEFAULT_IGNORED_DIRS.has(name)) continue;
    if (ignoreMatcher.ignores(name, entry.isDirectory())) continue;
    if (entry.isDirectory()) {
      dirs.push(name);
    } else if (entry.isFile()) {
      files.push(name);
    }
  }

  return {
    directories: dirs.sort((left, right) => left.localeCompare(right)).slice(0, 200),
    files: files.sort((left, right) => left.localeCompare(right)).slice(0, 200),
  };
}

export async function collectCodebaseIngest({ rootPath = process.cwd() } = {}) {
  const resolvedRoot = path.resolve(rootPath);
  const ignoreMatcher = await createIgnoreMatcher(resolvedRoot);
  const topLevel = await listTopLevel(resolvedRoot, ignoreMatcher);
  const fingerprintHasher = createHash("sha256");
  let fingerprintFilesCount = 0;
  let latestFileMtimeMs = 0;

  const stack = [resolvedRoot];
  const fileSet = new Set();
  const languageStats = {};
  const manifests = {};

  const indexedFiles = [];
  let indexedOmittedCount = 0;
  let filesScanned = 0;
  let directoriesScanned = 0;
  let totalLoc = 0;
  let totalBytes = 0;

  while (stack.length > 0) {
    const current = stack.pop();
    if (!current) continue;

    let entries = [];
    try {
      entries = await fsp.readdir(current, { withFileTypes: true });
    } catch {
      continue;
    }

    directoriesScanned += 1;

    for (const entry of entries) {
      const fullPath = path.join(current, entry.name);
      const relativePath = toPosixPath(path.relative(resolvedRoot, fullPath));

      if (entry.isDirectory()) {
        if (!relativePath) {
          continue;
        }
        if (DEFAULT_IGNORED_DIRS.has(entry.name)) {
          continue;
        }
        if (ignoreMatcher.ignores(relativePath, true)) {
          continue;
        }
        stack.push(fullPath);
        continue;
      }

      if (!entry.isFile()) {
        continue;
      }
      if (ignoreMatcher.ignores(relativePath, false)) {
        continue;
      }

      let stat;
      try {
        stat = await fsp.stat(fullPath);
      } catch {
        continue;
      }
      if (!stat || stat.size > MAX_FILE_SIZE_BYTES) {
        continue;
      }

      appendFingerprintInput(fingerprintHasher, relativePath, stat.size, stat.mtimeMs);
      fingerprintFilesCount += 1;
      latestFileMtimeMs = Math.max(latestFileMtimeMs, normalizeMtimeMs(stat.mtimeMs));

      let text = "";
      try {
        text = await fsp.readFile(fullPath, "utf-8");
      } catch {
        continue;
      }

      const loc = countLoc(text);
      const language = detectLanguage(relativePath);

      filesScanned += 1;
      totalLoc += loc;
      totalBytes += stat.size;
      fileSet.add(relativePath);

      if (!languageStats[language]) {
        languageStats[language] = { files: 0, loc: 0 };
      }
      languageStats[language].files += 1;
      languageStats[language].loc += loc;

      const baseName = path.basename(relativePath);
      if (MANIFEST_CANDIDATES.has(baseName)) {
        manifests[baseName] = text;
      }

      if (indexedFiles.length < FILE_INDEX_LIMIT) {
        indexedFiles.push({
          path: relativePath,
          language,
          loc,
          sizeBytes: stat.size,
        });
      } else {
        indexedOmittedCount += 1;
      }
    }
  }

  const frameworks = detectFrameworks(manifests);
  const packageMetadata = derivePackageMetadata(manifests);
  const entryPoints = deriveEntryPoints(fileSet, manifests);
  const riskSurfaces = deriveRiskSurfaces({
    fileSet,
    frameworks,
    manifests,
    languageStats,
  });

  return {
    schemaVersion: "1.0.0",
    generatedAt: new Date().toISOString(),
    rootPath: resolvedRoot,
    summary: {
      filesScanned,
      directoriesScanned,
      totalLoc,
      totalBytes,
    },
    topLevel,
    manifests: {
      detected: Object.keys(manifests).sort((left, right) => left.localeCompare(right)),
    },
    languages: summarizeLanguageStats(languageStats, totalLoc),
    frameworks,
    packageMetadata,
    entryPoints,
    riskSurfaces,
    indexedFiles: {
      limit: FILE_INDEX_LIMIT,
      omitted: indexedOmittedCount,
      files: indexedFiles,
    },
    cache: {
      schema: INGEST_CACHE_SCHEMA,
      contentHash: fingerprintHasher.digest("hex"),
      filesCount: fingerprintFilesCount,
      latestFileMtimeMs,
    },
  };
}

export function formatIngestSummary(ingest) {
  const summary = ingest && ingest.summary ? ingest.summary : {};
  const languageHead = Array.isArray(ingest.languages)
    ? ingest.languages
        .slice(0, 5)
        .map((item) => `${item.language}(${item.files} files/${item.loc} LOC)`)
        .join(", ")
    : "none";
  const frameworks = Array.isArray(ingest.frameworks) && ingest.frameworks.length
    ? ingest.frameworks.join(", ")
    : "none";
  const entryPoints = Array.isArray(ingest.entryPoints) && ingest.entryPoints.length
    ? ingest.entryPoints.join(", ")
    : "none";
  const packageName = String(ingest.packageMetadata?.name || "").trim();
  const packageScripts = Array.isArray(ingest.packageMetadata?.scripts)
    ? ingest.packageMetadata.scripts
    : [];

  const lines = [
    `Workspace path: ${ingest.rootPath}`,
    `Top-level directories: ${(ingest.topLevel?.directories || []).slice(0, 20).join(", ") || "none"}`,
    `Top-level files: ${(ingest.topLevel?.files || []).slice(0, 20).join(", ") || "none"}`,
    `Files scanned: ${summary.filesScanned || 0}`,
    `Total LOC: ${summary.totalLoc || 0}`,
    `Languages: ${languageHead}`,
    `Frameworks: ${frameworks}`,
    `Entry points: ${entryPoints}`,
  ];

  if (packageName) {
    lines.push(`package.json name: ${packageName}`);
  }
  if (packageScripts.length > 0) {
    lines.push(`package scripts: ${packageScripts.slice(0, 15).join(", ")}`);
  }

  return lines.join("\n");
}

export async function writeCodebaseIngest({ ingest, rootPath, outputFile = "", outputDir = "" } = {}) {
  const resolvedRoot = path.resolve(rootPath || process.cwd());
  const resolvedOutputFile = String(outputFile || "").trim();
  const outputPath = resolvedOutputFile
    ? path.resolve(resolvedRoot, resolvedOutputFile)
    : path.join(
        await resolveOutputRoot({
          cwd: resolvedRoot,
          outputDirOverride: outputDir,
        }),
        "CODEBASE_INGEST.json"
      );

  await fsp.mkdir(path.dirname(outputPath), { recursive: true });
  await fsp.writeFile(outputPath, `${JSON.stringify(ingest, null, 2)}\n`, "utf-8");
  return outputPath;
}

export async function resolveCodebaseIngest({
  rootPath = process.cwd(),
  outputFile = "",
  outputDir = "",
  refresh = false,
} = {}) {
  const resolvedRoot = path.resolve(rootPath || process.cwd());
  const outputPath = await resolveIngestOutputPath({
    rootPath: resolvedRoot,
    outputFile,
    outputDir,
  });
  const existingIngest = await readExistingIngest(outputPath);
  const fingerprint = await computeCodebaseContentFingerprint({
    rootPath: resolvedRoot,
  });
  const lastCommitAt = await readGitLastCommitAt(resolvedRoot);
  const staleness = buildIngestStaleness({
    existingIngest,
    fingerprint,
    lastCommitAt,
  });
  const staleBeforeRefresh = staleness.stale;

  let ingest = existingIngest;
  let refreshed = false;
  let refreshedBecause = "";
  if (!existingIngest) {
    refreshed = true;
    refreshedBecause = "missing_ingest";
  } else if (refresh) {
    refreshed = true;
    refreshedBecause = "refresh_requested";
  }

  if (refreshed) {
    ingest = await collectCodebaseIngest({
      rootPath: resolvedRoot,
    });
    ingest.generatedAt = new Date().toISOString();
    if (!ingest.cache || typeof ingest.cache !== "object") {
      ingest.cache = {};
    }
    ingest.cache.schema = INGEST_CACHE_SCHEMA;
    ingest.cache.contentHash = fingerprint.contentHash;
    ingest.cache.filesCount = fingerprint.filesCount;
    ingest.cache.latestFileMtimeMs = fingerprint.latestFileMtimeMs;
    await writeCodebaseIngest({
      ingest,
      rootPath: resolvedRoot,
      outputFile,
      outputDir,
    });
  }

  const resolutionReasons = refreshed
    ? [refreshedBecause, ...staleness.reasons].filter(Boolean)
    : staleness.reasons;

  return {
    ingest,
    outputPath,
    refreshed,
    stale: refreshed ? false : staleness.stale,
    staleBeforeRefresh,
    reasons: resolutionReasons,
    refreshedBecause,
    refreshRequested: Boolean(refresh),
    lastCommitAt,
    fingerprint,
    event:
      refreshed || staleBeforeRefresh
        ? {
            event: "ingest_refresh",
            payload: {
              refreshed,
              stale: refreshed ? false : staleness.stale,
              reason:
                refreshedBecause || (staleness.reasons.length > 0 ? staleness.reasons.join(",") : "cache_hit"),
              contentHash: fingerprint.contentHash,
              filesCount: fingerprint.filesCount,
              lastCommitAt,
            },
          }
        : null,
  };
}

export async function generateCodebaseIngest({
  rootPath = process.cwd(),
  outputFile = "",
  outputDir = "",
} = {}) {
  const ingest = await collectCodebaseIngest({ rootPath });
  const outputPath = await writeCodebaseIngest({
    ingest,
    rootPath,
    outputFile,
    outputDir,
  });
  return {
    ingest,
    outputPath,
  };
}

// File → persona ownership routing (#A10, spec §5.7). Implementation lives
// in ./ownership.js to keep this 918-LOC module from ballooning; re-exported
// here so existing callers that already import from ingest/engine.js can
// reach the new API without extra plumbing.
export {
  buildOwnershipMap,
  computeRoutingStats,
  loadScaffoldConfig,
  parseScaffoldYaml,
  routeFileHeuristic,
  routeFindingsToPersonas,
  DEFAULT_HEURISTIC_FALLBACK,
  SCAFFOLD_RELATIVE_PATH,
} from "./ownership.js";
