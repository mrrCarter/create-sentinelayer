import { spawnSync } from "node:child_process";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";

import pc from "picocolors";
import prompts from "prompts";

import {
  createMultiProviderApiClient,
  resolveModel,
  resolveProvider,
} from "../ai/client.js";
import { loadConfig, resolveOutputRoot } from "../config/service.js";
import { evaluateBudget } from "../cost/budget.js";
import { appendCostEntry, summarizeCostHistory } from "../cost/history.js";
import { estimateModelCost } from "../cost/tracker.js";
import {
  applyPolicyPackToScanProfile,
  resolveActivePolicyPack,
} from "../policy/packs.js";
import {
  buildSecretSetupInstructions,
  buildSecurityReviewWorkflow,
  DEFAULT_SCAN_WORKFLOW_PATH,
  inferScanProfile,
  SUPPORTED_E2E_HINTS,
  SUPPORTED_PLAYWRIGHT_MODES,
  validateSecurityReviewWorkflow,
} from "../scan/generator.js";
import { appendRunEvent, deriveStopClassFromBudget } from "../telemetry/ledger.js";

const LEGACY_SCAN_WORKFLOW_PATH = ".github/workflows/security-review.yml";

function shouldEmitJson(options, command) {
  const local = Boolean(options && options.json);
  const globalFromCommand =
    command && command.optsWithGlobals ? Boolean(command.optsWithGlobals().json) : false;
  return local || globalFromCommand;
}

function resolveSpecPath(targetPath, explicitSpecFile) {
  const explicit = String(explicitSpecFile || "").trim();
  if (explicit) {
    return path.resolve(targetPath, explicit);
  }

  const candidates = [path.join(targetPath, "SPEC.md"), path.join(targetPath, "docs", "spec.md")];
  const found = candidates.find((candidate) => fs.existsSync(candidate));
  if (!found) {
    throw new Error("No spec file found. Provide --spec-file or generate SPEC.md first.");
  }
  return found;
}

function normalizeRepoSlug(value) {
  return String(value || "").trim().replace(/\.git$/i, "");
}

function parseRepoSlugFromRemote(remoteUrl) {
  const remote = String(remoteUrl || "").trim();
  if (!remote) {
    return "";
  }

  const sshMatch = remote.match(/^git@github\.com:([^/]+)\/(.+?)(?:\.git)?$/i);
  if (sshMatch) {
    return normalizeRepoSlug(`${sshMatch[1]}/${sshMatch[2]}`);
  }

  const httpsMatch = remote.match(/^https?:\/\/github\.com\/([^/]+)\/(.+?)(?:\.git)?$/i);
  if (httpsMatch) {
    return normalizeRepoSlug(`${httpsMatch[1]}/${httpsMatch[2]}`);
  }

  const sshUrlMatch = remote.match(/^ssh:\/\/git@github\.com\/([^/]+)\/(.+?)(?:\.git)?$/i);
  if (sshUrlMatch) {
    return normalizeRepoSlug(`${sshUrlMatch[1]}/${sshUrlMatch[2]}`);
  }

  return "";
}

function detectRepoSlugFromGit(targetPath) {
  const result = spawnSync("git", ["config", "--get", "remote.origin.url"], {
    cwd: targetPath,
    encoding: "utf-8",
  });
  if (result.status !== 0) {
    return "";
  }
  return parseRepoSlugFromRemote(result.stdout);
}

function resolveWorkflowPathForCommand({
  targetPath,
  explicitWorkflowFile = "",
  preferExistingLegacy = true,
} = {}) {
  const explicit = String(explicitWorkflowFile || "").trim();
  if (explicit) {
    return {
      workflowFile: explicit,
      workflowPath: path.resolve(targetPath, explicit),
    };
  }

  const preferredWorkflowPath = path.resolve(targetPath, DEFAULT_SCAN_WORKFLOW_PATH);
  if (fs.existsSync(preferredWorkflowPath)) {
    return {
      workflowFile: DEFAULT_SCAN_WORKFLOW_PATH,
      workflowPath: preferredWorkflowPath,
    };
  }

  if (preferExistingLegacy) {
    const legacyWorkflowPath = path.resolve(targetPath, LEGACY_SCAN_WORKFLOW_PATH);
    if (fs.existsSync(legacyWorkflowPath)) {
      return {
        workflowFile: LEGACY_SCAN_WORKFLOW_PATH,
        workflowPath: legacyWorkflowPath,
      };
    }
  }

  return {
    workflowFile: DEFAULT_SCAN_WORKFLOW_PATH,
    workflowPath: preferredWorkflowPath,
  };
}

