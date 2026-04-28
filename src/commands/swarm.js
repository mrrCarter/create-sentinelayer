import path from "node:path";
import process from "node:process";

import pc from "picocolors";

import { buildSwarmExecutionPlan, writeSwarmPlanArtifacts } from "../swarm/factory.js";
import { loadSwarmRegistry, selectSwarmAgents } from "../swarm/registry.js";
import { loadSwarmPlanFile, loadSwarmPlaybook, runSwarmRuntime } from "../swarm/runtime.js";
import {
  loadSwarmDashboardSnapshot,
  renderSwarmDashboard,
  watchSwarmDashboard,
} from "../swarm/dashboard.js";
import { buildSwarmExecutionReport } from "../swarm/report.js";
import {
  parseScenarioFile,
  renderScenarioTemplate,
  validateScenarioSpec,
  writeScenarioTemplate,
} from "../swarm/scenario-dsl.js";
import { listBuiltinPentestScenarios, runSwarmPentest } from "../swarm/pentest.js";

function shouldEmitJson(options, command) {
  const local = Boolean(options && options.json);
  const globalFromCommand =
    command && command.optsWithGlobals ? Boolean(command.optsWithGlobals().json) : false;
  return local || globalFromCommand;
}

function parseMaxParallel(rawValue) {
  const normalized = Number(rawValue || 0);
  if (!Number.isFinite(normalized) || normalized < 1) {
    throw new Error("max-parallel must be an integer >= 1.");
  }
  return Math.floor(normalized);
}

function parseMaxSteps(rawValue) {
  const normalized = Number(rawValue || 0);
  if (!Number.isFinite(normalized) || normalized < 1) {
    throw new Error("max-steps must be an integer >= 1.");
  }
  return Math.floor(normalized);
}

function parsePollSeconds(rawValue, fieldName) {
  const normalized = Number(rawValue || 0);
  if (!Number.isFinite(normalized) || normalized <= 0) {
    throw new Error(`${fieldName} must be a positive number.`);
  }
  return normalized;
}

function parsePositiveNumber(rawValue, fieldName) {
  const normalized = Number(rawValue || 0);
  if (!Number.isFinite(normalized) || normalized <= 0) {
    throw new Error(`${fieldName} must be a positive number.`);
  }
  return normalized;
}

function normalizeString(value) {
  return String(value || "").trim();
}

function ensureOmarIncluded(registryAgents = [], selectedAgents = []) {
  const omarAgent = registryAgents.find((agent) => agent.id === "omar");
  if (!omarAgent) {
    throw new Error("Swarm registry must include 'omar' orchestrator.");
  }
  if (selectedAgents.some((agent) => agent.id === "omar")) {
    return [...selectedAgents];
  }
  return [omarAgent, ...selectedAgents];
}

function printSwarmSummary(payload = {}) {
  console.log(pc.bold("Swarm plan generated"));
  console.log(pc.gray(`Run: ${payload.runId}`));
  console.log(pc.gray(`Plan JSON: ${payload.planJsonPath}`));
  console.log(pc.gray(`Plan Markdown: ${payload.planMarkdownPath}`));
  console.log(`Scenario: ${payload.scenario}`);
  console.log(`Agents: ${payload.selectedAgents.join(", ")}`);
  console.log(
    `Budgets: cost<=${payload.globalBudget.maxCostUsd} tokens<=${payload.globalBudget.maxOutputTokens} runtime_ms<=${payload.globalBudget.maxRuntimeMs} tools<=${payload.globalBudget.maxToolCalls}`
  );
}

function printRuntimeSummary(payload = {}) {
  console.log(pc.bold("Swarm runtime complete"));
  console.log(pc.gray(`Runtime run: ${payload.runtimeRunId}`));
  console.log(pc.gray(`Plan run: ${payload.planRunId}`));
  console.log(pc.gray(`Runtime JSON: ${payload.runtimeJsonPath}`));
  console.log(pc.gray(`Runtime events: ${payload.runtimeEventsPath}`));
  console.log(`Status: ${payload.completed ? "completed" : `stopped (${payload.stop.stopClass})`}`);
  console.log(
    `Usage: output_tokens=${payload.usage.outputTokens} tool_calls=${payload.usage.toolCalls} duration_ms=${payload.usage.durationMs} cost_usd=${payload.usage.costUsd}`
  );
}

