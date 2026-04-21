/**
 * Compliance pack — SOC 2 / ISO 27001 / GDPR-CCPA / HIPAA / license / DR
 * (#investor-dd-20..24).
 *
 * Runs as a persona-adjacent dispatch under the investor-DD umbrella.
 * Leila Farouk owns this lane: she cross-reads every file in the repo
 * against standards-oriented checklists and emits a compliance-gap
 * table. Each gap has the control id, the expected artifact, what was
 * searched for, whether it was found, and (if found) where.
 *
 * The pack is artifact-driven — no LLM. It reads the repo, looks for
 * documented controls, and reports gaps. Downstream PRs may layer an
 * LLM review on top, but the ground-truth floor is deterministic so an
 * acquirer's auditor can re-run it and get the same gap table.
 */

import fsp from "node:fs/promises";
import path from "node:path";

export const COMPLIANCE_PACK_VERSION = "1.0.0";

/**
 * Walk a repo and collect file list (skips known noise dirs). Produces
 * the same walker output as the orchestrator so the pack can reuse
 * artifacts when run inside a larger investor-DD flow.
 */
async function walkFiles(rootPath) {
  const SKIP = new Set([
    "node_modules",
    ".git",
    "dist",
    "build",
    "coverage",
    ".sentinelayer",
    ".next",
    "__pycache__",
  ]);
  const out = [];
  async function walk(abs, rel) {
    let entries;
    try {
      entries = await fsp.readdir(abs, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.name.startsWith(".") && e.name !== ".github" && e.name !== ".gitignore") continue;
      if (e.isDirectory() && SKIP.has(e.name)) continue;
      const absPath = path.join(abs, e.name);
      const relPath = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) {
        await walk(absPath, relPath);
      } else if (e.isFile()) {
        out.push({ relPath, absPath });
      }
    }
  }
  await walk(rootPath, "");
  return out;
}

function fileExistsAnyName(files, patterns) {
  for (const { relPath } of files) {
    for (const p of patterns) {
      if (relPath.toLowerCase().includes(p.toLowerCase())) return relPath;
    }
  }
  return null;
}

async function fileContentContains(files, regex) {
  for (const { relPath, absPath } of files) {
    try {
      const stat = await fsp.stat(absPath);
      if (stat.size > 1024 * 1024) continue; // skip > 1MB
      const text = await fsp.readFile(absPath, "utf-8");
      if (regex.test(text)) return { file: relPath, match: true };
    } catch {
      // unreadable file; skip
    }
  }
  return { file: null, match: false };
}

/**
 * SOC 2 Trust Service Criteria coverage. Focus: the controls whose
 * evidence is typically in-repo (logging, backups, access control,
 * change management). Operational controls that live outside the repo
 * (personnel security, facilities) are out of scope for a code-level
 * audit.
 */
const SOC2_CHECKLIST = Object.freeze([
  {
    controlId: "CC6.1",
    title: "Logical access controls enforced",
    expected: "Auth middleware / route guards in code",
    searchPaths: ["auth", "middleware", "guard"],
  },
  {
    controlId: "CC6.6",
    title: "Transmission of confidential data is encrypted",
    expected: "HTTPS + TLS config references",
    searchRegex: /(https:\/\/|tls|ssl|cert)/i,
  },
  {
    controlId: "CC7.1",
    title: "Configuration management and change tracking",
    expected: "CHANGELOG or release notes",
    searchPaths: ["CHANGELOG", "RELEASES"],
  },
  {
    controlId: "CC7.2",
    title: "System monitoring and alerting",
    expected: "Observability config, dashboards, or alerts",
    searchPaths: ["monitor", "alert", "dashboard", "grafana", "datadog", "sentry"],
  },
  {
    controlId: "CC7.3",
    title: "Anomaly / incident detection",
    expected: "Security incident playbook or runbook",
    searchPaths: ["incident", "runbook", "playbook", "SECURITY.md"],
  },
  {
    controlId: "CC8.1",
    title: "Data backups and restoration tested",
    expected: "Backup policy or DR runbook",
    searchPaths: ["backup", "disaster-recovery", "dr-", "restore"],
  },
  {
    controlId: "A1.2",
    title: "Availability — RTO/RPO documented",
    expected: "RTO/RPO mentions in docs",
    searchRegex: /\b(rto|rpo|recovery[\s-]time|recovery[\s-]point)\b/i,
  },
  {
    controlId: "P2.1",
    title: "Privacy notice provided to users",
    expected: "PRIVACY.md or privacy-policy",
    searchPaths: ["PRIVACY", "privacy-policy", "privacy_policy"],
  },
]);

