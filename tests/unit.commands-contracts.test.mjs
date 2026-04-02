import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp, rm, writeFile } from "node:fs/promises";

import { Command } from "commander";

import { registerAiCommand } from "../src/commands/ai.js";
import { registerDaemonCommand } from "../src/commands/daemon.js";
import { registerScanCommand } from "../src/commands/scan.js";
import { registerReviewCommand } from "../src/commands/review.js";
import { registerSwarmCommand } from "../src/commands/swarm.js";

function buildProgram(registerFn) {
  const program = new Command();
  program
    .name("sl")
    .exitOverride()
    .configureOutput({
      writeOut: () => {},
      writeErr: () => {},
    });
  registerFn(program);
  return program;
}

function getCommandByPath(program, commandPath) {
  const segments = String(commandPath || "")
    .trim()
    .split(/\s+/)
    .filter(Boolean);

  let current = null;
  let children = program.commands;
  for (const segment of segments) {
    current = children.find((command) => command.name() === segment);
    assert.ok(current, `Expected command path '${commandPath}' to include '${segment}'.`);
    children = current.commands;
  }
  return current;
}

function commandOptionFlags(command) {
  return new Set((command.options || []).map((option) => option.flags));
}

function assertCommandHasOption(command, flag) {
  const options = commandOptionFlags(command);
  assert.equal(
    options.has(flag),
    true,
    `Expected command '${command.name()}' to include option '${flag}'.`
  );
}

async function expectParseError(program, argv, pattern) {
  await assert.rejects(() => program.parseAsync(argv, { from: "user" }), pattern);
}

test("Unit command contracts: ai command tree registers identity lifecycle surfaces", () => {
  const program = buildProgram(registerAiCommand);

  const ai = getCommandByPath(program, "ai");
  const aiSubcommands = new Set(ai.commands.map((command) => command.name()));
  assert.equal(aiSubcommands.has("provision-email"), true);
  assert.equal(aiSubcommands.has("identity"), true);

  const provision = getCommandByPath(program, "ai provision-email");
  assert.equal(provision.aliases().includes("provision"), true);
  assertCommandHasOption(provision, "--execute");
  assertCommandHasOption(provision, "--allow-webhooks");
  assertCommandHasOption(provision, "--no-allow-webhooks");
  assertCommandHasOption(provision, "--idempotency-key <key>");

  const waitForOtp = getCommandByPath(program, "ai identity wait-for-otp");
  assertCommandHasOption(waitForOtp, "--interval-seconds <seconds>");
  assertCommandHasOption(waitForOtp, "--timeout <seconds>");
  assertCommandHasOption(waitForOtp, "--min-confidence <value>");
  assertCommandHasOption(waitForOtp, "--json");

  const killAll = getCommandByPath(program, "ai identity kill-all");
  assertCommandHasOption(killAll, "--execute");
  assertCommandHasOption(killAll, "--tags <csv>");

  const legalHoldStatus = getCommandByPath(program, "ai identity legal-hold status");
  assertCommandHasOption(legalHoldStatus, "--path <path>");
});

test("Unit command contracts: daemon command tree exposes operator and routing controls", () => {
  const program = buildProgram(registerDaemonCommand);

  const daemon = getCommandByPath(program, "daemon");
  const daemonSubcommands = new Set(daemon.commands.map((command) => command.name()));
  for (const expected of [
    "assign",
    "jira",
    "budget",
    "control",
    "lineage",
    "map",
    "reliability",
    "maintenance",
    "error",
  ]) {
    assert.equal(daemonSubcommands.has(expected), true, `Expected daemon command '${expected}'.`);
  }

  const controlStop = getCommandByPath(program, "daemon control stop");
  assertCommandHasOption(controlStop, "--mode <mode>");
  assertCommandHasOption(controlStop, "--confirm");

  const reliabilityRun = getCommandByPath(program, "daemon reliability run");
  assertCommandHasOption(reliabilityRun, "--simulate-failure <csv>");
  assertCommandHasOption(reliabilityRun, "--maintenance-auto-open <bool>");
  assertCommandHasOption(reliabilityRun, "--clear-maintenance-on-pass <bool>");

  const errorWorker = getCommandByPath(program, "daemon error worker");
  assertCommandHasOption(errorWorker, "--max-events <n>");
});

