#!/usr/bin/env node
import fs from "node:fs";

const reportPath = process.argv[2] ?? "license-report.json";
const policyPath = process.argv[3] ?? ".github/policies/license-policy.json";
const outputPath = process.argv[4] ?? "license-violations.json";

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function normalizeLicenseToken(value) {
  return String(value)
    .trim()
    .replace(/^\(+/, "")
    .replace(/\)+$/, "")
    .replace(/\*+$/, "")
    .toUpperCase();
}

function evaluateExpression(rawExpression, allowedSet) {
  const expression = String(rawExpression || "").trim();
  const normalized = expression.toUpperCase();
  if (!normalized) {
    return { ok: false, reason: "missing_license" };
  }

  if (/unknown|unlicensed|see license in/i.test(normalized)) {
    return { ok: false, reason: "unknown_or_unlicensed" };
  }

  const clean = normalized
    .replace(/[()]/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  if (clean.includes(" OR ")) {
    const options = clean.split(/\s+OR\s+/).map((item) => normalizeLicenseToken(item));
    return {
      ok: options.some((item) => allowedSet.has(item)),
      reason: "or_expression",
      tokens: options
    };
  }

  if (clean.includes(" AND ")) {
    const required = clean.split(/\s+AND\s+/).map((item) => normalizeLicenseToken(item));
    return {
      ok: required.every((item) => allowedSet.has(item)),
      reason: "and_expression",
      tokens: required
    };
  }

  const token = normalizeLicenseToken(clean);
  return {
    ok: allowedSet.has(token),
    reason: "single_token",
    tokens: [token]
  };
}

const report = readJson(reportPath);
const policy = readJson(policyPath);
const allowedSet = new Set((policy.allowed_licenses || []).map((item) => normalizeLicenseToken(item)));
const failOnUnknown = policy.fail_on_unknown !== false;

const failures = [];
let unknownSkipped = 0;
for (const [pkgName, metadata] of Object.entries(report)) {
  const rawLicense = metadata?.licenses ?? "";
  const evaluation = evaluateExpression(rawLicense, allowedSet);
  if (!evaluation.ok) {
    if (
      !failOnUnknown &&
      (evaluation.reason === "missing_license" || evaluation.reason === "unknown_or_unlicensed")
    ) {
      unknownSkipped += 1;
      continue;
    }
    failures.push({
      package: pkgName,
      license: rawLicense || null,
      reason: evaluation.reason,
      parsed_tokens: evaluation.tokens || []
    });
  }
}

const summary = {
  total_packages: Object.keys(report).length,
  failed_packages: failures.length,
  unknown_skipped: unknownSkipped,
  fail_on_unknown: failOnUnknown,
  allowed_licenses: [...allowedSet].sort()
};

const output = {
  summary,
  failures
};

fs.writeFileSync(outputPath, JSON.stringify(output, null, 2) + "\n");
console.log(`License policy summary: packages=${summary.total_packages}, failures=${summary.failed_packages}`);

if (failures.length > 0) {
  console.error("Disallowed or unknown licenses detected.");
  process.exit(1);
}