function normalizeE2EHint(rawValue) {
  const normalized = String(rawValue || "auto").trim().toLowerCase() || "auto";
  if (!SUPPORTED_E2E_HINTS.includes(normalized)) {
    throw new Error(
      `Invalid --has-e2e-tests value '${rawValue}'. Allowed: ${SUPPORTED_E2E_HINTS.join(", ")}`
    );
  }
  return normalized;
}

function normalizePlaywrightMode(rawValue) {
  const normalized = String(rawValue || "auto").trim().toLowerCase() || "auto";
  if (!SUPPORTED_PLAYWRIGHT_MODES.includes(normalized)) {
    throw new Error(
      `Invalid --playwright-mode value '${rawValue}'. Allowed: ${SUPPORTED_PLAYWRIGHT_MODES.join(", ")}`
    );
  }
  return normalized;
}

function parseNonNegativeNumber(rawValue, field) {
  const normalized = Number(rawValue || 0);
  if (!Number.isFinite(normalized) || normalized < 0) {
    throw new Error(`${field} must be a non-negative number.`);
  }
  return normalized;
}

function parsePercent(rawValue, field) {
  const normalized = Number(rawValue || 0);
  if (!Number.isFinite(normalized) || normalized < 0 || normalized > 100) {
    throw new Error(`${field} must be between 0 and 100.`);
  }
  return normalized;
}

function estimateTokenCount(text) {
  const normalized = String(text || "");
  if (!normalized) {
    return 0;
  }
  return Math.max(1, Math.ceil(normalized.length / 4));
}

function resolveConfiguredApiKey(provider, resolvedConfig = {}) {
  const normalizedProvider = String(provider || "").trim().toLowerCase();
  if (normalizedProvider === "openai") {
    return String(resolvedConfig.openaiApiKey || "").trim();
  }
  if (normalizedProvider === "anthropic") {
    return String(resolvedConfig.anthropicApiKey || "").trim();
  }
  if (normalizedProvider === "google") {
    return String(resolvedConfig.googleApiKey || "").trim();
  }
  return "";
}

function maybeEstimateModelCost({ modelId, inputTokens, outputTokens }) {
  try {
    return {
      costUsd: estimateModelCost({
        modelId,
        inputTokens,
        outputTokens,
      }),
      pricingFound: true,
    };
  } catch {
    return {
      costUsd: 0,
      pricingFound: false,
    };
  }
}

function createTimestampToken() {
  return new Date().toISOString().replace(/[-:]/g, "").replace(/\..+/, "").replace("T", "-");
}

async function maybePromptForE2EChoice({ inferredHasE2E, hasE2ETests, nonInteractive }) {
  if (hasE2ETests !== "auto") {
    return hasE2ETests;
  }
  if (nonInteractive || !process.stdin.isTTY || !process.stdout.isTTY) {
    return hasE2ETests;
  }

  const answer = await prompts({
    type: "toggle",
    name: "hasE2ETests",
    message: "Do you have E2E tests in this repository?",
    initial: inferredHasE2E ? 1 : 0,
    active: "yes",
    inactive: "no",
  });

  if (!Object.prototype.hasOwnProperty.call(answer, "hasE2ETests")) {
    throw new Error("Scan init cancelled.");
  }
  return answer.hasE2ETests ? "yes" : "no";
}

function buildAiPreScanPrompt({
  targetPath,
  specMarkdown,
  profile,
} = {}) {
  return [
    "You are a senior application security reviewer preparing a pre-scan triage report.",
    "Return markdown only with the following sections:",
    "1. Executive Summary",
    "2. Predicted P0 Findings",
    "3. Predicted P1 Findings",
    "4. Predicted P2 Findings",
    "5. Recommended Omar Gate Focus Areas",
    "6. Test and Evidence Plan",
    "Use concise, actionable bullets and map findings to likely folders/files when possible.",
    "",
    `Workspace: ${targetPath}`,
    `scan_mode=${profile.scanMode}`,
    `severity_gate=${profile.severityGate}`,
    `playwright_mode=${profile.playwrightMode}`,
    `sbom_mode=${profile.sbomMode}`,
    "",
    "Source spec markdown:",
    specMarkdown,
  ].join("\n");
}

