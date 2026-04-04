import fs from "node:fs";
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

function fail(message) {
  console.error(`::error::${message}`);
  process.exit(1);
}

function validateWorkflowPermissions(workflowPath) {
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
    for (const [scope, value] of Object.entries(permissions)) {
      if (!ALLOWED_PERMISSION_SCOPES.has(scope)) {
        fail(
          `Workflow '${workflowPath}' job '${jobName}' uses non-allowlisted permission scope '${scope}'.`
        );
      }
      const normalizedValue = String(value || "").trim().toLowerCase();
      if (!ALLOWED_PERMISSION_VALUES.has(normalizedValue)) {
        fail(
          `Workflow '${workflowPath}' job '${jobName}' scope '${scope}' has invalid value '${value}'.`
        );
      }
    }
  }
}

const workflowPath = process.argv[2] || ".github/workflows/quality-gates.yml";
validateWorkflowPermissions(workflowPath);
