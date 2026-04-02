import path from "node:path";
import process from "node:process";

import pc from "picocolors";

import { buildSwarmExecutionPlan, writeSwarmPlanArtifacts } from "../swarm/factory.js";
import { loadSwarmRegistry, selectSwarmAgents } from "../swarm/registry.js";

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

function parsePositiveNumber(rawValue, fieldName) {
  const normalized = Number(rawValue || 0);
  if (!Number.isFinite(normalized) || normalized <= 0) {
    throw new Error(`${fieldName} must be a positive number.`);
  }
  return normalized;
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

      const omarAgent = registry.agents.find((agent) => agent.id === "omar");
      if (!omarAgent) {
        throw new Error("Swarm registry must include 'omar' orchestrator.");
      }
      const selectedAgents = selected.selected.some((agent) => agent.id === "omar")
        ? [...selected.selected]
        : [omarAgent, ...selected.selected];

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
}
