const SOURCE_EXTENSIONS = new Set([
  ".c",
  ".cc",
  ".cpp",
  ".cs",
  ".css",
  ".go",
  ".graphql",
  ".h",
  ".hpp",
  ".java",
  ".js",
  ".jsx",
  ".kt",
  ".mjs",
  ".php",
  ".py",
  ".rb",
  ".rs",
  ".scss",
  ".sql",
  ".svelte",
  ".swift",
  ".tf",
  ".ts",
  ".tsx",
  ".vue",
]);

const SOURCE_LANGUAGES = new Set([
  "c",
  "c++",
  "c#",
  "css",
  "dockerfile",
  "go",
  "graphql",
  "java",
  "javascript",
  "jsx",
  "kotlin",
  "php",
  "python",
  "ruby",
  "rust",
  "scss",
  "sql",
  "svelte",
  "swift",
  "terraform",
  "typescript",
  "tsx",
  "vue",
]);

const LOCKFILE_NAMES = new Set([
  "cargo.lock",
  "composer.lock",
  "go.sum",
  "package-lock.json",
  "pipfile.lock",
  "pnpm-lock.yaml",
  "poetry.lock",
  "yarn.lock",
]);

function normalizePath(value) {
  return String(value || "").replace(/\\/g, "/").replace(/^\.\/+/, "").toLowerCase();
}

function basename(filePath) {
  const normalized = normalizePath(filePath);
  return normalized.slice(normalized.lastIndexOf("/") + 1);
}

function extension(filePath) {
  const name = basename(filePath);
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(dot) : "";
}

export function isAuditTestPath(filePath) {
  const normalized = normalizePath(filePath);
  return /(^|\/)(__tests__|tests?|specs?)(\/|$)|\.(test|spec)\.[^.\/]+$/i.test(normalized);
}

export function isAuditSupportPath(filePath) {
  const normalized = normalizePath(filePath);
  if (!normalized) {
    return true;
  }
  if (LOCKFILE_NAMES.has(basename(normalized))) {
    return true;
  }
  if (/(^|\/)(node_modules|vendor|fixtures?|__fixtures__|mocks?|__mocks__|snapshots?|__snapshots__)(\/|$)/i.test(normalized)) {
    return true;
  }
  if (/(^|\/)(generated|__generated__|auto-generated|coverage|dist|build|out|\.next|\.nuxt|\.turbo|\.cache)(\/|$)/i.test(normalized)) {
    return true;
  }
  if (/^(docs?|guides?|adr|tasks?|\.github|\.vscode|\.husky|public)(\/|$)/i.test(normalized)) {
    return true;
  }
  if (/(\.min|\.bundle|generated)\.[^.\/]+$/i.test(normalized)) {
    return true;
  }
  return false;
}

export function isAuditSourceFile(file = {}) {
  const filePath = typeof file === "string" ? file : file.path;
  const normalized = normalizePath(filePath);
  if (!normalized || isAuditTestPath(normalized) || isAuditSupportPath(normalized)) {
    return false;
  }
  if (SOURCE_EXTENSIONS.has(extension(normalized))) {
    return true;
  }
  return SOURCE_LANGUAGES.has(String(file.language || "").trim().toLowerCase());
}
