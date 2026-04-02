import { registerDaemonCoreCommands } from "./daemon/core.js";
import { registerDaemonExtendedCommands } from "./daemon/extended.js";

export function registerDaemonCommand(program) {
  const daemon = program
    .command("daemon")
    .description("OMAR daemon controls for error-event intake and routed queue management");

  registerDaemonCoreCommands(daemon);
  registerDaemonExtendedCommands(daemon);
}
