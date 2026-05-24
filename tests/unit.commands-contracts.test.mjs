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
import { registerSpecCommand } from "../src/commands/spec.js";
import { registerPromptCommand } from "../src/commands/prompt.js";
import { registerAuditCommand } from "../src/commands/audit.js";
import { formatCheckpointLine, registerSessionCommand } from "../src/commands/session.js";
import { registerOmarGateCommand } from "../src/commands/omargate.js";

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
    "watchdog",
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

  const watchdogRun = getCommandByPath(program, "daemon watchdog run");
  assertCommandHasOption(watchdogRun, "--no-tool-call-seconds <n>");
  assertCommandHasOption(watchdogRun, "--repeated-file-reads-threshold <n>");
  assertCommandHasOption(watchdogRun, "--budget-warning-threshold <ratio>");
  assertCommandHasOption(watchdogRun, "--turn-stall-turns <n>");
  assertCommandHasOption(watchdogRun, "--execute <bool>");
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
    "--spec <path>",
    "--refresh",
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
  assertCommandHasOption(reviewScan, "--spec <path>");
  assertCommandHasOption(reviewScan, "--refresh");

  const reviewReplay = getCommandByPath(program, "review replay");
  assertCommandHasOption(reviewReplay, "--refresh");
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
    "--agent <id>",
    "--scope <scope>",
    "--identity-id <id>",
    "--max-steps <n>",
    "--engine <mode>",
    "--execute",
  ]) {
    assertCommandHasOption(run, flag);
  }
});

test("Unit command contracts: spec, prompt, and audit commands expose ingest refresh controls", () => {
  const specProgram = buildProgram(registerSpecCommand);
  assertCommandHasOption(getCommandByPath(specProgram, "spec generate"), "--refresh");
  assertCommandHasOption(getCommandByPath(specProgram, "spec regenerate"), "--refresh");

  const promptProgram = buildProgram(registerPromptCommand);
  assertCommandHasOption(getCommandByPath(promptProgram, "prompt generate"), "--refresh");
  assertCommandHasOption(getCommandByPath(promptProgram, "prompt preview"), "--refresh");

  const auditProgram = new Command();
  auditProgram
    .name("sl")
    .exitOverride()
    .configureOutput({
      writeOut: () => {},
      writeErr: () => {},
    });
  registerAuditCommand(auditProgram, async () => {});
  assertCommandHasOption(getCommandByPath(auditProgram, "audit"), "--refresh");
  assertCommandHasOption(getCommandByPath(auditProgram, "audit"), "--reuse-omargate <runId>");
  assertCommandHasOption(getCommandByPath(auditProgram, "audit local"), "--reuse-omargate <runId>");
  assertCommandHasOption(getCommandByPath(auditProgram, "audit replay"), "--refresh");
  assertCommandHasOption(getCommandByPath(auditProgram, "audit security"), "--refresh");
  assertCommandHasOption(getCommandByPath(auditProgram, "audit architecture"), "--refresh");
  assertCommandHasOption(getCommandByPath(auditProgram, "audit testing"), "--refresh");
  assertCommandHasOption(getCommandByPath(auditProgram, "audit performance"), "--refresh");
  assertCommandHasOption(getCommandByPath(auditProgram, "audit compliance"), "--refresh");
  assertCommandHasOption(getCommandByPath(auditProgram, "audit documentation"), "--refresh");
});

test("Unit command contracts: omargate investor-dd exposes devTestBot controls", () => {
  const program = new Command();
  program
    .name("sl")
    .exitOverride()
    .configureOutput({
      writeOut: () => {},
      writeErr: () => {},
    });
  registerOmarGateCommand(program, async () => {});

  const investorDd = getCommandByPath(program, "omargate investor-dd");
  assertCommandHasOption(investorDd, "--devtestbot-base-url <url>");
  assertCommandHasOption(investorDd, "--devtestbot-scope <scope>");
  assertCommandHasOption(investorDd, "--no-devtestbot");
  assertCommandHasOption(investorDd, "--email-on-complete <addr>");
  assertCommandHasOption(investorDd, "--require-usage-ledger");
});

