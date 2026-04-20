// tenancy-scan — flag queries that may leak across tenants (#A17).
//
// In a multi-tenant system every row-level query needs to constrain on
// tenant_id / org_id / workspace_id (whatever the ambient tenancy column
// is). Missing that filter is a cross-tenant data leak — classic P0.
//
// Heuristic: we look for "tenancy-table" signals (tables or models whose
// schema mentions tenant_id / org_id / workspace_id) and then in application
// code we flag queries against those tables that don't include the tenancy
// column in the WHERE.

import fsp from "node:fs/promises";
import path from "node:path";

import { createFinding, toPosix, walkRepoFiles } from "./base.js";

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

const TENANCY_COLUMNS = ["tenant_id", "org_id", "organization_id", "workspace_id", "account_id"];

function tenancyTableRegex() {
  // Match a schema / model declaration (CREATE TABLE, @Column, JS class,
  // Python class) that sits within ~2 KB of one of the tenancy column
  // names.
  return new RegExp(
    `(?:CREATE\\s+TABLE\\s+[\\w.]+|@Column|class\\s+\\w+\\s*[({:]|class\\s+\\w+\\s*\\{|model\\s*:\\s*\\w+)[\\s\\S]{0,2000}?(${TENANCY_COLUMNS.join("|")})`,
    "gi"
  );
}

function queryRegex(tableName) {
  // Match a SELECT / UPDATE / DELETE referencing the table name.
  return new RegExp(
    `(?:SELECT[\\s\\S]*?FROM|UPDATE|DELETE\\s+FROM)\\s+[\\w.\`"]*?\\b${tableName}\\b`,
    "gi"
  );
}

async function collectTenancyTables(rootPath) {
  const tables = new Set();
  for await (const { fullPath, relativePath } of walkRepoFiles({
    rootPath,
    extensions: CODE_EXTENSIONS,
  })) {
    const p = toPosix(relativePath);
    const isSchemaFile =
      /(^|\/)(schema|models?)\//i.test(p) ||
      /(^|\/)migrations?\//i.test(p) ||
      /(^|\/)alembic\/versions\//i.test(p) ||
      /(^|\/)prisma\//i.test(p);
    if (!isSchemaFile) {
      continue;
    }
    let content;
    try {
      content = await fsp.readFile(fullPath, "utf-8");
    } catch {
      continue;
    }
    const regex = tenancyTableRegex();
    let match;
    while ((match = regex.exec(content)) !== null) {
      // Pull the table / class name from the match prefix.
      const prefix = match[0];
      const tableMatch = prefix.match(/CREATE\s+TABLE\s+[`"]?(\w+)/i);
      if (tableMatch) {
        tables.add(tableMatch[1].toLowerCase());
        continue;
      }
      const classMatch = prefix.match(/class\s+(\w+)/);
      if (classMatch) {
        // Convention: class Foo → table foos / foo. Keep both.
        const name = classMatch[1].toLowerCase();
        tables.add(name);
        tables.add(`${name}s`);
      }
    }
  }
  return tables;
}

export async function runTenancyScan({ rootPath, files = null, tenancyTables = null } = {}) {
  const resolvedRoot = path.resolve(String(rootPath || "."));
  const tables =
    tenancyTables instanceof Set
      ? tenancyTables
      : await collectTenancyTables(resolvedRoot);
  if (tables.size === 0) {
    return [];
  }

  const findings = [];
  const iterator =
    Array.isArray(files) && files.length > 0
      ? iterateExplicitFiles(resolvedRoot, files)
      : walkRepoFiles({ rootPath: resolvedRoot, extensions: CODE_EXTENSIONS });

  for await (const { fullPath, relativePath } of iterator) {
    let content;
    try {
      content = await fsp.readFile(fullPath, "utf-8");
    } catch {
      continue;
    }
    for (const table of tables) {
      const regex = queryRegex(table);
      let match;
      while ((match = regex.exec(content)) !== null) {
        // Look at a ~200-char window after the match for a tenancy column
        // in the WHERE clause.
        const window = content.slice(match.index, match.index + 400);
        const hasTenancyFilter = TENANCY_COLUMNS.some((col) =>
          new RegExp(`\\b${col}\\s*(?:=|IN|\\?)`).test(window)
        );
        if (hasTenancyFilter) {
          continue;
        }
        const lineIndex = content.slice(0, match.index).split(/\r?\n/).length;
        const lineContent = content.split(/\r?\n/)[lineIndex - 1] || "";
        findings.push(
          createFinding({
            tool: "tenancy-scan",
            kind: "data.missing-tenancy-filter",
            severity: "P0",
            file: toPosix(relativePath),
            line: lineIndex,
            evidence: lineContent.trim(),
            rootCause: `Query against tenancy-owning table '${table}' has no tenant_id / org_id / workspace_id constraint in the WHERE.`,
            recommendedFix: `Add a tenancy filter: "WHERE tenant_id = :tenantId" (or the equivalent tenancy column). Enforce with a database RLS policy when possible.`,
            confidence: 0.7,
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

export { TENANCY_COLUMNS, collectTenancyTables };
