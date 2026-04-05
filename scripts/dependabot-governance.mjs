#!/usr/bin/env node
import fs from "node:fs";

const policyPath = process.argv[2] ?? ".github/policies/dependabot-governance.json";
const metadataPath = process.argv[3] ?? "dependabot-metadata.json";
const outputPath = process.argv[4] ?? "dependabot-governance.json";

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function normalizeString(value) {
  return String(value ?? "").trim();
}

function parseDependencyNames(value) {
  if (Array.isArray(value)) {
    return value.map((item) => normalizeString(item)).filter(Boolean);
  }
  return normalizeString(value)
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function compileRegexList(patterns) {
  const compiled = [];
  for (const pattern of patterns || []) {
    try {
      compiled.push(new RegExp(String(pattern), "i"));
    } catch {
      // Ignore invalid patterns and fail closed through policy mismatch if needed.
    }
  }
  return compiled;
}

const policy = readJson(policyPath);
const metadata = readJson(metadataPath);
const automergePolicy = policy.automerge || {};

const actor = normalizeString(metadata.actor);
const updateType = normalizeString(metadata.update_type);
const dependencyType = normalizeString(metadata.dependency_type) || "unknown";
const packageEcosystem = normalizeString(metadata.package_ecosystem) || "unknown";
const dependencyNames = parseDependencyNames(metadata.dependency_names);

const reasons = [];

const requiredActor = normalizeString(automergePolicy.required_actor);
if (!requiredActor || actor !== requiredActor) {
  reasons.push("actor_not_allowed");
}

const allowedUpdateTypes = new Set(
  (automergePolicy.allowed_update_types || []).map((item) => normalizeString(item))
);
if (!allowedUpdateTypes.has(updateType)) {
  reasons.push("update_type_not_allowed");
}

const allowedDependencyTypes = new Set(
  (automergePolicy.allowed_dependency_types || []).map((item) => normalizeString(item))
);
if (!allowedDependencyTypes.has(dependencyType)) {
  reasons.push("dependency_type_not_allowed");
}

const allowedPackageEcosystems = new Set(
  (automergePolicy.allowed_package_ecosystems || []).map((item) => normalizeString(item))
);
if (!allowedPackageEcosystems.has(packageEcosystem)) {
  reasons.push("package_ecosystem_not_allowed");
}

const blockedDependencyRegexes = compileRegexList(automergePolicy.blocked_dependency_patterns || []);
const blockedDependencies = dependencyNames.filter((dependencyName) =>
  blockedDependencyRegexes.some((pattern) => pattern.test(dependencyName))
);
if (blockedDependencies.length > 0) {
  reasons.push("dependency_blocked_by_policy");
}

const eligible = reasons.length === 0;

const result = {
  evaluated_at: new Date().toISOString(),
  eligible,
  reasons,
  metadata: {
    actor,
    update_type: updateType,
    dependency_type: dependencyType,
    package_ecosystem: packageEcosystem,
    dependency_names: dependencyNames,
    pr_number: metadata.pr_number ?? null
  },
  policy: {
    required_actor: requiredActor,
    allowed_update_types: [...allowedUpdateTypes],
    allowed_dependency_types: [...allowedDependencyTypes],
    allowed_package_ecosystems: [...allowedPackageEcosystems],
    blocked_dependency_patterns: automergePolicy.blocked_dependency_patterns || []
  },
  blocked_dependencies: blockedDependencies
};

fs.writeFileSync(outputPath, JSON.stringify(result, null, 2) + "\n");
const reasonText = reasons.length > 0 ? reasons.join(",") : "none";
console.log(`Dependabot governance decision: eligible=${eligible} reasons=${reasonText}`);
