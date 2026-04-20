// query-explain — flag unbounded / N+1 query shapes (#A17).
//
// We scan code for common data-access anti-patterns. Real EXPLAIN output is
// a database-side operation; this tool focuses on the source-level red
// flags (missing LIMIT, findAll in loops, string-concatenated SQL) that
// typically predict explosive queries before the DB actually runs them.

import fsp from "node:fs/promises";
import path from "node:path";

import { createFinding, findLineMatches, getLineContent, toPosix, walkRepoFiles } from "./base.js";

const CODE_EXTENSIONS = new Set([
  ".js",
  ".jsx",
  ".ts",
  ".tsx",
  ".mjs",
  ".cjs",
  ".py",
  ".go",
  ".rb",
]);

const RULES = [
  {
    id: "data.query-no-limit",
    pattern: /SELECT[\s\S]{0,200}?FROM\s+[\w.`"]+\s*(?!.*\b(LIMIT|FETCH FIRST)\b)(?:WHERE\s[^;]*)?;?\s*[`'"]/i,
    severity: "P1",
    rootCause:
      "Raw SELECT without LIMIT / FETCH FIRST. On a growing table this returns more rows every day and will eventually OOM the caller.",
    recommendedFix:
      "Always paginate: add LIMIT with a configured page size, or switch to cursor-based iteration (`WHERE id > :lastId ORDER BY id LIMIT n`).",
    confidence: 0.6,
  },
  {
    id: "data.n-plus-one-findall-in-loop",
    pattern: /for\s*\([^)]*\)\s*\{[\s\S]{0,400}?\b(?:findAll|findMany|find_one|find_all|objects\.all|objects\.filter|Model\.\w+|repository\.\w+|db\.[a-z_]+\.find)\s*\(/,
    severity: "P1",
    rootCause:
      "Data-access call inside a for-loop body — classic N+1. Each iteration issues another round-trip to the database.",
    recommendedFix:
      "Batch the loop: fetch once with `WHERE id IN (…)` or an eager-loaded join; or use a dataloader (JS) / prefetch_related (Django) / bullet gem (Rails).",
    confidence: 0.65,
  },
  {
    id: "data.string-concat-sql",
    pattern: /(?:query|execute|db\.raw|sequelize\.query|knex\.raw|\.exec)\s*\(\s*[`'"][^`'"]*[`'"]\s*\+/,
    severity: "P0",
    rootCause:
      "SQL built via string concatenation — if any concatenated term is user input, this is a SQLi path.",
    recommendedFix:
      "Use parameterized queries / prepared statements. Every major driver supports `?` / `$1` / `:named` placeholders.",
    confidence: 0.85,
  },
  {
    id: "data.select-star",
    pattern: /SELECT\s+\*\s+FROM\s+[\w.`"]+/i,
    severity: "P3",
    rootCause:
      "`SELECT *` binds the caller to every column the table happens to have — a schema change (adding a BYTEA / LONGTEXT) can silently blow up payload size.",
    recommendedFix:
      "Enumerate the columns you actually need. If you really need everything, wrap in a view so the contract is explicit.",
    confidence: 0.8,
  },
];

export async function runQueryExplain({ rootPath, files = null } = {}) {
  const resolvedRoot = path.resolve(String(rootPath || "."));
  const iterator =
    Array.isArray(files) && files.length > 0
      ? iterateExplicitFiles(resolvedRoot, files)
      : walkRepoFiles({ rootPath: resolvedRoot, extensions: CODE_EXTENSIONS });

  const findings = [];
  for await (const { fullPath, relativePath } of iterator) {
    let content;
    try {
      content = await fsp.readFile(fullPath, "utf-8");
    } catch {
      continue;
    }
    for (const rule of RULES) {
      for (const match of findLineMatches(content, rule.pattern)) {
        findings.push(
          createFinding({
            tool: "query-explain",
            kind: rule.id,
            severity: rule.severity,
            file: toPosix(relativePath),
            line: match.line,
            evidence: getLineContent(content, match.line),
            rootCause: rule.rootCause,
            recommendedFix: rule.recommendedFix,
            confidence: rule.confidence,
          })
        );
      }
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

export { RULES as QUERY_RULES };
