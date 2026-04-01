import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp, mkdir, rm } from "node:fs/promises";

import {
  ensureEditableConfigPath,
  findConfigSource,
  listConfigKeys,
  loadConfig,
  resolveOutputRoot,
  setConfigValue,
} from "../src/config/service.js";
import {
  defaultPromptFileName,
  generateExecutionPrompt,
  resolvePromptTarget,
} from "../src/prompt/generator.js";
import {
  generateSpecMarkdown,
  inferProjectName,
  resolveSpecTemplate,
} from "../src/spec/generator.js";
import {
  enforceCostBudget,
  estimateCostUsd,
  estimateModelCost,
  listKnownModelPricing,
  rollupUsage,
} from "../src/cost/tracker.js";
import { buildCliProgram } from "../src/cli.js";

test("Unit: config layering resolves env > project > global and output root precedence", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "create-sentinelayer-unit-config-"));
  const projectDir = path.join(tempRoot, "project");
  const homeDir = path.join(tempRoot, "home");

  try {
    await mkdir(projectDir, { recursive: true });
    await mkdir(homeDir, { recursive: true });

    await setConfigValue({
      key: "apiUrl",
      value: "https://global.example.com",
      scope: "global",
      cwd: projectDir,
      homeDir,
    });
    await setConfigValue({
      key: "apiUrl",
      value: "https://project.example.com",
      scope: "project",
      cwd: projectDir,
      homeDir,
    });
    await setConfigValue({
      key: "outputDir",
      value: ".sentinelayer-custom",
      scope: "project",
      cwd: projectDir,
      homeDir,
    });

    const config = await loadConfig({
      cwd: projectDir,
      homeDir,
      env: {
        SENTINELAYER_API_URL: "https://env.example.com",
      },
    });
    assert.equal(config.resolved.apiUrl, "https://env.example.com");
    assert.equal(config.resolved.outputDir, ".sentinelayer-custom");
    assert.equal(findConfigSource(config, "apiUrl"), "env");

    const resolvedFromConfig = await resolveOutputRoot({
      cwd: projectDir,
      homeDir,
      env: {
        SENTINELAYER_API_URL: "https://env.example.com",
      },
    });
    assert.equal(resolvedFromConfig, path.resolve(projectDir, ".sentinelayer-custom"));

    const resolvedFromOverride = await resolveOutputRoot({
      cwd: projectDir,
      homeDir,
      outputDirOverride: "override-output",
      env: {},
    });
    assert.equal(resolvedFromOverride, path.resolve(projectDir, "override-output"));
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("Unit: config service exposes writable/editable guards and default output root fallback", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "create-sentinelayer-unit-config-"));
  const projectDir = path.join(tempRoot, "project");
  const homeDir = path.join(tempRoot, "home");

  try {
    await mkdir(projectDir, { recursive: true });
    await mkdir(homeDir, { recursive: true });

    await setConfigValue({
      key: "webUrl",
      value: "https://global-web.example.com",
      scope: "global",
      cwd: projectDir,
      homeDir,
    });
    await setConfigValue({
      key: "webUrl",
      value: "https://project-web.example.com",
      scope: "project",
      cwd: projectDir,
      homeDir,
    });

    const config = await loadConfig({
      cwd: projectDir,
      homeDir,
      env: {},
    });
    assert.equal(findConfigSource(config, "webUrl"), "project");

    const editableProject = await ensureEditableConfigPath({
      scope: "project",
      cwd: projectDir,
      homeDir,
    });
    assert.match(editableProject.path, /[\\/]project[\\/]\.sentinelayer\.yml$/);

    const editableGlobal = await ensureEditableConfigPath({
      scope: "global",
      cwd: projectDir,
      homeDir,
    });
    assert.match(editableGlobal.path, /[\\/]home[\\/]\.sentinelayer[\\/]config\.yml$/);

    const outputRoot = await resolveOutputRoot({
      cwd: projectDir,
      homeDir,
      env: {},
    });
    assert.equal(outputRoot, path.resolve(projectDir, ".sentinelayer"));

    const keys = listConfigKeys();
    assert.equal(Array.isArray(keys), true);
    assert.equal(keys.includes("apiUrl"), true);

    await assert.rejects(
      () =>
        setConfigValue({
          key: "apiUrl",
          value: "https://env-write.example.com",
          scope: "env",
          cwd: projectDir,
          homeDir,
        }),
      /Resolved scope is read-only|Cannot write scope/
    );
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("Unit: spec generator renders deterministic sections from template + ingest context", () => {
  const template = resolveSpecTemplate("api-service");
  const markdown = generateSpecMarkdown({
    template,
    description: "Deliver secure API hardening in iterative phases.",
    projectPath: "/repo/demo",
    ingest: {
      rootPath: "/repo/demo",
      summary: {
        filesScanned: 42,
        totalLoc: 1500,
      },
      languages: [{ language: "TypeScript", loc: 1200 }],
      frameworks: ["express"],
      entryPoints: ["src/index.ts"],
      riskSurfaces: [{ surface: "security_overlay" }, { surface: "supply_chain" }],
      packageMetadata: { name: "demo-service" },
    },
    generatedAt: "2026-04-01T00:00:00.000Z",
  });

  assert.match(markdown, /# SPEC - demo-service/);
  assert.match(markdown, /Template: api-service/);
  assert.match(markdown, /Deliver secure API hardening in iterative phases\./);
  assert.match(markdown, /## Security Checklist/);
  assert.match(markdown, /## Phase Plan/);
  assert.match(markdown, /Phase 1 - Foundation/);
});

test("Unit: spec helpers validate template ids and project-name inference", () => {
  const defaultTemplate = resolveSpecTemplate();
  assert.equal(defaultTemplate.id, "api-service");

  assert.throws(
    () => resolveSpecTemplate("unknown-template"),
    /Unknown spec template/
  );

  const inferredFromPackage = inferProjectName({
    ingest: {
      packageMetadata: {
        name: "from-package",
      },
    },
    projectPath: "/tmp/fallback",
  });
  assert.equal(inferredFromPackage, "from-package");

  const inferredFromPath = inferProjectName({
    ingest: {},
    projectPath: "/tmp/path-based-name",
  });
  assert.equal(inferredFromPath, "path-based-name");

  const fallbackMarkdown = generateSpecMarkdown({
    ingest: {
      rootPath: "/tmp/fallback",
      summary: {
        filesScanned: 1,
        totalLoc: 10,
      },
    },
    projectPath: "/tmp/fallback",
  });
  assert.match(fallbackMarkdown, /Entry points: none detected/);
  assert.match(fallbackMarkdown, /Risk surfaces: code_quality/);
});

test("Unit: prompt generator resolves target and embeds authoritative spec block", () => {
  const resolvedTarget = resolvePromptTarget("codex");
  assert.equal(resolvedTarget, "codex");
  assert.equal(defaultPromptFileName("generic"), "PROMPT.md");
  assert.equal(defaultPromptFileName("cursor"), "PROMPT_cursor.md");

  const prompt = generateExecutionPrompt({
    specMarkdown: "# SPEC - Prompt Unit Test\n\n## Goal\nValidate prompt shape.\n",
    target: "codex",
    projectPath: "/repo/demo",
    generatedAt: "2026-04-01T00:00:00.000Z",
  });

  assert.match(prompt, /Codex execution prompt/);
  assert.match(prompt, /Agent target: codex/);
  assert.match(prompt, /## Source Spec \(Authoritative\)/);
  assert.match(prompt, /# SPEC - Prompt Unit Test/);
  assert.throws(
    () => resolvePromptTarget("unknown-agent"),
    /Unsupported prompt target/
  );
  assert.throws(
    () =>
      generateExecutionPrompt({
        specMarkdown: "",
        target: "generic",
      }),
    /Spec content is empty/
  );
});

test("Unit: cost tracker estimates, aggregates, and enforces budget deterministically", () => {
  const directCost = estimateCostUsd({
    inputTokens: 100_000,
    outputTokens: 50_000,
    inputPerMillionUsd: 2,
    outputPerMillionUsd: 10,
  });
  assert.equal(directCost, 0.7);

  const modelCost = estimateModelCost({
    modelId: "gpt-5.3-codex",
    inputTokens: 100_000,
    outputTokens: 100_000,
  });
  assert.equal(modelCost, 0.75);

  const usage = rollupUsage([
    { inputTokens: 500, outputTokens: 200, costUsd: 0.01 },
    { inputTokens: 1000, outputTokens: 400, costUsd: 0.02 },
  ]);
  assert.deepEqual(usage, {
    inputTokens: 1500,
    outputTokens: 600,
    costUsd: 0.03,
  });

  const budgetStatus = enforceCostBudget({ totalCostUsd: 1.25, budgetUsd: 1.0 });
  assert.equal(budgetStatus.exceeded, true);
  assert.equal(budgetStatus.remainingUsd, 0);

  const pricing = listKnownModelPricing();
  assert.equal(Array.isArray(pricing), true);
  assert.equal(pricing.some((entry) => entry.modelId === "gpt-5.3-codex"), true);
  assert.equal(pricing.some((entry) => entry.modelId === "gpt-4o"), true);
  assert.equal(pricing.some((entry) => entry.modelId === "claude-sonnet-4"), true);

  assert.throws(
    () =>
      estimateModelCost({
        modelId: "",
        inputTokens: 1,
        outputTokens: 1,
      }),
    /modelId is required/
  );
  assert.throws(
    () =>
      estimateModelCost({
        modelId: "missing-model",
        inputTokens: 1,
        outputTokens: 1,
      }),
    /No pricing data configured/
  );
  assert.throws(
    () => rollupUsage("not-array"),
    /entries must be an array/
  );
  assert.throws(
    () =>
      estimateCostUsd({
        inputTokens: -1,
        outputTokens: 0,
      }),
    /inputTokens must be a non-negative number/
  );
  assert.throws(
    () =>
      estimateCostUsd({
        inputTokens: 0,
        outputTokens: 0,
        inputPerMillionUsd: -1,
      }),
    /inputPerMillionUsd must be a non-negative number/
  );
});

test("Unit: CLI command tree registers auth/watch/plugin command groups", () => {
  const program = buildCliProgram({ invokeLegacy: async () => {} });
  const commandNames = program.commands.map((command) => command.name());
  assert.equal(commandNames.includes("auth"), true);
  assert.equal(commandNames.includes("watch"), true);
  assert.equal(commandNames.includes("plugin"), true);
});
