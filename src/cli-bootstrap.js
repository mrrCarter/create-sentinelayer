import process from "node:process";

import { restrictProgramLookupToPath } from "./program-lookup.js";

/**
 * Entry for the bin scripts. Checks the runtime before the rest of the CLI is loaded: importing
 * cli.js loads every command module, and some modules do work as they load (for example, creating
 * ~/.sentinelayer), so this module and program-lookup.js are the only ones a bin script imports
 * statically. runCli repeats the check for callers that import cli.js directly.
 */
export async function bootstrapCli() {
  const programLookup = restrictProgramLookupToPath();
  if (!programLookup.ok) {
    console.error(programLookup.message);
    process.exitCode = 1;
    return;
  }
  const { runCli } = await import("./cli.js");
  await runCli();
}
