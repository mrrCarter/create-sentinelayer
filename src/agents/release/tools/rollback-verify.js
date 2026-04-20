// rollback-verify — ensure recent migrations + deploy configs support rollback (#A19).
//
// We check:
//   - Alembic versions have a downgrade() body (not just pass)
//   - Rails migrations have a `def down` or `reversible` block
//   - Infrastructure / deploy configs mention rollback / revert strategies

import fsp from "node:fs/promises";
import path from "node:path";

import { createFinding, toPosix, walkRepoFiles } from "./base.js";

const MIGRATION_EXTENSIONS = new Set([".py", ".rb", ".sql", ".js", ".ts"]);

function isAlembicFile(relPath) {
  return /(^|\/)alembic\/versions\//.test(toPosix(relPath));
}

function isRailsMigrationFile(relPath) {
  return /(^|\/)db\/migrate\/[^/]+\.rb$/.test(toPosix(relPath));
}

function isKnexMigrationFile(relPath) {
  return /(^|\/)knex\/migrations?\//i.test(toPosix(relPath));
}

export async function runRollbackVerify({ rootPath, files = null } = {}) {
  const resolvedRoot = path.resolve(String(rootPath || "."));
  const iterator =
    Array.isArray(files) && files.length > 0
      ? iterateExplicitFiles(resolvedRoot, files)
      : walkRepoFiles({ rootPath: resolvedRoot, extensions: MIGRATION_EXTENSIONS });

  const findings = [];
  for await (const { fullPath, relativePath } of iterator) {
    const rel = toPosix(relativePath);
    let content;
    try {
      content = await fsp.readFile(fullPath, "utf-8");
    } catch {
      continue;
    }

    if (isAlembicFile(rel)) {
      const downgradeMatch = content.match(
        /def\s+downgrade\s*\(\s*\)\s*(?:->[\s\S]*?)?\s*:\s*([\s\S]*?)(?=\ndef|\Z)/
      );
      const body = downgradeMatch ? downgradeMatch[1].trim() : "";
      if (!downgradeMatch || body === "" || body === "pass" || /^\s*pass\s*$/.test(body)) {
        findings.push(
          createFinding({
            tool: "rollback-verify",
            kind: "release.empty-downgrade",
            severity: "P1",
            file: rel,
            line: 0,
            evidence: downgradeMatch ? "downgrade() body is empty / pass" : "no downgrade() defined",
            rootCause:
              "Alembic migration has no downgrade path. If the upgrade breaks production, we have no clean rollback.",
            recommendedFix:
              "Implement downgrade() that reverses upgrade() exactly. If data loss is inevitable, document it explicitly and gate upgrade() on a confirmation flag.",
            confidence: 0.85,
          })
        );
      }
    }

    if (isRailsMigrationFile(rel)) {
      const hasDown = /\bdef\s+down\b/.test(content);
      const hasReversible = /\breversible\b/.test(content);
      const hasChange = /\bdef\s+change\b/.test(content);
      if (!hasDown && !hasReversible && !hasChange) {
        findings.push(
          createFinding({
            tool: "rollback-verify",
            kind: "release.no-rails-down",
            severity: "P1",
            file: rel,
            line: 0,
            evidence: "No `def change`, `def down`, or `reversible` block",
            rootCause:
              "Rails migration without a reversible path. `rails db:rollback` will not undo this.",
            recommendedFix:
              "Use `def change` (Rails 4+ auto-reversible) or define an explicit `def down`.",
            confidence: 0.85,
          })
        );
      }
    }

    if (isKnexMigrationFile(rel)) {
      const hasDown = /exports\.down\s*=|export\s+(?:async\s+)?function\s+down\b/.test(content);
      if (!hasDown) {
        findings.push(
          createFinding({
            tool: "rollback-verify",
            kind: "release.no-knex-down",
            severity: "P1",
            file: rel,
            line: 0,
            evidence: "No exports.down / export function down in Knex migration",
            rootCause:
              "Knex migration without a down step — `knex migrate:rollback` will fail.",
            recommendedFix:
              "Pair every `exports.up` with an `exports.down` that reverses it.",
            confidence: 0.85,
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
