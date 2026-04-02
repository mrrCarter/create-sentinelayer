import { registerAiIdentityLifecycleCommands } from "./ai/identity-lifecycle.js";
import { registerAiProvisionAndGovernanceCommands } from "./ai/provision-governance.js";

export function registerAiCommand(program) {
  const ai = program
    .command("ai")
    .description("AIdenID helper commands for ambient agent identity workflows");

  const { identity, legalHold } = registerAiProvisionAndGovernanceCommands(ai);
  registerAiIdentityLifecycleCommands({ identity, legalHold });
}
