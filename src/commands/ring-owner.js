import process from "node:process";

import { ringOwner } from "../pocket/ring-owner.js";

function shouldEmitJson(options, command) {
  if (options && options.json) return true;
  return typeof command?.optsWithGlobals === "function" ? Boolean(command.optsWithGlobals().json) : false;
}

export function registerRingOwnerCommand(program) {
  program
    .command("ring-owner")
    .description("Ring the owner's phone about a decision that needs them (Senti Pocket dial)")
    .argument("<question>", "The question / decision to put to the owner")
    .requiredOption("--session <id>", "The session this decision belongs to")
    .option("--kind <kind>", "decisionYours | pickOption | go | info | checkpointReady", "decisionYours")
    .option(
      "--option <label>",
      "A pickOption choice (repeat for multiple)",
      (value, acc) => { acc.push(value); return acc; },
      [],
    )
    .option("--what-we-need <text>", "A short 'what we need' lead-in for the ring")
    .option("--checkpoint <id>", "An optional checkpoint id for jump-to context")
    .option("--idempotency-key <key>", "Dedupe key so an accidental retry rings only once")
    .option("--gateway-url <url>", "Pocket gateway base URL (else the SENTI_POCKET_URL env var)")
    .option("--json", "Emit machine-readable output")
    .action(async (question, options, command) => {
      const emitJson = shouldEmitJson(options, command);
      try {
        const result = await ringOwner(question, {
          kind: options.kind,
          sessionId: options.session,
          options: options.option || [],
          whatWeNeed: options.whatWeNeed,
          checkpointId: options.checkpoint,
          idempotencyKey: options.idempotencyKey,
          gatewayUrl: options.gatewayUrl,
          env: process.env,
        });
        if (emitJson) {
          process.stdout.write(`${JSON.stringify(result)}\n`);
          return;
        }
        if (result && result.dispatched) {
          const replay = result.idempotent ? " (idempotent replay — already ringing)" : "";
          process.stdout.write(`Ringing the owner — dialId ${result.dialId}${replay}\n`);
        } else {
          const reason = result && result.reason ? `: ${result.reason}` : "";
          process.stdout.write(`Not dispatched${reason} (dialId ${(result && result.dialId) || "n/a"})\n`);
          process.exitCode = 1;
        }
      } catch (err) {
        process.stderr.write(`ring-owner failed: ${err && err.message ? err.message : String(err)}\n`);
        process.exitCode = 1;
      }
    });
}
