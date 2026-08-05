/**
 * ENGRAM §2 — Memory-as-a-Service: detachable public entry point.
 *
 * This barrel is the sellable-alone surface: the 3 tools + the store, trust,
 * governance, and namespace seams, over the §1 recall engine. It imports NO
 * SentinelLayer session/mcp/auth runtime — the SL session is just ONE injected
 * store adapter (see the CLI wiring in src/mcp/session-stdio-server.js).
 */

export { createStore, itemId } from "./store.js";
export {
  parseNamespace,
  authorize,
  createLocalConsent,
  AccessDeniedError,
  ACTION_SCOPES,
} from "./namespace.js";
export {
  TRUST_LEVELS,
  AUTHORITATIVE_FLOOR,
  classifyWrite,
  classifyObservation,
  isAuthoritative,
  trustRank,
  sealItem,
  visibleUnderScope,
} from "./trust.js";
export { createGovernance } from "./governance.js";
export { createMemoryTools } from "./tools.js";
export { runEngramSla } from "./sla.js";

import { createStore } from "./store.js";
import { createLocalConsent } from "./namespace.js";
import { createGovernance } from "./governance.js";
import { createMemoryTools } from "./tools.js";
import { createEmbedder } from "../session/recall/embedder.js";

/**
 * Convenience factory: wire a default CLI-local MaaS instance (permissive-local
 * consent, stub governance, hash-projection embedder) over a store. Callers
 * inject `adapters` (e.g. { session }) to make a kind a first-class namespace.
 *
 * @param {object} options
 * @param {string} options.storeRoot
 * @param {Record<string,Function>} [options.adapters]
 * @param {object} [options.embedder]
 * @param {object} [options.consent]
 * @param {object} [options.governance]
 * @param {object} [options.renderer]
 * @returns {{tools: object, store: object}}
 */
export function createMemoryService({
  storeRoot,
  adapters = {},
  embedder = createEmbedder(),
  consent = createLocalConsent(),
  governance = createGovernance(),
  renderer = null,
  isAuthorizedForSealed,
} = {}) {
  const store = createStore({ storeRoot, adapters });
  const tools = createMemoryTools({ store, consent, governance, embedder, renderer, isAuthorizedForSealed });
  return { tools, store };
}