const ISO27001_CHECKLIST = Object.freeze([
  {
    controlId: "A.5.1",
    title: "Information security policy documented",
    expected: "SECURITY.md",
    searchPaths: ["SECURITY.md"],
  },
  {
    controlId: "A.8.1",
    title: "Asset inventory",
    expected: "SBOM or dependency manifest",
    searchPaths: ["sbom", "package.json", "requirements.txt", "go.mod", "Cargo.toml"],
  },
  {
    controlId: "A.9.2",
    title: "User access management",
    expected: "User / role / permission definitions",
    searchPaths: ["role", "permission", "rbac"],
  },
  {
    controlId: "A.12.4",
    title: "Event logging",
    expected: "Logging library usage",
    searchRegex: /\b(log(ger)?|structlog|winston|bunyan|pino)\b/i,
  },
  {
    controlId: "A.13.1",
    title: "Network security controls",
    expected: "Ingress / firewall / VPC / security-group config",
    searchPaths: ["ingress", "firewall", "security-group", "security_group", "vpc"],
  },
  {
    controlId: "A.14.2",
    title: "Secure development process",
    expected: "CI workflow with linting / testing / security scan",
    searchPaths: [".github/workflows", "azure-pipelines", ".gitlab-ci", "jenkinsfile"],
  },
  {
    controlId: "A.16.1",
    title: "Incident management procedures",
    expected: "Incident response runbook",
    searchPaths: ["incident", "runbook", "postmortem"],
  },
  {
    controlId: "A.17.1",
    title: "Business continuity",
    expected: "Failover / DR runbook",
    searchPaths: ["disaster-recovery", "dr-", "failover", "business-continuity"],
  },
  {
    controlId: "A.18.1",
    title: "Compliance with legal requirements",
    expected: "LICENSE file",
    searchPaths: ["LICENSE", "LICENCE"],
  },
]);

const GDPR_CCPA_CHECKLIST = Object.freeze([
  {
    controlId: "GDPR.DS-Rights",
    title: "Data subject rights endpoints (access / deletion / export)",
    expected: "User deletion or data-export endpoints",
    searchRegex: /(delete[_-]?user|user[_-]?delete|right[_-]?to[_-]?be[_-]?forgotten|data[_-]?export)/i,
  },
  {
    controlId: "GDPR.Consent",
    title: "Consent capture / ledger",
    expected: "Consent tracking code or schema",
    searchRegex: /\bconsent\b.*\b(given|captured|record)/i,
  },
  {
    controlId: "GDPR.LawfulBasis",
    title: "Lawful basis documentation",
    expected: "Privacy policy with legal basis",
    searchRegex: /legitimate[\s-]?interest|legal[\s-]?basis|lawful[\s-]?basis/i,
  },
  {
    controlId: "GDPR.DPA",
    title: "Data Processing Agreement template",
    expected: "DPA.md or data-processing-agreement",
    searchPaths: ["DPA", "data-processing-agreement"],
  },
  {
    controlId: "CCPA.DoNotSell",
    title: "Do-Not-Sell / Opt-Out endpoint",
    expected: "Do-not-sell link or endpoint",
    searchRegex: /do[\s-]?not[\s-]?sell|opt[\s-]?out[\s-]?of[\s-]?sale/i,
  },
]);

const HIPAA_CHECKLIST = Object.freeze([
  {
    controlId: "HIPAA.PHI",
    title: "PHI field identification in schema",
    expected: "Fields tagged as PHI or PII",
    searchRegex: /\b(phi|ssn|dob|diagnosis|icd10|mrn|health[\s_-]?record)\b/i,
  },
  {
    controlId: "HIPAA.Encryption",
    title: "Encryption at rest",
    expected: "Database encryption config",
    searchRegex: /encryption[\s_-]?at[\s_-]?rest|kms[\s_-]?key|aes[\s_-]?256/i,
  },
  {
    controlId: "HIPAA.AuditLog",
    title: "PHI access audit log",
    expected: "Access log table or middleware",
    searchRegex: /audit[\s_-]?log|phi[\s_-]?access[\s_-]?log/i,
  },
  {
    controlId: "HIPAA.BAA",
    title: "Business Associate Agreement references",
    expected: "BAA.md or BAA template",
    searchPaths: ["BAA", "business-associate"],
  },
]);