test("Unit command contracts: session exposes D2 ensure and resume controls", () => {
  const program = buildProgram(registerSessionCommand);

  getCommandByPath(program, "session ensure");
  getCommandByPath(program, "session listen");
  getCommandByPath(program, "session checkpoint");
  const start = getCommandByPath(program, "session start");
  assertCommandHasOption(start, "--resume");
  assertCommandHasOption(start, "--no-resume");
  assertCommandHasOption(start, "--reuse-window-seconds <seconds>");
  assertCommandHasOption(start, "--force-new");

  const ensure = getCommandByPath(program, "session ensure");
  assertCommandHasOption(ensure, "--path <path>");
  assertCommandHasOption(ensure, "--resume");
  assertCommandHasOption(ensure, "--no-resume");
  assertCommandHasOption(ensure, "--reuse-window-seconds <seconds>");
  assertCommandHasOption(ensure, "--force-new");

  const say = getCommandByPath(program, "session say");
  assertCommandHasOption(say, "--to <agent>");
  assertCommandHasOption(say, "--reply-to <sequence>");
  assertCommandHasOption(say, "--reply-cursor <cursor>");

  const postAgent = getCommandByPath(program, "session post-agent");
  assertCommandHasOption(postAgent, "--agent <id>");
  assertCommandHasOption(postAgent, "--model <model>");
  assertCommandHasOption(postAgent, "--display-name <name>");
  assertCommandHasOption(postAgent, "--role <role>");
  assertCommandHasOption(postAgent, "--to <agent>");

  const action = getCommandByPath(program, "session action");
  assertCommandHasOption(action, "--target-sequence <n>");
  assertCommandHasOption(action, "--target-cursor <cursor>");
  assertCommandHasOption(action, "--target-action-id <uuid>");
  assertCommandHasOption(action, "--note <text>");
  assertCommandHasOption(action, "--agent <id>");
  assertCommandHasOption(action, "--idempotency-key <key>");

  const actions = getCommandByPath(program, "session actions");
  assert.ok(actions.description().includes("message actions"));

  const react = getCommandByPath(program, "session react");
  assertCommandHasOption(react, "--target-sequence <n>");
  assertCommandHasOption(react, "--target-cursor <cursor>");
  assertCommandHasOption(react, "--target-action-id <uuid>");

  const reply = getCommandByPath(program, "session reply");
  assertCommandHasOption(reply, "--agent <id>");
  assertCommandHasOption(reply, "--idempotency-key <key>");

  const comment = getCommandByPath(program, "session comment");
  assertCommandHasOption(comment, "--agent <id>");
  assertCommandHasOption(comment, "--idempotency-key <key>");

  const view = getCommandByPath(program, "session view");
  assertCommandHasOption(view, "--agent <id>");
  assertCommandHasOption(view, "--idempotency-key <key>");

  const read = getCommandByPath(program, "session read");
  assertCommandHasOption(read, "--before-sequence <n>");
  assertCommandHasOption(read, "--no-actions");

  const search = getCommandByPath(program, "session search");
  assertCommandHasOption(search, "--before-sequence <n>");
  assertCommandHasOption(search, "--limit <n>");

  const listen = getCommandByPath(program, "session listen");
  assertCommandHasOption(listen, "--session <id>");
  assertCommandHasOption(listen, "--agent <id>");
  assertCommandHasOption(listen, "--interval <seconds>");
  assertCommandHasOption(listen, "--active-interval <seconds>");
  assertCommandHasOption(listen, "--active-window <seconds>");
  assertCommandHasOption(listen, "--emit <format>");
  assertCommandHasOption(listen, "--limit <n>");
  assertCommandHasOption(listen, "--since <cursor>");
  assertCommandHasOption(listen, "--replay");
  assertCommandHasOption(listen, "--max-polls <n>");

  assertCommandHasOption(say, "--agent <id>");
  assertCommandHasOption(say, "--model <model>");
  assertCommandHasOption(say, "--display-name <name>");
  assertCommandHasOption(say, "--role <role>");

  const recapNow = getCommandByPath(program, "session recap now");
  assertCommandHasOption(recapNow, "--session <id>");
  assertCommandHasOption(recapNow, "--remote");
  assertCommandHasOption(recapNow, "--agent <id>");
  assertCommandHasOption(recapNow, "--max-events <n>");
  assertCommandHasOption(recapNow, "--path <path>");
  assertCommandHasOption(recapNow, "--json");

  const checkpointList = getCommandByPath(program, "session checkpoint list");
  assertCommandHasOption(checkpointList, "--limit <n>");
  assertCommandHasOption(checkpointList, "--path <path>");
  assertCommandHasOption(checkpointList, "--json");

  const checkpointCreate = getCommandByPath(program, "session checkpoint create");
  assertCommandHasOption(checkpointCreate, "--start-sequence <n>");
  assertCommandHasOption(checkpointCreate, "--end-sequence <n>");
  assertCommandHasOption(checkpointCreate, "--title <title>");
  assertCommandHasOption(checkpointCreate, "--summary <text>");
  assertCommandHasOption(checkpointCreate, "--summary-file <file>");
  assertCommandHasOption(checkpointCreate, "--kind <kind>");
  assertCommandHasOption(checkpointCreate, "--checkpoint-id <id>");
  assertCommandHasOption(checkpointCreate, "--agent <id>");
  assertCommandHasOption(checkpointCreate, "--token-start <n>");
  assertCommandHasOption(checkpointCreate, "--token-end <n>");

  const checkpointGenerate = getCommandByPath(program, "session checkpoint generate");
  assertCommandHasOption(checkpointGenerate, "--min-events <n>");
  assertCommandHasOption(checkpointGenerate, "--max-events <n>");
  assertCommandHasOption(checkpointGenerate, "--operation-id <key>");
  assertCommandHasOption(checkpointGenerate, "--agent <id>");
  assertCommandHasOption(checkpointGenerate, "--json");
});

test("Unit command contracts: checkpoint lines include deterministic grade labels", () => {
  assert.equal(
    formatCheckpointLine({
      checkpointId: "cp_1",
      kind: "handoff",
      startSequence: 3,
      endSequence: 9,
      title: "PR-C1 handoff",
      createdByAgentId: "codex",
      grade: "B",
      gradeScore: 84,
      gradeReasons: [
        { code: "brief_summary", message: "Checkpoint summary is under 200 characters." },
      ],
    }),
    "#3-9 cp_1 [handoff] PR-C1 handoff by codex grade B 84/100: Checkpoint summary is under 200 characters.",
  );

  assert.equal(
    formatCheckpointLine({
      checkpointId: "cp_2",
      title: "Legacy summary",
      grade: "F",
      grade_score: 41,
    }),
    "anchor pending cp_2 [summary] Legacy summary grade F 41/100",
  );

  assert.equal(
    formatCheckpointLine({
      checkpointId: "cp_3",
      title: "Ungraded summary",
    }),
    "anchor pending cp_3 [summary] Ungraded summary",
  );
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
