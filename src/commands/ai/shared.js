import { randomUUID } from "node:crypto";
import fsp from "node:fs/promises";
import path from "node:path";

// Shared helper utilities for ai command modules.

export function shouldEmitJson(options, command) {
  const local = Boolean(options && options.json);
  const globalFromCommand =
    command && command.optsWithGlobals ? Boolean(command.optsWithGlobals().json) : false;
  return local || globalFromCommand;
}

export function stableTimestampForFile(date = new Date()) {
  return date.toISOString().replace(/[:.]/g, "-");
}

export function parsePositiveInteger(rawValue, field, fallbackValue) {
  if (rawValue === undefined || rawValue === null || String(rawValue).trim() === "") {
    return fallbackValue;
  }
  const normalized = Number(rawValue);
  if (!Number.isFinite(normalized) || normalized <= 0) {
    throw new Error(`${field} must be a positive integer.`);
  }
  return Math.round(normalized);
}

export function parseConfidenceThreshold(rawValue, fallbackValue = 0.8) {
  if (rawValue === undefined || rawValue === null || String(rawValue).trim() === "") {
    return fallbackValue;
  }
  const normalized = Number(rawValue);
  if (!Number.isFinite(normalized) || normalized < 0 || normalized > 1) {
    throw new Error("minConfidence must be between 0 and 1.");
  }
  return normalized;
}

export function parseCsvTokens(rawValue, fallbackValues = []) {
  const normalized = String(rawValue || "").trim();
  if (!normalized) {
    return [...fallbackValues];
  }
  const unique = new Set();
  for (const token of normalized.split(",")) {
    const item = token.trim();
    if (item) {
      unique.add(item);
    }
  }
  return unique.size > 0 ? [...unique] : [...fallbackValues];
}

export function parseJsonObject(rawValue, field) {
  const normalized = String(rawValue || "").trim();
  if (!normalized) {
    return {};
  }
  let parsed;
  try {
    parsed = JSON.parse(normalized);
  } catch {
    throw new Error(`${field} must be valid JSON.`);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`${field} must be a JSON object.`);
  }
  return parsed;
}

export function normalizeLegalHoldStatus(rawValue) {
  const normalized = String(rawValue || "").trim().toUpperCase();
  if (!normalized) {
    return "NONE";
  }
  if (normalized === "HOLD" || normalized === "NONE" || normalized === "UNKNOWN") {
    return normalized;
  }
  return normalized;
}

export function identityIsUnderLegalHold(identityRecord = {}) {
  const directStatus = normalizeLegalHoldStatus(identityRecord.legalHoldStatus);
  const metadataStatus = normalizeLegalHoldStatus(identityRecord?.metadata?.legalHoldStatus);
  const metadataFlag = Boolean(identityRecord?.metadata?.legalHold === true);
  return directStatus === "HOLD" || metadataStatus === "HOLD" || metadataFlag;
}

export function normalizeIdempotencyKey(rawValue) {
  const normalized = String(rawValue || "").trim();
  return normalized || randomUUID();
}

export function hasExtractionSignal(extraction = {}) {
  return Boolean(String(extraction.otp || "").trim() || String(extraction.primaryActionUrl || "").trim());
}

export function meetsConfidenceThreshold(extraction = {}, minConfidence = 0.8) {
  const normalizedConfidence = Number(extraction.confidence);
  if (!Number.isFinite(normalizedConfidence)) {
    return minConfidence <= 0;
  }
  return normalizedConfidence >= minConfidence;
}

export function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function renderLineageRows(lineage = {}) {
  const nodes = Array.isArray(lineage.nodes) ? lineage.nodes : [];
  return [...nodes]
    .sort((left, right) => {
      const leftDepth = Number(left.depth);
      const rightDepth = Number(right.depth);
      if (leftDepth !== rightDepth) {
        return leftDepth - rightDepth;
      }
      return String(left.identityId || "").localeCompare(String(right.identityId || ""));
    })
    .map((node) => {
      const depth = Number.isFinite(Number(node.depth)) ? Math.max(0, Number(node.depth)) : 0;
      const indent = "  ".repeat(depth);
      const status = String(node.status || "UNKNOWN");
      const email = String(node.emailAddress || "unknown-email");
      return `${indent}- ${String(node.identityId || "unknown-id")} | ${status} | ${email}`;
    });
}

export async function writeArtifact(filePath, payload) {
  await fsp.mkdir(path.dirname(filePath), { recursive: true });
  await fsp.writeFile(filePath, `${JSON.stringify(payload, null, 2)}\n`, "utf-8");
}

export function buildCurlPreview({ apiUrl, idempotencyKey, requestPath }) {
  const escapedPath = String(requestPath || "").replace(/\\/g, "/");
  return [
    `curl -X POST ${apiUrl}/v1/identities \\`,
    `  -H \"Authorization: Bearer $AIDENID_API_KEY\" \\`,
    `  -H \"X-Org-Id: $AIDENID_ORG_ID\" \\`,
    `  -H \"X-Project-Id: $AIDENID_PROJECT_ID\" \\`,
    `  -H \"Idempotency-Key: ${idempotencyKey}\" \\`,
    `  -H \"Content-Type: application/json\" \\`,
    `  --data @${escapedPath}`,
  ].join("\n");
}
