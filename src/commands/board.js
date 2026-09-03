import fsp from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { spawn as nodeSpawn } from "node:child_process";

import { VERDICTS, checkTicketDone } from "../board/done-gate.js";
import { createEvidenceResolver, createGhRunner } from "../board/evidence-resolvers.js";

/**
 * `sl board check` — ask whether a ticket's evidence actually holds.
 *
 * This is the command that makes the done-gate real. Without a caller, the gate and
 * its resolvers are correct code that never runs, which this repo established the
 * hard way tonight.
 *
 * WHAT IT DELIBERATELY DOES NOT DO: mark anything done. It reports a verdict and
 * exits. Closing a ticket is a write, and a checker that closes tickets on its own
 * judgement is the thing the whole design exists to prevent -- a model or a script
 * deciding "done" instead of a person acting on verified evidence.
 *
 * EXIT CODES, chosen so a script cannot mistake one outcome for another:
 *   0  done           every claim was checked and holds
 *   1  not-done       a claim was checked and does not hold
 *   2  cannot-verify  something could not be checked -- NOT a failure of the work
 *
 * `cannot-verify` gets its own code rather than sharing with `not-done`, because a
 * caller that treats "GitHub was down" as "the work is incomplete" reintroduces the
 * collapse at the shell level, one layer below where we prevented it.
 */

function spawnCapture(cmd, argv) {
  return new Promise((resolve, reject) => {
    let stdout = "";
    let stderr = "";
    const child = nodeSpawn(cmd, argv, { stdio: ["ignore", "pipe", "pipe"] });
    child.on("error", reject);
    child.stdout.on("data", (d) => { stdout += d; });
    child.stderr.on("data", (d) => { stderr += d; });
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

const EXIT = {
  [VERDICTS.DONE]: 0,
  [VERDICTS.NOT_DONE]: 1,
  [VERDICTS.CANNOT_VERIFY]: 2,
};

/**
 * Read a ticket from a JSON file: `{ id?, title?, evidence: [ ... ] }`.
 * A file that is missing, unreadable or unparseable is CANNOT-VERIFY, never NOT-DONE:
 * we learned nothing about the work, only about the file.
 */
export async function loadTicket(file) {
  let raw;
  try {
    raw = await fsp.readFile(file, "utf-8");
  } catch (error) {
    return { error: `cannot read ticket file: ${error?.message ?? error}` };
  }
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return { error: "ticket file is not an object" };
    return { ticket: parsed };
  } catch (error) {
    return { error: `ticket file is not valid JSON: ${error?.message ?? error}` };
  }
}

export async function runBoardCheck({ file, emitJson, deps = {} } = {}) {
  const { ticket, error } = await loadTicket(file);
  if (error) {
    const out = { verdict: VERDICTS.CANNOT_VERIFY, reason: error };
    print(out, emitJson);
    return EXIT[VERDICTS.CANNOT_VERIFY];
  }

  const run = deps.run ?? createGhRunner({ spawn: deps.spawn ?? spawnCapture });
  const resolve = deps.resolve ?? createEvidenceResolver({ run });
  const result = await checkTicketDone(ticket, { resolve });

  print({ ...result, ticket: ticket.id ?? ticket.title ?? path.basename(file) }, emitJson);
  return EXIT[result.verdict] ?? EXIT[VERDICTS.CANNOT_VERIFY];
}

function print(result, emitJson) {
  if (emitJson) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return;
  }
  const lines = [`verdict: ${result.verdict}`];
  if (result.reason) lines.push(`reason:  ${result.reason}`);
  for (const r of result.results ?? []) {
    lines.push(`  - ${r.kind ?? "?"}: ${r.verdict}${r.reason ? ` (${r.reason})` : ""}`);
  }
  process.stdout.write(`${lines.join("\n")}\n`);
}

export function registerBoardCommand(program) {
  const board = program.command("board").description("Check ticket evidence deterministically");

  board
    .command("check")
    .description("Check whether a ticket's evidence holds (done | not-done | cannot-verify)")
    .requiredOption("--file <path>", "Ticket JSON file with an `evidence` array")
    .option("--json", "Emit machine-readable output")
    .action(async (options) => {
      const code = await runBoardCheck({
        file: path.resolve(process.cwd(), String(options.file)),
        emitJson: Boolean(options.json),
      });
      process.exitCode = code;
    });

  return board;
}
