import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";

const KEYWORD_REGEX =
  /(token|secret|api[_-]?key|access[_-]?token|refresh[_-]?token|id[_-]?token|authorization|password|passphrase|credential|cookie|session[_-]?(?:id|token)?)/i;
const KEY_VALUE_REGEX =
  /(token|secret|api[_-]?key|access[_-]?token|refresh[_-]?token|id[_-]?token|authorization|password|passphrase|credential|cookie|session[_-]?(?:id|token)?)[^\n]{0,40}[:=]\s*['"]?([A-Za-z0-9/+_.-]{16,})/i;
const CANDIDATE_REGEX = /[A-Za-z0-9/+_.-]{32,}/g;
const SECRET_PATTERNS = Object.freeze([
  Object.freeze({
    type: "github_token",
    regex: /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/g,
  }),
  Object.freeze({
    type: "openai_or_anthropic_key",
    regex: /\bsk-(?:[A-Za-z0-9]+-)*[A-Za-z0-9_-]{20,}\b/g,
  }),
  Object.freeze({
    type: "shift4_key",
    regex: /\bsk_(?:live|test)_[A-Za-z0-9]{16,}\b/g,
  }),
  Object.freeze({
    type: "google_api_key",
    regex: /\bAIza[0-9A-Za-z_-]{35}\b/g,
  }),
  Object.freeze({
    type: "slack_token",
    regex: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g,
  }),
  Object.freeze({
    type: "aws_access_key_id",
    regex: /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g,
  }),
  Object.freeze({
    type: "provider_api_key",
    regex: /\b(?:xai-|gsk_)[A-Za-z0-9_-]{20,}\b/g,
  }),
  Object.freeze({
    type: "npm_token",
    regex: /\bnpm_[A-Za-z0-9]{30,}\b/g,
  }),
  Object.freeze({
    type: "jwt",
    regex: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g,
  }),
  Object.freeze({
    type: "private_key",
    regex: /-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY(?: BLOCK)?-----/g,
  }),
  Object.freeze({
    type: "authorization_header",
    regex: /\b(?:Bearer\s+[A-Za-z0-9._~+/=-]{8,}|Basic\s+[A-Za-z0-9+/]{4,}={0,2})\b/gi,
  }),
  Object.freeze({
    type: "database_url",
    regex: /\b(?:postgres(?:ql)?|mysql|mariadb|mongodb(?:\+srv)?|rediss?|amqps?):\/\/[^/\s:@]+:[^@\s/]+@/gi,
  }),
  Object.freeze({
    type: "cookie_header",
    regex: /\b(?:set-cookie|cookie)\s*:\s*[^;\s=]+=[^;\s]{4,}/gi,
  }),
  Object.freeze({
    type: "password_or_credential",
    regex: /\b(?:password|passphrase|credential)\b[^\n]{0,24}[:=]\s*['"]?[^\s'",;}{]{6,}/gi,
  }),
]);

const DEFAULT_MAX_BYTES = 64 * 1024 * 1024;
const DEFAULT_MAX_TOTAL_BYTES = 256 * 1024 * 1024;
const DEFAULT_MAX_FILES = 10_000;
const MAX_REPORTED_FINDINGS = 1_000;

function parsePositiveInteger(value, flag) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`${flag} must be a positive safe integer`);
  }
  return parsed;
}

function parseArgs() {
  const args = process.argv.slice(2);
  const result = {
    dir: "omar-artifacts",
    report: "omar-artifacts/secret-scan.json",
    manifest: "",
    expectedManifest: "",
    maxBytes: DEFAULT_MAX_BYTES,
    maxTotalBytes: DEFAULT_MAX_TOTAL_BYTES,
    maxFiles: DEFAULT_MAX_FILES,
  };
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === "--path") {
      result.dir = args[i + 1];
      i += 1;
    } else if (arg === "--report") {
      result.report = args[i + 1];
      i += 1;
    } else if (arg === "--manifest") {
      result.manifest = args[i + 1];
      i += 1;
    } else if (arg === "--expected-manifest") {
      result.expectedManifest = args[i + 1];
      i += 1;
    } else if (arg === "--max-bytes") {
      result.maxBytes = parsePositiveInteger(args[i + 1], arg);
      i += 1;
    } else if (arg === "--max-total-bytes") {
      result.maxTotalBytes = parsePositiveInteger(args[i + 1], arg);
      i += 1;
    } else if (arg === "--max-files") {
      result.maxFiles = parsePositiveInteger(args[i + 1], arg);
      i += 1;
    }
  }
  if (result.manifest && result.expectedManifest) {
    throw new Error("--manifest and --expected-manifest are mutually exclusive");
  }
  return result;
}

