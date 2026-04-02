import path from "node:path";
import process from "node:process";

import pc from "picocolors";

import {
  buildChildIdentityPayload,
  createChildIdentity,
  getIdentityLineage,
  getLatestIdentityExtraction,
  listIdentityEvents,
  normalizeAidenIdApiUrl,
  revokeIdentity,
  revokeIdentityChildren,
  resolveAidenIdCredentials,
} from "../../ai/aidenid.js";
import {
  filterIdentitiesByTags,
  findStaleIdentities,
  getIdentityById,
  listIdentities,
  recordProvisionedIdentity,
  updateIdentityStatus,
} from "../../ai/identity-store.js";
import { resolveOutputRoot } from "../../config/service.js";
import {
  delay,
  hasExtractionSignal,
  identityIsUnderLegalHold,
  meetsConfidenceThreshold,
  normalizeIdempotencyKey,
  normalizeLegalHoldStatus,
  parseConfidenceThreshold,
  parseCsvTokens,
  parsePositiveInteger,
  renderLineageRows,
  shouldEmitJson,
  stableTimestampForFile,
  writeArtifact,
} from "./shared.js";

export function registerAiIdentityLifecycleCommands({ identity, legalHold }) {
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

legalHold
  .command("status")
  .description("Show legal-hold status for a tracked identity")
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

    const underHold = identityIsUnderLegalHold(identityRecord);
    const status = underHold ? "HOLD" : normalizeLegalHoldStatus(identityRecord.legalHoldStatus);
    const stamp = stableTimestampForFile();
    const artifactsDir = path.join(outputRoot, "aidenid", "legal-hold-status");
    const outputPath = path.join(
      artifactsDir,
      `legal-hold-${encodeURIComponent(identityId)}-${stamp}.json`
    );
    await writeArtifact(outputPath, {
      generatedAt: new Date().toISOString(),
      identityId,
      status,
      underHold,
      identity: identityRecord,
    });

    const payload = {
      command: "ai identity legal-hold status",
      identityId,
      registryPath,
      outputPath,
      status,
      underHold,
    };
    if (emitJson) {
      console.log(JSON.stringify(payload, null, 2));
      return;
    }

    console.log(pc.bold("AIdenID legal-hold status"));
    console.log(pc.gray(`Registry: ${registryPath}`));
    console.log(pc.gray(`Artifact: ${outputPath}`));
    console.log(`${identityId} | legal_hold=${status}`);
  });

identity
  .command("audit")
  .description("Audit tracked identities for stale lifecycle records")
  .option("--path <path>", "Workspace path for artifact/config resolution", ".")
  .option("--output-dir <path>", "Optional artifact output root override")
  .option("--stale", "Return only stale identities", true)
  .option("--no-stale", "Return full identity inventory")
  .option("--json", "Emit machine-readable output")
  .action(async (options, command) => {
    const emitJson = shouldEmitJson(options, command);
    const targetPath = path.resolve(process.cwd(), String(options.path || "."));
    const outputRoot = await resolveOutputRoot({
      cwd: targetPath,
      outputDirOverride: options.outputDir,
      env: process.env,
    });
    const staleScan = await findStaleIdentities({
      outputRoot,
    });
    const staleOnly = Boolean(options.stale);
    const identities = staleOnly ? staleScan.stale : staleScan.identities;
    const stamp = stableTimestampForFile();
    const artifactsDir = path.join(outputRoot, "aidenid", "identity-audit");
    const outputPath = path.join(artifactsDir, `identity-audit-${stamp}.json`);
    await writeArtifact(outputPath, {
      generatedAt: new Date().toISOString(),
      staleOnly,
      staleCount: staleScan.stale.length,
      totalCount: staleScan.identities.length,
      identities,
    });

    const payload = {
      command: "ai identity audit",
      staleOnly,
      registryPath: staleScan.registryPath,
      outputPath,
      staleCount: staleScan.stale.length,
      totalCount: staleScan.identities.length,
      identities,
    };
    if (emitJson) {
      console.log(JSON.stringify(payload, null, 2));
      return;
    }

    console.log(pc.bold("AIdenID identity audit"));
    console.log(pc.gray(`Registry: ${staleScan.registryPath}`));
    console.log(pc.gray(`Artifact: ${outputPath}`));
    console.log(`stale=${staleScan.stale.length} total=${staleScan.identities.length}`);
    for (const identityRecord of identities) {
      console.log(
        `- ${identityRecord.identityId} | ${identityRecord.status} | expires=${identityRecord.expiresAt || "n/a"}`
      );
    }
  });

