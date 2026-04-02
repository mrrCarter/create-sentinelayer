import path from "node:path";
import process from "node:process";

import pc from "picocolors";

import { runAuditOrchestrator } from "../audit/orchestrator.js";
import { loadAuditRegistry, selectAuditAgents } from "../audit/registry.js";
import { buildLegacyArgs } from "./legacy-args.js";

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

function printAuditSummary(result) {
  console.log(pc.bold("Audit orchestrator complete"));
  console.log(pc.gray(`Run: ${result.runId}`));
  console.log(pc.gray(`Report: ${result.reportMarkdownPath}`));
  console.log(pc.gray(`JSON: ${result.reportJsonPath}`));
  console.log(
    `Summary: P0=${result.summary.P0} P1=${result.summary.P1} P2=${result.summary.P2} P3=${result.summary.P3}`
  );
  console.log(`Agents: ${result.agentResults.length}, max_parallel=${result.maxParallel}`);
}

export function registerAuditCommand(program, invokeLegacy) {
  const audit = program
    .command("audit")
    .description("Run audit orchestrator swarm or local compatibility audit")
    .argument("[targetPath]", "Target workspace path", ".")
    .option("--path <path>", "Target workspace path override")
    .option("--agents <ids>", "Comma-separated agent ids (default: all built-in agents)", "")
    .option("--max-parallel <n>", "Maximum agents processed in parallel", "3")
    .option("--registry-file <path>", "Optional custom audit registry file")
    .option("--output-dir <path>", "Optional artifact output root override")
    .option("--dry-run", "Skip deterministic baseline and run orchestration planning only")
    .option("--json", "Emit machine-readable output")
    .action(async (targetPathArg, options, command) => {
      const emitJson = shouldEmitJson(options, command);
      const targetPath = path.resolve(process.cwd(), String(options.path || targetPathArg || "."));
      const registry = await loadAuditRegistry({
        registryFile: options.registryFile,
      });
      const selected = selectAuditAgents(registry.agents, options.agents);
      if (selected.missing.length > 0) {
        throw new Error(`Unknown agent id(s): ${selected.missing.join(", ")}`);
      }
      if (selected.selected.length === 0) {
        throw new Error("No agents selected for audit run.");
      }

      const result = await runAuditOrchestrator({
        targetPath,
        agents: selected.selected,
        maxParallel: parseMaxParallel(options.maxParallel),
        outputDir: options.outputDir,
        dryRun: Boolean(options.dryRun),
      });

      const payload = {
        command: "audit",
        targetPath: result.targetPath,
        runId: result.runId,
        runDirectory: result.runDirectory,
        reportPath: result.reportMarkdownPath,
        reportJsonPath: result.reportJsonPath,
        dryRun: result.dryRun,
        registrySource: registry.registrySource,
        registryFile: registry.registryFile,
        selectedAgents: result.selectedAgents,
        maxParallel: result.maxParallel,
        summary: result.summary,
        agentCount: result.agentResults.length,
      };

      if (emitJson) {
        console.log(JSON.stringify(payload, null, 2));
      } else {
        printAuditSummary(result);
      }

      if (result.summary.blocking) {
        process.exitCode = 2;
      }
    });

  audit
    .command("registry")
    .description("List audit agent registry records")
    .option("--registry-file <path>", "Optional custom audit registry file")
    .option("--json", "Emit machine-readable output")
    .action(async (options, command) => {
      const emitJson = shouldEmitJson(options, command);
      const registry = await loadAuditRegistry({
        registryFile: options.registryFile,
      });
      const payload = {
        command: "audit registry",
        registrySource: registry.registrySource,
        registryFile: registry.registryFile,
        agentCount: registry.agents.length,
        agents: registry.agents,
      };

      if (emitJson) {
        console.log(JSON.stringify(payload, null, 2));
        return;
      }

      console.log(pc.bold("Audit registry"));
      console.log(pc.gray(`Source: ${registry.registrySource}`));
      for (const agent of registry.agents) {
        console.log(`- ${agent.id} (${agent.persona}) :: ${agent.domain}`);
      }
    });

  audit
    .command("security")
    .description("Run security specialist agent only")
    .option("--path <path>", "Target workspace path", ".")
    .option("--registry-file <path>", "Optional custom audit registry file")
    .option("--output-dir <path>", "Optional artifact output root override")
    .option("--dry-run", "Skip deterministic baseline and run security planning only")
    .option("--json", "Emit machine-readable output")
    .action(async (options, command) => {
      const emitJson = shouldEmitJson(options, command);
      const targetPath = path.resolve(process.cwd(), String(options.path || "."));
      const registry = await loadAuditRegistry({
        registryFile: options.registryFile,
      });
      const selected = selectAuditAgents(registry.agents, "security");
      if (selected.selected.length !== 1) {
        throw new Error("Security specialist agent is unavailable in the current registry.");
      }

      const result = await runAuditOrchestrator({
        targetPath,
        agents: selected.selected,
        maxParallel: 1,
        outputDir: options.outputDir,
        dryRun: Boolean(options.dryRun),
      });
      const securityAgent = result.agentResults.find((agent) => agent.agentId === "security") || null;

      const payload = {
        command: "audit security",
        targetPath: result.targetPath,
        runId: result.runId,
        runDirectory: result.runDirectory,
        reportPath: result.reportMarkdownPath,
        reportJsonPath: result.reportJsonPath,
        securityAgentPath: securityAgent?.artifactPath || null,
        securitySpecialistReportPath: securityAgent?.specialistReportPath || null,
        summary: result.summary,
        specialistSummary: securityAgent?.summary || null,
        dryRun: result.dryRun,
      };

      if (emitJson) {
        console.log(JSON.stringify(payload, null, 2));
      } else {
        console.log(pc.bold("Security specialist audit complete"));
        console.log(pc.gray(`Run: ${result.runId}`));
        console.log(pc.gray(`Report: ${result.reportMarkdownPath}`));
        if (payload.securitySpecialistReportPath) {
          console.log(pc.gray(`Security report: ${payload.securitySpecialistReportPath}`));
        }
        console.log(
          `Summary: P0=${result.summary.P0} P1=${result.summary.P1} P2=${result.summary.P2} P3=${result.summary.P3}`
        );
      }

      if (result.summary.blocking) {
        process.exitCode = 2;
      }
    });

  audit
    .command("architecture")
    .description("Run architecture specialist agent only")
    .option("--path <path>", "Target workspace path", ".")
    .option("--registry-file <path>", "Optional custom audit registry file")
    .option("--output-dir <path>", "Optional artifact output root override")
    .option("--dry-run", "Skip deterministic baseline and run architecture planning only")
    .option("--json", "Emit machine-readable output")
    .action(async (options, command) => {
      const emitJson = shouldEmitJson(options, command);
      const targetPath = path.resolve(process.cwd(), String(options.path || "."));
      const registry = await loadAuditRegistry({
        registryFile: options.registryFile,
      });
      const selected = selectAuditAgents(registry.agents, "architecture");
      if (selected.selected.length !== 1) {
        throw new Error("Architecture specialist agent is unavailable in the current registry.");
      }

      const result = await runAuditOrchestrator({
        targetPath,
        agents: selected.selected,
        maxParallel: 1,
        outputDir: options.outputDir,
        dryRun: Boolean(options.dryRun),
      });
      const architectureAgent =
        result.agentResults.find((agent) => agent.agentId === "architecture") || null;

      const payload = {
        command: "audit architecture",
        targetPath: result.targetPath,
        runId: result.runId,
        runDirectory: result.runDirectory,
        reportPath: result.reportMarkdownPath,
        reportJsonPath: result.reportJsonPath,
        architectureAgentPath: architectureAgent?.artifactPath || null,
        architectureSpecialistReportPath: architectureAgent?.specialistReportPath || null,
        summary: result.summary,
        specialistSummary: architectureAgent?.summary || null,
        dryRun: result.dryRun,
      };

      if (emitJson) {
        console.log(JSON.stringify(payload, null, 2));
      } else {
        console.log(pc.bold("Architecture specialist audit complete"));
        console.log(pc.gray(`Run: ${result.runId}`));
        console.log(pc.gray(`Report: ${result.reportMarkdownPath}`));
        if (payload.architectureSpecialistReportPath) {
          console.log(pc.gray(`Architecture report: ${payload.architectureSpecialistReportPath}`));
        }
        console.log(
          `Summary: P0=${result.summary.P0} P1=${result.summary.P1} P2=${result.summary.P2} P3=${result.summary.P3}`
        );
      }

      if (result.summary.blocking) {
        process.exitCode = 2;
      }
    });

  audit
    .command("testing")
    .description("Run testing specialist agent only")
    .option("--path <path>", "Target workspace path", ".")
    .option("--registry-file <path>", "Optional custom audit registry file")
    .option("--output-dir <path>", "Optional artifact output root override")
    .option("--dry-run", "Skip deterministic baseline and run testing planning only")
    .option("--json", "Emit machine-readable output")
    .action(async (options, command) => {
      const emitJson = shouldEmitJson(options, command);
      const targetPath = path.resolve(process.cwd(), String(options.path || "."));
      const registry = await loadAuditRegistry({
        registryFile: options.registryFile,
      });
      const selected = selectAuditAgents(registry.agents, "testing");
      if (selected.selected.length !== 1) {
        throw new Error("Testing specialist agent is unavailable in the current registry.");
      }

      const result = await runAuditOrchestrator({
        targetPath,
        agents: selected.selected,
        maxParallel: 1,
        outputDir: options.outputDir,
        dryRun: Boolean(options.dryRun),
      });
      const testingAgent = result.agentResults.find((agent) => agent.agentId === "testing") || null;

      const payload = {
        command: "audit testing",
        targetPath: result.targetPath,
        runId: result.runId,
        runDirectory: result.runDirectory,
        reportPath: result.reportMarkdownPath,
        reportJsonPath: result.reportJsonPath,
        testingAgentPath: testingAgent?.artifactPath || null,
        testingSpecialistReportPath: testingAgent?.specialistReportPath || null,
        summary: result.summary,
        specialistSummary: testingAgent?.summary || null,
        dryRun: result.dryRun,
      };

      if (emitJson) {
        console.log(JSON.stringify(payload, null, 2));
      } else {
        console.log(pc.bold("Testing specialist audit complete"));
        console.log(pc.gray(`Run: ${result.runId}`));
        console.log(pc.gray(`Report: ${result.reportMarkdownPath}`));
        if (payload.testingSpecialistReportPath) {
          console.log(pc.gray(`Testing report: ${payload.testingSpecialistReportPath}`));
        }
        console.log(
          `Summary: P0=${result.summary.P0} P1=${result.summary.P1} P2=${result.summary.P2} P3=${result.summary.P3}`
        );
      }

      if (result.summary.blocking) {
        process.exitCode = 2;
      }
    });

  audit
    .command("performance")
    .description("Run performance specialist agent only")
    .option("--path <path>", "Target workspace path", ".")
    .option("--registry-file <path>", "Optional custom audit registry file")
    .option("--output-dir <path>", "Optional artifact output root override")
    .option("--dry-run", "Skip deterministic baseline and run performance planning only")
    .option("--json", "Emit machine-readable output")
    .action(async (options, command) => {
      const emitJson = shouldEmitJson(options, command);
      const targetPath = path.resolve(process.cwd(), String(options.path || "."));
      const registry = await loadAuditRegistry({
        registryFile: options.registryFile,
      });
      const selected = selectAuditAgents(registry.agents, "performance");
      if (selected.selected.length !== 1) {
        throw new Error("Performance specialist agent is unavailable in the current registry.");
      }

      const result = await runAuditOrchestrator({
        targetPath,
        agents: selected.selected,
        maxParallel: 1,
        outputDir: options.outputDir,
        dryRun: Boolean(options.dryRun),
      });
      const performanceAgent =
        result.agentResults.find((agent) => agent.agentId === "performance") || null;

      const payload = {
        command: "audit performance",
        targetPath: result.targetPath,
        runId: result.runId,
        runDirectory: result.runDirectory,
        reportPath: result.reportMarkdownPath,
        reportJsonPath: result.reportJsonPath,
        performanceAgentPath: performanceAgent?.artifactPath || null,
        performanceSpecialistReportPath: performanceAgent?.specialistReportPath || null,
        summary: result.summary,
        specialistSummary: performanceAgent?.summary || null,
        dryRun: result.dryRun,
      };

      if (emitJson) {
        console.log(JSON.stringify(payload, null, 2));
      } else {
        console.log(pc.bold("Performance specialist audit complete"));
        console.log(pc.gray(`Run: ${result.runId}`));
        console.log(pc.gray(`Report: ${result.reportMarkdownPath}`));
        if (payload.performanceSpecialistReportPath) {
          console.log(pc.gray(`Performance report: ${payload.performanceSpecialistReportPath}`));
        }
        console.log(
          `Summary: P0=${result.summary.P0} P1=${result.summary.P1} P2=${result.summary.P2} P3=${result.summary.P3}`
        );
      }

      if (result.summary.blocking) {
        process.exitCode = 2;
      }
    });

  audit
    .command("compliance")
    .description("Run compliance specialist agent only")
    .option("--path <path>", "Target workspace path", ".")
    .option("--registry-file <path>", "Optional custom audit registry file")
    .option("--output-dir <path>", "Optional artifact output root override")
    .option("--dry-run", "Skip deterministic baseline and run compliance planning only")
    .option("--json", "Emit machine-readable output")
    .action(async (options, command) => {
      const emitJson = shouldEmitJson(options, command);
      const targetPath = path.resolve(process.cwd(), String(options.path || "."));
      const registry = await loadAuditRegistry({
        registryFile: options.registryFile,
      });
      const selected = selectAuditAgents(registry.agents, "compliance");
      if (selected.selected.length !== 1) {
        throw new Error("Compliance specialist agent is unavailable in the current registry.");
      }

      const result = await runAuditOrchestrator({
        targetPath,
        agents: selected.selected,
        maxParallel: 1,
        outputDir: options.outputDir,
        dryRun: Boolean(options.dryRun),
      });
      const complianceAgent =
        result.agentResults.find((agent) => agent.agentId === "compliance") || null;

      const payload = {
        command: "audit compliance",
        targetPath: result.targetPath,
        runId: result.runId,
        runDirectory: result.runDirectory,
        reportPath: result.reportMarkdownPath,
        reportJsonPath: result.reportJsonPath,
        complianceAgentPath: complianceAgent?.artifactPath || null,
        complianceSpecialistReportPath: complianceAgent?.specialistReportPath || null,
        summary: result.summary,
        specialistSummary: complianceAgent?.summary || null,
        dryRun: result.dryRun,
      };

      if (emitJson) {
        console.log(JSON.stringify(payload, null, 2));
      } else {
        console.log(pc.bold("Compliance specialist audit complete"));
        console.log(pc.gray(`Run: ${result.runId}`));
        console.log(pc.gray(`Report: ${result.reportMarkdownPath}`));
        if (payload.complianceSpecialistReportPath) {
          console.log(pc.gray(`Compliance report: ${payload.complianceSpecialistReportPath}`));
        }
        console.log(
          `Summary: P0=${result.summary.P0} P1=${result.summary.P1} P2=${result.summary.P2} P3=${result.summary.P3}`
        );
      }

      if (result.summary.blocking) {
        process.exitCode = 2;
      }
    });

  audit
    .command("documentation")
    .description("Run documentation specialist agent only")
    .option("--path <path>", "Target workspace path", ".")
    .option("--registry-file <path>", "Optional custom audit registry file")
    .option("--output-dir <path>", "Optional artifact output root override")
    .option("--dry-run", "Skip deterministic baseline and run documentation planning only")
    .option("--json", "Emit machine-readable output")
    .action(async (options, command) => {
      const emitJson = shouldEmitJson(options, command);
      const targetPath = path.resolve(process.cwd(), String(options.path || "."));
      const registry = await loadAuditRegistry({
        registryFile: options.registryFile,
      });
      const selected = selectAuditAgents(registry.agents, "documentation");
      if (selected.selected.length !== 1) {
        throw new Error("Documentation specialist agent is unavailable in the current registry.");
      }

      const result = await runAuditOrchestrator({
        targetPath,
        agents: selected.selected,
        maxParallel: 1,
        outputDir: options.outputDir,
        dryRun: Boolean(options.dryRun),
      });
      const documentationAgent =
        result.agentResults.find((agent) => agent.agentId === "documentation") || null;

      const payload = {
        command: "audit documentation",
        targetPath: result.targetPath,
        runId: result.runId,
        runDirectory: result.runDirectory,
        reportPath: result.reportMarkdownPath,
        reportJsonPath: result.reportJsonPath,
        documentationAgentPath: documentationAgent?.artifactPath || null,
        documentationSpecialistReportPath: documentationAgent?.specialistReportPath || null,
        summary: result.summary,
        specialistSummary: documentationAgent?.summary || null,
        dryRun: result.dryRun,
      };

      if (emitJson) {
        console.log(JSON.stringify(payload, null, 2));
      } else {
        console.log(pc.bold("Documentation specialist audit complete"));
        console.log(pc.gray(`Run: ${result.runId}`));
        console.log(pc.gray(`Report: ${result.reportMarkdownPath}`));
        if (payload.documentationSpecialistReportPath) {
          console.log(pc.gray(`Documentation report: ${payload.documentationSpecialistReportPath}`));
        }
        console.log(
          `Summary: P0=${result.summary.P0} P1=${result.summary.P1} P2=${result.summary.P2} P3=${result.summary.P3}`
        );
      }

      if (result.summary.blocking) {
        process.exitCode = 2;
      }
    });

  audit
    .command("local")
    .description("Compatibility mode: run legacy local readiness + policy audit")
    .option("--path <path>", "Target repository path")
    .option("--output-dir <path>", "Artifact root for report output")
    .option("--json", "Emit machine-readable output")
    .action(async (options, command) => {
      const legacyArgs = buildLegacyArgs(["/audit"], {
        commandOptions: options,
        command,
      });
      await invokeLegacy(legacyArgs);
    });
}
