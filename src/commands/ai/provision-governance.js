import path from "node:path";
import process from "node:process";

import pc from "picocolors";

import {
  buildProvisionEmailPayload,
  createDomain,
  createTemporarySite,
  createTarget,
  freezeDomain,
  getTarget,
  normalizeAidenIdApiUrl,
  provisionEmailIdentity,
  resolveAidenIdCredentials,
  verifyDomain,
  verifyTarget,
} from "../../ai/aidenid.js";
import {
  getDomainById,
  getTargetById as getTrackedTargetById,
  recordDomainProofResponse,
  recordTargetProofResponse,
} from "../../ai/domain-target-store.js";
import { listSites, recordTemporarySite } from "../../ai/site-store.js";
import { getIdentityById, recordProvisionedIdentity } from "../../ai/identity-store.js";
import { resolveOutputRoot } from "../../config/service.js";
import {
  buildCurlPreview,
  normalizeIdempotencyKey,
  parseCsvTokens,
  parseJsonObject,
  parsePositiveInteger,
  shouldEmitJson,
  stableTimestampForFile,
  writeArtifact,
} from "./shared.js";

export function registerAiProvisionAndGovernanceCommands(ai) {
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
        tags: payload.tags,
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
const site = identity.command("site").description("AIdenID temporary callback domain commands");
const legalHold = identity.command("legal-hold").description("Identity legal-hold controls");

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

site
  .command("create")
  .description("Create an ephemeral callback site linked to an identity (dry-run by default)")
  .argument("<identityId>", "Identity id")
  .option("--path <path>", "Workspace path for artifact/config resolution", ".")
  .option("--output-dir <path>", "Optional artifact output root override")
  .option("--api-url <url>", "AIdenID API base URL", "https://api.aidenid.com")
  .option("--api-key <key>", "AIdenID API key (or use AIDENID_API_KEY env)")
  .option("--org-id <id>", "AIdenID org id (or use AIDENID_ORG_ID env)")
  .option("--project-id <id>", "AIdenID project id (or use AIDENID_PROJECT_ID env)")
  .option("--domain-id <id>", "Domain id used for callback host")
  .option("--subdomain-prefix <value>", "Subdomain prefix", "cb")
  .option("--callback-path <value>", "Callback path", "/callback")
  .option("--ttl-hours <hours>", "Site TTL in hours", "24")
  .option("--dns-cleanup-contract-json <json>", "JSON cleanup contract", "{}")
  .option("--metadata-json <json>", "JSON metadata", "{}")
  .option("--idempotency-key <key>", "Explicit idempotency key override")
  .option("--execute", "Execute live API call")
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
    const ttlHours = parsePositiveInteger(options.ttlHours, "ttlHours", 24);
    const domainId = String(options.domainId || "").trim();
    if (!domainId) {
      throw new Error("domainId is required. Use --domain-id <id>.");
    }
    const trackedIdentity = await getIdentityById({
      outputRoot,
      identityId,
    });
    const payload = {
      identityId,
      domainId,
      subdomainPrefix: String(options.subdomainPrefix || "cb").trim() || "cb",
      callbackPath: String(options.callbackPath || "/callback").trim() || "/callback",
      ttlHours,
      dnsCleanupContract: parseJsonObject(options.dnsCleanupContractJson, "dnsCleanupContractJson"),
      metadata: parseJsonObject(options.metadataJson, "metadataJson"),
    };

    const artifactsDir = path.join(outputRoot, "aidenid", "site-create");
    const stamp = stableTimestampForFile();
    const requestPath = path.join(artifactsDir, `request-${encodeURIComponent(identityId)}-${stamp}.json`);
    await writeArtifact(requestPath, {
      generatedAt: new Date().toISOString(),
      apiUrl,
      idempotencyKey,
      payload,
    });

    const resolvedCredentials = resolveAidenIdCredentials({
      apiKey: options.apiKey,
      orgId: options.orgId || trackedIdentity.identity?.orgId,
      projectId: options.projectId || trackedIdentity.identity?.projectId,
      env: process.env,
      requireAll: false,
    });
    if (!options.execute) {
      const result = {
        command: "ai identity site create",
        execute: false,
        identityId,
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
      console.log(pc.bold("AIdenID site create artifact generated (dry-run)"));
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
      orgId: options.orgId || trackedIdentity.identity?.orgId,
      projectId: options.projectId || trackedIdentity.identity?.projectId,
      env: process.env,
      requireAll: true,
    });
    const execution = await createTemporarySite({
      apiUrl,
      apiKey: requiredCredentials.apiKey,
      orgId: requiredCredentials.orgId,
      projectId: requiredCredentials.projectId,
      idempotencyKey,
      payload,
    });
    const responsePath = path.join(
      artifactsDir,
      `response-${encodeURIComponent(identityId)}-${stamp}.json`
    );
    await writeArtifact(responsePath, {
      receivedAt: new Date().toISOString(),
      apiUrl,
      idempotencyKey,
      response: execution.response,
    });

    const registryUpdate = await recordTemporarySite({
      outputRoot,
      site: execution.response || {},
      context: {
        source: "site-create",
        idempotencyKey,
        identityId,
        domainId,
        projectId: requiredCredentials.projectId,
      },
    });
    const result = {
      command: "ai identity site create",
      execute: true,
      identityId,
      apiUrl,
      idempotencyKey,
      requestPath,
      responsePath,
      site: execution.response || null,
      registryPath: registryUpdate.registryPath,
    };
    if (emitJson) {
      console.log(JSON.stringify(result, null, 2));
      return;
    }
    console.log(pc.bold("AIdenID temporary site created"));
    console.log(pc.gray(`Response: ${responsePath}`));
    console.log(
      `${String(result.site?.id || "unknown-site")} | ${String(result.site?.callbackUrl || result.site?.host || "unknown-host")}`
    );
  });

site
  .command("list")
  .description("List locally tracked temporary callback sites")
  .option("--path <path>", "Workspace path for artifact/config resolution", ".")
  .option("--output-dir <path>", "Optional artifact output root override")
  .option("--identity-id <id>", "Optional identity filter")
  .option("--json", "Emit machine-readable output")
  .action(async (options, command) => {
    const emitJson = shouldEmitJson(options, command);
    const targetPath = path.resolve(process.cwd(), String(options.path || "."));
    const outputRoot = await resolveOutputRoot({
      cwd: targetPath,
      outputDirOverride: options.outputDir,
      env: process.env,
    });
    const listing = await listSites({
      outputRoot,
      identityId: options.identityId,
    });
    const payload = {
      command: "ai identity site list",
      registryPath: listing.registryPath,
      count: listing.sites.length,
      sites: listing.sites,
    };
    if (emitJson) {
      console.log(JSON.stringify(payload, null, 2));
      return;
    }

    console.log(pc.bold("AIdenID temporary sites"));
    console.log(pc.gray(`Registry: ${listing.registryPath}`));
    if (listing.sites.length === 0) {
      console.log(pc.gray("No tracked temporary sites."));
      return;
    }
    for (const item of listing.sites) {
      console.log(
        `- ${item.siteId} | ${item.identityId || "unknown-identity"} | ${item.status} | ${item.callbackUrl || item.host || "unknown-host"}`
      );
    }
  });

  return { identity, legalHold };
}