test("Unit command contracts: scan command tree preserves workflow and precheck controls", () => {
  const program = buildProgram(registerScanCommand);

  getCommandByPath(program, "scan init");
  getCommandByPath(program, "scan validate");
  getCommandByPath(program, "scan precheck");

  const init = getCommandByPath(program, "scan init");
  assertCommandHasOption(init, "--spec-file <path>");
  assertCommandHasOption(init, "--has-e2e-tests <mode>");
  assertCommandHasOption(init, "--playwright-mode <mode>");

  const precheck = getCommandByPath(program, "scan precheck");
  for (const flag of [
    "--provider <name>",
    "--model <id>",
    "--max-cost <usd>",
    "--max-tokens <n>",
    "--max-runtime-ms <n>",
    "--max-tool-calls <n>",
    "--warn-at-percent <n>",
  ]) {
    assertCommandHasOption(precheck, flag);
  }
});

test("Unit command contracts: review command tree keeps deterministic + HITL flows", () => {
  const program = buildProgram(registerReviewCommand);

  const review = getCommandByPath(program, "review");
  for (const flag of [
    "--diff",
    "--staged",
    "--ai",
    "--ai-dry-run",
    "--max-cost <usd>",
    "--max-tokens <n>",
    "--max-runtime-ms <n>",
  ]) {
    assertCommandHasOption(review, flag);
  }

  for (const subcommand of [
    "show",
    "export",
    "replay",
    "diff",
    "accept",
    "reject",
    "defer",
    "scan",
  ]) {
    getCommandByPath(program, `review ${subcommand}`);
  }

  const reviewScan = getCommandByPath(program, "review scan");
  assertCommandHasOption(reviewScan, "--mode <mode>");
  assertCommandHasOption(reviewScan, "--diff");
  assertCommandHasOption(reviewScan, "--staged");
});

test("Unit command contracts: swarm command tree keeps planning/runtime/report controls", () => {
  const program = buildProgram(registerSwarmCommand);

  for (const subcommand of [
    "registry",
    "create",
    "scenario",
    "plan",
    "dashboard",
    "report",
    "run",
  ]) {
    getCommandByPath(program, `swarm ${subcommand}`);
  }
  getCommandByPath(program, "swarm scenario init");
  getCommandByPath(program, "swarm scenario validate");

  const plan = getCommandByPath(program, "swarm plan");
  for (const flag of [
    "--agents <ids>",
    "--max-parallel <n>",
    "--max-cost-usd <n>",
    "--max-output-tokens <n>",
    "--max-runtime-ms <n>",
    "--max-tool-calls <n>",
    "--warning-threshold-percent <n>",
  ]) {
    assertCommandHasOption(plan, flag);
  }

  const run = getCommandByPath(program, "swarm run");
  for (const flag of [
    "--plan-file <path>",
    "--playbook-file <path>",
    "--scenario-file <path>",
    "--max-steps <n>",
    "--engine <mode>",
    "--execute",
  ]) {
    assertCommandHasOption(run, flag);
  }
});

test("Unit command contracts: review rejects conflicting diff and staged flags", async () => {
  const program = buildProgram(registerReviewCommand);
  await expectParseError(
    program,
    ["review", ".", "--diff", "--staged", "--json"],
    /Use only one of --diff or --staged/i
  );
});

test("Unit command contracts: swarm run rejects mixed playbook and scenario inputs", async () => {
  const program = buildProgram(registerSwarmCommand);
  await expectParseError(
    program,
    [
      "swarm",
      "run",
      ".",
      "--playbook-file",
      "playbook.json",
      "--scenario-file",
      "scenario.sls",
      "--json",
    ],
    /Use either --playbook-file or --scenario-file/i
  );
});

test("Unit command contracts: ai wait-for-otp enforces confidence bounds", async () => {
  const program = buildProgram(registerAiCommand);
  await expectParseError(
    program,
    ["ai", "identity", "wait-for-otp", "identity_123", "--min-confidence", "1.5", "--json"],
    /minConfidence must be between 0 and 1/i
  );
});

test("Unit command contracts: scan init rejects unsupported playwright mode values", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "create-sentinelayer-scan-command-"));
  try {
    await writeFile(path.join(tempRoot, "SPEC.md"), "# SPEC - unit test\n", "utf-8");
    const program = buildProgram(registerScanCommand);
    await expectParseError(
      program,
      [
        "scan",
        "init",
        "--path",
        tempRoot,
        "--playwright-mode",
        "invalid-mode",
        "--non-interactive",
        "--json",
      ],
      /Invalid --playwright-mode value/i
    );
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("Unit command contracts: daemon reliability run rejects invalid boolean toggles", async () => {
  const program = buildProgram(registerDaemonCommand);
  await expectParseError(
    program,
    [
      "daemon",
      "reliability",
      "run",
      "--maintenance-auto-open",
      "maybe",
      "--json",
    ],
    /Value must be true\/false/i
  );
});
