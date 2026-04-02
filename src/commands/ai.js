import { randomUUID } from "node:crypto";
import fsp from "node:fs/promises";
import path from "node:path";
import process from "node:process";

import pc from "picocolors";

import {
  buildChildIdentityPayload,
  buildProvisionEmailPayload,
  createChildIdentity,
  createDomain,
  createTarget,
  getLatestIdentityExtraction,
  getIdentityLineage,
  getTarget,
  freezeDomain,
  listIdentityEvents,
  normalizeAidenIdApiUrl,
  provisionEmailIdentity,
  revokeIdentityChildren,
  revokeIdentity,
  resolveAidenIdCredentials,
  verifyDomain,
  verifyTarget,
} from "../ai/aidenid.js";
import {
  getDomainById,
  getTargetById as getTrackedTargetById,
  recordDomainProofResponse,
  recordTargetProofResponse,
} from "../ai/domain-target-store.js";
import {
  getIdentityById,
  listIdentities,
  recordProvisionedIdentity,
  updateIdentityStatus,
} from "../ai/identity-store.js";
import { resolveOutputRoot } from "../config/service.js";

function shouldEmitJson(options, command) {
  const local = Boolean(options && options.json);
  const globalFromCommand =
    command && command.optsWithGlobals ? Boolean(command.optsWithGlobals().json) : false;
  return local || globalFromCommand;
}

function stableTimestampForFile(date = new Date()) {
  return date.toISOString().replace(/[:.]/g, "-");
}

function parsePositiveInteger(rawValue, field, fallbackValue) {
  if (rawValue === undefined || rawValue === null || String(rawValue).trim() === "") {
    return fallbackValue;
  }
  const normalized = Number(rawValue);
  if (!Number.isFinite(normalized) || normalized <= 0) {
    throw new Error(`${field} must be a positive integer.`);
  }
  return Math.round(normalized);
}

function parseConfidenceThreshold(rawValue, fallbackValue = 0.8) {
  if (rawValue === undefined || rawValue === null || String(rawValue).trim() === "") {
    return fallbackValue;
  }
  const normalized = Number(rawValue);
  if (!Number.isFinite(normalized) || normalized < 0 || normalized > 1) {
    throw new Error("minConfidence must be between 0 and 1.");
  }
  return normalized;
}

