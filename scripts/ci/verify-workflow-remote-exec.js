#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import process from "node:process";

import { parseDocument } from "yaml";

const NETWORK_FETCH_RE = /\b(curl|wget|invoke-webrequest|iwr|irm)\b/i;
const SHELL_SINK_RE = /\b(bash|sh|zsh|ksh|pwsh|powershell|iex)\b/i;
const PIPE_REMOTE_EXEC_RE =
  /(curl|wget|invoke-webrequest|iwr|irm)\b[^|]*\|[^|]*(bash|sh|zsh|ksh|pwsh|powershell|iex)\b/i;
const BASE64_PIPE_EXEC_RE =
  /(base64|openssl\s+base64)\b[^|]*\|[^|]*(bash|sh|zsh|ksh|pwsh|powershell|iex)\b/i;
const PROCESS_SUBSTITUTION_RE =
  /\b(bash|sh|zsh|ksh)\b[^#\n]*<\(\s*(curl|wget|invoke-webrequest|iwr|irm)\b/i;
const SOURCE_SUBSTITUTION_RE =
  /\b(source|\.)\b[^#\n]*<\(\s*(curl|wget|invoke-webrequest|iwr|irm)\b/i;
const COMMAND_SUBSTITUTION_RE = /\$\([^)]*(curl|wget|invoke-webrequest|iwr|irm)\b[^)]*\)/i;

function fail(message) {
  console.error(`::error::${message}`);
  process.exit(1);
}

function slugify(value, fallback) {
  const normalized = String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return normalized || fallback;
}

function normalizeWhitespace(value) {
  return String(value || "")
    .replace(/\r/g, "")
    .replace(/\t/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeForCheck(line) {
  return normalizeWhitespace(line).toLowerCase();
}

function decodeAllowlist(allowlistPath) {
  let raw = "";
  try {
    raw = fs.readFileSync(allowlistPath, "utf8");
  } catch (error) {
    fail(`Unable to read remote-exec allowlist '${allowlistPath}' (${error?.message || "unknown error"}).`);
  }
  const patterns = raw
    .split(/\r?\n/g)
    .map((entry) => entry.trim())
    .filter((entry) => entry && !entry.startsWith("#"));
  return patterns.map((entry) => {
    try {
      return new RegExp(entry, "i");
    } catch (error) {
      fail(`Invalid remote-exec allowlist regex '${entry}' in '${allowlistPath}' (${error?.message || "invalid regex"}).`);
    }
    return null;
  });
}

function listWorkflowFiles() {
  const workflowDir = path.resolve(".github", "workflows");
  if (!fs.existsSync(workflowDir)) {
    return [];
  }
  return fs
    .readdirSync(workflowDir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".yml"))
    .map((entry) => path.join(".github", "workflows", entry.name))
    .sort((a, b) => a.localeCompare(b));
}

function parseArgs(argv) {
  let allowlistPath = ".github/security/workflow-remote-exec-allowlist.txt";
  const workflowFiles = [];
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--allowlist") {
      const next = argv[index + 1];
      if (!next) {
        fail("Missing value for --allowlist.");
      }
      allowlistPath = next;
      index += 1;
      continue;
    }
    workflowFiles.push(arg);
  }
  return {
    allowlistPath,
    workflowFiles: workflowFiles.length > 0 ? workflowFiles : listWorkflowFiles(),
  };
}

function parseWorkflow(workflowPath) {
  let raw = "";
  try {
    raw = fs.readFileSync(workflowPath, "utf8");
  } catch (error) {
    fail(`Unable to read workflow '${workflowPath}' (${error?.message || "unknown error"}).`);
  }
  let doc;
  try {
    doc = parseDocument(raw, {
      uniqueKeys: true,
      strict: true,
      merge: false,
      prettyErrors: true,
    });
  } catch (error) {
    fail(`Unable to parse workflow '${workflowPath}' (${error?.message || "parse failure"}).`);
  }
  if (Array.isArray(doc.errors) && doc.errors.length > 0) {
    const summary = doc.errors.map((entry) => String(entry?.message || entry)).join("; ");
    fail(`Unable to parse workflow '${workflowPath}' (${summary}).`);
  }
  if (Array.isArray(doc.warnings) && doc.warnings.length > 0) {
    const summary = doc.warnings.map((entry) => String(entry?.message || entry)).join("; ");
    fail(`Workflow '${workflowPath}' emitted parser warnings (${summary}).`);
  }
  const parsed = doc.toJS();
  const jobs = parsed && typeof parsed === "object" && parsed.jobs && typeof parsed.jobs === "object"
    ? parsed.jobs
    : {};
  const runSteps = [];
  for (const [jobIdRaw, jobValue] of Object.entries(jobs)) {
    if (!jobValue || typeof jobValue !== "object") {
      continue;
    }
    const jobId = slugify(jobIdRaw, "job");
    const steps = Array.isArray(jobValue.steps) ? jobValue.steps : [];
    for (let stepIndex = 0; stepIndex < steps.length; stepIndex += 1) {
      const step = steps[stepIndex];
      if (!step || typeof step !== "object") {
        continue;
      }
      const run = typeof step.run === "string" ? step.run : "";
      if (!run.trim()) {
        continue;
      }
      const stepId = slugify(step.id || step.name, `step-${stepIndex + 1}`);
      runSteps.push({
        workflowPath,
        jobId,
        stepId,
        run,
      });
    }
  }
  return runSteps;
}