function buildPreScanReportMarkdown({
  generatedAt,
  specPath,
  profile,
  provider,
  model,
  aiMarkdown,
} = {}) {
  return [
    "# AI PRE-SCAN REPORT",
    "",
    `Generated: ${generatedAt}`,
    `Spec: ${specPath}`,
    `Provider: ${provider}`,
    `Model: ${model}`,
    "",
    "## Derived Scan Profile",
    `- scan_mode: ${profile.scanMode}`,
    `- severity_gate: ${profile.severityGate}`,
    `- playwright_mode: ${profile.playwrightMode}`,
    `- sbom_mode: ${profile.sbomMode}`,
    "",
    "## AI Review",
    String(aiMarkdown || "").trim() || "_No AI output returned._",
    "",
  ].join("\n");
}

async function resolvePreScanReportPath({
  targetPath,
  outputDirOverride,
  outputFile,
} = {}) {
  const explicit = String(outputFile || "").trim();
  if (explicit) {
    return path.resolve(targetPath, explicit);
  }

  const outputRoot = await resolveOutputRoot({
    cwd: targetPath,
    outputDirOverride,
    env: process.env,
  });
  return path.join(outputRoot, "reports", `scan-precheck-${createTimestampToken()}.md`);
}

function printAiPreScanSummary({ reportPath, ai }) {
  console.log(pc.bold("AI pre-scan report generated"));
  console.log(pc.gray(`Report: ${reportPath}`));
  console.log(pc.gray(`Provider: ${ai.provider}, Model: ${ai.model}`));
  console.log(
    pc.gray(
      `Input tokens=${ai.usage.inputTokens}, Output tokens=${ai.usage.outputTokens}, Cost=$${ai.usage.costUsd.toFixed(6)}, DurationMs=${ai.usage.durationMs}`
    )
  );
  if (!ai.pricingFound) {
    console.log(pc.yellow("Model pricing missing from local table; cost recorded as 0."));
  }
  if (ai.budget.blocking) {
    console.log(pc.red("AI budget guardrail triggered:"));
    for (const reason of ai.budget.reasons) {
      console.log(`- ${reason.code}: ${reason.message}`);
    }
  } else if (ai.budget.warnings.length > 0) {
    console.log(pc.yellow("AI budget warning threshold reached:"));
    for (const warning of ai.budget.warnings) {
      console.log(`- ${warning.code}: ${warning.message}`);
    }
  }
}

