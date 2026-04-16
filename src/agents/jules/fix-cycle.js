// Re-export from platform daemon. Fix-cycle is not Jules-specific.
// Jules passes its own identity; any persona can use the same lifecycle.
import { runFixCycle as _runFixCycle } from "../../daemon/fix-cycle.js";
import { JULES_DEFINITION } from "./config/definition.js";

export function runFixCycle(opts) {
  return _runFixCycle({
    ...opts,
    agentIdentity: {
      id: JULES_DEFINITION.id,
      persona: JULES_DEFINITION.persona,
      color: JULES_DEFINITION.color,
      avatar: JULES_DEFINITION.avatar,
      signature: JULES_DEFINITION.signature,
    },
  });
}
