// index-audit — flag WHERE / JOIN columns that probably lack indexes (#A17).
//
// Without DB access we can't know what's actually indexed, but we can
// cross-reference source-level migrations:
//   - Find every `WHERE col = :x` and `JOIN t ON a.col = b.col` in source.
//   - Collect every `CREATE INDEX` / `@Index` / `db_index=True` declaration
//     in the repo.
//   - Flag WHERE / JOIN columns that don't appear in an index declaration.
//
// Conservative: we only consider columns that appear under standard
// migration directories so we don't cross-pollute with JS variable names
// that coincidentally look SQL-ish.

import fsp from "node:fs/promises";
import path from "node:path";

import { createFinding, toPosix, walkRepoFiles } from "./base.js";
import { isMigrationPath } from "./migration-scan.js";

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
  ".sql",
]);

function collectIndexDecls(content) {
  const declared = new Set();
  const patterns = [
    /CREATE\s+(?:UNIQUE\s+)?INDEX\s+[`"]?\w*[`"]?\s+ON\s+[`"]?\w+[`"]?\s*\(\s*[`"]?(\w+)[`"]?/gi,
    /@Index\s*\(\s*[`"]?(\w+)[`"]?/g, // TypeORM
    /db_index\s*=\s*True/g, // Django: presence implies indexed
    /index=True/g, // SQLAlchemy: per-column index
    /\.index\s*\(\s*['"`](\w+)['"`]/g, // Knex migrations
  ];
  for (const pattern of patterns) {
    let match;
    while ((match = pattern.exec(content)) !== null) {
      const name = match[1];
      if (name) {
        declared.add(name);
      }
    }
  }
  return declared;
}

function collectLookupColumns(content) {
  const columns = new Map(); // col -> first line
  const whereRegex = /WHERE\s+(?:[\w.`"]+\.)?[`"]?(\w+)[`"]?\s*(?:=|IN|LIKE|>|<|>=|<=|BETWEEN)/gi;
  const joinRegex = /JOIN\s+[\w.]+\s+(?:AS\s+\w+\s+)?ON\s+[\w.`"]+\.[`"]?(\w+)[`"]?\s*=/gi;
  const knexRegex = /\.(?:where|orWhere|join)\(\s*['"`](\w+)['"`]/g;
  const lines = content.split(/\r?\n/);
  for (const regex of [whereRegex, joinRegex, knexRegex]) {
    let match;
    while ((match = regex.exec(content)) !== null) {
      const name = match[1];
      if (!name) {
        continue;
      }
      const lineIndex = content.slice(0, match.index).split(/\r?\n/).length;
      if (!columns.has(name)) {
        columns.set(name, { line: lineIndex, lineContent: (lines[lineIndex - 1] || "").trim() });
      }
    }
  }
  return columns;
}

export async function runIndexAudit({ rootPath, files = null } = {}) {
  const resolvedRoot = path.resolve(String(rootPath || "."));
  const declared = new Set();
  // Pass 1: collect index declarations from migrations + schema files.
  for await (const { fullPath, relativePath } of walkRepoFiles({
    rootPath: resolvedRoot,
    extensions: CODE_EXTENSIONS,
  })) {
    const isMigration = isMigrationPath(relativePath);
    const isOrmModel = /\/models?\/|schema\.(?:prisma|ts|js|py)$/i.test(
      toPosix(relativePath)
    );
    if (!isMigration && !isOrmModel) {
      continue;
    }
    let content;
    try {
      content = await fsp.readFile(fullPath, "utf-8");
    } catch {
      continue;
    }
    for (const name of collectIndexDecls(content)) {
      declared.add(name);
    }
  }

  // Pass 2: collect lookup columns from application code.
  const findings = [];
  const iterator =
    Array.isArray(files) && files.length > 0
      ? iterateExplicitFiles(resolvedRoot, files)
      : walkRepoFiles({ rootPath: resolvedRoot, extensions: CODE_EXTENSIONS });

  const reported = new Set();
  for await (const { fullPath, relativePath } of iterator) {
    const relPos = toPosix(relativePath);
    if (isMigrationPath(relPos)) {
      continue;
    }
    let content;
    try {
      content = await fsp.readFile(fullPath, "utf-8");
    } catch {
      continue;
    }
    const lookups = collectLookupColumns(content);
    for (const [name, meta] of lookups) {
      if (declared.has(name)) {
        continue;
      }
      const key = `${relPos}#${name}`;
      if (reported.has(key)) {
        continue;
      }
      reported.add(key);
      findings.push(
        createFinding({
          tool: "index-audit",
          kind: "data.missing-index",
          severity: "P2",
          file: relPos,
          line: meta.line,
          evidence: meta.lineContent,
          rootCause: `Column '${name}' is used in a WHERE / JOIN predicate but no matching CREATE INDEX / @Index / db_index=True declaration was found in migrations or models.`,
          recommendedFix: `Add an index on ${name} in the next migration. Test with EXPLAIN on production-like data before merging.`,
          confidence: 0.45,
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

export { collectIndexDecls, collectLookupColumns };
