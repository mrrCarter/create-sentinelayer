import fs from "node:fs";
import process from "node:process";

import { parse } from "yaml";

function fail(message) {
  console.error(`::error::${message}`);
  process.exit(1);
}

function normalizeNeeds(needs) {
  if (!needs) {
    return [];
  }
  if (Array.isArray(needs)) {
    return needs.map((entry) => String(entry || "").trim()).filter(Boolean);
  }
  return [String(needs || "").trim()].filter(Boolean);
}

function verifyQualityGateGraph(workflowPath) {
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
    fail(`Unable to parse workflow '${workflowPath}' (${error?.message || "unknown parse error"}).`);
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    fail(`Workflow '${workflowPath}' parsed to invalid root type.`);
  }

  const jobs = parsed.jobs;
  if (!jobs || typeof jobs !== "object" || Array.isArray(jobs)) {
    fail(`Workflow '${workflowPath}' must define a jobs object.`);
  }

  const requiredJobs = [
    "artifact-attestation-gate",
    "release-readiness",
    "deploy-readiness",
    "deploy-stage",
    "deploy",
    "quality-summary",
  ];
  for (const jobId of requiredJobs) {
    if (!Object.prototype.hasOwnProperty.call(jobs, jobId)) {
      fail(`Workflow '${workflowPath}' is missing required job '${jobId}'.`);
    }
  }

  const releaseReadinessNeeds = new Set(normalizeNeeds(jobs["release-readiness"]?.needs));
  if (!releaseReadinessNeeds.has("artifact-attestation-gate")) {
    fail(`Workflow '${workflowPath}' job 'release-readiness' must depend on 'artifact-attestation-gate'.`);
  }

  const deployReadinessNeeds = new Set(normalizeNeeds(jobs["deploy-readiness"]?.needs));
  if (!deployReadinessNeeds.has("artifact-attestation-gate")) {
    fail(`Workflow '${workflowPath}' job 'deploy-readiness' must depend on 'artifact-attestation-gate'.`);
  }

  const deployStageNeeds = new Set(normalizeNeeds(jobs["deploy-stage"]?.needs));
  if (!deployStageNeeds.has("artifact-attestation-gate")) {
    fail(`Workflow '${workflowPath}' job 'deploy-stage' must depend on 'artifact-attestation-gate'.`);
  }
  if (!deployStageNeeds.has("deploy-readiness")) {
    fail(`Workflow '${workflowPath}' job 'deploy-stage' must depend on 'deploy-readiness'.`);
  }

  const deployNeeds = new Set(normalizeNeeds(jobs.deploy?.needs));
  if (!deployNeeds.has("deploy-stage")) {
    fail(`Workflow '${workflowPath}' job 'deploy' must depend on 'deploy-stage'.`);
  }

  const qualitySummaryNeeds = new Set(normalizeNeeds(jobs["quality-summary"]?.needs));
  for (const requiredNeed of ["artifact-attestation-gate", "deploy-readiness", "deploy-stage", "deploy"]) {
    if (!qualitySummaryNeeds.has(requiredNeed)) {
      fail(
        `Workflow '${workflowPath}' job 'quality-summary' must depend on '${requiredNeed}' for deploy gate-chain enforcement.`
      );
    }
  }
}

const workflowPath = process.argv[2] || ".github/workflows/quality-gates.yml";
verifyQualityGateGraph(workflowPath);
