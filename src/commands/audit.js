import path from "node:path";
import process from "node:process";

import pc from "picocolors";

import { runAuditOrchestrator } from "../audit/orchestrator.js";
import { loadAuditRunReport, resolveAuditRunDirectory, writeDdPackage } from "../audit/package.js";
import { writeAuditComparisonArtifact } from "../audit/replay.js";
import { loadAuditRegistry, selectAuditAgents } from "../audit/registry.js";
import { resolveOutputRoot } from "../config/service.js";
import { createAgentEvent } from "../events/schema.js";
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

function parseIsolationMode(rawValue) {
  const normalized = String(rawValue || "strict").trim().toLowerCase();
  if (normalized === "strict" || normalized === "relaxed") {
    return normalized;
  }
  throw new Error("isolation must be one of: strict, relaxed.");
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

function buildAuditOrchestratorEventHandler(emitStream) {
  if (!emitStream) {
    return null;
  }
  return (evt) => {
    console.log(JSON.stringify(evt));
  };
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
    .option("--isolation <mode>", "Persona isolation mode: strict | relaxed", "strict")
    .option("--no-seed-from-deterministic", "Run personas without deterministic baseline or specialist seed findings")
    .option("--stream", "Emit NDJSON agent events to stdout")
    .option("--json", "Emit machine-readable output")
    .action(async (targetPathArg, options, command) => {
      const emitJson = shouldEmitJson(options, command);
      const emitStream = Boolean(options.stream);
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
        isolation: parseIsolationMode(options.isolation),
        seedFromDeterministic: options.seedFromDeterministic !== false,
        onEvent: buildAuditOrchestratorEventHandler(emitStream),
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
        isolation: result.isolation,
        seedFromDeterministic: result.seedFromDeterministic !== false,
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
      } else if (!emitStream) {
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
        isolation: baseReport.isolation || "strict",
        seedFromDeterministic: baseReport.seedFromDeterministic !== false,
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
        isolation: replayResult.isolation,
        seedFromDeterministic: replayResult.seedFromDeterministic !== false,
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

  // ── Persona subcommands: sl audit <persona-name-or-domain> ─────────
  //
  // Every persona follows the same architecture:
  //   1. Ingest codebase (auto-refresh if stale)
  //   2. Run Omar baseline (7-layer deterministic) — persona does NOT see results yet
  //   3. Build scope map from ingest
  //   4. Wire memory (blackboard for sub-agents + FAISS recall from previous runs)
  //   5. Run persona agentic loop BLIND-FIRST (no baseline anchoring)
  //   6. After persona completes: RECONCILIATION against Omar baseline
  //   7. Write artifacts + report
  //
  // Jules Tanaka (frontend) was the first onboarded, but all 13 personas
  // share the same tool-equipped, budget-governed, isolated-context runtime.
  //
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
    .option("--skip-baseline", "Skip Omar deterministic baseline (not recommended)")
    .option("--url <url>", "Deployed URL for runtime audit (Lighthouse, headers, DevTools)")
    .option("--skip-runtime", "Skip runtime audit even if URL is detected")
    .option("--output-dir <path>", "Artifact output root override")
    .option("--json", "Emit machine-readable final output")
    .action(async (options, command) => {
      const emitJson = shouldEmitJson(options, command);
      const emitStream = Boolean(options.stream);
      const targetPath = path.resolve(process.cwd(), String(options.path || "."));

      // Lazy-load modules
      const { julesAuditLoop } = await import("../agents/jules/loop.js");
      const { JULES_DEFINITION } = await import("../agents/jules/config/definition.js");
      const { collectCodebaseIngest, generateCodebaseIngest } = await import("../ingest/engine.js");
      const { resolveOutputRoot: resolveOut } = await import("../config/service.js");
      const { createBlackboard } = await import("../memory/blackboard.js");
      const { runDeterministicReviewPipeline } = await import("../review/local-review.js");
      const fsp = await import("node:fs/promises");

      const outputRoot = await resolveOut({ targetPath, outputDir: options.outputDir });
      const artifactDir = path.join(outputRoot, "reports", "jules-" + Date.now());
      await fsp.mkdir(artifactDir, { recursive: true });

      // Build event handler
      const onEvent = buildEventHandler(emitStream, emitJson, JULES_DEFINITION);

      emitProgress(onEvent, JULES_DEFINITION, "Starting Jules Tanaka frontend audit...");

      // ── [1] INGEST ────────────────────────────────────────────────
      emitProgress(onEvent, JULES_DEFINITION, "Ingesting codebase...");
      let ingest;
      try {
        ingest = await generateCodebaseIngest({
          rootPath: targetPath, outputDir: outputRoot,
          refresh: Boolean(options.refresh),
        });
      } catch {
        ingest = await collectCodebaseIngest({ rootPath: targetPath });
      }
      emitProgress(onEvent, JULES_DEFINITION,
        "Ingest complete: " + (ingest?.summary?.filesScanned || 0) + " files, " +
        (ingest?.summary?.totalLoc || 0) + " LOC");

      // ── [2] OMAR BASELINE (blind — Jules won't see until reconciliation) ──
      let omarBaseline = null;
      if (!options.skipBaseline) {
        emitProgress(onEvent, JULES_DEFINITION, "Running Omar 7-layer deterministic baseline...");
        try {
          omarBaseline = await runDeterministicReviewPipeline({
            targetPath,
            mode: "full",
            outputDir: artifactDir,
          });
          emitProgress(onEvent, JULES_DEFINITION,
            "Baseline complete: P0=" + (omarBaseline?.summary?.P0 || 0) +
            " P1=" + (omarBaseline?.summary?.P1 || 0) +
            " P2=" + (omarBaseline?.summary?.P2 || 0) +
            " (held for reconciliation — Jules runs blind-first)");
        } catch (err) {
          emitProgress(onEvent, JULES_DEFINITION,
            "Baseline failed (non-blocking): " + err.message);
        }
      }

      // ── [3] SCOPE MAP ─────────────────────────────────────────────
      const scopeMap = buildScopeMapFromIngest(ingest, JULES_DEFINITION.defaultScope);
      emitProgress(onEvent, JULES_DEFINITION,
        "Scope: " + (scopeMap.primary?.length || 0) + " primary, " +
        (scopeMap.secondary?.length || 0) + " secondary files");

      // ── [4] MEMORY ────────────────────────────────────────────────
      const blackboard = createBlackboard();
      let memoryIndex = null;
      try {
        const { queryRetrievalIndex } = await import("../memory/retrieval.js");
        memoryIndex = {
          query: (opts) => queryRetrievalIndex({ targetPath, ...opts }),
          index: (docs) => {}, // indexing happens after completion
        };
      } catch { /* memory retrieval unavailable — non-blocking */ }

      // ── [5] PROVIDER ──────────────────────────────────────────────
      const providerConfig = {};
      if (options.provider) providerConfig.provider = options.provider;
      if (options.model) providerConfig.model = options.model;
      if (options.apiKey) providerConfig.apiKey = options.apiKey;

      // ── [6] SYSTEM PROMPT (full production prompt) ─────────────────
      const { buildJulesProductionPrompt } = await import("../agents/jules/config/system-prompt.js");
      const systemPrompt = buildJulesProductionPrompt({
        mode: options.mode,
        framework: ingest?.frameworks?.[0] || "unknown",
        componentCount: ingest?.indexedFiles?.files?.filter(
          f => /\.(tsx|jsx|vue|svelte)$/.test(f.path || ""),
        ).length || 0,
        scopeMap,
        ingestSummary: ingest?.summary || {},
      });

      // ── [7] JULES AGENTIC LOOP (BLIND-FIRST — no baseline) ───────
      emitProgress(onEvent, JULES_DEFINITION, "Starting blind-first deep analysis...");
      let report;
      const gen = julesAuditLoop({
        systemPrompt,
        scopeMap,
        rootPath: targetPath,
        // omarBaseline intentionally NOT passed here — Jules runs blind
        blackboard,
        memory: memoryIndex,
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

      let julesFindings = [];
      for await (const evt of gen) {
        if (evt.event === "agent_complete") {
          report = evt;
          julesFindings = evt.payload?.findings || [];
        }
      }

      // ── [7.5] RUNTIME AUDIT (if --url provided or URL detected) ────
      let runtimeResult = null;
      const runtimeUrl = options.url || null;
      if (runtimeUrl || !options.skipRuntime) {
        emitProgress(onEvent, JULES_DEFINITION, "Checking for deployed URL...");
        try {
          const { runtimeAudit: runRT } = await import("../agents/jules/tools/runtime-audit.js");

          // Detect URL if not provided
          let targetUrl = runtimeUrl;
          if (!targetUrl) {
            const detected = runRT({ operation: "detect_deployed_url", path: targetPath });
            if (detected.found) {
              targetUrl = detected.primary;
              emitProgress(onEvent, JULES_DEFINITION, "Detected deployed URL: " + targetUrl);
            }
          }

          if (targetUrl) {
            emitProgress(onEvent, JULES_DEFINITION, "Running runtime audit on " + targetUrl + "...");

            // Response headers (security check)
            const headers = runRT({ operation: "check_response_headers", url: targetUrl });
            if (headers.available && headers.securityFindings) {
              for (const hf of headers.securityFindings) {
                julesFindings.push({
                  severity: hf.severity, file: targetUrl, line: 0,
                  title: "Missing security header: " + hf.header,
                  evidence: "HTTP response from " + targetUrl + " lacks " + hf.header,
                  source: "runtime_audit",
                });
              }
            }

            // Network waterfall
            const waterfall = runRT({ operation: "check_network_waterfall", url: targetUrl });

            // Lighthouse (if available)
            const lighthouse = runRT({ operation: "lighthouse_scan", url: targetUrl, path: targetPath });

            runtimeResult = { url: targetUrl, headers, waterfall, lighthouse };
            emitProgress(onEvent, JULES_DEFINITION,
              "Runtime audit complete" +
              (lighthouse.available ? " (Lighthouse: perf=" + ((lighthouse.scores?.performance || 0) * 100).toFixed(0) + "%)" : "") +
              (headers.available ? " (" + (headers.securityFindings?.length || 0) + " header findings)" : ""));
          } else {
            emitProgress(onEvent, JULES_DEFINITION, "No deployed URL found — skipping runtime audit");
          }
        } catch (rtErr) {
          emitProgress(onEvent, JULES_DEFINITION, "Runtime audit failed (non-blocking): " + rtErr.message);
        }
      }

      // ── [8] RECONCILIATION (now Jules gets the baseline) ──────────
      emitProgress(onEvent, JULES_DEFINITION, "Reconciling against Omar baseline...");
      const reconciliation = reconcileWithBaseline(julesFindings, omarBaseline);

      if (onEvent && reconciliation.summary) {
        onEvent(createAgentEvent({
          event: "reconciliation_complete",
          agent: {
            id: JULES_DEFINITION.id,
            persona: JULES_DEFINITION.persona,
            color: JULES_DEFINITION.color,
            avatar: JULES_DEFINITION.avatar,
          },
          payload: reconciliation.summary,
        }));
      }

      // ── [9] FINAL REPORT ──────────────────────────────────────────
      const allFindings = [
        ...reconciliation.preserved,
        ...reconciliation.newFromJules,
      ];
      const severityCounts = { P0: 0, P1: 0, P2: 0, P3: 0 };
      for (const f of allFindings) {
        const sev = (f.severity || "P3").toUpperCase();
        if (severityCounts[sev] !== undefined) severityCounts[sev]++;
        else severityCounts.P3++;
      }

      const reportPayload = {
        command: "audit frontend",
        persona: JULES_DEFINITION.persona,
        targetPath,
        mode: options.mode,
        framework: ingest?.frameworks?.[0] || "unknown",
        findings: allFindings,
        summary: { total: allFindings.length, ...severityCounts, blocking: severityCounts.P0 > 0 || severityCounts.P1 > 0 },
        reconciliation: reconciliation.summary,
        baseline: omarBaseline ? { ran: true, findingCount: omarBaseline.findings?.length || 0 } : { ran: false },
        runtime: runtimeResult ? {
          ran: true, url: runtimeResult.url,
          lighthouse: runtimeResult.lighthouse?.available ? runtimeResult.lighthouse.scores : null,
          headerFindings: runtimeResult.headers?.securityFindings?.length || 0,
        } : { ran: false },
        julesUsage: report?.usage || {},
        signature: JULES_DEFINITION.signature,
      };

      await fsp.writeFile(
        path.join(artifactDir, "JULES_AUDIT.json"),
        JSON.stringify(reportPayload, null, 2),
      );

      // Write baseline artifact if it exists
      if (omarBaseline) {
        await fsp.writeFile(
          path.join(artifactDir, "OMAR_BASELINE.json"),
          JSON.stringify(omarBaseline, null, 2),
        );
      }

      // Write reconciliation artifact
      await fsp.writeFile(
        path.join(artifactDir, "RECONCILIATION.json"),
        JSON.stringify(reconciliation, null, 2),
      );

      if (emitJson) {
        console.log(JSON.stringify(reportPayload, null, 2));
      } else if (!emitStream) {
        process.stderr.write("\n" + JULES_DEFINITION.signature + "\n");
        process.stderr.write("Report: " + artifactDir + "/JULES_AUDIT.json\n");
        if (omarBaseline) {
          process.stderr.write("Baseline: " + artifactDir + "/OMAR_BASELINE.json\n");
        }
        process.stderr.write("Reconciliation: " + artifactDir + "/RECONCILIATION.json\n");
        process.stderr.write("Summary: " + allFindings.length + " findings (P0=" + severityCounts.P0 + " P1=" + severityCounts.P1 + " P2=" + severityCounts.P2 + ")\n");
      }

      // Sync run to dashboard (fire-and-forget)
      try {
        const { syncRunToDashboard } = await import("../telemetry/sync.js");
        const syncResult = await syncRunToDashboard({
          command: "audit frontend",
          persona: JULES_DEFINITION.persona,
          mode: options.mode,
          framework: ingest?.frameworks?.[0] || "unknown",
          summary: { total: allFindings.length, ...severityCounts, blocking: severityCounts.P0 > 0 || severityCounts.P1 > 0 },
          usage: report?.usage || {},
          stopReason: report?.usage?.stopReason || "completed",
          reconciliation: reconciliation.summary,
          runtime: runtimeResult ? { ran: true, url: runtimeResult.url } : { ran: false },
        });
        if (!emitJson && !emitStream && syncResult.synced) {
          process.stderr.write(JULES_DEFINITION.avatar + " Run synced to dashboard" + (syncResult.runId ? " (run:" + syncResult.runId + ")" : "") + "\n");
        }
      } catch { /* sync failure never blocks CLI */ }

      if (severityCounts.P0 > 0 || severityCounts.P1 > 0) {
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

// ── Reconciliation ──────────────────────────────────────────────────

function reconcileWithBaseline(julesFindings, omarBaseline) {
  if (!omarBaseline || !omarBaseline.findings || !Array.isArray(omarBaseline.findings)) {
    return {
      preserved: julesFindings || [],
      newFromJules: [],
      rejectedBaseline: [],
      corroboratedBaseline: [],
      summary: {
        julesCount: (julesFindings || []).length,
        baselineCount: 0,
        preserved: (julesFindings || []).length,
        corroborated: 0,
        rejected: 0,
        newFromJules: 0,
      },
    };
  }

  const baselineFindings = omarBaseline.findings;
  const corroborated = [];
  const rejected = [];
  const newFromJules = [];

  // Build a fingerprint set from baseline for matching
  const baselineFingerprints = new Set();
  for (const bf of baselineFindings) {
    const fp = (bf.file || "") + ":" + (bf.line || "") + ":" + (bf.severity || "");
    baselineFingerprints.add(fp);
  }

  // Classify Jules findings
  const julesMatched = new Set();
  for (const jf of (julesFindings || [])) {
    const fp = (jf.file || "") + ":" + (jf.line || "") + ":" + (jf.severity || "");
    if (baselineFingerprints.has(fp)) {
      corroborated.push({ ...jf, source: "corroborated", baselineMatch: true });
      julesMatched.add(fp);
    } else {
      newFromJules.push({ ...jf, source: "jules_new" });
    }
  }

  // Baseline findings not corroborated by Jules — preserved (not silently dropped)
  const preservedBaseline = [];
  for (const bf of baselineFindings) {
    const fp = (bf.file || "") + ":" + (bf.line || "") + ":" + (bf.severity || "");
    if (!julesMatched.has(fp)) {
      preservedBaseline.push({ ...bf, source: "baseline_preserved" });
    }
  }

  return {
    preserved: [...corroborated, ...preservedBaseline],
    newFromJules,
    rejectedBaseline: rejected,
    corroboratedBaseline: corroborated,
    summary: {
      julesCount: (julesFindings || []).length,
      baselineCount: baselineFindings.length,
      preserved: corroborated.length + preservedBaseline.length,
      corroborated: corroborated.length,
      preservedFromBaseline: preservedBaseline.length,
      rejected: rejected.length,
      newFromJules: newFromJules.length,
    },
  };
}

// ── Event helpers ───────────────────────────────────────────────────

function buildEventHandler(emitStream, emitJson, def) {
  if (emitStream) return (evt) => console.log(JSON.stringify(evt));
  if (emitJson) return undefined;
  return (evt) => {
    if (evt.event === "progress") {
      process.stderr.write(def.avatar + " " + def.shortName + ": " + (evt.payload?.message || "") + "\n");
    } else if (evt.event === "finding") {
      const f = evt.payload;
      process.stderr.write(def.avatar + " [" + (f.severity || "P3") + "] " + (f.file || "") + ":" + (f.line || "") + " " + (f.title || "") + "\n");
    } else if (evt.event === "heartbeat") {
      const h = evt.payload;
      process.stderr.write(def.avatar + " " + def.shortName + " [" + (h.turnsCompleted || 0) + "/" + (h.turnsMax || "?") + " turns, $" + (h.budgetRemaining?.costUsd?.toFixed(2) || "?") + "]\n");
    } else if (evt.event === "agent_complete") {
      process.stderr.write(def.avatar + " " + def.persona + " complete: " + (evt.payload?.total || 0) + " findings (P0=" + (evt.payload?.P0 || 0) + " P1=" + (evt.payload?.P1 || 0) + " P2=" + (evt.payload?.P2 || 0) + ")\n");
    } else if (evt.event === "reconciliation_complete") {
      const r = evt.payload;
      process.stderr.write(def.avatar + " Reconciliation: " + (r.corroborated || 0) + " corroborated, " + (r.newFromJules || 0) + " new, " + (r.preservedFromBaseline || 0) + " baseline preserved\n");
    }
  };
}

function emitProgress(onEvent, def, message) {
  if (onEvent) {
    onEvent(createAgentEvent({
      event: "progress",
      agent: { id: def.id, persona: def.persona, color: def.color, avatar: def.avatar },
      payload: { phase: "setup", message },
    }));
  }
}
