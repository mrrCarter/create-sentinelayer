import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";

import pc from "picocolors";
import prompts from "prompts";

import {
  buildSecretSetupInstructions,
  buildSecurityReviewWorkflow,
  DEFAULT_SCAN_WORKFLOW_PATH,
  inferScanProfile,
  SUPPORTED_E2E_HINTS,
  SUPPORTED_PLAYWRIGHT_MODES,
  validateSecurityReviewWorkflow,
} from "../scan/generator.js";

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

export function registerScanCommand(program) {
  const scan = program.command("scan").description("Generate and validate Omar Gate workflow config");

  scan
    .command("init")
    .description("Generate .github/workflows/security-review.yml from spec context")
    .option("--path <path>", "Target workspace path", ".")
    .option("--spec-file <path>", "Spec file path relative to --path")
    .option(
      "--workflow-file <path>",
      "Workflow output path relative to --path",
      DEFAULT_SCAN_WORKFLOW_PATH
    )
    .option("--secret-name <name>", "GitHub Actions secret name for sentinelayer_token", "SENTINELAYER_TOKEN")
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
      const workflowFile = String(options.workflowFile || DEFAULT_SCAN_WORKFLOW_PATH).trim();
      const workflowPath = path.resolve(targetPath, workflowFile);
      const specPath = resolveSpecPath(targetPath, options.specFile);
      const specMarkdown = await fsp.readFile(specPath, "utf-8");

      const hasE2EHint = normalizeE2EHint(options.hasE2eTests);
      const playwrightMode = normalizePlaywrightMode(options.playwrightMode);
      const nonInteractive = Boolean(options.nonInteractive);

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
      const workflowMarkdown = buildSecurityReviewWorkflow({
        secretName: options.secretName,
        profile,
      });

      await fsp.mkdir(path.dirname(workflowPath), { recursive: true });
      await fsp.writeFile(workflowPath, workflowMarkdown, "utf-8");

      const instructions = buildSecretSetupInstructions(options.secretName);
      const payload = {
        command: "scan init",
        targetPath,
        specPath,
        workflowPath,
        profile,
        instructions,
      };

      if (shouldEmitJson(options, command)) {
        console.log(JSON.stringify(payload, null, 2));
        return;
      }

      console.log(pc.bold("Security review workflow generated"));
      console.log(pc.gray(`Spec: ${specPath}`));
      console.log(pc.gray(`Workflow: ${workflowPath}`));
      console.log(pc.gray(`scan_mode=${profile.scanMode}, severity_gate=${profile.severityGate}`));
      console.log(
        pc.gray(`playwright_mode=${profile.playwrightMode}, sbom_mode=${profile.sbomMode}`)
      );
      instructions.forEach((line) => console.log(line));
    });

  scan
    .command("validate")
    .description("Validate existing security-review workflow against current spec profile")
    .option("--path <path>", "Target workspace path", ".")
    .option("--spec-file <path>", "Spec file path relative to --path")
    .option(
      "--workflow-file <path>",
      "Workflow file path relative to --path",
      DEFAULT_SCAN_WORKFLOW_PATH
    )
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
      const workflowPath = path.resolve(
        targetPath,
        String(options.workflowFile || DEFAULT_SCAN_WORKFLOW_PATH).trim()
      );

      const specMarkdown = await fsp.readFile(specPath, "utf-8");
      const workflowMarkdown = await fsp.readFile(workflowPath, "utf-8");
      const expectedProfile = inferScanProfile({
        specMarkdown,
        hasE2ETests: normalizeE2EHint(options.hasE2eTests),
        playwrightMode: normalizePlaywrightMode(options.playwrightMode),
      });

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
}

