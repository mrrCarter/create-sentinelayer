// File-to-persona ownership routing (#A10, spec §5.7).
//
// Personas are expensive: every persona runs an LLM call over whatever files
// it thinks are in-scope. When 13 personas each scan the whole codebase the
// token usage compounds. This module lets the orchestrator send each finding
// (or each file) to only the persona that owns the code, which the spec
// measures at >40% token savings on multi-persona runs.
//
// Two routing modes:
//   1. Explicit — read `.sentinelayer/scaffold.yaml`, walk `ownership_rules`
//      as a last-match-wins glob → persona list.
//   2. Heuristic — no scaffold.yaml, fall back to keyword / extension rules
//      derived from the 13-persona canon (security, backend, frontend,
//      testing, code-quality, data-layer, documentation, reliability,
//      release, observability, infrastructure, supply-chain, ai-governance).
//
// All exports are pure functions: no filesystem work except
// `loadScaffoldConfig` which reads a single YAML file. The rest operate on
// in-memory inputs so they compose cleanly with existing ingest callers.

import fsp from "node:fs/promises";
import path from "node:path";
import process from "node:process";

import YAML from "yaml";

import { PERSONA_IDS } from "../review/persona-prompts.js";

const DEFAULT_HEURISTIC_FALLBACK = "backend";
const SCAFFOLD_RELATIVE_PATH = ".sentinelayer/scaffold.yaml";

// --- Glob matching -------------------------------------------------------

