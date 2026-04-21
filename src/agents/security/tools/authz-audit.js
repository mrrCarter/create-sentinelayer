// authz-audit — look for route handlers that forget to call auth middleware (#A13).
//
// This is a lightweight static pass. We don't try to model every framework —
// we focus on the three routing styles the DevTestBot substrate actually
// uses (Express, Fastify, Next.js app-router route handlers) plus a Python
// FastAPI pass.
//
// Strategy: for each detected route declaration, look at the 6-line window
// above for an auth/session guard. If none is present, emit a P1 finding
// with moderate confidence — the persona LLM layer (or a human reviewer)
// decides whether it's a real gap.

import fsp from "node:fs/promises";
import path from "node:path";

import { createFinding, walkRepoFiles } from "./base.js";

const JS_TS_EXTENSIONS = new Set([
  ".js",
  ".jsx",
  ".ts",
  ".tsx",
  ".mjs",
  ".cjs",
]);
const PY_EXTENSIONS = new Set([".py"]);

// Patterns that make us comfortable that the route IS guarded.
const AUTH_GUARD_PATTERNS = [
  /requireAuth|requireSession|requireUser|requireLogin|auth\.\w+|authenticate|isAuthenticated|ensureAuthenticated|protect\(/,
  /@login_required|@require_auth|@protected|HTTPBearer|Depends\(get_current_user/,
  /middleware:\s*\[[^\]]*auth/i,
];

// Route declaration patterns we consider "mutation-ish" (POST/PUT/PATCH/DELETE).
const JS_ROUTE_PATTERNS = [
  /\b(?:app|router|route|server)\.(post|put|patch|delete)\s*\(/,
  /\bfastify\.(post|put|patch|delete)\s*\(/,
];

// Next.js app-router POST / PUT / DELETE / PATCH handler declarations.
const NEXT_APP_ROUTER_PATTERNS = [
  /^export\s+async\s+function\s+(POST|PUT|PATCH|DELETE)\s*\(/m,
];

const PY_ROUTE_PATTERNS = [
  /@(?:app|router)\.(post|put|patch|delete)\s*\(/,
];

function hasGuardAbove(lines, idx, window = 6) {
  const start = Math.max(0, idx - window);
  const snippet = lines.slice(start, idx + 1).join("\n");
  return AUTH_GUARD_PATTERNS.some((pattern) => pattern.test(snippet));
}

function evidenceForRoute(lines, idx) {
  const start = Math.max(0, idx - 1);
  const end = Math.min(lines.length - 1, idx + 2);
  return lines.slice(start, end + 1).join("\n").trim().slice(0, 300);
}

export async function runAuthzAudit({ rootPath, files = null } = {}) {
  const resolvedRoot = path.resolve(String(rootPath || "."));
  const extensions = new Set([...JS_TS_EXTENSIONS, ...PY_EXTENSIONS]);
  const iterator =
    Array.isArray(files) && files.length > 0
      ? iterateExplicitFiles(resolvedRoot, files)
      : walkRepoFiles({ rootPath: resolvedRoot, extensions });

  const findings = [];
  for await (const { fullPath, relativePath } of iterator) {
    let content;
    try {
      content = await fsp.readFile(fullPath, "utf-8");
    } catch {
      continue;
    }
    const ext = path.extname(fullPath).toLowerCase();
    const lines = content.split(/\r?\n/);
    const routePatterns =
      PY_EXTENSIONS.has(ext) ? PY_ROUTE_PATTERNS : [...JS_ROUTE_PATTERNS, ...NEXT_APP_ROUTER_PATTERNS];

    for (let i = 0; i < lines.length; i += 1) {
      const line = lines[i];
      let matchedRoute = null;
      for (const pattern of routePatterns) {
        if (pattern.test(line)) {
          matchedRoute = line;
          break;
        }
      }
      if (!matchedRoute) {
        continue;
      }
      if (hasGuardAbove(lines, i)) {
        continue;
      }
      findings.push(
        createFinding({
          tool: "authz-audit",
          kind: "authz.missing-guard",
          severity: "P1",
          file: relativePath,
          line: i + 1,
          evidence: evidenceForRoute(lines, i),
          rootCause:
            "A mutation-style route handler was declared without a recognizable auth guard in the 6 lines above it.",
          recommendedFix:
            "Add a middleware / decorator that validates the caller's session (requireAuth, @login_required, Depends(get_current_user), …) before the handler body runs.",
          confidence: 0.55,
        })
      );
    }
  }
  return findings;
}

async function* iterateExplicitFiles(resolvedRoot, files) {
  for (const file of files) {
    const trimmed = String(file || "").trim();
    if (!trimmed) {
      continue;
    }
    const fullPath = path.isAbsolute(trimmed)
      ? trimmed
      : path.join(resolvedRoot, trimmed);
    const relativePath = path
      .relative(resolvedRoot, fullPath)
      .replace(/\\/g, "/");
    yield { fullPath, relativePath };
  }
}

export { AUTH_GUARD_PATTERNS };