export function registerScanCommand(program) {
  const scan = program.command("scan").description("Generate and validate Omar Gate workflow config");

  scan
    .command("init")
    .description("Generate .github/workflows/omar-gate.yml from spec context")
    .option("--path <path>", "Target workspace path", ".")
    .option("--spec-file <path>", "Spec file path relative to --path")
    .option("--workflow-file <path>", "Workflow output path relative to --path")
    .option(
      "--secret-name <name>",
      "GitHub Actions secret name for sentinelayer_token",
      "SENTINELAYER_TOKEN"
    )
    .option(
      "--has-e2e-tests <mode>",
      `E2E hint (${SUPPORTED_E2E_HINTS.join("|")})`,
      "auto"
    )
    .option(
      "--playwright-mode <mode>",
      `Playwright override (${SUPPORTED_PLAYWRIGHT_MODES.join("|")})`,
      "auto"
    )
    .option("--non-interactive", "Disable wizard prompts and rely on deterministic inference")
    .option("--json", "Emit machine-readable output")
    .action(async (options, command) => {
      const targetPath = path.resolve(process.cwd(), String(options.path || "."));
      const workflowTarget = resolveWorkflowPathForCommand({
        targetPath,
        explicitWorkflowFile: options.workflowFile,
        preferExistingLegacy: true,
      });
      const workflowFile = workflowTarget.workflowFile;
      const workflowPath = workflowTarget.workflowPath;
      const specPath = resolveSpecPath(targetPath, options.specFile);
      const specMarkdown = await fsp.readFile(specPath, "utf-8");

      const hasE2EHint = normalizeE2EHint(options.hasE2eTests);
      const playwrightMode = normalizePlaywrightMode(options.playwrightMode);
      const nonInteractive = Boolean(options.nonInteractive);
      const activePolicy = await resolveActivePolicyPack({
        cwd: targetPath,
        env: process.env,
      });

      const initialProfile = inferScanProfile({
        specMarkdown,
        hasE2ETests: hasE2EHint,
        playwrightMode,
      });
      const resolvedE2EHint = await maybePromptForE2EChoice({
        inferredHasE2E: initialProfile.inferredHasE2E,
        hasE2ETests: hasE2EHint,
        nonInteractive,
      });

      const profile = inferScanProfile({
        specMarkdown,
        hasE2ETests: resolvedE2EHint,
        playwrightMode,
      });
      const appliedProfile = applyPolicyPackToScanProfile(profile, activePolicy.selected);
      const workflowMarkdown = buildSecurityReviewWorkflow({
        secretName: options.secretName,
        profile: appliedProfile,
      });

      await fsp.mkdir(path.dirname(workflowPath), { recursive: true });
      await fsp.writeFile(workflowPath, workflowMarkdown, "utf-8");

      const instructions = buildSecretSetupInstructions(options.secretName, {
        repoSlug: detectRepoSlugFromGit(targetPath),
      });
      const payload = {
        command: "scan init",
        targetPath,
        specPath,
        workflowPath,
        profile: appliedProfile,
        policyPack: activePolicy.selected
          ? {
              id: activePolicy.selected.id,
              source: activePolicy.selected.source,
            }
          : null,
        instructions,
      };

      if (shouldEmitJson(options, command)) {
        console.log(JSON.stringify(payload, null, 2));
        return;
      }

      console.log(pc.bold("Security review workflow generated"));
      console.log(pc.gray(`Spec: ${specPath}`));
      console.log(pc.gray(`Workflow: ${workflowPath}`));
      console.log(
        pc.gray(`scan_mode=${appliedProfile.scanMode}, severity_gate=${appliedProfile.severityGate}`)
      );
      console.log(
        pc.gray(
          `playwright_mode=${appliedProfile.playwrightMode}, sbom_mode=${appliedProfile.sbomMode}`
        )
      );
      if (activePolicy.selected) {
        console.log(pc.gray(`policy_pack=${activePolicy.selected.id} (${activePolicy.selected.source})`));
      }
      instructions.forEach((line) => console.log(line));
    });

  scan
    .command("validate")
    .description("Validate existing Omar Gate workflow against current spec profile")
    .option("--path <path>", "Target workspace path", ".")
    .option("--spec-file <path>", "Spec file path relative to --path")
    .option("--workflow-file <path>", "Workflow file path relative to --path")
    .option("--secret-name <name>", "Expected GitHub Actions secret name", "SENTINELAYER_TOKEN")
    .option(
      "--has-e2e-tests <mode>",
      `E2E hint (${SUPPORTED_E2E_HINTS.join("|")})`,
      "auto"
    )
    .option(
      "--playwright-mode <mode>",
      `Playwright override (${SUPPORTED_PLAYWRIGHT_MODES.join("|")})`,
      "auto"
    )
    .option("--json", "Emit machine-readable output")
    .action(async (options, command) => {
      const targetPath = path.resolve(process.cwd(), String(options.path || "."));
      const specPath = resolveSpecPath(targetPath, options.specFile);
      const workflowPath = resolveWorkflowPathForCommand({
        targetPath,
        explicitWorkflowFile: options.workflowFile,
        preferExistingLegacy: true,
      }).workflowPath;

      const specMarkdown = await fsp.readFile(specPath, "utf-8");
      const workflowMarkdown = await fsp.readFile(workflowPath, "utf-8");
      const activePolicy = await resolveActivePolicyPack({
        cwd: targetPath,
        env: process.env,
      });
      const inferredProfile = inferScanProfile({
        specMarkdown,
        hasE2ETests: normalizeE2EHint(options.hasE2eTests),
        playwrightMode: normalizePlaywrightMode(options.playwrightMode),
      });
      const expectedProfile = applyPolicyPackToScanProfile(inferredProfile, activePolicy.selected);

      const validation = validateSecurityReviewWorkflow({
        workflowMarkdown,
        expectedProfile,
        expectedSecretName: options.secretName,
      });

      const payload = {
        command: "scan validate",
        targetPath,
        specPath,
        workflowPath,
        aligned: validation.aligned,
        expected: validation.expected,
        actual: validation.actual,
        mismatches: validation.mismatches,
        policyPack: activePolicy.selected
          ? {
              id: activePolicy.selected.id,
              source: activePolicy.selected.source,
            }
          : null,
      };

      if (shouldEmitJson(options, command)) {
        console.log(JSON.stringify(payload, null, 2));
      } else if (validation.aligned) {
        console.log(pc.bold("Security review workflow matches spec profile."));
        console.log(pc.gray(`Workflow: ${workflowPath}`));
      } else {
        console.log(pc.red("Security review workflow drift detected."));
        console.log(pc.gray(`Workflow: ${workflowPath}`));
        validation.mismatches.forEach((item, index) => {
          console.log(
            `${index + 1}. ${item.field}: expected '${item.expected}' but found '${item.actual}'.`
          );
        });
      }

      if (!validation.aligned) {
        process.exitCode = 2;
      }
    });

  scan
    .command("precheck")
    .description("Run AI pre-scan triage from spec context and emit a review-ready report")
    .option("--path <path>", "Target workspace path", ".")
    .option("--spec-file <path>", "Spec file path relative to --path")
    .option("--output-file <path>", "Report output path relative to --path")
    .option("--output-dir <path>", "Optional output dir override for report/cost/telemetry artifacts")
    .option(
      "--has-e2e-tests <mode>",
      `E2E hint (${SUPPORTED_E2E_HINTS.join("|")})`,
      "auto"
    )
    .option(
      "--playwright-mode <mode>",
      `Playwright override (${SUPPORTED_PLAYWRIGHT_MODES.join("|")})`,
      "auto"
    )
    .option("--provider <name>", "AI provider override (openai|anthropic|google)")
    .option("--model <id>", "AI model override")
    .option("--api-key <key>", "Optional explicit API key override")
    .option("--session-id <id>", "Cost/telemetry session id", "scan-ai-precheck")
    .option("--max-cost <usd>", "Max AI cost budget per session", "0.5")
    .option("--max-tokens <n>", "Max output token budget per session (0 = disabled)", "0")
    .option("--max-runtime-ms <n>", "Max runtime budget per session in milliseconds (0 = disabled)", "0")
    .option("--max-tool-calls <n>", "Max tool-call budget per session (0 = disabled)", "0")
    .option("--max-no-progress <n>", "Max consecutive no-progress events before stop", "3")
    .option("--warn-at-percent <n>", "Warning threshold percentage for enabled budgets", "80")
    .option("--json", "Emit machine-readable output")
    .action(async (options, command) => {
      const targetPath = path.resolve(process.cwd(), String(options.path || "."));
      const specPath = resolveSpecPath(targetPath, options.specFile);
      const specMarkdown = await fsp.readFile(specPath, "utf-8");
      const activePolicy = await resolveActivePolicyPack({
        cwd: targetPath,
        env: process.env,
      });
      const profile = applyPolicyPackToScanProfile(
        inferScanProfile({
          specMarkdown,
          hasE2ETests: normalizeE2EHint(options.hasE2eTests),
          playwrightMode: normalizePlaywrightMode(options.playwrightMode),
        }),
        activePolicy.selected
      );

      const config = await loadConfig({ cwd: targetPath });
      const resolvedProvider = resolveProvider({
        provider: options.provider,
        configProvider: config.resolved.defaultModelProvider,
        env: process.env,
      });
      const resolvedModel = resolveModel({
        provider: resolvedProvider,
        model: options.model,
        configModel: config.resolved.defaultModelId,
      });
      const explicitApiKey = String(options.apiKey || "").trim();
      const configuredApiKey = resolveConfiguredApiKey(resolvedProvider, config.resolved);

      const prompt = buildAiPreScanPrompt({
        targetPath,
        specMarkdown,
        profile,
      });

      const startedAtMs = Date.now();
      const client = createMultiProviderApiClient();
      const response = await client.invoke({
        provider: resolvedProvider,
        model: resolvedModel,
        prompt,
        apiKey: explicitApiKey || configuredApiKey,
        env: process.env,
        stream: false,
      });
      const durationMs = Math.max(0, Date.now() - startedAtMs);
      const aiMarkdown = String(response.text || "").trim();
      const generatedAt = new Date().toISOString();

      const reportMarkdown = buildPreScanReportMarkdown({
        generatedAt,
        specPath,
        profile,
        provider: response.provider,
        model: response.model,
        aiMarkdown,
      });
      const reportPath = await resolvePreScanReportPath({
        targetPath,
        outputDirOverride: options.outputDir,
        outputFile: options.outputFile,
      });
      await fsp.mkdir(path.dirname(reportPath), { recursive: true });
      await fsp.writeFile(reportPath, reportMarkdown, "utf-8");

      const inputTokens = estimateTokenCount(prompt);
      const outputTokens = estimateTokenCount(aiMarkdown);
      const modelCost = maybeEstimateModelCost({
        modelId: response.model,
        inputTokens,
        outputTokens,
      });
      const sessionId = String(options.sessionId || "scan-ai-precheck").trim() || "scan-ai-precheck";

      const appendedCost = await appendCostEntry(
        {
          targetPath,
          outputDirOverride: options.outputDir,
        },
        {
          sessionId,
          provider: response.provider,
          model: response.model,
          inputTokens,
          outputTokens,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
          durationMs,
          toolCalls: 1,
          costUsd: modelCost.costUsd,
          progressScore: aiMarkdown ? 1 : 0,
        }
      );

      const costSummary = summarizeCostHistory(appendedCost.history);
      const sessionSummary = costSummary.sessions.find((item) => item.sessionId === sessionId) || {
        sessionId,
        invocationCount: 0,
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        durationMs: 0,
        toolCalls: 0,
        costUsd: 0,
        noProgressStreak: 0,
      };

      const budget = evaluateBudget({
        sessionSummary,
        maxCostUsd: parseNonNegativeNumber(options.maxCost, "maxCost"),
        maxOutputTokens: parseNonNegativeNumber(options.maxTokens, "maxTokens"),
        maxNoProgress: parseNonNegativeNumber(options.maxNoProgress, "maxNoProgress"),
        maxRuntimeMs: parseNonNegativeNumber(options.maxRuntimeMs, "maxRuntimeMs"),
        maxToolCalls: parseNonNegativeNumber(options.maxToolCalls, "maxToolCalls"),
        warningThresholdPercent: parsePercent(options.warnAtPercent, "warnAtPercent"),
      });

      const usageTelemetry = await appendRunEvent(
        {
          targetPath,
          outputDirOverride: options.outputDir,
        },
        {
          sessionId,
          runId: sessionId,
          eventType: "usage",
          usage: {
            inputTokens,
            outputTokens,
            cacheReadTokens: 0,
            cacheWriteTokens: 0,
            costUsd: modelCost.costUsd,
            durationMs,
            toolCalls: 1,
          },
          metadata: {
            sourceCommand: "scan precheck",
            provider: response.provider,
            model: response.model,
            invocationId: appendedCost.entry.invocationId,
          },
        }
      );

      let stopTelemetry = null;
      if (budget.blocking) {
        stopTelemetry = await appendRunEvent(
          {
            targetPath,
            outputDirOverride: options.outputDir,
          },
          {
            sessionId,
            runId: sessionId,
            eventType: "run_stop",
            usage: {
              inputTokens: sessionSummary.inputTokens,
              outputTokens: sessionSummary.outputTokens,
              cacheReadTokens: sessionSummary.cacheReadTokens,
              cacheWriteTokens: sessionSummary.cacheWriteTokens,
              costUsd: sessionSummary.costUsd,
              durationMs: sessionSummary.durationMs,
              toolCalls: sessionSummary.toolCalls,
            },
            stop: {
              stopClass: deriveStopClassFromBudget(budget),
              blocking: true,
              reasonCodes: budget.reasons.map((reason) => reason.code),
            },
            metadata: {
              sourceCommand: "scan precheck",
              provider: response.provider,
              model: response.model,
              invocationId: appendedCost.entry.invocationId,
            },
          }
        );
      }

      const payload = {
        command: "scan precheck",
        targetPath,
        specPath,
        reportPath,
        profile,
        policyPack: activePolicy.selected
          ? {
              id: activePolicy.selected.id,
              source: activePolicy.selected.source,
            }
          : null,
        ai: {
          provider: response.provider,
          model: response.model,
          pricingFound: modelCost.pricingFound,
          usage: {
            inputTokens,
            outputTokens,
            costUsd: modelCost.costUsd,
            durationMs,
            toolCalls: 1,
          },
          budget,
          cost: {
            filePath: appendedCost.filePath,
            invocationId: appendedCost.entry.invocationId,
            sessionId,
          },
          telemetry: {
            filePath: usageTelemetry.filePath,
            usageEventId: usageTelemetry.event.eventId,
            stopEventId: stopTelemetry?.event?.eventId || null,
          },
        },
      };

      if (shouldEmitJson(options, command)) {
        console.log(JSON.stringify(payload, null, 2));
      } else {
        printAiPreScanSummary({
          reportPath,
          ai: payload.ai,
        });
      }

      if (budget.blocking) {
        process.exitCode = 2;
      }
    });
}