function listFiles(root, { maxFiles, maxTotalBytes, excludedPaths = new Set() }) {
  const files = [];
  const queue = [root];
  const resolvedRoot = path.resolve(root);
  let observedEntries = 0;
  let totalBytes = 0;
  while (queue.length) {
    const current = queue.pop();
    if (!current || !fs.existsSync(current)) {
      continue;
    }
    if (excludedPaths.has(path.resolve(current))) {
      continue;
    }
    if (path.resolve(current) !== resolvedRoot) {
      observedEntries += 1;
      if (observedEntries > maxFiles) {
        return {
          files: [],
          findings: [{
            file: null,
            line: null,
            type: "file_count_limit",
            observed_files: observedEntries,
            max_files: maxFiles,
          }],
        };
      }
    }
    const stats = fs.lstatSync(current);
    if (stats.isSymbolicLink()) {
      throw new Error("Artifact scan refuses symbolic links");
    }
    if (stats.isDirectory()) {
      const entries = fs.readdirSync(current).sort().reverse();
      for (const entry of entries) {
        queue.push(path.join(current, entry));
      }
      continue;
    }
    if (stats.isFile()) {
      files.push({
        path: current,
        size: stats.size,
        device: stats.dev,
        inode: stats.ino,
      });
      totalBytes += stats.size;
      if (totalBytes > maxTotalBytes) {
        return {
          files: [],
          findings: [{
            file: null,
            line: null,
            type: "aggregate_size_limit",
            observed_bytes: totalBytes,
            max_total_bytes: maxTotalBytes,
          }],
        };
      }
      continue;
    }
    throw new Error("Artifact scan refuses non-regular filesystem entries");
  }
  return { files, findings: [] };
}

function shannonEntropy(value) {
  if (!value) return 0;
  const counts = new Map();
  for (const char of value) {
    counts.set(char, (counts.get(char) || 0) + 1);
  }
  let entropy = 0;
  for (const count of counts.values()) {
    const p = count / value.length;
    entropy -= p * Math.log2(p);
  }
  return entropy;
}

function fingerprint(value) {
  return `sha256:${createHash("sha256").update(value).digest("hex").slice(0, 16)}`;
}

function createFinding(filePath, lineNumber, type, value) {
  return {
    file: filePath,
    line: lineNumber,
    type,
    fingerprint: fingerprint(value),
    match_length: value.length,
  };
}

function scanLine(line, filePath, lineNumber, maxFindings = MAX_REPORTED_FINDINGS) {
  const findings = [];
  const seen = new Set();
  const addFinding = (type, value) => {
    if (findings.length >= maxFindings) {
      return;
    }
    const candidate = createFinding(filePath, lineNumber, type, value);
    const key = `${type}:${candidate.fingerprint}`;
    if (!seen.has(key)) {
      seen.add(key);
      findings.push(candidate);
    }
  };

  for (const { type, regex } of SECRET_PATTERNS) {
    if (findings.length >= maxFindings) {
      break;
    }
    for (const match of line.matchAll(regex)) {
      addFinding(type, match[0]);
      if (findings.length >= maxFindings) {
        break;
      }
    }
  }
  if (findings.length < maxFindings) {
    const kvMatch = line.match(KEY_VALUE_REGEX);
    if (kvMatch) {
      addFinding("key_value", kvMatch[2]);
    }
  }
  if (findings.length < maxFindings && KEYWORD_REGEX.test(line)) {
    for (const match of line.matchAll(CANDIDATE_REGEX)) {
      const candidate = match[0];
      const entropy = shannonEntropy(candidate);
      if (entropy >= 4.2) {
        addFinding("entropy", candidate);
      }
      if (findings.length >= maxFindings) {
        break;
      }
    }
  }
  return findings;
}

