#!/usr/bin/env bash
set -euo pipefail

LOCK_FILE="${1:-.github/policies/actions-lock.json}"

if [ ! -f "${LOCK_FILE}" ]; then
  echo "::error::Action lock policy file not found: ${LOCK_FILE}"
  exit 1
fi

export LOCK_FILE

node <<'NODE'
const fs = require("node:fs");
const path = require("node:path");

const lockFile = process.env.LOCK_FILE || ".github/policies/actions-lock.json";
const workflowRoots = [".github/workflows", ".github/actions"];
const usesPattern = /^\s*uses:\s*([^\s#]+)@([A-Za-z0-9._-]+)\b/;
const shaPattern = /^[a-f0-9]{40}$/;
const broadVersionCommentPattern = /^v\d+$/i;

function readJson(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch (error) {
    throw new Error(`Failed to parse ${filePath}: ${error.message}`);
  }
}

function listYamlFiles(rootDir) {
  if (!fs.existsSync(rootDir)) {
    return [];
  }
  const results = [];
  const stack = [rootDir];
  while (stack.length > 0) {
    const current = stack.pop();
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const fullPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(fullPath);
        continue;
      }
      if (entry.isFile() && (entry.name.endsWith(".yml") || entry.name.endsWith(".yaml"))) {
        results.push(fullPath);
      }
    }
  }
  return results.sort();
}

function normalizeLock(raw) {
  const normalized = new Map();
  for (const [action, value] of Object.entries(raw || {})) {
    const values = Array.isArray(value) ? value : [value];
    const cleaned = values
      .map((item) => String(item || "").trim().toLowerCase())
      .filter((item) => item.length > 0);
    normalized.set(action.trim(), new Set(cleaned));
  }
  return normalized;
}

function collectUsesRefs(filePath) {
  const refs = [];
  const lines = fs.readFileSync(filePath, "utf8").split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const match = line.match(usesPattern);
    if (!match) {
      continue;
    }
    const actionRef = match[1];
    const pin = match[2].toLowerCase();
    if (actionRef.startsWith("./")) {
      continue;
    }
    refs.push({
      filePath,
      lineNumber: index + 1,
      actionRef,
      pin,
      inlineComment: line.includes("#") ? line.slice(line.indexOf("#") + 1).trim() : ""
    });
  }
  return refs;
}

function main() {
  const lock = normalizeLock(readJson(lockFile));
  const yamlFiles = workflowRoots.flatMap((root) => listYamlFiles(root));
  const refs = yamlFiles.flatMap((filePath) => collectUsesRefs(filePath));
  const errors = [];

  for (const ref of refs) {
    if (!shaPattern.test(ref.pin)) {
      errors.push(
        `${ref.filePath}:${ref.lineNumber} uses ${ref.actionRef}@${ref.pin} but pin is not a full 40-char commit SHA.`
      );
      continue;
    }
    if (ref.inlineComment && broadVersionCommentPattern.test(ref.inlineComment)) {
      errors.push(
        `${ref.filePath}:${ref.lineNumber} uses ${ref.actionRef}@${ref.pin} with broad version comment '${ref.inlineComment}'. ` +
        "Use a specific release annotation or 'digest-pinned (<action>)'."
      );
      continue;
    }
    if (!lock.has(ref.actionRef)) {
      errors.push(
        `${ref.filePath}:${ref.lineNumber} uses ${ref.actionRef}@${ref.pin} but ${ref.actionRef} is not listed in ${lockFile}.`
      );
      continue;
    }
    const allowedPins = lock.get(ref.actionRef);
    if (!allowedPins.has(ref.pin)) {
      errors.push(
        `${ref.filePath}:${ref.lineNumber} uses ${ref.actionRef}@${ref.pin} but lock policy allows: ${Array.from(
          allowedPins
        ).join(", ")}`
      );
    }
  }

  if (errors.length > 0) {
    console.error("::error::Workflow action pin policy violations detected:");
    for (const error of errors) {
      console.error(`::error::${error}`);
    }
    process.exit(1);
  }

  console.log(
    `Verified ${refs.length} external action pins across ${yamlFiles.length} workflow/action definition files against ${lockFile}.`
  );
}

main();
NODE
