import { randomUUID } from "node:crypto";
import fsp from "node:fs/promises";
import path from "node:path";
import process from "node:process";

import pc from "picocolors";

import {
  buildProvisionEmailPayload,
  getLatestIdentityExtraction,
  listIdentityEvents,
  normalizeAidenIdApiUrl,
  provisionEmailIdentity,
  revokeIdentity,
  resolveAidenIdCredentials,
} from "../ai/aidenid.js";
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
