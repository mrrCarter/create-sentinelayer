// migration-scan — flag unsafe migration patterns (#A17).
//
// Migration reviews are where data-layer review adds the most value. We
// scan .sql, alembic versions, prisma migrations, knex migrations for
// patterns that lock the table, drop data, or block app writes during a
// long backfill.

import fsp from "node:fs/promises";
import path from "node:path";

import { createFinding, findLineMatches, getLineContent, toPosix, walkRepoFiles } from "./base.js";

const MIGRATION_EXTENSIONS = new Set([".sql", ".py"]);

function isMigrationPath(relPath) {
  const p = toPosix(relPath);
  return (
    /(^|\/)migrations?\//i.test(p) ||
    /(^|\/)alembic\/versions\//.test(p) ||
    /(^|\/)prisma\/migrations\//.test(p) ||
    /(^|\/)knex\/migrations?\//i.test(p) ||
    /(^|\/)db\/migrate\//.test(p) // Rails
  );
}

const RULES = [
  {
    id: "migration.drop-table",
    pattern: /\bDROP\s+TABLE\b/i,
    severity: "P0",
    rootCause:
      "DROP TABLE in a migration deletes data irreversibly. Even if the table seems unused, a rollback can't recover rows without a backup.",
    recommendedFix:
      "Phase the change: (1) stop writing to the table; (2) wait long enough for any in-flight reads to drain; (3) rename to `_<table>_deprecated` for N days; (4) then DROP once restoration is impossible.",
    confidence: 0.95,
  },
  {
    id: "migration.drop-column",
    pattern: /\bDROP\s+COLUMN\b/i,
    severity: "P1",
    rootCause:
      "DROP COLUMN blocks writers from rolling back gracefully (the app still references the column until redeployed).",
    recommendedFix:
      "Migrate in two phases: remove app reads/writes first, deploy, then drop the column in a follow-up migration.",
    confidence: 0.85,
  },
  {
    id: "migration.add-column-not-null-no-default",
    pattern: /ALTER\s+TABLE[\s\S]{0,200}?ADD\s+(?:COLUMN\s+)?[`"]?\w+[`"]?\s+[\w()]+\s+NOT\s+NULL(?!\s+DEFAULT)/i,
    severity: "P0",
    rootCause:
      "Adding a NOT NULL column with no DEFAULT rewrites every existing row at migration time — long AccessExclusiveLock on large tables, breaks writes.",
    recommendedFix:
      "Add the column nullable first, backfill in batches, then set NOT NULL (and DEFAULT) once the backfill is complete.",
    confidence: 0.9,
  },
  {
    id: "migration.no-concurrent-index",
    // Postgres-specific: CREATE INDEX without CONCURRENTLY blocks writes
    pattern: /CREATE\s+(?!UNIQUE\s+)INDEX\s+(?!CONCURRENTLY)\b/i,
    severity: "P1",
    rootCause:
      "CREATE INDEX without CONCURRENTLY holds a ShareLock on the table — no writes while the index builds. On hot tables this is effectively an outage.",
    recommendedFix:
      "Use `CREATE INDEX CONCURRENTLY`. It takes longer and can't run inside a transaction, but writes proceed throughout.",
    confidence: 0.7,
  },
  {
    id: "migration.unbatched-update",
    pattern: /\bUPDATE\s+[\w.`"]+\s+SET\b(?![\s\S]*?WHERE\s+[\s\S]{0,200}?\bLIMIT\b)/i,
    severity: "P1",
    rootCause:
      "Unbatched UPDATE of an entire table — long transaction, large WAL / redo log, potential replication lag or disk fill.",
    recommendedFix:
      "Batch: `WHERE id BETWEEN :lo AND :hi LIMIT n` and commit per batch. For Postgres add pg_sleep between batches to give autovacuum time to catch up.",
    confidence: 0.55,
  },
];

export async function runMigrationScan({ rootPath, files = null } = {}) {
  const resolvedRoot = path.resolve(String(rootPath || "."));
  const iterator =
    Array.isArray(files) && files.length > 0
      ? iterateExplicitFiles(resolvedRoot, files)
      : walkRepoFiles({ rootPath: resolvedRoot, extensions: MIGRATION_EXTENSIONS });

  const findings = [];
  for await (const { fullPath, relativePath } of iterator) {
    if (!isMigrationPath(relativePath)) {
      continue;
    }
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
            tool: "migration-scan",
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

export { RULES as MIGRATION_RULES, isMigrationPath };