function collectLineFindings(lineRaw, taintedVars, findings) {
  const normalized = normalizeForCheck(lineRaw);
  if (!normalized) {
    return;
  }
  const addFinding = (reason) => {
    findings.push({
      line: normalized,
      reason,
    });
  };
  const assignmentMatch = normalized.match(/^([a-z_][a-z0-9_]*)\s*=\s*(.+)$/i);
  if (assignmentMatch) {
    const variableName = String(assignmentMatch[1] || "").toLowerCase();
    const rhs = String(assignmentMatch[2] || "");
    if (variableName && NETWORK_FETCH_RE.test(rhs)) {
      taintedVars.add(variableName);
    }
  }
  if (PROCESS_SUBSTITUTION_RE.test(normalized) || SOURCE_SUBSTITUTION_RE.test(normalized)) {
    addFinding("process substitution from network fetch into shell execution");
  }
  if (PIPE_REMOTE_EXEC_RE.test(normalized)) {
    addFinding("network fetch piped directly into shell");
  }
  if (BASE64_PIPE_EXEC_RE.test(normalized)) {
    addFinding("encoded payload piped into shell execution");
  }
  if (COMMAND_SUBSTITUTION_RE.test(normalized) && SHELL_SINK_RE.test(normalized)) {
    addFinding("command substitution fetch executed by shell");
  }
  if (/\beval\b/.test(normalized) && NETWORK_FETCH_RE.test(normalized)) {
    addFinding("eval used with direct network fetch command");
  }
  for (const taintedVar of taintedVars) {
    const referenceRe = new RegExp(`\\$\\{?${taintedVar}\\}?`, "i");
    if (!referenceRe.test(normalized)) {
      continue;
    }
    if (/\beval\b/.test(normalized)) {
      addFinding(`tainted variable '${taintedVar}' executed via eval`);
    }
    if (/\b(bash|sh|zsh|ksh|pwsh|powershell)\b\s+-c\b/.test(normalized)) {
      addFinding(`tainted variable '${taintedVar}' executed via shell -c`);
    }
    if (/\|\s*(bash|sh|zsh|ksh|pwsh|powershell|iex)\b/.test(normalized)) {
      addFinding(`tainted variable '${taintedVar}' piped into shell`);
    }
  }
}

function shouldAllowFinding(allowlistRegexes, context, finding) {
  if (!Array.isArray(allowlistRegexes) || allowlistRegexes.length === 0) {
    return false;
  }
  const payload = `${context}\n${finding.reason}\n${finding.line}`;
  return allowlistRegexes.some((entry) => entry && entry.test(payload));
}

function main() {
  const { allowlistPath, workflowFiles } = parseArgs(process.argv.slice(2));
  if (!Array.isArray(workflowFiles) || workflowFiles.length === 0) {
    fail("No workflow files found for remote-exec verification.");
  }
  const allowlistRegexes = decodeAllowlist(allowlistPath);
  let failureCount = 0;
  for (const workflowPath of workflowFiles) {
    if (!fs.existsSync(workflowPath)) {
      fail(`Workflow file '${workflowPath}' does not exist.`);
    }
    const runSteps = parseWorkflow(workflowPath);
    for (const entry of runSteps) {
      const taintedVars = new Set();
      const findings = [];
      const lines = String(entry.run || "").split(/\r?\n/g);
      for (const lineRaw of lines) {
        collectLineFindings(lineRaw, taintedVars, findings);
      }
      const uniqueFindings = [];
      const seenKeys = new Set();
      for (const finding of findings) {
        const key = `${finding.reason}::${finding.line}`;
        if (seenKeys.has(key)) {
          continue;
        }
        seenKeys.add(key);
        uniqueFindings.push(finding);
      }
      const allowlistContext = `${workflowPath}#${entry.jobId}.${entry.stepId}`;
      for (const finding of uniqueFindings) {
        if (shouldAllowFinding(allowlistRegexes, allowlistContext, finding)) {
          continue;
        }
        const preview = String(finding.line || "").slice(0, 180);
        console.error(
          `::error file=${workflowPath}::Potential remote shell execution in run step is not allowlisted (${allowlistContext}): ${preview}`
        );
        failureCount += 1;
      }
    }
  }
  if (failureCount > 0) {
    fail(`Workflow remote-exec validation failed with ${failureCount} issue(s).`);
  }
  console.log(`Verified workflow remote-exec policy for ${workflowFiles.length} workflow file(s).`);
}

main();