identity
  .command("kill-all")
  .description("Emergency bulk squash by tags with legal-hold protections")
  .option("--path <path>", "Workspace path for artifact/config resolution", ".")
  .option("--output-dir <path>", "Optional artifact output root override")
  .option("--tags <csv>", "Comma-separated tags used for identity selection")
  .option("--api-url <url>", "AIdenID API base URL", "https://api.aidenid.com")
  .option("--api-key <key>", "AIdenID API key (or use AIDENID_API_KEY env)")
  .option("--org-id <id>", "AIdenID org id (or use AIDENID_ORG_ID env)")
  .option("--project-id <id>", "AIdenID project id (or use AIDENID_PROJECT_ID env)")
  .option("--execute", "Execute live revoke calls before local squash updates")
  .option("--json", "Emit machine-readable output")
  .action(async (options, command) => {
    const emitJson = shouldEmitJson(options, command);
    const tags = parseCsvTokens(options.tags, []);
    if (tags.length === 0) {
      throw new Error("At least one tag is required via --tags.");
    }
    const targetPath = path.resolve(process.cwd(), String(options.path || "."));
    const outputRoot = await resolveOutputRoot({
      cwd: targetPath,
      outputDirOverride: options.outputDir,
      env: process.env,
    });
    const { registryPath, identities } = await listIdentities({ outputRoot });
    const tagged = filterIdentitiesByTags(identities, tags);
    const candidates = tagged.filter((identityRecord) => String(identityRecord.status || "").toUpperCase() !== "SQUASHED");
    const blocked = candidates.filter((identityRecord) => identityIsUnderLegalHold(identityRecord));
    const eligible = candidates.filter((identityRecord) => !identityIsUnderLegalHold(identityRecord));

    const apiUrl = normalizeAidenIdApiUrl(options.apiUrl);
    const killCampaignId = normalizeIdempotencyKey("");
    const stamp = stableTimestampForFile();
    const artifactsDir = path.join(outputRoot, "aidenid", "kill-all");
    const requestPath = path.join(artifactsDir, `request-${stamp}.json`);
    await writeArtifact(requestPath, {
      generatedAt: new Date().toISOString(),
      killCampaignId,
      apiUrl,
      tags,
      candidateIdentityIds: candidates.map((item) => item.identityId),
      blockedIdentityIds: blocked.map((item) => item.identityId),
      eligibleIdentityIds: eligible.map((item) => item.identityId),
    });

    if (!options.execute) {
      const payload = {
        command: "ai identity kill-all",
        execute: false,
        killCampaignId,
        tags,
        registryPath,
        requestPath,
        candidateCount: candidates.length,
        blockedCount: blocked.length,
        eligibleCount: eligible.length,
        blockedIdentityIds: blocked.map((item) => item.identityId),
        eligibleIdentityIds: eligible.map((item) => item.identityId),
      };
      if (emitJson) {
        console.log(JSON.stringify(payload, null, 2));
        return;
      }

      console.log(pc.bold("AIdenID kill-all request generated (dry-run)"));
      console.log(pc.gray(`Registry: ${registryPath}`));
      console.log(pc.gray(`Request: ${requestPath}`));
      console.log(`campaign=${killCampaignId} candidates=${candidates.length} blocked=${blocked.length}`);
      return;
    }

    const resolvedCredentials = resolveAidenIdCredentials({
      apiKey: options.apiKey,
      orgId: options.orgId,
      projectId: options.projectId,
      env: process.env,
      requireAll: false,
    });
    const canCallApi = resolvedCredentials.missing.length === 0;

    const executeOne = async (identityRecord) => {
      const revokedAt = new Date().toISOString();
      let revokeResponse = null;
      if (canCallApi) {
        const revokeExecution = await revokeIdentity({
          apiUrl,
          apiKey: resolvedCredentials.apiKey,
          orgId: resolvedCredentials.orgId,
          projectId: resolvedCredentials.projectId || identityRecord.projectId,
          idempotencyKey: normalizeIdempotencyKey(""),
          identityId: identityRecord.identityId,
        });
        revokeResponse = revokeExecution.response || null;
      }
      const updated = await updateIdentityStatus({
        outputRoot,
        identityId: identityRecord.identityId,
        status: "SQUASHED",
        revokedAt,
        squashedAt: revokedAt,
        metadataPatch: {
          killCampaignId,
          killSwitchTags: tags,
          killAllExecutedAt: revokedAt,
          killAllApiCalled: canCallApi,
        },
      });
      return {
        identityId: identityRecord.identityId,
        status: updated.identity?.status || "SQUASHED",
        revokeResponse,
      };
    };

    const updates = [];
    for (const identityRecord of eligible) {
      const updated = await executeOne(identityRecord);
      updates.push(updated);
    }
    const responsePath = path.join(artifactsDir, `response-${stamp}.json`);
    await writeArtifact(responsePath, {
      generatedAt: new Date().toISOString(),
      killCampaignId,
      tags,
      candidateCount: candidates.length,
      blockedIdentityIds: blocked.map((item) => item.identityId),
      updated: updates,
      apiCalled: canCallApi,
      credentialsMissing: resolvedCredentials.missing,
    });

    const payload = {
      command: "ai identity kill-all",
      execute: true,
      killCampaignId,
      tags,
      registryPath,
      requestPath,
      responsePath,
      candidateCount: candidates.length,
      blockedCount: blocked.length,
      updatedCount: updates.length,
      blockedIdentityIds: blocked.map((item) => item.identityId),
      updated: updates,
      apiCalled: canCallApi,
      credentialsMissing: resolvedCredentials.missing,
    };
    if (emitJson) {
      console.log(JSON.stringify(payload, null, 2));
      return;
    }

    console.log(pc.bold("AIdenID kill-all executed"));
    console.log(pc.gray(`Registry: ${registryPath}`));
    console.log(pc.gray(`Response: ${responsePath}`));
    console.log(
      `campaign=${killCampaignId} updated=${updates.length} blocked=${blocked.length} api_called=${canCallApi}`
    );
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
    if (identityIsUnderLegalHold(trackedIdentity)) {
      throw new Error(`Identity '${identityId}' is under legal hold and cannot be revoked.`);
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
        tags: payload.tags,
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
    if (trackedIdentity && identityIsUnderLegalHold(trackedIdentity)) {
      throw new Error(`Identity '${identityId}' is under legal hold and cannot run revoke-children.`);
    }
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

    const updateResults = await Promise.all(
      execution.revokedIdentityIds.map(async (revokedIdentityId) => {
        try {
          const updated = await updateIdentityStatus({
            outputRoot,
            identityId: revokedIdentityId,
            status: "SQUASHED",
            revokedAt: new Date().toISOString(),
            squashedAt: new Date().toISOString(),
            metadataPatch: {
              revokeChildrenRequestIdempotencyKey: idempotencyKey,
              parentIdentityId: execution.parentIdentityId,
            },
          });
          return updated.identity?.identityId || null;
        } catch {
          return null;
        }
      })
    );
    const localUpdatedIdentityIds = updateResults.filter(Boolean);

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
