import fs from "node:fs";
import path from "node:path";
import process from "node:process";

import { parse } from "yaml";

const ALLOWED_PERMISSION_SCOPES = new Set([
  "actions",
  "attestations",
  "checks",
  "contents",
  "id-token",
  "pull-requests",
  "security-events",
]);
const ALLOWED_PERMISSION_VALUES = new Set(["read", "write", "none"]);
const PERMISSION_LEVEL_RANK = Object.freeze({
  none: 0,
  read: 1,
  write: 2,
});

function fail(message) {
  console.error(`::error::${message}`);
  process.exit(1);
}

function normalizePermissionLevel(value, context) {
  const normalized = String(value || "")
    .trim()
    .toLowerCase();
  if (!ALLOWED_PERMISSION_VALUES.has(normalized)) {
    fail(`${context} has invalid permission value '${value}'.`);
  }
  return normalized;
}

function resolveWorkflowPath(rawPath = "") {
  const normalized = String(rawPath || "").trim();
  if (!normalized) {
    fail("Workflow path cannot be empty.");
  }
  return normalized.replace(/\\/g, "/");
}

function validateWorkflowPermissions(workflowPath, policy) {
  let raw = "";
  try {
    raw = fs.readFileSync(workflowPath, "utf8");
  } catch (error) {
    fail(`Unable to read workflow '${workflowPath}' (${error?.message || "unknown read error"}).`);
  }

  let parsed = null;
  try {
    parsed = parse(raw);
  } catch (error) {
    fail(`Unable to parse YAML for '${workflowPath}' (${error?.message || "unknown parse error"}).`);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    fail(`Workflow '${workflowPath}' parsed to invalid root type.`);
  }

  if (!Object.prototype.hasOwnProperty.call(parsed, "permissions")) {
    fail(`Workflow '${workflowPath}' must define top-level permissions explicitly.`);
  }

  const workflowPolicy = policy?.workflows?.[workflowPath];
  if (!workflowPolicy || typeof workflowPolicy !== "object" || Array.isArray(workflowPolicy)) {
    fail(`Permission policy entry is missing for workflow '${workflowPath}'.`);
  }
  const workflowJobPolicy = workflowPolicy.jobs;
  if (!workflowJobPolicy || typeof workflowJobPolicy !== "object" || Array.isArray(workflowJobPolicy)) {
    fail(`Permission policy jobs map is missing for workflow '${workflowPath}'.`);
  }

  const jobs = parsed.jobs;
  if (!jobs || typeof jobs !== "object" || Array.isArray(jobs)) {
    fail(`Workflow '${workflowPath}' must define a jobs object.`);
  }

  for (const [jobName, jobConfig] of Object.entries(jobs)) {
    if (!jobConfig || typeof jobConfig !== "object" || Array.isArray(jobConfig)) {
      fail(`Workflow '${workflowPath}' job '${jobName}' has invalid configuration payload.`);
    }
    if (!Object.prototype.hasOwnProperty.call(jobConfig, "permissions")) {
      fail(`Workflow '${workflowPath}' job '${jobName}' must declare explicit permissions.`);
    }
    const permissions = jobConfig.permissions;
    if (!permissions || typeof permissions !== "object" || Array.isArray(permissions)) {
      fail(
        `Workflow '${workflowPath}' job '${jobName}' permissions must be an object with explicit scopes.`
      );
    }
    const jobPolicy = workflowJobPolicy?.[jobName];
    if (!jobPolicy || typeof jobPolicy !== "object" || Array.isArray(jobPolicy)) {
      fail(`Workflow '${workflowPath}' job '${jobName}' is missing in workflow-permissions policy.`);
    }
    const maxPolicy = jobPolicy.max;
    const requiredPolicy = jobPolicy.required;
    if (!maxPolicy || typeof maxPolicy !== "object" || Array.isArray(maxPolicy)) {
      fail(`Workflow '${workflowPath}' job '${jobName}' policy is missing 'max' permission map.`);
    }
    if (!requiredPolicy || typeof requiredPolicy !== "object" || Array.isArray(requiredPolicy)) {
      fail(`Workflow '${workflowPath}' job '${jobName}' policy is missing 'required' permission map.`);
    }

    for (const [scope, value] of Object.entries(permissions)) {
      if (!ALLOWED_PERMISSION_SCOPES.has(scope)) {
        fail(
          `Workflow '${workflowPath}' job '${jobName}' uses non-allowlisted permission scope '${scope}'.`
        );
      }
      if (!Object.prototype.hasOwnProperty.call(maxPolicy, scope)) {
        fail(
          `Workflow '${workflowPath}' job '${jobName}' scope '${scope}' is not declared in policy max map.`
        );
      }
      const normalizedValue = normalizePermissionLevel(
        value,
        `Workflow '${workflowPath}' job '${jobName}' scope '${scope}'`
      );
      const normalizedMax = normalizePermissionLevel(
        maxPolicy[scope],
        `Workflow '${workflowPath}' job '${jobName}' scope '${scope}' max policy`
      );
      if (PERMISSION_LEVEL_RANK[normalizedValue] > PERMISSION_LEVEL_RANK[normalizedMax]) {
        fail(
          `Workflow '${workflowPath}' job '${jobName}' scope '${scope}' exceeds policy max '${normalizedMax}' (actual='${normalizedValue}').`
        );
      }
    }

    for (const [scope, requiredValue] of Object.entries(requiredPolicy)) {
      if (!Object.prototype.hasOwnProperty.call(permissions, scope)) {
        fail(`Workflow '${workflowPath}' job '${jobName}' is missing required scope '${scope}'.`);
      }
      const normalizedRequired = normalizePermissionLevel(
        requiredValue,
        `Workflow '${workflowPath}' job '${jobName}' scope '${scope}' required policy`
      );
      const normalizedActual = normalizePermissionLevel(
        permissions[scope],
        `Workflow '${workflowPath}' job '${jobName}' scope '${scope}'`
      );
      if (PERMISSION_LEVEL_RANK[normalizedActual] < PERMISSION_LEVEL_RANK[normalizedRequired]) {
        fail(
          `Workflow '${workflowPath}' job '${jobName}' scope '${scope}' is below required '${normalizedRequired}' (actual='${normalizedActual}').`
        );
      }
    }
  }

  for (const policyJobName of Object.keys(workflowJobPolicy)) {
    if (!Object.prototype.hasOwnProperty.call(jobs, policyJobName)) {
      fail(
        `Workflow '${workflowPath}' permissions policy references missing job '${policyJobName}'.`
      );
    }
  }
}

const policyPath = path.normalize(".github/security/workflow-permissions-policy.json");
let policy = null;
try {
  policy = JSON.parse(fs.readFileSync(policyPath, "utf8"));
} catch (error) {
  fail(`Unable to load workflow permissions policy '${policyPath}' (${error?.message || "unknown parse error"}).`);
}
if (!policy || typeof policy !== "object" || Array.isArray(policy)) {
  fail(`Workflow permissions policy '${policyPath}' has invalid root structure.`);
}

const workflowPaths = process.argv.slice(2);
const normalizedWorkflowPaths =
  workflowPaths.length > 0
    ? workflowPaths.map((entry) => resolveWorkflowPath(entry))
    : Object.keys(policy.workflows || {}).map((entry) => resolveWorkflowPath(entry));
if (normalizedWorkflowPaths.length === 0) {
  fail("No workflow paths supplied for permission verification.");
}

for (const workflowPath of normalizedWorkflowPaths) {
  validateWorkflowPermissions(workflowPath, policy);
}
