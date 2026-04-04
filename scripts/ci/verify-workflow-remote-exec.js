#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import process from "node:process";

import { parseDocument } from "yaml";

const NETWORK_COMMANDS = new Set([
  "curl",
  "wget",
  "invoke-webrequest",
  "iwr",
  "irm",
]);

const EXECUTION_SINKS = new Set([
  "bash",
  "sh",
  "zsh",
  "ksh",
  "pwsh",
  "powershell",
  "iex",
  "eval",
]);

function fail(message) {
  console.error(`::error::${message}`);
  process.exit(1);
}

function normalizeWhitespace(value) {
  return String(value || "")
    .replace(/\r/g, "")
    .replace(/\t/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function slugify(value, fallback) {
  const normalized = String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return normalized || fallback;
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
  if (workflowFiles.length > 0) {
    return { allowlistPath, workflowFiles };
  }
  const workflowDir = path.resolve(".github", "workflows");
  if (!fs.existsSync(workflowDir)) {
    fail("No workflow files found for remote-exec validation.");
  }
  const discovered = fs
    .readdirSync(workflowDir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".yml"))
    .map((entry) => path.join(".github", "workflows", entry.name))
    .sort((a, b) => a.localeCompare(b));
  return { allowlistPath, workflowFiles: discovered };
}

function loadAllowlistRegexes(allowlistPath) {
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

function parseWorkflowRunSteps(workflowPath) {
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
    for (let index = 0; index < steps.length; index += 1) {
      const step = steps[index];
      if (!step || typeof step !== "object") {
        continue;
      }
      const run = typeof step.run === "string" ? step.run : "";
      if (!run.trim()) {
        continue;
      }
      const stepId = slugify(step.id || step.name, `step-${index + 1}`);
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

function toLowerToken(token) {
  return String(token || "").trim().toLowerCase();
}

function stripTrailingControlOperators(command) {
  let trimmed = command.trim();
  while (trimmed.endsWith("&") || trimmed.endsWith("|")) {
    trimmed = trimmed.slice(0, -1).trimEnd();
  }
  return trimmed;
}

function splitTopLevel(input, delimiter) {
  const parts = [];
  let current = "";
  let singleQuote = false;
  let doubleQuote = false;
  let backtickQuote = false;
  let parenDepth = 0;
  for (let i = 0; i < input.length; i += 1) {
    const char = input[i];
    const next = input[i + 1] || "";
    const prev = input[i - 1] || "";
    if (char === "'" && !doubleQuote && !backtickQuote && prev !== "\\") {
      singleQuote = !singleQuote;
      current += char;
      continue;
    }
    if (char === '"' && !singleQuote && !backtickQuote && prev !== "\\") {
      doubleQuote = !doubleQuote;
      current += char;
      continue;
    }
    if (char === "`" && !singleQuote && !doubleQuote && prev !== "\\") {
      backtickQuote = !backtickQuote;
      current += char;
      continue;
    }
    if (!singleQuote && !doubleQuote && !backtickQuote) {
      if (char === "$" && next === "(") {
        parenDepth += 1;
        current += char;
        continue;
      }
      if (char === "<" && next === "(") {
        parenDepth += 1;
        current += char;
        continue;
      }
      if (char === "(" && parenDepth > 0) {
        parenDepth += 1;
        current += char;
        continue;
      }
      if (char === ")" && parenDepth > 0) {
        parenDepth -= 1;
        current += char;
        continue;
      }
      if (parenDepth === 0 && char === delimiter) {
        const value = stripTrailingControlOperators(current);
        if (value) {
          parts.push(value);
        }
        current = "";
        continue;
      }
    }
    current += char;
  }
  const last = stripTrailingControlOperators(current);
  if (last) {
    parts.push(last);
  }
  return parts;
}

function splitCommands(run) {
  const rawLines = String(run || "")
    .replace(/\r/g, "")
    .split("\n")
    .map((entry) => entry.trim())
    .filter((entry) => entry && !entry.startsWith("#"));
  const commands = [];
  for (const line of rawLines) {
    for (const command of splitTopLevel(line, ";")) {
      const normalized = normalizeWhitespace(command);
      if (normalized) {
        commands.push(normalized);
      }
    }
  }
  return commands;
}

function splitWords(segment) {
  const words = [];
  let current = "";
  let singleQuote = false;
  let doubleQuote = false;
  let backtickQuote = false;
  for (let i = 0; i < segment.length; i += 1) {
    const char = segment[i];
    const prev = segment[i - 1] || "";
    if (char === "'" && !doubleQuote && !backtickQuote && prev !== "\\") {
      singleQuote = !singleQuote;
      current += char;
      continue;
    }
    if (char === '"' && !singleQuote && !backtickQuote && prev !== "\\") {
      doubleQuote = !doubleQuote;
      current += char;
      continue;
    }
    if (char === "`" && !singleQuote && !doubleQuote && prev !== "\\") {
      backtickQuote = !backtickQuote;
      current += char;
      continue;
    }
    if (!singleQuote && !doubleQuote && !backtickQuote && /\s/.test(char)) {
      if (current) {
        words.push(current);
        current = "";
      }
      continue;
    }
    current += char;
  }
  if (current) {
    words.push(current);
  }
  return words;
}

function parseAssignments(words) {
  const assignments = [];
  const args = [];
  let reachedCommand = false;
  for (const word of words) {
    if (!reachedCommand) {
      const equalsIndex = word.indexOf("=");
      const startsWithVariable = /^[A-Za-z_][A-Za-z0-9_]*=/.test(word);
      if (equalsIndex > 0 && startsWithVariable) {
        assignments.push({
          name: word.slice(0, equalsIndex),
          value: word.slice(equalsIndex + 1),
        });
        continue;
      }
      reachedCommand = true;
    }
    args.push(word);
  }
  return { assignments, args };
}

function containsNetworkFetchFragment(fragment) {
  const lower = String(fragment || "").toLowerCase();
  for (const command of NETWORK_COMMANDS) {
    if (lower.includes(command)) {
      return true;
    }
  }
  return false;
}

function extractReferencedVariables(fragment) {
  const references = new Set();
  const text = String(fragment || "");
  const variableRegex = /\$[{]?([A-Za-z_][A-Za-z0-9_]*)[}]?/g;
  let match;
  while ((match = variableRegex.exec(text)) !== null) {
    const name = String(match[1] || "").toLowerCase();
    if (name) {
      references.add(name);
    }
  }
  return references;
}

function isNetworkCommand(commandName) {
  return NETWORK_COMMANDS.has(toLowerToken(commandName));
}

function isExecutionSink(commandName) {
  return EXECUTION_SINKS.has(toLowerToken(commandName));
}

function buildCommandModel(commandText) {
  const segments = splitTopLevel(commandText, "|").map((segment) => {
    const words = splitWords(segment);
    const parsed = parseAssignments(words);
    const commandName = parsed.args.length > 0 ? toLowerToken(parsed.args[0]) : "";
    return {
      raw: segment,
      assignments: parsed.assignments,
      args: parsed.args,
      commandName,
    };
  });
  return {
    raw: commandText,
    segments,
  };
}

function analyzeRunStep(step) {
  const findings = [];
  const taintedVariables = new Set();
  const commands = splitCommands(step.run).map((commandText) => buildCommandModel(commandText));

  const addFinding = (reason, commandRaw) => {
    const preview = normalizeWhitespace(commandRaw).slice(0, 220);
    findings.push({ reason, preview });
  };

  for (const command of commands) {
    for (const segment of command.segments) {
      for (const assignment of segment.assignments) {
        const varName = toLowerToken(assignment.name);
        const value = String(assignment.value || "");
        if (!varName) {
          continue;
        }
        if (containsNetworkFetchFragment(value) && (value.includes("$(") || value.includes("`"))) {
          taintedVariables.add(varName);
        }
      }
    }

    const firstNetworkIndex = command.segments.findIndex((segment) => isNetworkCommand(segment.commandName));
    const firstSinkIndex = command.segments.findIndex((segment) => isExecutionSink(segment.commandName));
    if (firstNetworkIndex >= 0 && firstSinkIndex > firstNetworkIndex) {
      addFinding("network command piped into execution sink", command.raw);
    }

    for (const segment of command.segments) {
      const joinedArgs = segment.args.join(" ");
      if (joinedArgs.includes("<(") && containsNetworkFetchFragment(joinedArgs) && isExecutionSink(segment.commandName)) {
        addFinding("process substitution executes network-fetched payload", command.raw);
      }
      if (joinedArgs.includes("$(") && containsNetworkFetchFragment(joinedArgs) && isExecutionSink(segment.commandName)) {
        addFinding("command substitution executes network-fetched payload", command.raw);
      }
      if (joinedArgs.includes("base64") && command.segments.some((entry) => isExecutionSink(entry.commandName))) {
        addFinding("encoded payload routed into execution sink", command.raw);
      }
    }

    for (const segment of command.segments) {
      if (!isExecutionSink(segment.commandName)) {
        continue;
      }
      const argumentPayload = segment.args.slice(1).join(" ");
      if (!argumentPayload) {
        continue;
      }
      const referenced = extractReferencedVariables(argumentPayload);
      for (const variableName of referenced) {
        if (taintedVariables.has(variableName)) {
          addFinding(`tainted variable '${variableName}' reaches execution sink '${segment.commandName}'`, command.raw);
        }
      }
    }
  }

  const deduped = [];
  const seen = new Set();
  for (const finding of findings) {
    const key = `${finding.reason}::${finding.preview}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    deduped.push(finding);
  }
  return deduped;
}

function isAllowlisted(allowlistRegexes, context, finding) {
  if (!Array.isArray(allowlistRegexes) || allowlistRegexes.length === 0) {
    return false;
  }
  const payload = `${context}\n${finding.reason}\n${finding.preview}`;
  return allowlistRegexes.some((entry) => entry && entry.test(payload));
}

function main() {
  const { allowlistPath, workflowFiles } = parseArgs(process.argv.slice(2));
  const allowlistRegexes = loadAllowlistRegexes(allowlistPath);
  let failureCount = 0;
  for (const workflowPath of workflowFiles) {
    if (!fs.existsSync(workflowPath)) {
      fail(`Workflow file '${workflowPath}' does not exist.`);
    }
    const runSteps = parseWorkflowRunSteps(workflowPath);
    for (const step of runSteps) {
      const context = `${workflowPath}#${step.jobId}.${step.stepId}`;
      const findings = analyzeRunStep(step);
      for (const finding of findings) {
        if (isAllowlisted(allowlistRegexes, context, finding)) {
          continue;
        }
        console.error(
          `::error file=${workflowPath}::Potential remote shell execution in run step is not allowlisted (${context}): ${finding.preview}`
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