async function scanFile(filePath, displayPath, { maxBytes, maxFindings }) {
  const findings = [];
  const hash = createHash("sha256");
  let bytesRead = 0;
  let byteLimitExceeded = false;
  let findingsTruncated = false;
  const input = fs.createReadStream(filePath);
  input.on("data", (chunk) => {
    hash.update(chunk);
    bytesRead += chunk.length;
    if (bytesRead > maxBytes) {
      byteLimitExceeded = true;
      input.destroy();
    }
  });
  const lines = readline.createInterface({ input, crlfDelay: Infinity });
  let lineNumber = 0;
  try {
    for await (const line of lines) {
      if (byteLimitExceeded) {
        break;
      }
      lineNumber += 1;
      const remainingFindings = maxFindings - findings.length;
      findings.push(...scanLine(line, displayPath, lineNumber, remainingFindings));
      if (findings.length >= maxFindings) {
        findingsTruncated = true;
        input.destroy();
        break;
      }
    }
  } catch (error) {
    if (!byteLimitExceeded && !findingsTruncated) {
      throw error;
    }
  }
  if (byteLimitExceeded || findingsTruncated) {
    return {
      findings,
      bytesRead,
      byteLimitExceeded,
      findingsTruncated,
      sha256: null,
    };
  }
  return {
    findings,
    bytesRead,
    byteLimitExceeded: false,
    findingsTruncated: false,
    sha256: hash.digest("hex"),
  };
}

function relativeManifestPath(root, filePath) {
  const relative = path.relative(path.resolve(root), path.resolve(filePath));
  if (!relative || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error("Artifact path is outside the scan root");
  }
  return relative.split(path.sep).join("/");
}

function buildManifest(entries) {
  const files = [...entries].sort((left, right) => {
    if (left.path < right.path) return -1;
    if (left.path > right.path) return 1;
    return 0;
  });
  const rootSha256 = createHash("sha256")
    .update(JSON.stringify(files))
    .digest("hex");
  return {
    schema_version: "1.0",
    root_sha256: rootSha256,
    file_count: files.length,
    total_bytes: files.reduce((sum, entry) => sum + entry.size_bytes, 0),
    files,
  };
}

function loadExpectedManifest(manifestPath) {
  const stats = fs.lstatSync(manifestPath);
  if (stats.isSymbolicLink() || !stats.isFile() || stats.size > 16 * 1024 * 1024) {
    throw new Error("Expected artifact manifest must be a bounded regular file");
  }
  const parsed = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  const keys = Object.keys(parsed).sort();
  const expectedKeys = ["file_count", "files", "root_sha256", "schema_version", "total_bytes"];
  if (JSON.stringify(keys) !== JSON.stringify(expectedKeys) || parsed.schema_version !== "1.0") {
    throw new Error("Expected artifact manifest has an unsupported shape");
  }
  if (!Array.isArray(parsed.files)) {
    throw new Error("Expected artifact manifest files must be an array");
  }
  return parsed;
}

function manifestMismatch(expected, actual) {
  return (
    expected.root_sha256 !== actual.root_sha256 ||
    expected.file_count !== actual.file_count ||
    expected.total_bytes !== actual.total_bytes ||
    JSON.stringify(expected.files) !== JSON.stringify(actual.files)
  );
}