function parseCsvTokens(rawValue, fallbackValues = []) {
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

function parseJsonObject(rawValue, field) {
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

function normalizeIdempotencyKey(rawValue) {
  const normalized = String(rawValue || "").trim();
  return normalized || randomUUID();
}

function hasExtractionSignal(extraction = {}) {
  return Boolean(String(extraction.otp || "").trim() || String(extraction.primaryActionUrl || "").trim());
}

function meetsConfidenceThreshold(extraction = {}, minConfidence = 0.8) {
  const normalizedConfidence = Number(extraction.confidence);
  if (!Number.isFinite(normalizedConfidence)) {
    return minConfidence <= 0;
  }
  return normalizedConfidence >= minConfidence;
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function renderLineageRows(lineage = {}) {
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

async function writeArtifact(filePath, payload) {
  await fsp.mkdir(path.dirname(filePath), { recursive: true });
  await fsp.writeFile(filePath, `${JSON.stringify(payload, null, 2)}\n`, "utf-8");
}

function buildCurlPreview({ apiUrl, idempotencyKey, requestPath }) {
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

export function registerAiCommand(program) {
  const ai = program
    .command("ai")
    .description("AIdenID helper commands for ambient agent identity workflows");

  ai
    .command("provision-email")
    .alias("provision")
    .description("Provision an AIdenID identity payload (dry-run by default, optional live execute)")
    .option("--path <path>", "Workspace path for artifact/config resolution", ".")
    .option("--output-dir <path>", "Optional artifact output root override")
    .option("--api-url <url>", "AIdenID API base URL", "https://api.aidenid.com")
    .option("--api-key <key>", "AIdenID API key (or use AIDENID_API_KEY env)")
    .option("--org-id <id>", "AIdenID org id (or use AIDENID_ORG_ID env)")
    .option("--project-id <id>", "AIdenID project id (or use AIDENID_PROJECT_ID env)")
    .option("--alias-template <value>", "Optional alias template")
    .option("--ttl-hours <hours>", "Identity TTL in hours", "24")
    .option("--tags <csv>", "Comma-separated tags")
    .option("--domain-pool-id <id>", "Optional domain pool id")
    .option("--receive-mode <mode>", "Identity receive mode", "EDGE_ACCEPT")
    .option("--extraction-types <csv>", "Comma-separated extraction types", "otp,link")
    .option("--allow-webhooks", "Allow webhook delivery", true)
    .option("--no-allow-webhooks", "Disable webhook delivery")
    .option("--idempotency-key <key>", "Explicit idempotency key override")
    .option("--execute", "Execute live API call (default is dry-run artifact generation)")
    .option("--json", "Emit machine-readable output")
    .action(async (options, command) => {
      const emitJson = shouldEmitJson(options, command);
      const targetPath = path.resolve(process.cwd(), String(options.path || "."));
      const apiUrl = normalizeAidenIdApiUrl(options.apiUrl);
      const idempotencyKey = normalizeIdempotencyKey(options.idempotencyKey);
      const ttlHours = parsePositiveInteger(options.ttlHours, "ttlHours", 24);

      const payload = buildProvisionEmailPayload({
        aliasTemplate: options.aliasTemplate,
        ttlHours,
        tags: options.tags,
        domainPoolId: options.domainPoolId,
        receiveMode: options.receiveMode,
        allowWebhooks: Boolean(options.allowWebhooks),
        extractionTypes: options.extractionTypes,
      });

      const outputRoot = await resolveOutputRoot({
        cwd: targetPath,
        outputDirOverride: options.outputDir,
        env: process.env,
      });
      const artifactsDir = path.join(outputRoot, "aidenid", "provision-email");
      const stamp = stableTimestampForFile();
      const requestPath = path.join(artifactsDir, `request-${stamp}.json`);

      await writeArtifact(requestPath, {
        generatedAt: new Date().toISOString(),
        apiUrl,
        idempotencyKey,
        payload,
      });

      const resolvedCredentials = resolveAidenIdCredentials({
        apiKey: options.apiKey,
        orgId: options.orgId,
        projectId: options.projectId,
        env: process.env,
        requireAll: false,
      });

      if (!options.execute) {
        const result = {
          command: "ai provision-email",
          execute: false,
          apiUrl,
          idempotencyKey,
          requestPath,
          credentialsMissing: resolvedCredentials.missing,
          curlPreview: buildCurlPreview({
            apiUrl,
            idempotencyKey,
            requestPath,
          }),
        };

        if (emitJson) {
          console.log(JSON.stringify(result, null, 2));
          return;
        }

        console.log(pc.bold("AIdenID provision request artifact created (dry-run)"));
        console.log(pc.gray(`Request: ${requestPath}`));
        console.log(pc.gray(`API: ${apiUrl}`));
        console.log(pc.gray(`Idempotency-Key: ${idempotencyKey}`));
        if (resolvedCredentials.missing.length > 0) {
          console.log(
            pc.yellow(`Missing credentials for live execute: ${resolvedCredentials.missing.join(", ")}`)
          );
        }
        console.log(pc.gray("Execute preview:"));
        console.log(result.curlPreview);
        return;
      }

      const requiredCredentials = resolveAidenIdCredentials({
        apiKey: options.apiKey,
        orgId: options.orgId,
        projectId: options.projectId,
        env: process.env,
        requireAll: true,
      });

      const execution = await provisionEmailIdentity({
        apiUrl,
        apiKey: requiredCredentials.apiKey,
        orgId: requiredCredentials.orgId,
        projectId: requiredCredentials.projectId,
        idempotencyKey,
        payload,
      });

      const responsePath = path.join(artifactsDir, `response-${stamp}.json`);
      await writeArtifact(responsePath, {
        receivedAt: new Date().toISOString(),
        apiUrl,
        idempotencyKey,
        response: execution.response,
      });

      const responseIdentity = execution.response || {};
      const registryUpdate = await recordProvisionedIdentity({
        outputRoot,
        response: execution.response || {},
        context: {
          apiUrl,
          orgId: requiredCredentials.orgId,
          projectId: requiredCredentials.projectId,
          idempotencyKey,
        },
      });
      const result = {
        command: "ai provision-email",
        execute: true,
        apiUrl,
        idempotencyKey,
        requestPath,
        responsePath,
        identity: {
          id: String(responseIdentity.id || "").trim() || null,
          emailAddress: String(responseIdentity.emailAddress || "").trim() || null,
          status: String(responseIdentity.status || "").trim() || null,
          expiresAt: responseIdentity.expiresAt || null,
          projectId: responseIdentity.projectId || null,
        },
        response: execution.response,
        identityRegistryPath: registryUpdate.registryPath,
      };

      if (emitJson) {
        console.log(JSON.stringify(result, null, 2));
        return;
      }

      console.log(pc.bold("AIdenID identity provisioned"));
      console.log(pc.gray(`Request: ${requestPath}`));
      console.log(pc.gray(`Response: ${responsePath}`));
      if (result.identity.id || result.identity.emailAddress) {
        console.log(
          pc.green(
            `${result.identity.id || "unknown-id"} | ${result.identity.emailAddress || "unknown-email"} | ${
              result.identity.status || "unknown-status"
            }`
          )
        );
      }
    });

  const identity = ai.command("identity").description("AIdenID identity lifecycle commands");
  const domain = identity.command("domain").description("AIdenID domain governance commands");
  const target = identity.command("target").description("AIdenID target governance commands");

  domain
    .command("create")
    .description("Create a domain registration and proof challenge (dry-run by default)")
    .argument("<domainName>", "Domain hostname")
    .option("--path <path>", "Workspace path for artifact/config resolution", ".")
    .option("--output-dir <path>", "Optional artifact output root override")
    .option("--api-url <url>", "AIdenID API base URL", "https://api.aidenid.com")
    .option("--api-key <key>", "AIdenID API key (or use AIDENID_API_KEY env)")
    .option("--org-id <id>", "AIdenID org id (or use AIDENID_ORG_ID env)")
    .option("--project-id <id>", "AIdenID project id (or use AIDENID_PROJECT_ID env)")
    .option("--trust-class <value>", "Domain trust class", "BYOD")
    .option("--verification-method <value>", "Domain verification method", "DNS_TXT")
    .option("--challenge-value <value>", "Explicit challenge value override")
    .option("--proof-ttl-hours <hours>", "Proof TTL hours", "24")
    .option("--idempotency-key <key>", "Explicit idempotency key override")
    .option("--execute", "Execute live API call")
    .option("--json", "Emit machine-readable output")
    .action(async (domainName, options, command) => {
      const emitJson = shouldEmitJson(options, command);
      const targetPath = path.resolve(process.cwd(), String(options.path || "."));
      const outputRoot = await resolveOutputRoot({
        cwd: targetPath,
        outputDirOverride: options.outputDir,
        env: process.env,
      });
      const apiUrl = normalizeAidenIdApiUrl(options.apiUrl);
      const idempotencyKey = normalizeIdempotencyKey(options.idempotencyKey);
      const proofTtlHours = parsePositiveInteger(options.proofTtlHours, "proofTtlHours", 24);
      const payload = {
        domainName: String(domainName || "").trim(),
        trustClass: String(options.trustClass || "BYOD").trim() || "BYOD",
        verificationMethod:
          String(options.verificationMethod || "DNS_TXT").trim() || "DNS_TXT",
        challengeValue: String(options.challengeValue || "").trim() || null,
        proofTtlHours,
      };
      if (!payload.domainName) {
        throw new Error("domainName is required.");
      }

      const artifactsDir = path.join(outputRoot, "aidenid", "domain-create");
      const stamp = stableTimestampForFile();
      const requestPath = path.join(artifactsDir, `request-${encodeURIComponent(payload.domainName)}-${stamp}.json`);
      await writeArtifact(requestPath, {
        generatedAt: new Date().toISOString(),
        apiUrl,
        idempotencyKey,
        payload,
      });

      const resolvedCredentials = resolveAidenIdCredentials({
        apiKey: options.apiKey,
        orgId: options.orgId,
        projectId: options.projectId,
        env: process.env,
        requireAll: false,
      });

      if (!options.execute) {
        const result = {
          command: "ai identity domain create",
          execute: false,
          apiUrl,
          idempotencyKey,
          requestPath,
          payload,
          credentialsMissing: resolvedCredentials.missing,
          curlPreview: [
            `curl -X POST ${apiUrl}/v1/domains \\`,
            `  -H \"Authorization: Bearer $AIDENID_API_KEY\" \\`,
            `  -H \"X-Org-Id: $AIDENID_ORG_ID\" \\`,
            `  -H \"X-Project-Id: $AIDENID_PROJECT_ID\" \\`,
            `  -H \"Idempotency-Key: ${idempotencyKey}\" \\`,
            `  -H \"Content-Type: application/json\" \\`,
            `  --data @${String(requestPath || "").replace(/\\/g, "/")}`,
          ].join("\n"),
        };
        if (emitJson) {
          console.log(JSON.stringify(result, null, 2));
          return;
        }
        console.log(pc.bold("AIdenID domain create artifact generated (dry-run)"));
        console.log(pc.gray(`Request: ${requestPath}`));
        if (resolvedCredentials.missing.length > 0) {
          console.log(
            pc.yellow(`Missing credentials for live execute: ${resolvedCredentials.missing.join(", ")}`)
          );
        }
        console.log(result.curlPreview);
        return;
      }

      const requiredCredentials = resolveAidenIdCredentials({
        apiKey: options.apiKey,
        orgId: options.orgId,
        projectId: options.projectId,
        env: process.env,
        requireAll: true,
      });
      const execution = await createDomain({
        apiUrl,
        apiKey: requiredCredentials.apiKey,
        orgId: requiredCredentials.orgId,
        projectId: requiredCredentials.projectId,
        idempotencyKey,
        payload,
      });
      const responsePath = path.join(
        artifactsDir,
        `response-${encodeURIComponent(payload.domainName)}-${stamp}.json`
      );
      await writeArtifact(responsePath, {
        receivedAt: new Date().toISOString(),
        apiUrl,
        idempotencyKey,
        response: execution.response,
      });

      const proofResponse = execution.response || {};
      const registryUpdate = await recordDomainProofResponse({
        outputRoot,
        domain: proofResponse.domain || {},
        proof: proofResponse,
        context: {
          source: "domain-create",
          idempotencyKey,
          projectId: requiredCredentials.projectId,
        },
      });
      const result = {
        command: "ai identity domain create",
        execute: true,
        apiUrl,
        idempotencyKey,
        requestPath,
        responsePath,
        domain: proofResponse.domain || null,
        proof: {
          proofId: proofResponse.proofId || null,
          challengeValue: proofResponse.challengeValue || null,
          proofStatus: proofResponse.proofStatus || null,
          proofExpiresAt: proofResponse.proofExpiresAt || null,
        },
        registryPath: registryUpdate.registryPath,
      };
      if (emitJson) {
        console.log(JSON.stringify(result, null, 2));
        return;
      }
      console.log(pc.bold("AIdenID domain created"));
      console.log(pc.gray(`Response: ${responsePath}`));
      console.log(
        `${String(result.domain?.id || "unknown-domain")} | ${String(result.domain?.domainName || payload.domainName)}`
      );
    });

  domain
    .command("verify")
    .description("Verify domain proof challenge (dry-run by default)")
    .argument("<domainId>", "Domain id")
    .option("--path <path>", "Workspace path for artifact/config resolution", ".")
    .option("--output-dir <path>", "Optional artifact output root override")
    .option("--api-url <url>", "AIdenID API base URL", "https://api.aidenid.com")
    .option("--api-key <key>", "AIdenID API key (or use AIDENID_API_KEY env)")
    .option("--org-id <id>", "AIdenID org id (or use AIDENID_ORG_ID env)")
    .option("--project-id <id>", "AIdenID project id (or use AIDENID_PROJECT_ID env)")
    .option("--method <value>", "Verification method", "DNS_TXT")
    .option("--challenge-value <value>", "Challenge value override (fallback: local registry)")
    .option("--proof-value <value>", "Proof value", "txt-verification-record")
    .option("--verification-source <value>", "Verification source", "sentinelayer-cli")
    .option("--expires-hours <hours>", "Proof expiration in hours", "24")
    .option("--idempotency-key <key>", "Explicit idempotency key override")
    .option("--execute", "Execute live API call")
    .option("--json", "Emit machine-readable output")
    .action(async (domainId, options, command) => {
      const emitJson = shouldEmitJson(options, command);
      const targetPath = path.resolve(process.cwd(), String(options.path || "."));
      const outputRoot = await resolveOutputRoot({
        cwd: targetPath,
        outputDirOverride: options.outputDir,
        env: process.env,
      });
      const apiUrl = normalizeAidenIdApiUrl(options.apiUrl);
      const idempotencyKey = normalizeIdempotencyKey(options.idempotencyKey);
      const tracked = await getDomainById({ outputRoot, domainId });
      const challengeValue =
        String(options.challengeValue || "").trim() ||
        String(tracked.domain?.challengeValue || "").trim() ||
        null;
      if (!challengeValue) {
        throw new Error(
          `challengeValue is required. Provide --challenge-value or run domain create first for '${domainId}'.`
        );
      }
      const payload = {
        method: String(options.method || "DNS_TXT").trim() || "DNS_TXT",
        challengeValue,
        proofValue: String(options.proofValue || "txt-verification-record").trim() || null,
        verificationSource:
          String(options.verificationSource || "sentinelayer-cli").trim() || null,
        expiresHours: parsePositiveInteger(options.expiresHours, "expiresHours", 24),
      };

      const artifactsDir = path.join(outputRoot, "aidenid", "domain-verify");
      const stamp = stableTimestampForFile();
      const requestPath = path.join(artifactsDir, `request-${encodeURIComponent(domainId)}-${stamp}.json`);
      await writeArtifact(requestPath, {
        generatedAt: new Date().toISOString(),
        apiUrl,
        idempotencyKey,
        domainId,
        payload,
      });

      const resolvedCredentials = resolveAidenIdCredentials({
        apiKey: options.apiKey,
        orgId: options.orgId,
        projectId: options.projectId || tracked.domain?.projectId,
        env: process.env,
        requireAll: false,
      });
      if (!options.execute) {
        const result = {
          command: "ai identity domain verify",
          execute: false,
          domainId,
          apiUrl,
          idempotencyKey,
          requestPath,
          payload,
          credentialsMissing: resolvedCredentials.missing,
        };
        if (emitJson) {
          console.log(JSON.stringify(result, null, 2));
          return;
        }
        console.log(pc.bold("AIdenID domain verify artifact generated (dry-run)"));
        console.log(pc.gray(`Request: ${requestPath}`));
        if (resolvedCredentials.missing.length > 0) {
          console.log(
            pc.yellow(`Missing credentials for live execute: ${resolvedCredentials.missing.join(", ")}`)
          );
        }
        return;
      }

      const requiredCredentials = resolveAidenIdCredentials({
        apiKey: options.apiKey,
        orgId: options.orgId,
        projectId: options.projectId || tracked.domain?.projectId,
        env: process.env,
        requireAll: true,
      });
      const execution = await verifyDomain({
        apiUrl,
        apiKey: requiredCredentials.apiKey,
        orgId: requiredCredentials.orgId,
        projectId: requiredCredentials.projectId,
        domainId,
        idempotencyKey,
        payload,
      });
      const responsePath = path.join(
        artifactsDir,
        `response-${encodeURIComponent(domainId)}-${stamp}.json`
      );
      await writeArtifact(responsePath, {
        receivedAt: new Date().toISOString(),
        apiUrl,
        idempotencyKey,
        domainId,
        response: execution.response,
      });

      const proofResponse = execution.response || {};
      const registryUpdate = await recordDomainProofResponse({
        outputRoot,
        domain: proofResponse.domain || {},
        proof: proofResponse,
        context: {
          source: "domain-verify",
          idempotencyKey,
          projectId: requiredCredentials.projectId,
        },
      });
      const result = {
        command: "ai identity domain verify",
        execute: true,
        domainId,
        apiUrl,
        idempotencyKey,
        requestPath,
        responsePath,
        domain: proofResponse.domain || null,
        proof: {
          proofId: proofResponse.proofId || null,
          challengeValue: proofResponse.challengeValue || null,
          proofStatus: proofResponse.proofStatus || null,
          proofExpiresAt: proofResponse.proofExpiresAt || null,
        },
        registryPath: registryUpdate.registryPath,
      };
      if (emitJson) {
        console.log(JSON.stringify(result, null, 2));
        return;
      }
      console.log(pc.bold("AIdenID domain verified"));
      console.log(pc.gray(`Response: ${responsePath}`));
      console.log(
        `${String(result.domain?.id || domainId)} | verification=${String(result.domain?.verificationStatus || "UNKNOWN")}`
      );
    });

  domain
    .command("freeze")
    .description("Freeze a domain for containment (dry-run by default)")
    .argument("<domainId>", "Domain id")
    .option("--path <path>", "Workspace path for artifact/config resolution", ".")
    .option("--output-dir <path>", "Optional artifact output root override")
    .option("--api-url <url>", "AIdenID API base URL", "https://api.aidenid.com")
    .option("--api-key <key>", "AIdenID API key (or use AIDENID_API_KEY env)")
    .option("--org-id <id>", "AIdenID org id (or use AIDENID_ORG_ID env)")
    .option("--project-id <id>", "AIdenID project id (or use AIDENID_PROJECT_ID env)")
    .option("--reason <text>", "Freeze reason", "incident containment")
    .option("--pool-isolated", "Isolate the domain pool", true)
    .option("--no-pool-isolated", "Do not isolate the domain pool")
    .option("--idempotency-key <key>", "Explicit idempotency key override")
    .option("--execute", "Execute live API call")
    .option("--json", "Emit machine-readable output")
    .action(async (domainId, options, command) => {
      const emitJson = shouldEmitJson(options, command);
      const targetPath = path.resolve(process.cwd(), String(options.path || "."));
      const outputRoot = await resolveOutputRoot({
        cwd: targetPath,
        outputDirOverride: options.outputDir,
        env: process.env,
      });
      const apiUrl = normalizeAidenIdApiUrl(options.apiUrl);
      const idempotencyKey = normalizeIdempotencyKey(options.idempotencyKey);
      const tracked = await getDomainById({ outputRoot, domainId });
      const payload = {
        reason: String(options.reason || "").trim() || "incident containment",
        poolIsolated: Boolean(options.poolIsolated),
      };

      const artifactsDir = path.join(outputRoot, "aidenid", "domain-freeze");
      const stamp = stableTimestampForFile();
      const requestPath = path.join(artifactsDir, `request-${encodeURIComponent(domainId)}-${stamp}.json`);
      await writeArtifact(requestPath, {
        generatedAt: new Date().toISOString(),
        apiUrl,
        idempotencyKey,
        domainId,
        payload,
      });

      const resolvedCredentials = resolveAidenIdCredentials({
        apiKey: options.apiKey,
        orgId: options.orgId,
        projectId: options.projectId || tracked.domain?.projectId,
        env: process.env,
        requireAll: false,
      });
      if (!options.execute) {
        const result = {
          command: "ai identity domain freeze",
          execute: false,
          domainId,
          apiUrl,
          idempotencyKey,
          requestPath,
          payload,
          credentialsMissing: resolvedCredentials.missing,
        };
        if (emitJson) {
          console.log(JSON.stringify(result, null, 2));
          return;
        }
        console.log(pc.bold("AIdenID domain freeze artifact generated (dry-run)"));
        console.log(pc.gray(`Request: ${requestPath}`));
        if (resolvedCredentials.missing.length > 0) {
          console.log(
            pc.yellow(`Missing credentials for live execute: ${resolvedCredentials.missing.join(", ")}`)
          );
        }
        return;
      }

      const requiredCredentials = resolveAidenIdCredentials({
        apiKey: options.apiKey,
        orgId: options.orgId,
        projectId: options.projectId || tracked.domain?.projectId,
        env: process.env,
        requireAll: true,
      });
      const execution = await freezeDomain({
        apiUrl,
        apiKey: requiredCredentials.apiKey,
        orgId: requiredCredentials.orgId,
        projectId: requiredCredentials.projectId,
        domainId,
        idempotencyKey,
        payload,
      });
      const responsePath = path.join(
        artifactsDir,
        `response-${encodeURIComponent(domainId)}-${stamp}.json`
      );
      await writeArtifact(responsePath, {
        receivedAt: new Date().toISOString(),
        apiUrl,
        idempotencyKey,
        domainId,
        response: execution.response,
      });

      const registryUpdate = await recordDomainProofResponse({
        outputRoot,
        domain: execution.response || {},
        proof: {},
        context: {
          source: "domain-freeze",
          idempotencyKey,
          projectId: requiredCredentials.projectId,
        },
      });
      const result = {
        command: "ai identity domain freeze",
        execute: true,
        domainId,
        apiUrl,
        idempotencyKey,
        requestPath,
        responsePath,
        domain: execution.response || null,
        registryPath: registryUpdate.registryPath,
      };
      if (emitJson) {
        console.log(JSON.stringify(result, null, 2));
        return;
      }
      console.log(pc.bold("AIdenID domain frozen"));
      console.log(pc.gray(`Response: ${responsePath}`));
      console.log(
        `${String(result.domain?.id || domainId)} | freeze=${String(result.domain?.freezeStatus || "UNKNOWN")}`
      );
    });

  target
    .command("create")
    .description("Create a managed target and proof challenge (dry-run by default)")
    .argument("<host>", "Target host")
    .option("--path <path>", "Workspace path for artifact/config resolution", ".")
    .option("--output-dir <path>", "Optional artifact output root override")
    .option("--api-url <url>", "AIdenID API base URL", "https://api.aidenid.com")
    .option("--api-key <key>", "AIdenID API key (or use AIDENID_API_KEY env)")
    .option("--org-id <id>", "AIdenID org id (or use AIDENID_ORG_ID env)")
    .option("--project-id <id>", "AIdenID project id (or use AIDENID_PROJECT_ID env)")
    .option("--domain-id <id>", "Optional domain id")
    .option("--allowed-paths <csv>", "Allowed paths", "/")
    .option("--allowed-methods <csv>", "Allowed methods", "GET")
    .option("--allowed-scenarios <csv>", "Allowed scenarios", "form_boundary_fuzz")
    .option("--max-rps <count>", "Maximum requests per second", "5")
    .option("--max-concurrency <count>", "Maximum concurrency", "5")
    .option("--stop-conditions-json <json>", "JSON object for stop conditions", "{}")
    .option("--maintenance-window-json <json>", "JSON object for maintenance window", "{}")
    .option("--contact-json <json>", "JSON object for contact metadata", "{}")
    .option("--idempotency-key <key>", "Explicit idempotency key override")
    .option("--execute", "Execute live API call")
    .option("--json", "Emit machine-readable output")
    .action(async (host, options, command) => {
      const emitJson = shouldEmitJson(options, command);
      const targetPath = path.resolve(process.cwd(), String(options.path || "."));
      const outputRoot = await resolveOutputRoot({
        cwd: targetPath,
        outputDirOverride: options.outputDir,
        env: process.env,
      });
      const apiUrl = normalizeAidenIdApiUrl(options.apiUrl);
      const idempotencyKey = normalizeIdempotencyKey(options.idempotencyKey);
      const payload = {
        host: String(host || "").trim(),
        domainId: String(options.domainId || "").trim() || null,
        maintenanceWindow: parseJsonObject(options.maintenanceWindowJson, "maintenanceWindowJson"),
        contact: parseJsonObject(options.contactJson, "contactJson"),
        policy: {
          allowedPaths: parseCsvTokens(options.allowedPaths, ["/"]),
          allowedMethods: parseCsvTokens(options.allowedMethods, ["GET"]),
          allowedScenarios: parseCsvTokens(options.allowedScenarios, ["form_boundary_fuzz"]),
          maxRps: parsePositiveInteger(options.maxRps, "maxRps", 5),
          maxConcurrency: parsePositiveInteger(options.maxConcurrency, "maxConcurrency", 5),
          stopConditions: parseJsonObject(options.stopConditionsJson, "stopConditionsJson"),
        },
      };
      if (!payload.host) {
        throw new Error("host is required.");
      }

      const artifactsDir = path.join(outputRoot, "aidenid", "target-create");
      const stamp = stableTimestampForFile();
      const requestPath = path.join(artifactsDir, `request-${encodeURIComponent(payload.host)}-${stamp}.json`);
      await writeArtifact(requestPath, {
        generatedAt: new Date().toISOString(),
        apiUrl,
        idempotencyKey,
        payload,
      });

      const resolvedCredentials = resolveAidenIdCredentials({
        apiKey: options.apiKey,
        orgId: options.orgId,
        projectId: options.projectId,
        env: process.env,
        requireAll: false,
      });
      if (!options.execute) {
        const result = {
          command: "ai identity target create",
          execute: false,
          apiUrl,
          idempotencyKey,
          requestPath,
          payload,
          credentialsMissing: resolvedCredentials.missing,
        };
        if (emitJson) {
          console.log(JSON.stringify(result, null, 2));
          return;
        }
        console.log(pc.bold("AIdenID target create artifact generated (dry-run)"));
        console.log(pc.gray(`Request: ${requestPath}`));
        if (resolvedCredentials.missing.length > 0) {
          console.log(
            pc.yellow(`Missing credentials for live execute: ${resolvedCredentials.missing.join(", ")}`)
          );
        }
        return;
      }

      const requiredCredentials = resolveAidenIdCredentials({
        apiKey: options.apiKey,
        orgId: options.orgId,
        projectId: options.projectId,
        env: process.env,
        requireAll: true,
      });
      const execution = await createTarget({
        apiUrl,
        apiKey: requiredCredentials.apiKey,
        orgId: requiredCredentials.orgId,
        projectId: requiredCredentials.projectId,
        idempotencyKey,
        payload,
      });
      const responsePath = path.join(
        artifactsDir,
        `response-${encodeURIComponent(payload.host)}-${stamp}.json`
      );
      await writeArtifact(responsePath, {
        receivedAt: new Date().toISOString(),
        apiUrl,
        idempotencyKey,
        response: execution.response,
      });

      const proofResponse = execution.response || {};
      const registryUpdate = await recordTargetProofResponse({
        outputRoot,
        target: proofResponse.target || {},
        proof: proofResponse,
        context: {
          source: "target-create",
          idempotencyKey,
          projectId: requiredCredentials.projectId,
          domainId: payload.domainId,
        },
      });
      const result = {
        command: "ai identity target create",
        execute: true,
        apiUrl,
        idempotencyKey,
        requestPath,
        responsePath,
        target: proofResponse.target || null,
        proof: {
          proofId: proofResponse.proofId || null,
          challengeValue: proofResponse.challengeValue || null,
          proofStatus: proofResponse.proofStatus || null,
          proofExpiresAt: proofResponse.proofExpiresAt || null,
        },
        registryPath: registryUpdate.registryPath,
      };
      if (emitJson) {
        console.log(JSON.stringify(result, null, 2));
        return;
      }
      console.log(pc.bold("AIdenID target created"));
      console.log(pc.gray(`Response: ${responsePath}`));
      console.log(`${String(result.target?.id || "unknown-target")} | ${String(result.target?.host || payload.host)}`);
    });

  target
    .command("verify")
    .description("Verify target proof challenge (dry-run by default)")
    .argument("<targetId>", "Target id")
    .option("--path <path>", "Workspace path for artifact/config resolution", ".")
    .option("--output-dir <path>", "Optional artifact output root override")
    .option("--api-url <url>", "AIdenID API base URL", "https://api.aidenid.com")
    .option("--api-key <key>", "AIdenID API key (or use AIDENID_API_KEY env)")
    .option("--org-id <id>", "AIdenID org id (or use AIDENID_ORG_ID env)")
    .option("--project-id <id>", "AIdenID project id (or use AIDENID_PROJECT_ID env)")
    .option("--method <value>", "Verification method", "DNS_TXT")
    .option("--challenge-value <value>", "Challenge value override (fallback: local registry)")
    .option("--proof-value <value>", "Proof value", "target-txt-proof")
    .option("--verification-source <value>", "Verification source", "sentinelayer-cli")
    .option("--expires-hours <hours>", "Proof expiration in hours", "24")
    .option("--idempotency-key <key>", "Explicit idempotency key override")
    .option("--execute", "Execute live API call")
    .option("--json", "Emit machine-readable output")
    .action(async (targetId, options, command) => {
      const emitJson = shouldEmitJson(options, command);
      const targetPath = path.resolve(process.cwd(), String(options.path || "."));
      const outputRoot = await resolveOutputRoot({
        cwd: targetPath,
        outputDirOverride: options.outputDir,
        env: process.env,
      });
      const apiUrl = normalizeAidenIdApiUrl(options.apiUrl);
      const idempotencyKey = normalizeIdempotencyKey(options.idempotencyKey);
      const tracked = await getTrackedTargetById({ outputRoot, targetId });
      const challengeValue =
        String(options.challengeValue || "").trim() ||
        String(tracked.target?.challengeValue || "").trim() ||
        null;
      if (!challengeValue) {
        throw new Error(
          `challengeValue is required. Provide --challenge-value or run target create first for '${targetId}'.`
        );
      }
      const payload = {
        method: String(options.method || "DNS_TXT").trim() || "DNS_TXT",
        challengeValue,
        proofValue: String(options.proofValue || "target-txt-proof").trim() || null,
        verificationSource:
          String(options.verificationSource || "sentinelayer-cli").trim() || null,
        expiresHours: parsePositiveInteger(options.expiresHours, "expiresHours", 24),
      };

      const artifactsDir = path.join(outputRoot, "aidenid", "target-verify");
      const stamp = stableTimestampForFile();
      const requestPath = path.join(artifactsDir, `request-${encodeURIComponent(targetId)}-${stamp}.json`);
      await writeArtifact(requestPath, {
        generatedAt: new Date().toISOString(),
        apiUrl,
        idempotencyKey,
        targetId,
        payload,
      });

      const resolvedCredentials = resolveAidenIdCredentials({
        apiKey: options.apiKey,
        orgId: options.orgId,
        projectId: options.projectId || tracked.target?.projectId,
        env: process.env,
        requireAll: false,
      });
      if (!options.execute) {
        const result = {
          command: "ai identity target verify",
          execute: false,
          targetId,
          apiUrl,
          idempotencyKey,
          requestPath,
          payload,
          credentialsMissing: resolvedCredentials.missing,
        };
        if (emitJson) {
          console.log(JSON.stringify(result, null, 2));
          return;
        }
        console.log(pc.bold("AIdenID target verify artifact generated (dry-run)"));
        console.log(pc.gray(`Request: ${requestPath}`));
        if (resolvedCredentials.missing.length > 0) {
          console.log(
            pc.yellow(`Missing credentials for live execute: ${resolvedCredentials.missing.join(", ")}`)
          );
        }
        return;
      }

      const requiredCredentials = resolveAidenIdCredentials({
        apiKey: options.apiKey,
        orgId: options.orgId,
        projectId: options.projectId || tracked.target?.projectId,
        env: process.env,
        requireAll: true,
      });
      const execution = await verifyTarget({
        apiUrl,
        apiKey: requiredCredentials.apiKey,
        orgId: requiredCredentials.orgId,
        projectId: requiredCredentials.projectId,
        targetId,
        idempotencyKey,
        payload,
      });
      const responsePath = path.join(
        artifactsDir,
        `response-${encodeURIComponent(targetId)}-${stamp}.json`
      );
      await writeArtifact(responsePath, {
        receivedAt: new Date().toISOString(),
        apiUrl,
        idempotencyKey,
        targetId,
        response: execution.response,
      });

      const proofResponse = execution.response || {};
      const registryUpdate = await recordTargetProofResponse({
        outputRoot,
        target: proofResponse.target || {},
        proof: proofResponse,
        context: {
          source: "target-verify",
          idempotencyKey,
          projectId: requiredCredentials.projectId,
        },
      });
      const result = {
        command: "ai identity target verify",
        execute: true,
        targetId,
        apiUrl,
        idempotencyKey,
        requestPath,
        responsePath,
        target: proofResponse.target || null,
        proof: {
          proofId: proofResponse.proofId || null,
          challengeValue: proofResponse.challengeValue || null,
          proofStatus: proofResponse.proofStatus || null,
          proofExpiresAt: proofResponse.proofExpiresAt || null,
        },
        registryPath: registryUpdate.registryPath,
      };
      if (emitJson) {
        console.log(JSON.stringify(result, null, 2));
        return;
      }
      console.log(pc.bold("AIdenID target verified"));
      console.log(pc.gray(`Response: ${responsePath}`));
      console.log(
        `${String(result.target?.id || targetId)} | verification=${String(result.target?.verificationStatus || "UNKNOWN")}`
      );
    });

  target
    .command("show")
    .description("Show managed target details")
    .argument("<targetId>", "Target id")
    .option("--path <path>", "Workspace path for artifact/config resolution", ".")
    .option("--output-dir <path>", "Optional artifact output root override")
    .option("--api-url <url>", "AIdenID API base URL", "https://api.aidenid.com")
    .option("--api-key <key>", "AIdenID API key (or use AIDENID_API_KEY env)")
    .option("--org-id <id>", "AIdenID org id (or use AIDENID_ORG_ID env)")
    .option("--project-id <id>", "AIdenID project id (or use AIDENID_PROJECT_ID env)")
    .option("--json", "Emit machine-readable output")
    .action(async (targetId, options, command) => {
      const emitJson = shouldEmitJson(options, command);
      const targetPath = path.resolve(process.cwd(), String(options.path || "."));
      const outputRoot = await resolveOutputRoot({
        cwd: targetPath,
        outputDirOverride: options.outputDir,
        env: process.env,
      });
      const apiUrl = normalizeAidenIdApiUrl(options.apiUrl);
      const tracked = await getTrackedTargetById({ outputRoot, targetId });
      const credentials = resolveAidenIdCredentials({
        apiKey: options.apiKey,
        orgId: options.orgId,
        projectId: options.projectId || tracked.target?.projectId,
        env: process.env,
        requireAll: true,
      });

      const execution = await getTarget({
        apiUrl,
        apiKey: credentials.apiKey,
        orgId: credentials.orgId,
        projectId: credentials.projectId,
        targetId,
      });
      const stamp = stableTimestampForFile();
      const artifactsDir = path.join(outputRoot, "aidenid", "target-show");
      const outputPath = path.join(artifactsDir, `target-${encodeURIComponent(targetId)}-${stamp}.json`);
      await writeArtifact(outputPath, {
        generatedAt: new Date().toISOString(),
        targetId,
        response: execution.response,
      });

      const registryUpdate = await recordTargetProofResponse({
        outputRoot,
        target: execution.response || {},
        proof: {},
        context: {
          source: "target-show",
          projectId: credentials.projectId,
        },
      });
      const payload = {
        command: "ai identity target show",
        targetId,
        outputPath,
        target: execution.response,
        registryPath: registryUpdate.registryPath,
      };
      if (emitJson) {
        console.log(JSON.stringify(payload, null, 2));
        return;
      }

      console.log(pc.bold("AIdenID target"));
      console.log(pc.gray(`Artifact: ${outputPath}`));
      console.log(
        `${String(execution.response?.id || targetId)} | host=${String(execution.response?.host || "unknown")}`
      );
      console.log(
        `status=${String(execution.response?.status || "UNKNOWN")} verification=${String(
          execution.response?.verificationStatus || "UNKNOWN"
        )}`
      );
    });

  identity
    .command("list")
    .description("List locally tracked AIdenID identities")
    .option("--path <path>", "Workspace path for artifact/config resolution", ".")
    .option("--output-dir <path>", "Optional artifact output root override")
    .option("--json", "Emit machine-readable output")
    .action(async (options, command) => {
      const emitJson = shouldEmitJson(options, command);
      const targetPath = path.resolve(process.cwd(), String(options.path || "."));
      const outputRoot = await resolveOutputRoot({
        cwd: targetPath,
        outputDirOverride: options.outputDir,
        env: process.env,
      });
      const { registryPath, identities } = await listIdentities({ outputRoot });

      const payload = {
        command: "ai identity list",
        registryPath,
        count: identities.length,
        identities,
      };

      if (emitJson) {
        console.log(JSON.stringify(payload, null, 2));
        return;
      }

      console.log(pc.bold("AIdenID identity registry"));
      console.log(pc.gray(`Registry: ${registryPath}`));
      if (identities.length === 0) {
        console.log(pc.gray("No tracked identities."));
        return;
      }
      for (const item of identities) {
        console.log(
          `- ${item.identityId} | ${item.emailAddress || "unknown-email"} | ${item.status} | ${
            item.projectId || "no-project"
          }`
        );
      }
    });

  identity
    .command("show")
    .description("Show a tracked identity record")
    .argument("<identityId>", "Identity id")
    .option("--path <path>", "Workspace path for artifact/config resolution", ".")
    .option("--output-dir <path>", "Optional artifact output root override")
    .option("--json", "Emit machine-readable output")
    .action(async (identityId, options, command) => {
      const emitJson = shouldEmitJson(options, command);
      const targetPath = path.resolve(process.cwd(), String(options.path || "."));
      const outputRoot = await resolveOutputRoot({
        cwd: targetPath,
        outputDirOverride: options.outputDir,
        env: process.env,
      });
      const { registryPath, identity: identityRecord } = await getIdentityById({
        outputRoot,
        identityId,
      });
      if (!identityRecord) {
        throw new Error(`Identity '${identityId}' is not present in local registry.`);
      }

      const payload = {
        command: "ai identity show",
        registryPath,
        identity: identityRecord,
      };
      if (emitJson) {
        console.log(JSON.stringify(payload, null, 2));
        return;
      }

      console.log(pc.bold("AIdenID identity"));
      console.log(pc.gray(`Registry: ${registryPath}`));
      console.log(`${identityRecord.identityId} | ${identityRecord.emailAddress || "unknown-email"}`);
      console.log(`status=${identityRecord.status} project=${identityRecord.projectId || "n/a"}`);
    });

  identity
    .command("revoke")
    .description("Revoke a tracked identity (dry-run by default)")
    .argument("<identityId>", "Identity id")
    .option("--path <path>", "Workspace path for artifact/config resolution", ".")
    .option("--output-dir <path>", "Optional artifact output root override")
    .option("--api-url <url>", "AIdenID API base URL", "https://api.aidenid.com")
    .option("--api-key <key>", "AIdenID API key (or use AIDENID_API_KEY env)")
    .option("--org-id <id>", "AIdenID org id (or use AIDENID_ORG_ID env)")
    .option("--project-id <id>", "AIdenID project id (or use AIDENID_PROJECT_ID env)")
    .option("--idempotency-key <key>", "Explicit idempotency key override")
    .option("--execute", "Execute live revoke API call")
    .option("--json", "Emit machine-readable output")
    .action(async (identityId, options, command) => {
      const emitJson = shouldEmitJson(options, command);
      const targetPath = path.resolve(process.cwd(), String(options.path || "."));
      const outputRoot = await resolveOutputRoot({
        cwd: targetPath,
        outputDirOverride: options.outputDir,
        env: process.env,
      });
      const apiUrl = normalizeAidenIdApiUrl(options.apiUrl);
      const idempotencyKey = normalizeIdempotencyKey(options.idempotencyKey);
      const stamp = stableTimestampForFile();
      const artifactsDir = path.join(outputRoot, "aidenid", "revoke-identity");
      const requestPath = path.join(artifactsDir, `request-${stamp}.json`);
      await writeArtifact(requestPath, {
        generatedAt: new Date().toISOString(),
        apiUrl,
        idempotencyKey,
        identityId,
      });

      const { registryPath, identity: trackedIdentity } = await getIdentityById({
        outputRoot,
        identityId,
      });
      if (!trackedIdentity) {
        throw new Error(`Identity '${identityId}' is not present in local registry.`);
      }

      const resolvedCredentials = resolveAidenIdCredentials({
        apiKey: options.apiKey,
        orgId: options.orgId,
        projectId: options.projectId || trackedIdentity.projectId,
        env: process.env,
        requireAll: false,
      });

      if (!options.execute) {
        const payload = {
          command: "ai identity revoke",
          execute: false,
          identityId,
          registryPath,
          requestPath,
          credentialsMissing: resolvedCredentials.missing,
          trackedIdentity,
          curlPreview: [
            `curl -X POST ${apiUrl}/v1/identities/${encodeURIComponent(identityId)}/revoke \\`,
            `  -H \"Authorization: Bearer $AIDENID_API_KEY\" \\`,
            `  -H \"X-Org-Id: $AIDENID_ORG_ID\" \\`,
            `  -H \"X-Project-Id: $AIDENID_PROJECT_ID\" \\`,
            `  -H \"Idempotency-Key: ${idempotencyKey}\"`,
          ].join("\n"),
        };
        if (emitJson) {
          console.log(JSON.stringify(payload, null, 2));
          return;
        }
        console.log(pc.bold("AIdenID revoke request artifact created (dry-run)"));
        console.log(pc.gray(`Registry: ${registryPath}`));
        console.log(pc.gray(`Request: ${requestPath}`));
        if (resolvedCredentials.missing.length > 0) {
          console.log(
            pc.yellow(`Missing credentials for live execute: ${resolvedCredentials.missing.join(", ")}`)
          );
        }
        console.log(payload.curlPreview);
        return;
      }

      const requiredCredentials = resolveAidenIdCredentials({
        apiKey: options.apiKey,
        orgId: options.orgId || trackedIdentity.orgId,
        projectId: options.projectId || trackedIdentity.projectId,
        env: process.env,
        requireAll: true,
      });

      const execution = await revokeIdentity({
        apiUrl,
        apiKey: requiredCredentials.apiKey,
        orgId: requiredCredentials.orgId,
        projectId: requiredCredentials.projectId,
        idempotencyKey,
        identityId,
      });
      const responsePath = path.join(artifactsDir, `response-${stamp}.json`);
      await writeArtifact(responsePath, {
        receivedAt: new Date().toISOString(),
        apiUrl,
        idempotencyKey,
        response: execution.response,
      });

      const revokedAt = String(execution.response?.revokedAt || "").trim() || new Date().toISOString();
      const updated = await updateIdentityStatus({
        outputRoot,
        identityId,
        status: String(execution.response?.status || "REVOKED"),
        revokedAt,
        metadataPatch: {
          revokeRequestIdempotencyKey: idempotencyKey,
        },
      });

      const payload = {
        command: "ai identity revoke",
        execute: true,
        identityId,
        registryPath: updated.registryPath,
        requestPath,
        responsePath,
        identity: updated.identity,
        response: execution.response,
      };
      if (emitJson) {
        console.log(JSON.stringify(payload, null, 2));
        return;
      }

      console.log(pc.bold("AIdenID identity revoked"));
      console.log(pc.gray(`Registry: ${updated.registryPath}`));
      console.log(pc.gray(`Response: ${responsePath}`));
      console.log(`${updated.identity.identityId} | ${updated.identity.status}`);
    });

  identity
    .command("create-child")
    .description("Create a child identity under a parent (dry-run by default)")
    .argument("<parentIdentityId>", "Parent identity id")
    .option("--path <path>", "Workspace path for artifact/config resolution", ".")
    .option("--output-dir <path>", "Optional artifact output root override")
    .option("--api-url <url>", "AIdenID API base URL", "https://api.aidenid.com")
    .option("--api-key <key>", "AIdenID API key (or use AIDENID_API_KEY env)")
    .option("--org-id <id>", "AIdenID org id (or use AIDENID_ORG_ID env)")
    .option("--project-id <id>", "AIdenID project id (or use AIDENID_PROJECT_ID env)")
    .option("--alias-template <value>", "Optional alias template")
    .option("--ttl-hours <hours>", "Identity TTL in hours", "24")
    .option("--tags <csv>", "Comma-separated tags")
    .option("--domain-pool-id <id>", "Optional domain pool id")
    .option("--receive-mode <mode>", "Identity receive mode", "EDGE_ACCEPT")
    .option("--extraction-types <csv>", "Comma-separated extraction types", "otp,link")
    .option("--allow-webhooks", "Allow webhook delivery", true)
    .option("--no-allow-webhooks", "Disable webhook delivery")
    .option("--event-budget <count>", "Optional inbound event budget envelope")
    .option("--idempotency-key <key>", "Explicit idempotency key override")
    .option("--execute", "Execute live API call")
    .option("--json", "Emit machine-readable output")
    .action(async (parentIdentityId, options, command) => {
      const emitJson = shouldEmitJson(options, command);
      const targetPath = path.resolve(process.cwd(), String(options.path || "."));
      const outputRoot = await resolveOutputRoot({
        cwd: targetPath,
        outputDirOverride: options.outputDir,
        env: process.env,
      });
      const apiUrl = normalizeAidenIdApiUrl(options.apiUrl);
      const idempotencyKey = normalizeIdempotencyKey(options.idempotencyKey);
      const ttlHours = parsePositiveInteger(options.ttlHours, "ttlHours", 24);
      const eventBudget =
        options.eventBudget === undefined || options.eventBudget === null || String(options.eventBudget).trim() === ""
          ? null
          : parsePositiveInteger(options.eventBudget, "eventBudget", 1);

      const payload = buildChildIdentityPayload({
        aliasTemplate: options.aliasTemplate,
        ttlHours,
        tags: options.tags,
        domainPoolId: options.domainPoolId,
        receiveMode: options.receiveMode,
        allowWebhooks: Boolean(options.allowWebhooks),
        extractionTypes: options.extractionTypes,
        eventBudget,
      });

      const { identity: parentIdentity } = await getIdentityById({
        outputRoot,
        identityId: parentIdentityId,
      });

      const artifactsDir = path.join(outputRoot, "aidenid", "create-child");
      const stamp = stableTimestampForFile();
      const requestPath = path.join(
        artifactsDir,
        `request-${encodeURIComponent(parentIdentityId)}-${stamp}.json`
      );
      await writeArtifact(requestPath, {
        generatedAt: new Date().toISOString(),
        apiUrl,
        idempotencyKey,
        parentIdentityId,
        payload,
      });

      const resolvedCredentials = resolveAidenIdCredentials({
        apiKey: options.apiKey,
        orgId: options.orgId || parentIdentity?.orgId,
        projectId: options.projectId || parentIdentity?.projectId,
        env: process.env,
        requireAll: false,
      });

      if (!options.execute) {
        const result = {
          command: "ai identity create-child",
          execute: false,
          apiUrl,
          idempotencyKey,
          parentIdentityId,
          requestPath,
          payload,
          credentialsMissing: resolvedCredentials.missing,
          parentIdentityTracked: Boolean(parentIdentity),
          curlPreview: [
            `curl -X POST ${apiUrl}/v1/identities/${encodeURIComponent(parentIdentityId)}/children \\`,
            `  -H \"Authorization: Bearer $AIDENID_API_KEY\" \\`,
            `  -H \"X-Org-Id: $AIDENID_ORG_ID\" \\`,
            `  -H \"X-Project-Id: $AIDENID_PROJECT_ID\" \\`,
            `  -H \"Idempotency-Key: ${idempotencyKey}\" \\`,
            `  -H \"Content-Type: application/json\" \\`,
            `  --data @${String(requestPath || "").replace(/\\/g, "/")}`,
          ].join("\n"),
        };
        if (emitJson) {
          console.log(JSON.stringify(result, null, 2));
          return;
        }

        console.log(pc.bold("AIdenID child identity request artifact created (dry-run)"));
        console.log(pc.gray(`Request: ${requestPath}`));
        if (!parentIdentity) {
          console.log(pc.yellow(`Parent identity '${parentIdentityId}' is not present in local registry.`));
        }
        if (resolvedCredentials.missing.length > 0) {
          console.log(
            pc.yellow(`Missing credentials for live execute: ${resolvedCredentials.missing.join(", ")}`)
          );
        }
        console.log(result.curlPreview);
        return;
      }

      const requiredCredentials = resolveAidenIdCredentials({
        apiKey: options.apiKey,
        orgId: options.orgId || parentIdentity?.orgId,
        projectId: options.projectId || parentIdentity?.projectId,
        env: process.env,
        requireAll: true,
      });

      const execution = await createChildIdentity({
        apiUrl,
        apiKey: requiredCredentials.apiKey,
        orgId: requiredCredentials.orgId,
        projectId: requiredCredentials.projectId,
        parentIdentityId,
        idempotencyKey,
        payload,
      });

      const responsePath = path.join(
        artifactsDir,
        `response-${encodeURIComponent(parentIdentityId)}-${stamp}.json`
      );
      await writeArtifact(responsePath, {
        receivedAt: new Date().toISOString(),
        apiUrl,
        idempotencyKey,
        parentIdentityId,
        response: execution.response,
      });

      const registryUpdate = await recordProvisionedIdentity({
        outputRoot,
        response: execution.response || {},
        context: {
          source: "create-child",
          apiUrl,
          orgId: requiredCredentials.orgId,
          projectId: requiredCredentials.projectId,
          idempotencyKey,
          parentIdentityId,
          eventBudget,
        },
      });
      const childIdentity = execution.response || {};
      const result = {
        command: "ai identity create-child",
        execute: true,
        parentIdentityId,
        apiUrl,
        idempotencyKey,
        requestPath,
        responsePath,
        childIdentity: {
          id: String(childIdentity.id || "").trim() || null,
          parentIdentityId: String(childIdentity.parentIdentityId || parentIdentityId).trim() || null,
          emailAddress: String(childIdentity.emailAddress || "").trim() || null,
          status: String(childIdentity.status || "").trim() || null,
          expiresAt: childIdentity.expiresAt || null,
          projectId: childIdentity.projectId || null,
        },
        response: execution.response,
        identityRegistryPath: registryUpdate.registryPath,
      };
      if (emitJson) {
        console.log(JSON.stringify(result, null, 2));
        return;
      }

      console.log(pc.bold("AIdenID child identity created"));
      console.log(pc.gray(`Request: ${requestPath}`));
      console.log(pc.gray(`Response: ${responsePath}`));
      console.log(
        `${result.childIdentity.id || "unknown-id"} | parent=${result.childIdentity.parentIdentityId || "n/a"}`
      );
    });

  identity
    .command("lineage")
    .description("Show parent/child lineage for an identity")
    .argument("<identityId>", "Identity id")
    .option("--path <path>", "Workspace path for artifact/config resolution", ".")
    .option("--output-dir <path>", "Optional artifact output root override")
    .option("--api-url <url>", "AIdenID API base URL", "https://api.aidenid.com")
    .option("--api-key <key>", "AIdenID API key (or use AIDENID_API_KEY env)")
    .option("--org-id <id>", "AIdenID org id (or use AIDENID_ORG_ID env)")
    .option("--project-id <id>", "AIdenID project id (or use AIDENID_PROJECT_ID env)")
    .option("--json", "Emit machine-readable output")
    .action(async (identityId, options, command) => {
      const emitJson = shouldEmitJson(options, command);
      const targetPath = path.resolve(process.cwd(), String(options.path || "."));
      const outputRoot = await resolveOutputRoot({
        cwd: targetPath,
        outputDirOverride: options.outputDir,
        env: process.env,
      });
      const apiUrl = normalizeAidenIdApiUrl(options.apiUrl);
      const { registryPath, identity: trackedIdentity } = await getIdentityById({
        outputRoot,
        identityId,
      });
      const credentials = resolveAidenIdCredentials({
        apiKey: options.apiKey,
        orgId: options.orgId || trackedIdentity?.orgId,
        projectId: options.projectId || trackedIdentity?.projectId,
        env: process.env,
        requireAll: true,
      });

      const execution = await getIdentityLineage({
        apiUrl,
        apiKey: credentials.apiKey,
        orgId: credentials.orgId,
        projectId: credentials.projectId,
        identityId,
      });
      const stamp = stableTimestampForFile();
      const artifactsDir = path.join(outputRoot, "aidenid", "lineage");
      const outputPath = path.join(
        artifactsDir,
        `lineage-${encodeURIComponent(identityId)}-${stamp}.json`
      );
      await writeArtifact(outputPath, {
        generatedAt: new Date().toISOString(),
        identityId,
        response: execution.response,
      });

      const rows = renderLineageRows({
        nodes: execution.nodes,
      });
      const payload = {
        command: "ai identity lineage",
        identityId,
        registryPath,
        outputPath,
        rootIdentityId: execution.rootIdentityId,
        nodeCount: execution.nodes.length,
        edgeCount: execution.edges.length,
        nodes: execution.nodes,
        edges: execution.edges,
        tree: rows.join("\n"),
      };
      if (emitJson) {
        console.log(JSON.stringify(payload, null, 2));
        return;
      }

      console.log(pc.bold("AIdenID identity lineage"));
      console.log(pc.gray(`Registry: ${registryPath}`));
      console.log(pc.gray(`Artifact: ${outputPath}`));
      console.log(`root=${execution.rootIdentityId} nodes=${execution.nodes.length} edges=${execution.edges.length}`);
      for (const row of rows) {
        console.log(row);
      }
    });

  identity
    .command("revoke-children")
    .description("Revoke all descendants under a parent identity (dry-run by default)")
    .argument("<identityId>", "Parent identity id")
    .option("--path <path>", "Workspace path for artifact/config resolution", ".")
    .option("--output-dir <path>", "Optional artifact output root override")
    .option("--api-url <url>", "AIdenID API base URL", "https://api.aidenid.com")
    .option("--api-key <key>", "AIdenID API key (or use AIDENID_API_KEY env)")
    .option("--org-id <id>", "AIdenID org id (or use AIDENID_ORG_ID env)")
    .option("--project-id <id>", "AIdenID project id (or use AIDENID_PROJECT_ID env)")
    .option("--idempotency-key <key>", "Explicit idempotency key override")
    .option("--execute", "Execute live revoke API call")
    .option("--json", "Emit machine-readable output")
    .action(async (identityId, options, command) => {
      const emitJson = shouldEmitJson(options, command);
      const targetPath = path.resolve(process.cwd(), String(options.path || "."));
      const outputRoot = await resolveOutputRoot({
        cwd: targetPath,
        outputDirOverride: options.outputDir,
        env: process.env,
      });
      const apiUrl = normalizeAidenIdApiUrl(options.apiUrl);
      const idempotencyKey = normalizeIdempotencyKey(options.idempotencyKey);
      const { registryPath, identity: trackedIdentity } = await getIdentityById({
        outputRoot,
        identityId,
      });
      const stamp = stableTimestampForFile();
      const artifactsDir = path.join(outputRoot, "aidenid", "revoke-children");
      const requestPath = path.join(
        artifactsDir,
        `request-${encodeURIComponent(identityId)}-${stamp}.json`
      );
      await writeArtifact(requestPath, {
        generatedAt: new Date().toISOString(),
        apiUrl,
        idempotencyKey,
        identityId,
      });

      const resolvedCredentials = resolveAidenIdCredentials({
        apiKey: options.apiKey,
        orgId: options.orgId || trackedIdentity?.orgId,
        projectId: options.projectId || trackedIdentity?.projectId,
        env: process.env,
        requireAll: false,
      });

      if (!options.execute) {
        const payload = {
          command: "ai identity revoke-children",
          execute: false,
          identityId,
          registryPath,
          requestPath,
          credentialsMissing: resolvedCredentials.missing,
          parentIdentityTracked: Boolean(trackedIdentity),
          curlPreview: [
            `curl -X POST ${apiUrl}/v1/identities/${encodeURIComponent(identityId)}/revoke-children \\`,
            `  -H \"Authorization: Bearer $AIDENID_API_KEY\" \\`,
            `  -H \"X-Org-Id: $AIDENID_ORG_ID\" \\`,
            `  -H \"X-Project-Id: $AIDENID_PROJECT_ID\" \\`,
            `  -H \"Idempotency-Key: ${idempotencyKey}\"`,
          ].join("\n"),
        };
        if (emitJson) {
          console.log(JSON.stringify(payload, null, 2));
          return;
        }
        console.log(pc.bold("AIdenID revoke-children request artifact created (dry-run)"));
        console.log(pc.gray(`Registry: ${registryPath}`));
        console.log(pc.gray(`Request: ${requestPath}`));
        if (!trackedIdentity) {
          console.log(pc.yellow(`Parent identity '${identityId}' is not present in local registry.`));
        }
        if (resolvedCredentials.missing.length > 0) {
          console.log(
            pc.yellow(`Missing credentials for live execute: ${resolvedCredentials.missing.join(", ")}`)
          );
        }
        console.log(payload.curlPreview);
        return;
      }

      const requiredCredentials = resolveAidenIdCredentials({
        apiKey: options.apiKey,
        orgId: options.orgId || trackedIdentity?.orgId,
        projectId: options.projectId || trackedIdentity?.projectId,
        env: process.env,
        requireAll: true,
      });

      const execution = await revokeIdentityChildren({
        apiUrl,
        apiKey: requiredCredentials.apiKey,
        orgId: requiredCredentials.orgId,
        projectId: requiredCredentials.projectId,
        identityId,
        idempotencyKey,
      });
      const responsePath = path.join(
        artifactsDir,
        `response-${encodeURIComponent(identityId)}-${stamp}.json`
      );
      await writeArtifact(responsePath, {
        receivedAt: new Date().toISOString(),
        apiUrl,
        idempotencyKey,
        identityId,
        response: execution.response,
      });

      const localUpdatedIdentityIds = [];
      for (const revokedIdentityId of execution.revokedIdentityIds) {
        try {
          const updated = await updateIdentityStatus({
            outputRoot,
            identityId: revokedIdentityId,
            status: "SQUASHED",
            revokedAt: new Date().toISOString(),
            metadataPatch: {
              revokeChildrenRequestIdempotencyKey: idempotencyKey,
              parentIdentityId: execution.parentIdentityId,
            },
          });
          if (updated.identity) {
            localUpdatedIdentityIds.push(updated.identity.identityId);
          }
        } catch {
          // Skip identities that are not tracked locally.
        }
      }

      const payload = {
        command: "ai identity revoke-children",
        execute: true,
        identityId,
        parentIdentityId: execution.parentIdentityId,
        registryPath,
        requestPath,
        responsePath,
        revokedCount: execution.revokedCount,
        revokedIdentityIds: execution.revokedIdentityIds,
        localUpdatedIdentityIds,
        response: execution.response,
      };
      if (emitJson) {
        console.log(JSON.stringify(payload, null, 2));
        return;
      }

      console.log(pc.bold("AIdenID child identities revoked"));
      console.log(pc.gray(`Registry: ${registryPath}`));
      console.log(pc.gray(`Response: ${responsePath}`));
      console.log(
        `parent=${execution.parentIdentityId} revoked=${execution.revokedCount} localUpdated=${localUpdatedIdentityIds.length}`
      );
    });

  identity
    .command("events")
    .description("List inbound events for a tracked identity")
    .argument("<identityId>", "Identity id")
    .option("--path <path>", "Workspace path for artifact/config resolution", ".")
    .option("--output-dir <path>", "Optional artifact output root override")
    .option("--api-url <url>", "AIdenID API base URL", "https://api.aidenid.com")
    .option("--api-key <key>", "AIdenID API key (or use AIDENID_API_KEY env)")
    .option("--org-id <id>", "AIdenID org id (or use AIDENID_ORG_ID env)")
    .option("--project-id <id>", "AIdenID project id (or use AIDENID_PROJECT_ID env)")
    .option("--cursor <cursor>", "Pagination cursor")
    .option("--limit <count>", "Max events to fetch per page", "50")
    .option("--json", "Emit machine-readable output")
    .action(async (identityId, options, command) => {
      const emitJson = shouldEmitJson(options, command);
      const targetPath = path.resolve(process.cwd(), String(options.path || "."));
      const outputRoot = await resolveOutputRoot({
        cwd: targetPath,
        outputDirOverride: options.outputDir,
        env: process.env,
      });
      const apiUrl = normalizeAidenIdApiUrl(options.apiUrl);
      const limit = parsePositiveInteger(options.limit, "limit", 50);
      const { registryPath, identity: trackedIdentity } = await getIdentityById({
        outputRoot,
        identityId,
      });
      if (!trackedIdentity) {
        throw new Error(`Identity '${identityId}' is not present in local registry.`);
      }

      const credentials = resolveAidenIdCredentials({
        apiKey: options.apiKey,
        orgId: options.orgId || trackedIdentity.orgId,
        projectId: options.projectId || trackedIdentity.projectId,
        env: process.env,
        requireAll: true,
      });

      const execution = await listIdentityEvents({
        apiUrl,
        apiKey: credentials.apiKey,
        orgId: credentials.orgId,
        projectId: credentials.projectId,
        identityId,
        cursor: options.cursor,
        limit,
      });

      const stamp = stableTimestampForFile();
      const artifactsDir = path.join(outputRoot, "aidenid", "events");
      const outputPath = path.join(
        artifactsDir,
        `events-${encodeURIComponent(identityId)}-${stamp}.json`
      );
      await writeArtifact(outputPath, {
        generatedAt: new Date().toISOString(),
        identityId,
        cursor: String(options.cursor || "").trim() || null,
        limit,
        response: execution.response,
      });

      const payload = {
        command: "ai identity events",
        identityId,
        registryPath,
        outputPath,
        cursor: String(options.cursor || "").trim() || null,
        nextCursor: execution.nextCursor,
        previousCursor: execution.previousCursor,
        count: execution.events.length,
        events: execution.events,
      };

      if (emitJson) {
        console.log(JSON.stringify(payload, null, 2));
        return;
      }

      console.log(pc.bold("AIdenID identity events"));
      console.log(pc.gray(`Registry: ${registryPath}`));
      console.log(pc.gray(`Artifact: ${outputPath}`));
      console.log(pc.gray(`Events: ${execution.events.length}`));
      if (execution.nextCursor) {
        console.log(pc.gray(`nextCursor=${execution.nextCursor}`));
      }
      for (const item of execution.events) {
        const eventId = String(item.eventId || item.id || item.messageId || "event");
        const eventType = String(item.eventType || item.type || item.category || "unknown");
        const eventAt = String(item.receivedAt || item.createdAt || item.timestamp || "unknown-time");
        console.log(`- ${eventId} | ${eventType} | ${eventAt}`);
      }
    });

  identity
    .command("latest")
    .description("Show latest extraction and most recent event for an identity")
    .argument("<identityId>", "Identity id")
    .option("--path <path>", "Workspace path for artifact/config resolution", ".")
    .option("--output-dir <path>", "Optional artifact output root override")
    .option("--api-url <url>", "AIdenID API base URL", "https://api.aidenid.com")
    .option("--api-key <key>", "AIdenID API key (or use AIDENID_API_KEY env)")
    .option("--org-id <id>", "AIdenID org id (or use AIDENID_ORG_ID env)")
    .option("--project-id <id>", "AIdenID project id (or use AIDENID_PROJECT_ID env)")
    .option("--json", "Emit machine-readable output")
    .action(async (identityId, options, command) => {
      const emitJson = shouldEmitJson(options, command);
      const targetPath = path.resolve(process.cwd(), String(options.path || "."));
      const outputRoot = await resolveOutputRoot({
        cwd: targetPath,
        outputDirOverride: options.outputDir,
        env: process.env,
      });
      const apiUrl = normalizeAidenIdApiUrl(options.apiUrl);
      const { registryPath, identity: trackedIdentity } = await getIdentityById({
        outputRoot,
        identityId,
      });
      if (!trackedIdentity) {
        throw new Error(`Identity '${identityId}' is not present in local registry.`);
      }

      const credentials = resolveAidenIdCredentials({
        apiKey: options.apiKey,
        orgId: options.orgId || trackedIdentity.orgId,
        projectId: options.projectId || trackedIdentity.projectId,
        env: process.env,
        requireAll: true,
      });

      const [latestExtraction, latestEventBatch] = await Promise.all([
        getLatestIdentityExtraction({
          apiUrl,
          apiKey: credentials.apiKey,
          orgId: credentials.orgId,
          projectId: credentials.projectId,
          identityId,
        }),
        listIdentityEvents({
          apiUrl,
          apiKey: credentials.apiKey,
          orgId: credentials.orgId,
          projectId: credentials.projectId,
          identityId,
          limit: 1,
        }),
      ]);
      const latestEvent = latestEventBatch.events[0] || null;

      const stamp = stableTimestampForFile();
      const artifactsDir = path.join(outputRoot, "aidenid", "latest");
      const outputPath = path.join(
        artifactsDir,
        `latest-${encodeURIComponent(identityId)}-${stamp}.json`
      );
      await writeArtifact(outputPath, {
        generatedAt: new Date().toISOString(),
        identityId,
        latestEvent,
        extraction: latestExtraction.extraction,
        extractionResponse: latestExtraction.response,
      });

      const payload = {
        command: "ai identity latest",
        identityId,
        registryPath,
        outputPath,
        latestEvent,
        extraction: latestExtraction.extraction,
        extractionAvailable: hasExtractionSignal(latestExtraction.extraction),
      };
      if (emitJson) {
        console.log(JSON.stringify(payload, null, 2));
        return;
      }

      console.log(pc.bold("AIdenID latest identity signal"));
      console.log(pc.gray(`Registry: ${registryPath}`));
      console.log(pc.gray(`Artifact: ${outputPath}`));
      console.log(
        `source=${payload.extraction.source} confidence=${
          Number.isFinite(Number(payload.extraction.confidence))
            ? Number(payload.extraction.confidence).toFixed(3)
            : "n/a"
        }`
      );
      if (payload.extraction.otp) {
        console.log(`otp=${payload.extraction.otp}`);
      }
      if (payload.extraction.primaryActionUrl) {
        console.log(`primaryActionUrl=${payload.extraction.primaryActionUrl}`);
      }
      if (latestEvent) {
        console.log(
          `latestEvent=${String(latestEvent.eventId || latestEvent.id || "event")} type=${String(
            latestEvent.eventType || latestEvent.type || "unknown"
          )}`
        );
      }
    });

  identity
    .command("wait-for-otp")
    .description("Poll latest extraction until OTP/link appears and confidence passes threshold")
    .argument("<identityId>", "Identity id")
    .option("--path <path>", "Workspace path for artifact/config resolution", ".")
    .option("--output-dir <path>", "Optional artifact output root override")
    .option("--api-url <url>", "AIdenID API base URL", "https://api.aidenid.com")
    .option("--api-key <key>", "AIdenID API key (or use AIDENID_API_KEY env)")
    .option("--org-id <id>", "AIdenID org id (or use AIDENID_ORG_ID env)")
    .option("--project-id <id>", "AIdenID project id (or use AIDENID_PROJECT_ID env)")
    .option("--interval-seconds <seconds>", "Polling interval in seconds", "2")
    .option("--timeout <seconds>", "Polling timeout in seconds", "60")
    .option("--min-confidence <value>", "Minimum confidence threshold (0-1)", "0.8")
    .option("--json", "Emit machine-readable output")
    .action(async (identityId, options, command) => {
      const emitJson = shouldEmitJson(options, command);
      const targetPath = path.resolve(process.cwd(), String(options.path || "."));
      const outputRoot = await resolveOutputRoot({
        cwd: targetPath,
        outputDirOverride: options.outputDir,
        env: process.env,
      });
      const apiUrl = normalizeAidenIdApiUrl(options.apiUrl);
      const intervalSeconds = parsePositiveInteger(
        options.intervalSeconds,
        "intervalSeconds",
        2
      );
      const timeoutSeconds = parsePositiveInteger(options.timeout, "timeout", 60);
      const minConfidence = parseConfidenceThreshold(options.minConfidence, 0.8);
      const { registryPath, identity: trackedIdentity } = await getIdentityById({
        outputRoot,
        identityId,
      });
      if (!trackedIdentity) {
        throw new Error(`Identity '${identityId}' is not present in local registry.`);
      }

      const credentials = resolveAidenIdCredentials({
        apiKey: options.apiKey,
        orgId: options.orgId || trackedIdentity.orgId,
        projectId: options.projectId || trackedIdentity.projectId,
        env: process.env,
        requireAll: true,
      });

      const stamp = stableTimestampForFile();
      const artifactsDir = path.join(outputRoot, "aidenid", "wait-for-otp");
      const outputPath = path.join(
        artifactsDir,
        `wait-for-otp-${encodeURIComponent(identityId)}-${stamp}.json`
      );
      const startedAt = Date.now();
      const deadlineAt = startedAt + timeoutSeconds * 1000;
      const attempts = [];
      let lastExtraction = null;
      let success = null;

      while (Date.now() <= deadlineAt) {
        const execution = await getLatestIdentityExtraction({
          apiUrl,
          apiKey: credentials.apiKey,
          orgId: credentials.orgId,
          projectId: credentials.projectId,
          identityId,
        });
        lastExtraction = execution.extraction;

        const hasSignal = hasExtractionSignal(execution.extraction);
        const confidenceSatisfied = meetsConfidenceThreshold(execution.extraction, minConfidence);
        const pollAt = new Date().toISOString();

        attempts.push({
          attempt: attempts.length + 1,
          polledAt: pollAt,
          source: execution.extraction.source,
          confidence: execution.extraction.confidence,
          hasSignal,
          confidenceSatisfied,
          notFound: Boolean(execution.notFound),
        });

        if (hasSignal && confidenceSatisfied) {
          success = {
            foundAt: pollAt,
            extraction: execution.extraction,
            source: execution.extraction.source,
            confidence: execution.extraction.confidence,
          };
          break;
        }

        if (Date.now() >= deadlineAt) {
          break;
        }
        await delay(intervalSeconds * 1000);
      }

      const finishedAtIso = new Date().toISOString();
      const elapsedSeconds = Math.max(0, Math.round((Date.now() - startedAt) / 1000));
      const artifactPayload = {
        generatedAt: finishedAtIso,
        identityId,
        registryPath,
        timeoutSeconds,
        intervalSeconds,
        minConfidence,
        elapsedSeconds,
        attempts,
        result: success
          ? {
              status: "FOUND",
              ...success,
            }
          : {
              status: "TIMEOUT",
              extraction: lastExtraction,
            },
      };
      await writeArtifact(outputPath, artifactPayload);

      if (!success) {
        throw new Error(
          `Timed out waiting for OTP/link for identity '${identityId}' within ${timeoutSeconds}s (artifact: ${outputPath}).`
        );
      }

      const payload = {
        command: "ai identity wait-for-otp",
        identityId,
        registryPath,
        outputPath,
        timeoutSeconds,
        intervalSeconds,
        minConfidence,
        attempts: attempts.length,
        extraction: success.extraction,
        source: success.source,
        confidence: success.confidence,
        foundAt: success.foundAt,
      };
      if (emitJson) {
        console.log(JSON.stringify(payload, null, 2));
        return;
      }

      console.log(pc.bold("AIdenID OTP/link extracted"));
      console.log(pc.gray(`Registry: ${registryPath}`));
      console.log(pc.gray(`Artifact: ${outputPath}`));
      console.log(`source=${success.source} confidence=${String(success.confidence ?? "n/a")}`);
      if (success.extraction.otp) {
        console.log(`otp=${success.extraction.otp}`);
      }
      if (success.extraction.primaryActionUrl) {
        console.log(`primaryActionUrl=${success.extraction.primaryActionUrl}`);
      }
    });
}