const LICENSE_CHECKLIST = Object.freeze([
  {
    controlId: "LIC.Root",
    title: "Root LICENSE file present",
    expected: "LICENSE",
    searchPaths: ["LICENSE", "LICENCE", "LICENSE.md"],
  },
  {
    controlId: "LIC.Manifest",
    title: "License declared in package manifest",
    expected: "license field in package.json / pyproject.toml",
    searchRegex: /"license"\s*:\s*"|^license\s*=\s*"/m,
  },
  {
    controlId: "LIC.SBOM",
    title: "SBOM artifact",
    expected: "SBOM or sbom.json / sbom.spdx.json",
    searchPaths: ["sbom", "SBOM"],
  },
]);

const DR_CHECKLIST = Object.freeze([
  {
    controlId: "DR.RTO",
    title: "Documented RTO",
    searchRegex: /\brto\b/i,
  },
  {
    controlId: "DR.RPO",
    title: "Documented RPO",
    searchRegex: /\brpo\b/i,
  },
  {
    controlId: "DR.Runbook",
    title: "Disaster-recovery runbook",
    searchPaths: ["disaster-recovery", "dr-runbook", "runbook/recovery"],
  },
  {
    controlId: "DR.BackupTest",
    title: "Evidence of backup restore test",
    searchRegex: /restore[\s_-]?test|backup[\s_-]?verified|test[\s_-]?restore/i,
  },
]);

const PACKS = Object.freeze({
  soc2: SOC2_CHECKLIST,
  iso27001: ISO27001_CHECKLIST,
  gdpr: GDPR_CCPA_CHECKLIST,
  ccpa: GDPR_CCPA_CHECKLIST,
  hipaa: HIPAA_CHECKLIST,
  license: LICENSE_CHECKLIST,
  dr: DR_CHECKLIST,
});

export const COMPLIANCE_PACK_CATALOG = Object.freeze(Object.keys(PACKS));

/**
 * Evaluate one checklist item against the repo. Returns a gap record
 * whether the control was satisfied or not — the consumer interprets
 * `status` to produce a final report.
 */
async function evaluateChecklistItem(item, files) {
  let foundFile = null;
  if (Array.isArray(item.searchPaths) && item.searchPaths.length > 0) {
    foundFile = fileExistsAnyName(files, item.searchPaths);
  }
  if (!foundFile && item.searchRegex) {
    const contentHit = await fileContentContains(files, item.searchRegex);
    if (contentHit.match) foundFile = contentHit.file;
  }
  return {
    controlId: item.controlId,
    title: item.title,
    expected: item.expected || "",
    status: foundFile ? "covered" : "gap",
    evidenceFile: foundFile,
  };
}

/**
 * Run one compliance pack against the repo.
 *
 * @param {string} packId        - e.g., "soc2", "iso27001", "gdpr", ...
 * @param {{rootPath: string, files?: Array<{relPath: string, absPath: string}>}} params
 * @returns {Promise<{packId: string, items: Array, covered: number, gaps: number}>}
 */
export async function runCompliancePack(packId, { rootPath, files } = {}) {
  const checklist = PACKS[packId];
  if (!checklist) throw new Error(`Unknown compliance pack: ${packId}`);
  if (!rootPath) throw new TypeError("runCompliancePack requires rootPath");
  const walked = files || (await walkFiles(rootPath));

  const items = [];
  let covered = 0;
  let gaps = 0;
  for (const item of checklist) {
    const record = await evaluateChecklistItem(item, walked);
    items.push(record);
    if (record.status === "covered") covered += 1;
    else gaps += 1;
  }
  return { packId, items, covered, gaps };
}

/**
 * Run the full compliance pack suite.
 *
 * @param {object} params
 * @param {string} params.rootPath
 * @param {string[]} [params.packs]   - Subset of pack IDs (default all).
 * @returns {Promise<{packs: Record<string, object>, totalCovered: number, totalGaps: number}>}
 */
export async function runFullCompliancePack({
  rootPath,
  packs = COMPLIANCE_PACK_CATALOG,
} = {}) {
  if (!rootPath) throw new TypeError("runFullCompliancePack requires rootPath");
  const files = await walkFiles(rootPath);
  const results = {};
  let totalCovered = 0;
  let totalGaps = 0;
  for (const packId of packs) {
    if (!PACKS[packId]) continue;
    const result = await runCompliancePack(packId, { rootPath, files });
    results[packId] = result;
    totalCovered += result.covered;
    totalGaps += result.gaps;
  }
  return { packs: results, totalCovered, totalGaps };
}