async function main() {
  const {
    dir,
    report,
    manifest,
    expectedManifest,
    maxBytes,
    maxFiles,
    maxTotalBytes,
  } = parseArgs();
  if (!fs.existsSync(dir)) {
    process.exit(0);
  }
  const expected = expectedManifest ? loadExpectedManifest(expectedManifest) : null;
  const excludedPaths = new Set();
  if (expectedManifest) {
    excludedPaths.add(path.resolve(expectedManifest));
  }
  const inventory = listFiles(dir, { maxFiles, maxTotalBytes, excludedPaths });
  const findings = [...inventory.findings];
  const manifestEntries = [];
  let scannedTotalBytes = 0;
  for (const file of inventory.files) {
    const relativePath = relativeManifestPath(dir, file.path);
    const remainingPathFindings = Math.max(0, MAX_REPORTED_FINDINGS - findings.length);
    const rawPathFindings = scanLine(
      relativePath,
      "<artifact-path>",
      null,
      remainingPathFindings,
    );
    const displayPath = rawPathFindings.length > 0
      ? `<redacted-path:${fingerprint(relativePath)}>`
      : relativePath;
    const pathFindings = rawPathFindings.map((item) => ({
      ...item,
      file: displayPath,
      type: `path_${item.type}`,
    }));
    findings.push(...pathFindings);
    if (findings.length >= MAX_REPORTED_FINDINGS) {
      findings.push({
        file: displayPath,
        line: null,
        type: "finding_count_limit",
        max_findings: MAX_REPORTED_FINDINGS,
      });
      break;
    }
    if (file.size > maxBytes) {
      findings.push({
        file: displayPath,
        line: null,
        type: "oversized_file",
        size_bytes: file.size,
        max_bytes: maxBytes,
      });
      continue;
    }
    const scanned = await scanFile(file.path, displayPath, {
      maxBytes,
      maxFindings: MAX_REPORTED_FINDINGS - findings.length,
    });
    findings.push(...scanned.findings);
    if (scanned.findingsTruncated) {
      findings.push({
        file: displayPath,
        line: null,
        type: "finding_count_limit",
        max_findings: MAX_REPORTED_FINDINGS,
      });
      break;
    }
    if (scanned.byteLimitExceeded) {
      findings.push({
        file: displayPath,
        line: null,
        type: "oversized_file",
        size_bytes: scanned.bytesRead,
        max_bytes: maxBytes,
      });
      continue;
    }
    scannedTotalBytes += scanned.bytesRead;
    if (scannedTotalBytes > maxTotalBytes) {
      findings.push({
        file: null,
        line: null,
        type: "aggregate_size_limit",
        observed_bytes: scannedTotalBytes,
        max_total_bytes: maxTotalBytes,
      });
      break;
    }
    const finalStats = fs.lstatSync(file.path);
    if (
      finalStats.isSymbolicLink() ||
      !finalStats.isFile() ||
      finalStats.size !== file.size ||
      finalStats.dev !== file.device ||
      finalStats.ino !== file.inode ||
      scanned.bytesRead !== file.size
    ) {
      findings.push({
        file: displayPath,
        line: null,
        type: "file_changed_during_scan",
      });
      continue;
    }
    manifestEntries.push({
      path: relativePath,
      size_bytes: scanned.bytesRead,
      sha256: scanned.sha256,
    });
  }
  const actualManifest = buildManifest(manifestEntries);
  if (expected) {
    if (manifestMismatch(expected, actualManifest)) {
      findings.push({
        file: null,
        line: null,
        type: "artifact_manifest_mismatch",
        expected_root_sha256: expected.root_sha256,
        actual_root_sha256: actualManifest.root_sha256,
      });
    }
  }
  fs.mkdirSync(path.dirname(report), { recursive: true });
  fs.writeFileSync(report, `${JSON.stringify(findings, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  if (findings.length > 0) {
    process.exit(2);
  }
  if (manifest) {
    fs.mkdirSync(path.dirname(manifest), { recursive: true });
    fs.writeFileSync(manifest, `${JSON.stringify(actualManifest, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
  }
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  const safeMessage = /^(?:--[a-z-]+ must|--manifest and --expected-manifest|Artifact scan refuses (?:symbolic links|non-regular filesystem entries)|Artifact path is outside the scan root|Expected artifact manifest)/.test(
    message,
  )
    ? message
    : "Artifact scan failed closed";
  console.error(safeMessage);
  process.exit(1);
});