function printPentestSummary(payload = {}) {
  console.log(pc.bold("Swarm pen-test complete"));
  console.log(pc.gray(`Run: ${payload.runId}`));
  console.log(pc.gray(`Report JSON: ${payload.reportJsonPath}`));
  console.log(pc.gray(`Report Markdown: ${payload.reportMarkdownPath}`));
  console.log(pc.gray(`Audit log: ${payload.auditLogPath}`));
  console.log(`Target: ${payload.target.url} (${payload.target.targetId})`);
  console.log(`Scenario: ${payload.scenarioId}`);
  console.log(
    `Findings: P0=${payload.summary.P0} P1=${payload.summary.P1} P2=${payload.summary.P2} P3=${payload.summary.P3}`
  );
}

export function registerSwarmCommand(program) {
  const swarm = program
    .command("swarm")
    .description("Plan OMAR-governed swarm execution with deterministic assignments and budgets");

  swarm
    .command("registry")
    .description("List swarm agent registry records")
    .option("--registry-file <path>", "Optional custom swarm registry file")
    .option("--json", "Emit machine-readable output")
    .action(async (options, command) => {
      const emitJson = shouldEmitJson(options, command);
      const registry = await loadSwarmRegistry({
        registryFile: options.registryFile,
      });
      const payload = {
        command: "swarm registry",
        registrySource: registry.registrySource,
        registryFile: registry.registryFile,
        agentCount: registry.agents.length,
        agents: registry.agents,
      };

      if (emitJson) {
        console.log(JSON.stringify(payload, null, 2));
        return;
      }

      console.log(pc.bold("Swarm registry"));
      console.log(pc.gray(`Source: ${registry.registrySource}`));
      for (const agent of registry.agents) {
        console.log(`- ${agent.id} (${agent.persona}) :: ${agent.domain} [${agent.role}]`);
      }
    });

  swarm
    .command("create")
    .description("Create a governed swarm run (Phase 12.6 pen-test mode)")
    .option("--path <path>", "Target workspace path", ".")
    .option("--output-dir <path>", "Optional artifact output root override")
    .option("--scenario <id>", "Scenario identifier (`pen-test` or built-in pen-test scenario)", "pen-test")
    .option(
      "--pen-test-scenario <id>",
      "Built-in pen-test scenario when --scenario pen-test",
      "auth-bypass"
    )
    .option("--target <url>", "Target URL to test")
    .option("--target-id <id>", "Approved AIdenID target id")
    .option("--execute", "Execute live HTTP probes (default is dry-run logging)")
    .option("--json", "Emit machine-readable output")
    .action(async (options, command) => {
      const emitJson = shouldEmitJson(options, command);
      const targetPath = path.resolve(process.cwd(), String(options.path || "."));
      if (!normalizeString(options.target)) {
        throw new Error("--target is required.");
      }
      if (!normalizeString(options.targetId)) {
        throw new Error("--target-id is required.");
      }

      const report = await runSwarmPentest({
        targetPath,
        outputDir: options.outputDir,
        targetId: options.targetId,
        targetUrl: options.target,
        scenario: options.scenario,
        pentestScenario: options.penTestScenario,
        execute: Boolean(options.execute),
        env: process.env,
      });

      const payload = {
        command: "swarm create",
        mode: "pen-test",
        runId: report.runId,
        scenario: report.scenario,
        scenarioId: report.scenarioId,
        execute: report.execute,
        target: report.target,
        summary: report.summary,
        auditChain: report.auditChain,
        checkCount: report.checkCount,
        requestCount: report.requestCount,
        reportJsonPath: report.reportJsonPath,
        reportMarkdownPath: report.reportMarkdownPath,
        auditLogPath: report.auditLogPath,
        identityIsolationPath: report.identityIsolationPath,
        cleanupContractPath: report.cleanupContractPath,
        requestPlanPath: report.requestPlanPath,
        supportedPentestScenarios: listBuiltinPentestScenarios().map((item) => item.id),
      };

      if (emitJson) {
        console.log(JSON.stringify(payload, null, 2));
      } else {
        printPentestSummary(payload);
      }

      if (report.summary.blocking) {
        process.exitCode = 2;
      }
    });

  const scenario = swarm
    .command("scenario")
    .description("Create and validate swarm scenario DSL files");

  scenario
    .command("init")
    .description("Write scenario DSL template")
    .argument("<scenarioId>", "Scenario identifier")
    .option("--path <path>", "Target workspace path", ".")
    .option("--output <path>", "Output file path (default: .sentinelayer/scenarios/<scenarioId>.sls)")
    .option("--start-url <url>", "Default start URL for template", "https://example.com")
    .option("--json", "Emit machine-readable output")
    .action(async (scenarioId, options, command) => {
      const emitJson = shouldEmitJson(options, command);
      const targetPath = path.resolve(process.cwd(), String(options.path || "."));
      const result = await writeScenarioTemplate({
        scenarioId,
        targetPath,
        outputFile: options.output,
        startUrl: options.startUrl,
      });
      const payload = {
        command: "swarm scenario init",
        scenarioId,
        filePath: result.filePath,
        template: renderScenarioTemplate({
          scenarioId,
          startUrl: options.startUrl,
        }),
      };

      if (emitJson) {
        console.log(JSON.stringify(payload, null, 2));
        return;
      }

      console.log(pc.bold("Swarm scenario template generated"));
      console.log(pc.gray(`Scenario: ${scenarioId}`));
      console.log(pc.gray(`File: ${result.filePath}`));
    });

  scenario
    .command("validate")
    .description("Validate scenario DSL file")
    .option("--file <path>", "Scenario DSL file path")
    .option("--json", "Emit machine-readable output")
    .action(async (options, command) => {
      const emitJson = shouldEmitJson(options, command);
      if (!normalizeString(options.file)) {
        throw new Error("--file is required.");
      }
      const parsed = await parseScenarioFile(options.file);
      const validation = validateScenarioSpec(parsed.spec);
      const payload = {
        command: "swarm scenario validate",
        filePath: parsed.filePath,
        scenarioId: parsed.spec.id,
        startUrl: parsed.spec.startUrl,
        actionCount: parsed.spec.actions.length,
        valid: validation.valid,
        errors: validation.errors,
      };

      if (emitJson) {
        console.log(JSON.stringify(payload, null, 2));
        if (!validation.valid) {
          process.exitCode = 2;
        }
        return;
      }

      if (validation.valid) {
        console.log(pc.green("Scenario DSL valid"));
      } else {
        console.log(pc.red("Scenario DSL invalid"));
        for (const error of validation.errors) {
          console.log(`- ${error}`);
        }
        process.exitCode = 2;
      }
      console.log(pc.gray(`File: ${parsed.filePath}`));
    });

  swarm
    .command("plan")
    .description("Build deterministic swarm execution plan + artifacts")
    .argument("[targetPath]", "Target workspace path", ".")
    .option("--path <path>", "Target workspace path override")
    .option("--registry-file <path>", "Optional custom swarm registry file")
    .option("--agents <ids>", "Comma-separated agent ids (default: full registry)", "")
    .option("--scenario <id>", "Scenario identifier", "qa_audit")
    .option(
      "--objective <text>",
      "Execution objective",
      "Run OMAR-governed quality/security swarm analysis with deterministic handoffs."
    )
    .option("--max-parallel <n>", "Maximum specialist agents processed in parallel", "4")
    .option("--max-cost-usd <n>", "Global max cost budget", "5")
    .option("--max-output-tokens <n>", "Global max output-token budget", "20000")
    .option("--max-runtime-ms <n>", "Global max runtime budget (ms)", "3600000")
    .option("--max-tool-calls <n>", "Global max tool-call budget", "500")
    .option("--warning-threshold-percent <n>", "Budget warning threshold percent", "80")
    .option("--output-dir <path>", "Optional artifact output root override")
    .option("--json", "Emit machine-readable output")
    .action(async (targetPathArg, options, command) => {
      const emitJson = shouldEmitJson(options, command);
      const targetPath = path.resolve(process.cwd(), String(options.path || targetPathArg || "."));

      const registry = await loadSwarmRegistry({
        registryFile: options.registryFile,
      });
      const selected = selectSwarmAgents(registry.agents, options.agents);
      if (selected.missing.length > 0) {
        throw new Error(`Unknown agent id(s): ${selected.missing.join(", ")}`);
      }
      if (selected.selected.length === 0) {
        throw new Error("No agents selected for swarm plan.");
      }

      const selectedAgents = ensureOmarIncluded(registry.agents, selected.selected);

      const plan = buildSwarmExecutionPlan({
        targetPath,
        scenario: options.scenario,
        objective: options.objective,
        agents: selectedAgents,
        maxParallel: parseMaxParallel(options.maxParallel),
        globalBudget: {
          maxCostUsd: parsePositiveNumber(options.maxCostUsd, "max-cost-usd"),
          maxOutputTokens: parsePositiveNumber(options.maxOutputTokens, "max-output-tokens"),
          maxRuntimeMs: parsePositiveNumber(options.maxRuntimeMs, "max-runtime-ms"),
          maxToolCalls: parsePositiveNumber(options.maxToolCalls, "max-tool-calls"),
          warningThresholdPercent: parsePositiveNumber(
            options.warningThresholdPercent,
            "warning-threshold-percent"
          ),
        },
        registrySource: registry.registrySource,
        registryFile: registry.registryFile,
      });

      const artifacts = await writeSwarmPlanArtifacts({
        plan,
        outputDir: options.outputDir,
        env: process.env,
      });

      const payload = {
        command: "swarm plan",
        targetPath: plan.targetPath,
        runId: plan.runId,
        scenario: plan.scenario,
        objective: plan.objective,
        maxParallel: plan.maxParallel,
        registrySource: plan.registrySource,
        registryFile: plan.registryFile,
        selectedAgents: plan.selectedAgents,
        globalBudget: plan.globalBudget,
        summary: plan.summary,
        runDirectory: artifacts.runDirectory,
        planJsonPath: artifacts.planJsonPath,
        planMarkdownPath: artifacts.planMarkdownPath,
      };

      if (emitJson) {
        console.log(JSON.stringify(payload, null, 2));
        return;
      }

      printSwarmSummary(payload);
    });

  swarm
    .command("dashboard")
    .description("Show or watch runtime swarm dashboard snapshots from artifact streams")
    .option("--path <path>", "Target workspace path", ".")
    .option("--run-id <id>", "Runtime run id (defaults to latest swarm-runtime run)")
    .option("--output-dir <path>", "Optional artifact output root override")
    .option("--watch", "Stream dashboard snapshots until completion/idle timeout")
    .option("--poll-seconds <n>", "Polling interval for --watch", "2")
    .option("--max-idle-seconds <n>", "Idle timeout for --watch", "20")
    .option("--json", "Emit machine-readable output")
    .action(async (options, command) => {
      const emitJson = shouldEmitJson(options, command);
      const targetPath = path.resolve(process.cwd(), String(options.path || "."));

      if (!options.watch) {
        const snapshot = await loadSwarmDashboardSnapshot({
          targetPath,
          outputDir: options.outputDir,
          runId: options.runId,
          env: process.env,
        });
        const payload = {
          command: "swarm dashboard",
          mode: "snapshot",
          ...snapshot,
        };
        if (emitJson) {
          console.log(JSON.stringify(payload, null, 2));
          return;
        }
        console.log(pc.bold("Swarm dashboard snapshot"));
        console.log(renderSwarmDashboard(snapshot));
        return;
      }

      const streamedSnapshots = [];
      const watchResult = await watchSwarmDashboard({
        targetPath,
        outputDir: options.outputDir,
        runId: options.runId,
        pollSeconds: parsePollSeconds(options.pollSeconds, "poll-seconds"),
        maxIdleSeconds: parsePollSeconds(options.maxIdleSeconds, "max-idle-seconds"),
        env: process.env,
        onSnapshot: async (snapshot) => {
          streamedSnapshots.push(snapshot);
          if (!emitJson) {
            console.log("");
            console.log(pc.bold(`Swarm dashboard update @ ${snapshot.generatedAt}`));
            console.log(renderSwarmDashboard(snapshot));
          }
        },
      });

      const payload = {
        command: "swarm dashboard",
        mode: "watch",
        snapshotCount: streamedSnapshots.length,
        stopReason: watchResult.stopReason,
        finalSnapshot: watchResult.finalSnapshot,
      };

      if (emitJson) {
        console.log(JSON.stringify(payload, null, 2));
        return;
      }

      console.log("");
      console.log(pc.bold("Swarm dashboard watch complete"));
      console.log(pc.gray(`Snapshots: ${payload.snapshotCount}`));
      console.log(pc.gray(`Stop reason: ${payload.stopReason}`));
    });

  swarm
    .command("report")
    .description("Build deterministic swarm execution report bundle from runtime artifacts")
    .option("--path <path>", "Target workspace path", ".")
    .option("--run-id <id>", "Runtime run id (defaults to latest swarm-runtime run)")
    .option("--plan-file <path>", "Optional explicit SWARM_PLAN.json path")
    .option("--output-dir <path>", "Optional artifact output root override")
    .option("--json", "Emit machine-readable output")
    .action(async (options, command) => {
      const emitJson = shouldEmitJson(options, command);
      const targetPath = path.resolve(process.cwd(), String(options.path || "."));
      const report = await buildSwarmExecutionReport({
        targetPath,
        outputDir: options.outputDir,
        runId: options.runId,
        planFile: options.planFile,
        env: process.env,
      });
      const payload = {
        command: "swarm report",
        runtimeRunId: report.runtimeRunId,
        planRunId: report.planRunId,
        scenario: report.scenario,
        completed: report.completed,
        stop: report.stop,
        usage: report.usage,
        eventCount: report.eventCount,
        agentSummary: report.agentSummary,
        reportJsonPath: report.reportJsonPath,
        reportMarkdownPath: report.reportMarkdownPath,
        runtimeJsonPath: report.runtimeJsonPath,
        runtimeEventsPath: report.runtimeEventsPath,
        planJsonPath: report.planJsonPath,
      };

      if (emitJson) {
        console.log(JSON.stringify(payload, null, 2));
        return;
      }

      console.log(pc.bold("Swarm execution report generated"));
      console.log(pc.gray(`Runtime run: ${payload.runtimeRunId}`));
      console.log(pc.gray(`Report JSON: ${payload.reportJsonPath}`));
      console.log(pc.gray(`Report Markdown: ${payload.reportMarkdownPath}`));
      console.log(
        `Usage: output_tokens=${payload.usage.outputTokens || 0} tool_calls=${payload.usage.toolCalls || 0} duration_ms=${payload.usage.durationMs || 0} cost_usd=${payload.usage.costUsd || 0}`
      );
    });

  swarm
    .command("run")
    .description("Execute a governed swarm runtime loop (mock by default, optional Playwright adapter)")
    .argument("[targetPath]", "Target workspace path", ".")
    .option("--path <path>", "Target workspace path override")
    .option("--plan-file <path>", "Existing `SWARM_PLAN.json` to execute")
    .option("--playbook-file <path>", "Optional Playwright playbook JSON ({ actions: [...] })")
    .option("--scenario-file <path>", "Scenario DSL file (.sls) for runtime actions")
    .option("--registry-file <path>", "Optional custom swarm registry file (when building plan inline)")
    .option("--agents <ids>", "Comma-separated agent ids for inline plan mode", "security,testing,reliability")
    .option("--agent <id>", "Single agent id alias for --agents")
    .option("--scope <scope>", "Runtime scope alias for --scenario, used by devTestBot")
    .option("--identity-id <id>", "AIdenID identity id for devTestBot runtime")
    .option("--scenario <id>", "Scenario identifier for inline plan mode", "qa_audit")
    .option(
      "--objective <text>",
      "Execution objective for inline plan mode",
      "Run OMAR-governed runtime loop with deterministic artifact lineage."
    )
    .option("--max-parallel <n>", "Max specialist parallelism for inline plan mode", "3")
    .option("--max-steps <n>", "Maximum runtime steps before forced stop", "20")
    .option("--engine <mode>", "Runtime engine mode (`mock` or `playwright`)", "mock")
    .option("--start-url <url>", "Initial URL for Playwright mode", "about:blank")
    .option("--execute", "Enable live execution (default is dry-run simulation)")
    .option("--max-cost-usd <n>", "Global max cost budget for inline plan mode", "5")
    .option("--max-output-tokens <n>", "Global max output-token budget for inline plan mode", "20000")
    .option("--max-runtime-ms <n>", "Global max runtime budget for inline plan mode", "3600000")
    .option("--max-tool-calls <n>", "Global max tool-call budget for inline plan mode", "500")
    .option("--warning-threshold-percent <n>", "Budget warning threshold percent", "80")
    .option("--output-dir <path>", "Optional artifact output root override")
    .option("--json", "Emit machine-readable output")
    .action(async (targetPathArg, options, command) => {
      const emitJson = shouldEmitJson(options, command);
      const explicitTargetPath = normalizeString(options.path || targetPathArg);
      if (normalizeString(options.playbookFile) && normalizeString(options.scenarioFile)) {
        throw new Error("Use either --playbook-file or --scenario-file, not both.");
      }

      let playbookActions = await loadSwarmPlaybook(options.playbookFile);
      let scenarioSource = "flags";
      let scenarioIdOverride = "";
      let startUrlOverride = "";
      if (normalizeString(options.scenarioFile)) {
        const parsedScenario = await parseScenarioFile(options.scenarioFile);
        const validation = validateScenarioSpec(parsedScenario.spec);
        if (!validation.valid) {
          throw new Error(`Scenario DSL invalid: ${validation.errors.join("; ")}`);
        }
        playbookActions = parsedScenario.spec.actions;
        scenarioSource = "scenario_dsl";
        scenarioIdOverride = normalizeString(parsedScenario.spec.id);
        startUrlOverride = normalizeString(parsedScenario.spec.startUrl);
      }

      let plan;
      let inlinePlanArtifacts = null;
      let targetPath = path.resolve(process.cwd(), explicitTargetPath || ".");

      if (normalizeString(options.planFile)) {
        plan = await loadSwarmPlanFile(options.planFile);
        if (!explicitTargetPath) {
          targetPath = path.resolve(String(plan.targetPath || "."));
        }
      } else {
        const registry = await loadSwarmRegistry({
          registryFile: options.registryFile,
        });
        const selected = selectSwarmAgents(registry.agents, options.agent || options.agents);
        if (selected.missing.length > 0) {
          throw new Error(`Unknown agent id(s): ${selected.missing.join(", ")}`);
        }
        if (selected.selected.length === 0) {
          throw new Error("No agents selected for swarm runtime.");
        }
        const selectedAgents = ensureOmarIncluded(registry.agents, selected.selected);
        plan = buildSwarmExecutionPlan({
          targetPath,
          scenario: scenarioIdOverride || options.scope || options.scenario,
          objective: options.objective,
          agents: selectedAgents,
          maxParallel: parseMaxParallel(options.maxParallel),
          globalBudget: {
            maxCostUsd: parsePositiveNumber(options.maxCostUsd, "max-cost-usd"),
            maxOutputTokens: parsePositiveNumber(options.maxOutputTokens, "max-output-tokens"),
            maxRuntimeMs: parsePositiveNumber(options.maxRuntimeMs, "max-runtime-ms"),
            maxToolCalls: parsePositiveNumber(options.maxToolCalls, "max-tool-calls"),
            warningThresholdPercent: parsePositiveNumber(
              options.warningThresholdPercent,
              "warning-threshold-percent"
            ),
          },
          registrySource: registry.registrySource,
          registryFile: registry.registryFile,
        });
        inlinePlanArtifacts = await writeSwarmPlanArtifacts({
          plan,
          outputDir: options.outputDir,
          env: process.env,
        });
      }

      const runtime = await runSwarmRuntime({
        plan,
        targetPath,
        engine: options.engine,
        execute: Boolean(options.execute),
        maxSteps: parseMaxSteps(options.maxSteps),
        startUrl: startUrlOverride || options.startUrl,
        identityId: options.identityId,
        devTestBotScope: options.scope || scenarioIdOverride || options.scenario,
        playbookActions,
        outputDir: options.outputDir,
        env: process.env,
      });

      const payload = {
        command: "swarm run",
        targetPath: runtime.targetPath,
        runtimeRunId: runtime.runId,
        planRunId: runtime.planRunId,
        scenario: runtime.scenario,
        scenarioSource,
        scenarioFile: normalizeString(options.scenarioFile),
        engine: runtime.engine,
        execute: runtime.execute,
        completed: runtime.completed,
        stop: runtime.stop,
        usage: runtime.usage,
        eventCount: runtime.eventCount,
        findingCount: runtime.findingCount,
        findings: runtime.findings,
        artifactBundles: runtime.artifactBundles,
        devTestBotRuns: runtime.devTestBotRuns,
        runtimeDirectory: runtime.runtimeDirectory,
        runtimeJsonPath: runtime.runtimeJsonPath,
        runtimeMarkdownPath: runtime.runtimeMarkdownPath,
        runtimeEventsPath: runtime.runtimeEventsPath,
        inlinePlanPath: inlinePlanArtifacts?.planJsonPath || "",
      };

      if (emitJson) {
        console.log(JSON.stringify(payload, null, 2));
      } else {
        printRuntimeSummary(payload);
      }

      if (!runtime.completed) {
        process.exitCode = 2;
      }
    });
}
