import path from "node:path";
import process from "node:process";

import pc from "picocolors";

import { runAuditOrchestrator } from "../audit/orchestrator.js";
import { loadAuditRunReport, resolveAuditRunDirectory, writeDdPackage } from "../audit/package.js";
import { writeAuditComparisonArtifact } from "../audit/replay.js";
import { loadAuditRegistry, selectAuditAgents } from "../audit/registry.js";
import { resolveOutputRoot } from "../config/service.js";
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
  if (result.sharedMemory?.artifactPath) {
    console.log(pc.gray(`Shared memory: ${result.sharedMemory.artifactPath}`));
  }
  if (result.ddPackage?.executiveSummaryPath) {
    console.log(pc.gray(`DD package: ${result.ddPackage.executiveSummaryPath}`));
  }
  if (result.ingest?.refresh?.stale || result.ingest?.refresh?.refreshed) {
    const reasons = (result.ingest?.refresh?.reasons || []).join(", ") || "none";
    const line = `Ingest refresh: refreshed=${result.ingest?.refresh?.refreshed ? "yes" : "no"} stale=${
      result.ingest?.refresh?.stale ? "yes" : "no"
    } reasons=${reasons}`;
    const color = result.ingest?.refresh?.stale && !result.ingest?.refresh?.refreshed ? pc.yellow : pc.gray;
    console.log(color(line));
  }
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
    .option("--refresh", "Refresh CODEBASE_INGEST before running audit")
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
        refreshIngest: Boolean(options.refresh),
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
        sharedMemoryPath: result.sharedMemory?.artifactPath || "",
        sharedMemoryEntryCount: Number(result.sharedMemory?.entryCount || 0),
        sharedMemoryQueryCount: Number(result.sharedMemory?.queryCount || 0),
        ddPackageManifestPath: result.ddPackage?.manifestPath || "",
        ddPackageFindingsPath: result.ddPackage?.findingsIndexPath || "",
        ddPackageSummaryPath: result.ddPackage?.executiveSummaryPath || "",
        ingestRefresh: result.ingest?.refresh || null,
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
    .command("package")
    .description("Build or rebuild a unified DD package from an audit run")
    .option("--path <path>", "Target workspace path", ".")
    .option("--run-id <id>", "Audit run id (defaults to latest run under output root)")
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
      const runDirectory = await resolveAuditRunDirectory({
        outputRoot,
        runId: options.runId,
      });
      const { report } = await loadAuditRunReport(runDirectory);
      const ddPackage = await writeDdPackage({
        report,
        runDirectory,
      });

      const payload = {
        command: "audit package",
        targetPath,
        outputRoot,
        runId: report.runId,
        runDirectory,
        reportPath: path.join(runDirectory, "AUDIT_REPORT.md"),
        reportJsonPath: path.join(runDirectory, "AUDIT_REPORT.json"),
        ddPackageManifestPath: ddPackage.manifestPath,
        ddPackageFindingsPath: ddPackage.findingsIndexPath,
        ddPackageSummaryPath: ddPackage.executiveSummaryPath,
        findingsIndexCount: ddPackage.findingsIndexCount,
      };

      if (emitJson) {
        console.log(JSON.stringify(payload, null, 2));
      } else {
        console.log(pc.bold("Audit DD package complete"));
        console.log(pc.gray(`Run: ${payload.runId}`));
        console.log(pc.gray(`Manifest: ${payload.ddPackageManifestPath}`));
        console.log(pc.gray(`Summary: ${payload.ddPackageSummaryPath}`));
      }
    });

  audit
    .command("replay")
    .description("Replay an existing audit run with the same selected agent set")
    .argument("<runId>", "Base audit run id to replay")
    .option("--path <path>", "Workspace path override (defaults to original run target)")
    .option("--registry-file <path>", "Optional custom audit registry file")
    .option("--output-dir <path>", "Optional artifact output root override")
    .option("--refresh", "Refresh CODEBASE_INGEST before replay")
    .option("--json", "Emit machine-readable output")
    .action(async (runId, options, command) => {
      const emitJson = shouldEmitJson(options, command);
      const initialTargetPath = path.resolve(process.cwd(), String(options.path || "."));
      const outputRoot = await resolveOutputRoot({
        cwd: initialTargetPath,
        outputDirOverride: options.outputDir,
        env: process.env,
      });
      const baseRunDirectory = await resolveAuditRunDirectory({
        outputRoot,
        runId,
      });
      const { report: baseReport } = await loadAuditRunReport(baseRunDirectory);
      const targetPath = options.path
        ? path.resolve(process.cwd(), String(options.path || "."))
        : path.resolve(String(baseReport.targetPath || "."));

      const registry = await loadAuditRegistry({
        registryFile: options.registryFile,
      });
      const selected = selectAuditAgents(registry.agents, (baseReport.selectedAgents || []).join(","));
      if (selected.selected.length === 0) {
        throw new Error("No eligible agents available for replay in the active registry.");
      }

      const replayResult = await runAuditOrchestrator({
        targetPath,
        agents: selected.selected,
        maxParallel: Number(baseReport.maxParallel || 1),
        outputDir: options.outputDir,
        dryRun: Boolean(baseReport.dryRun),
        refreshIngest: Boolean(options.refresh),
      });

      const comparison = await writeAuditComparisonArtifact({
        baseReport,
        candidateReport: replayResult,
        outputDirectory: replayResult.runDirectory,
      });

      const payload = {
        command: "audit replay",
        baseRunId: baseReport.runId,
        replayRunId: replayResult.runId,
        targetPath: replayResult.targetPath,
        runDirectory: replayResult.runDirectory,
        reportPath: replayResult.reportMarkdownPath,
        reportJsonPath: replayResult.reportJsonPath,
        comparisonPath: comparison.outputPath,
        deterministicEquivalent: comparison.comparison.deterministicEquivalent,
        addedCount: comparison.comparison.addedCount,
        removedCount: comparison.comparison.removedCount,
        ingestRefresh: replayResult.ingest?.refresh || null,
      };

      if (emitJson) {
        console.log(JSON.stringify(payload, null, 2));
      } else {
        console.log(pc.bold("Audit replay complete"));
        console.log(pc.gray(`Base run: ${payload.baseRunId}`));
        console.log(pc.gray(`Replay run: ${payload.replayRunId}`));
        console.log(pc.gray(`Comparison: ${payload.comparisonPath}`));
      }
    });

  audit
    .command("diff")
    .description("Diff two audit runs and emit a reproducibility comparison artifact")
    .argument("<baseRunId>", "Base run id")
    .argument("<candidateRunId>", "Candidate run id")
    .option("--path <path>", "Workspace path for resolving output root", ".")
    .option("--output-dir <path>", "Optional artifact output root override")
    .option("--json", "Emit machine-readable output")
    .action(async (baseRunId, candidateRunId, options, command) => {
      const emitJson = shouldEmitJson(options, command);
      const targetPath = path.resolve(process.cwd(), String(options.path || "."));
      const outputRoot = await resolveOutputRoot({
        cwd: targetPath,
        outputDirOverride: options.outputDir,
        env: process.env,
      });
      const baseRunDirectory = await resolveAuditRunDirectory({
        outputRoot,
        runId: baseRunId,
      });
      const candidateRunDirectory = await resolveAuditRunDirectory({
        outputRoot,
        runId: candidateRunId,
      });
      const { report: baseReport } = await loadAuditRunReport(baseRunDirectory);
      const { report: candidateReport } = await loadAuditRunReport(candidateRunDirectory);
      const comparison = await writeAuditComparisonArtifact({
        baseReport,
        candidateReport,
        outputDirectory: candidateRunDirectory,
      });

      const payload = {
        command: "audit diff",
        baseRunId: baseReport.runId,
        candidateRunId: candidateReport.runId,
        outputPath: comparison.outputPath,
        deterministicEquivalent: comparison.comparison.deterministicEquivalent,
        addedCount: comparison.comparison.addedCount,
        removedCount: comparison.comparison.removedCount,
      };

      if (emitJson) {
        console.log(JSON.stringify(payload, null, 2));
      } else {
        console.log(pc.bold("Audit diff complete"));
        console.log(pc.gray(`Comparison: ${payload.outputPath}`));
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
    .option("--refresh", "Refresh CODEBASE_INGEST before security specialist run")
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
        refreshIngest: Boolean(options.refresh),
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
        ingestRefresh: result.ingest?.refresh || null,
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
    .option("--refresh", "Refresh CODEBASE_INGEST before architecture specialist run")
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
        refreshIngest: Boolean(options.refresh),
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
        ingestRefresh: result.ingest?.refresh || null,
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
    .option("--refresh", "Refresh CODEBASE_INGEST before testing specialist run")
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
        refreshIngest: Boolean(options.refresh),
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
        ingestRefresh: result.ingest?.refresh || null,
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
    .option("--refresh", "Refresh CODEBASE_INGEST before performance specialist run")
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
        refreshIngest: Boolean(options.refresh),
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
        ingestRefresh: result.ingest?.refresh || null,
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
    .option("--refresh", "Refresh CODEBASE_INGEST before compliance specialist run")
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
        refreshIngest: Boolean(options.refresh),
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
        ingestRefresh: result.ingest?.refresh || null,
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
    .option("--refresh", "Refresh CODEBASE_INGEST before documentation specialist run")
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
        refreshIngest: Boolean(options.refresh),
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
        ingestRefresh: result.ingest?.refresh || null,
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

  // ── Jules Tanaka: sl audit frontend ────────────────────────────────
  audit
    .command("frontend")
    .alias("jules")
    .description("Jules Tanaka — Frontend Runtime deep audit with agentic tool access")
    .option("--path <path>", "Target repository path")
    .option("--mode <mode>", "Agent mode: primary | secondary | tertiary", "primary")
    .option("--max-cost <usd>", "Max cost budget in USD", "5.0")
    .option("--max-turns <n>", "Max agentic loop turns", "25")
    .option("--provider <name>", "LLM provider: openai | anthropic | google")
    .option("--model <id>", "LLM model override")
    .option("--api-key <key>", "Explicit API key override")
    .option("--stream", "Emit NDJSON events to stdout as Jules works")
    .option("--refresh", "Refresh CODEBASE_INGEST before auditing")
    .option("--output-dir <path>", "Artifact output root override")
    .option("--json", "Emit machine-readable final output")
    .action(async (options, command) => {
      const emitJson = shouldEmitJson(options, command);
      const emitStream = Boolean(options.stream);
      const targetPath = path.resolve(process.cwd(), String(options.path || "."));

      // Lazy-load Jules modules (only when invoked)
      const { julesAuditLoop } = await import("../agents/jules/loop.js");
      const { JULES_DEFINITION } = await import("../agents/jules/config/definition.js");
      const { collectCodebaseIngest } = await import("../ingest/engine.js");
      const { resolveOutputRoot: resolveOut } = await import("../config/service.js");
      const { createBlackboard } = await import("../memory/blackboard.js");

      const outputRoot = resolveOut({ targetPath, outputDir: options.outputDir });

      // Prerequisites: ingest
      let ingest;
      try {
        const { generateCodebaseIngest } = await import("../ingest/engine.js");
        ingest = await generateCodebaseIngest({
          rootPath: targetPath,
          outputDir: outputRoot,
          refresh: Boolean(options.refresh),
        });
      } catch {
        ingest = await collectCodebaseIngest({ rootPath: targetPath });
      }

      // Build scope map from ingest
      const scopeMap = buildScopeMapFromIngest(ingest, JULES_DEFINITION.defaultScope);

      // Blackboard for findings
      const blackboard = createBlackboard();

      // Provider config
      const providerConfig = {};
      if (options.provider) providerConfig.provider = options.provider;
      if (options.model) providerConfig.model = options.model;
      if (options.apiKey) providerConfig.apiKey = options.apiKey;

      // Event handler
      const onEvent = emitStream
        ? (evt) => console.log(JSON.stringify(evt))
        : emitJson
          ? undefined
          : (evt) => {
              if (evt.event === "progress") {
                process.stderr.write(`${JULES_DEFINITION.avatar} ${JULES_DEFINITION.shortName}: ${evt.payload.message}\n`);
              } else if (evt.event === "finding") {
                const f = evt.payload;
                process.stderr.write(`${JULES_DEFINITION.avatar} [${f.severity || "P3"}] ${f.file || ""}:${f.line || ""} ${f.title || ""}\n`);
              } else if (evt.event === "heartbeat") {
                const h = evt.payload;
                process.stderr.write(`${JULES_DEFINITION.avatar} ${JULES_DEFINITION.shortName} [${h.turnsCompleted}/${h.turnsMax} turns, $${h.budgetRemaining?.costUsd?.toFixed(2) || "?"}]\n`);
              } else if (evt.event === "agent_complete") {
                process.stderr.write(`${JULES_DEFINITION.avatar} ${JULES_DEFINITION.persona} complete: ${evt.payload.total} findings (P0=${evt.payload.P0} P1=${evt.payload.P1} P2=${evt.payload.P2})\n`);
              }
            };

      // Build system prompt (simplified — full prompt is in J-8 definition)
      const systemPrompt = buildJulesSystemPrompt(JULES_DEFINITION, {
        mode: options.mode,
        framework: ingest?.frameworks?.[0] || "unknown",
      });

      // Run the loop
      let report;
      const gen = julesAuditLoop({
        systemPrompt,
        scopeMap,
        rootPath: targetPath,
        blackboard,
        budget: {
          maxCostUsd: parseFloat(options.maxCost) || 5.0,
          maxOutputTokens: JULES_DEFINITION.budget.maxOutputTokens,
          maxRuntimeMs: JULES_DEFINITION.budget.maxRuntimeMs,
          maxToolCalls: JULES_DEFINITION.budget.maxToolCalls,
        },
        provider: providerConfig,
        mode: options.mode,
        maxTurns: parseInt(options.maxTurns) || 25,
        onEvent,
      });

      for await (const evt of gen) {
        if (evt.event === "agent_complete") {
          report = evt;
        }
      }

      // Write artifacts
      const fsp = await import("node:fs/promises");
      const artifactDir = path.join(outputRoot, "reports", `jules-${Date.now()}`);
      await fsp.mkdir(artifactDir, { recursive: true });

      const findings = report?.payload || {};
      const reportPayload = {
        command: "audit frontend",
        persona: JULES_DEFINITION.persona,
        targetPath,
        mode: options.mode,
        framework: ingest?.frameworks?.[0] || "unknown",
        ...findings,
        signature: JULES_DEFINITION.signature,
      };

      await fsp.writeFile(
        path.join(artifactDir, "JULES_AUDIT.json"),
        JSON.stringify(reportPayload, null, 2),
      );

      if (emitJson) {
        console.log(JSON.stringify(reportPayload, null, 2));
      } else if (!emitStream) {
        process.stderr.write(`\n${JULES_DEFINITION.signature}\nReport: ${artifactDir}/JULES_AUDIT.json\n`);
      }

      if (findings.P0 > 0 || findings.P1 > 0) {
        process.exitCode = 2;
      }
    });
}

// ── Helpers for Jules invocation ──────────────────────────────────────

function buildScopeMapFromIngest(ingest, defaultScope) {
  if (!ingest || !ingest.indexedFiles) {
    return { primary: [], secondary: [], tertiary: [] };
  }

  const files = (ingest.indexedFiles.files || []).map(f => ({
    path: f.path,
    loc: f.loc || 0,
    language: f.language || "",
  }));

  const matchesAny = (filePath, patterns) =>
    patterns.some(p => {
      const regex = new RegExp(
        "^" + p.replace(/\*\*/g, ".*").replace(/\*/g, "[^/]*") + "$",
      );
      return regex.test(filePath);
    });

  return {
    primary: files.filter(f => matchesAny(f.path, defaultScope.primaryPatterns)),
    secondary: files.filter(f => matchesAny(f.path, defaultScope.secondaryPatterns)),
    tertiary: files.filter(f => matchesAny(f.path, defaultScope.tertiaryPatterns)),
  };
}

function buildJulesSystemPrompt(definition, { mode, framework }) {
  return `You are ${definition.persona}, the ${definition.domain} persona for SentinelLayer.
You are a ${framework} production specialist whose job is to determine:
"Will users perceive this surface as fast, stable, and trustworthy?"

Mode: ${mode} — ${definition.modes[mode] || definition.modes.primary}

You have access to these tools: ${definition.auditTools.join(", ")}.
To call a tool, output a tool_use code block:
\`\`\`tool_use
{"tool": "FileRead", "input": {"file_path": "src/app/page.tsx"}}
\`\`\`

When done, return findings as a JSON array:
\`\`\`json
[{"severity": "P1", "file": "path", "line": 42, "title": "...", "evidence": "...", "rootCause": "...", "recommendedFix": "...", "trafficLight": "red"}]
\`\`\`

Evidence standard: every claim must have file:line or command output proof.
Never write "probably" or "likely fine" without evidence.

${definition.signature}`;
}