// Translate a shell-style glob into a RegExp. Supports `*` (single segment),
// `**` (cross-segment), `?` (single char), and character classes passed
// through. Not a full fnmatch — but enough for ownership routing and good
// enough that a pattern like `lib/auth/**/*.{ts,tsx}` could be rewritten as
// two entries: `lib/auth/**/*.ts` and `lib/auth/**/*.tsx`.
function globToRegExp(glob) {
  const raw = String(glob || "").trim();
  if (!raw) {
    throw new Error("ownership_rules.pattern is required.");
  }
  const normalized = raw.replace(/\\/g, "/").replace(/^\.\//, "");

  let escaped = "";
  for (let idx = 0; idx < normalized.length; idx += 1) {
    const ch = normalized[idx];
    const next = normalized[idx + 1];
    if (ch === "*") {
      if (next === "*") {
        // `**/` matches zero or more path segments, `/** ` matches any tail
        if (normalized[idx + 2] === "/") {
          escaped += "(?:.*/)?";
          idx += 2;
        } else {
          escaped += ".*";
          idx += 1;
        }
      } else {
        escaped += "[^/]*";
      }
      continue;
    }
    if (ch === "?") {
      escaped += "[^/]";
      continue;
    }
    if ("\\.+^$(){}|".includes(ch)) {
      escaped += `\\${ch}`;
      continue;
    }
    escaped += ch;
  }
  return new RegExp(`^${escaped}$`);
}

function matchGlob(pattern, filePath) {
  return globToRegExp(pattern).test(filePath);
}

function normalizePathForMatch(filePath) {
  return String(filePath || "")
    .trim()
    .replace(/\\/g, "/")
    .replace(/^\.\//, "");
}

function normalizePersonaId(value) {
  return String(value || "").trim().toLowerCase();
}

function assertKnownPersona(value) {
  const normalized = normalizePersonaId(value);
  if (!normalized) {
    throw new Error("ownership_rules.persona is required.");
  }
  if (!PERSONA_IDS.includes(normalized)) {
    throw new Error(
      `ownership_rules.persona must be one of ${PERSONA_IDS.join(", ")} (got "${value}").`
    );
  }
  return normalized;
}

// --- Scaffold YAML -------------------------------------------------------

export function parseScaffoldYaml(raw) {
  const text = String(raw || "");
  const trimmed = text.trim();
  if (!trimmed) {
    return { ownershipRules: [] };
  }
  let parsed;
  try {
    parsed = YAML.parse(text);
  } catch (err) {
    throw new Error(`scaffold.yaml is not valid YAML: ${err.message}`);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("scaffold.yaml must be a mapping at the top level.");
  }
  const rawRules = parsed.ownership_rules;
  if (rawRules === undefined || rawRules === null) {
    return { ownershipRules: [] };
  }
  if (!Array.isArray(rawRules)) {
    throw new Error("scaffold.yaml ownership_rules must be a list.");
  }
  const ownershipRules = rawRules.map((rule, idx) => {
    if (!rule || typeof rule !== "object" || Array.isArray(rule)) {
      throw new Error(`scaffold.yaml ownership_rules[${idx}] must be a mapping.`);
    }
    const pattern = String(rule.pattern || "").trim();
    if (!pattern) {
      throw new Error(`scaffold.yaml ownership_rules[${idx}].pattern is required.`);
    }
    const persona = assertKnownPersona(rule.persona);
    return { pattern, persona };
  });
  return { ownershipRules };
}

export async function loadScaffoldConfig({
  targetPath = process.cwd(),
  relativePath = SCAFFOLD_RELATIVE_PATH,
} = {}) {
  const absolutePath = path.join(
    path.resolve(String(targetPath || ".")),
    String(relativePath || SCAFFOLD_RELATIVE_PATH)
  );
  try {
    const raw = await fsp.readFile(absolutePath, "utf-8");
    return { found: true, path: absolutePath, ...parseScaffoldYaml(raw) };
  } catch (err) {
    if (err && typeof err === "object" && err.code === "ENOENT") {
      return { found: false, path: absolutePath, ownershipRules: [] };
    }
    throw err;
  }
}

// --- Heuristic routing ---------------------------------------------------

// The heuristic table is explicit rather than a big switch: earlier entries
// are more specific, later entries are broader catch-alls. We iterate in
// order and take the first match so "docs/api.md" sorts as documentation
// rather than getting routed to backend by the ".md" extension catch-all.
const HEURISTIC_RULES = [
  {
    persona: "testing",
    match: (p) =>
      /(^|\/)(tests?|__tests__|specs?)\//.test(p) ||
      /\.(test|spec)\.(js|jsx|ts|tsx|mjs|cjs|py|rb|go|rs)$/.test(p),
  },
  {
    persona: "documentation",
    match: (p) =>
      /(^|\/)docs?\//.test(p) ||
      /(^|\/)(README|CHANGELOG|CONTRIBUTING|ADR)(\.md)?$/i.test(p) ||
      /(^|\/)adr[-_]/i.test(p),
  },
  {
    persona: "supply-chain",
    match: (p) =>
      /(^|\/)package(-lock)?\.json$/.test(p) ||
      /(^|\/)yarn\.lock$/.test(p) ||
      /(^|\/)pnpm-lock\.yaml$/.test(p) ||
      /(^|\/)requirements([-.]\w+)?\.txt$/.test(p) ||
      /(^|\/)pyproject\.toml$/.test(p) ||
      /(^|\/)Pipfile(\.lock)?$/.test(p) ||
      /(^|\/)Gemfile(\.lock)?$/.test(p) ||
      /(^|\/)go\.(mod|sum)$/.test(p) ||
      /(^|\/)cargo\.toml$/i.test(p) ||
      /(^|\/)renovate\.json$/.test(p),
  },
  {
    persona: "release",
    match: (p) =>
      /(^|\/)\.github\/workflows\//.test(p) ||
      /(^|\/)release-please/.test(p) ||
      /(^|\/)action\.yml$/.test(p) ||
      /(^|\/)\.releaserc/.test(p) ||
      /(^|\/)(scripts|bin)\/release/.test(p),
  },
  {
    persona: "infrastructure",
    match: (p) =>
      /(^|\/)(infra|terraform|k8s|kubernetes|helm)\//.test(p) ||
      /\.(tf|tfvars|hcl)$/.test(p) ||
      /(^|\/)Dockerfile(\.\w+)?$/.test(p) ||
      /(^|\/)docker-compose(\.[-\w]+)?\.ya?ml$/.test(p) ||
      /(^|\/)\.dockerignore$/.test(p),
  },
  {
    persona: "observability",
    match: (p) =>
      /(^|\/)(observability|telemetry|metrics|tracing|logging|monitoring)\//i.test(p) ||
      /(^|\/)sentry\.(client|server)\./.test(p),
  },
  {
    persona: "ai-governance",
    match: (p) =>
      /(^|\/)(prompts?|llm|ai|agents?)\//i.test(p) ||
      /(^|\/)prompt[-_]/.test(p) ||
      /\.prompt(\.md)?$/.test(p),
  },
  {
    persona: "data-layer",
    match: (p) =>
      /(^|\/)(migrations?|alembic|prisma|db|database|schema)\//i.test(p) ||
      /\.sql$/.test(p) ||
      /(^|\/)models?\//i.test(p),
  },
  {
    persona: "security",
    match: (p) =>
      /(^|\/)(auth|authn|authz|security)\//i.test(p) ||
      /(^|\/)(middleware|guards?)\/(auth|security)/i.test(p) ||
      /(^|\/)\.env(\.\w+)?$/.test(p),
  },
  {
    persona: "frontend",
    match: (p) =>
      /(^|\/)(components?|pages?|app|views?|ui|styles?)\//i.test(p) ||
      /\.(tsx|jsx|vue|svelte|css|scss|sass)$/.test(p),
  },
  {
    persona: "reliability",
    match: (p) =>
      /(^|\/)(health|liveness|readiness|circuit[-_]?breaker)\//i.test(p) ||
      /(^|\/)retries?\//i.test(p),
  },
  {
    persona: "code-quality",
    match: (p) =>
      /(^|\/)\.?(eslintrc|prettierrc|biome|stylelintrc)(\.[-\w]+)?$/.test(p) ||
      /(^|\/)\.editorconfig$/.test(p),
  },
  {
    persona: "backend",
    match: (p) =>
      /(^|\/)(api|server|backend|routes?|services?|handlers?|controllers?)\//i.test(
        p
      ) ||
      /\.(py|rb|go|rs)$/.test(p) ||
      /\.(ts|js|mts|mjs|cts|cjs)$/.test(p),
  },
];

export function routeFileHeuristic(
  filePath,
  { fallback = DEFAULT_HEURISTIC_FALLBACK } = {}
) {
  const normalized = normalizePathForMatch(filePath);
  if (!normalized) {
    return fallback;
  }
  for (const rule of HEURISTIC_RULES) {
    if (rule.match(normalized)) {
      return rule.persona;
    }
  }
  return fallback;
}

// --- Public API ---------------------------------------------------------

// Given the file list plus (optional) scaffold config, produce a Map of
// posix-style relative path → persona id. Rules are last-match-wins: the
// scaffold ordering lets authors put a broad default first, then override
// subtrees below.
export function buildOwnershipMap(files, scaffoldConfig = null) {
  const rules = Array.isArray(scaffoldConfig?.ownershipRules)
    ? scaffoldConfig.ownershipRules
    : [];
  const map = new Map();
  const fileList = Array.isArray(files) ? files : [];
  for (const rawFile of fileList) {
    const file = normalizePathForMatch(rawFile);
    if (!file) {
      continue;
    }
    if (rules.length > 0) {
      let owner = null;
      for (const rule of rules) {
        if (matchGlob(rule.pattern, file)) {
          owner = rule.persona;
        }
      }
      if (owner) {
        map.set(file, owner);
        continue;
      }
    }
    map.set(file, routeFileHeuristic(file));
  }
  return map;
}

// Bin findings by persona using the ownership map. Findings whose file is
// not in the map (e.g. a scanner reported on a path outside the ingest)
// fall back to the heuristic router so they don't get silently dropped.
export function routeFindingsToPersonas(findings, ownershipMap) {
  const source = Array.isArray(findings) ? findings : [];
  const map = ownershipMap instanceof Map ? ownershipMap : new Map();
  const perPersona = {};
  for (const finding of source) {
    if (!finding || typeof finding !== "object") {
      continue;
    }
    const filePath = normalizePathForMatch(
      finding.file || finding.path || finding.location || ""
    );
    let persona = normalizePersonaId(map.get(filePath) || "");
    if (!persona) {
      persona = routeFileHeuristic(filePath);
    }
    if (!perPersona[persona]) {
      perPersona[persona] = [];
    }
    perPersona[persona].push(finding);
  }
  return perPersona;
}

// Lightweight metric for the spec's ≥40% token-reduction target. Given an
// ownership map + pre-routing cost assumption (every persona sees every
// file), report how many files each persona would actually need to scan.
export function computeRoutingStats(ownershipMap) {
  const map = ownershipMap instanceof Map ? ownershipMap : new Map();
  const totalFiles = map.size;
  if (totalFiles === 0) {
    return {
      totalFiles: 0,
      personaCoverage: {},
      totalScansUnrouted: 0,
      totalScansRouted: 0,
      tokenReductionEstimatePct: 0,
    };
  }
  const personaCoverage = {};
  for (const persona of map.values()) {
    personaCoverage[persona] = (personaCoverage[persona] || 0) + 1;
  }
  const totalScansUnrouted = totalFiles * PERSONA_IDS.length;
  const totalScansRouted = totalFiles; // 1 persona per file with last-match-wins routing
  const tokenReductionEstimatePct = Math.round(
    (1 - totalScansRouted / totalScansUnrouted) * 100
  );
  return {
    totalFiles,
    personaCoverage,
    totalScansUnrouted,
    totalScansRouted,
    tokenReductionEstimatePct,
  };
}

export { DEFAULT_HEURISTIC_FALLBACK, SCAFFOLD_RELATIVE_PATH };
