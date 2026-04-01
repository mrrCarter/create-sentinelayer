import { randomUUID } from "node:crypto";
import fsp from "node:fs/promises";
import path from "node:path";
import process from "node:process";

import pc from "picocolors";

import {
  buildProvisionEmailPayload,
  normalizeAidenIdApiUrl,
  provisionEmailIdentity,
  resolveAidenIdCredentials,
} from "../ai/aidenid.js";
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

function normalizeIdempotencyKey(rawValue) {
  const normalized = String(rawValue || "").trim();
  return normalized || randomUUID();
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
}
