/**
 * ENGRAM §1 — Session Recall: public entry point.
 *
 * `runSessionRecall` is the orchestrator behind `sl session recall`:
 *   1. (optional) full remote hydrate — tail:0 backfill so we never index a
 *      truncated local mirror (Redis hot-caches only the latest ~2k events;
 *      older history lives in Postgres and must be paged down first). We
 *      honor `eventsBackfillComplete` and warn if the backfill is partial.
 *   2. read the full local NDJSON stream (tail:0)
 *   3. pull the message-actions layer (reply edges + ACT-R rehearsal fuel)
 *   4. build the tri-layer recall index
 *   5. run the Recall Engine
 *   6. compute the token cut vs full-tail replay
 *
 * Runtime dependencies are injected (defaults wire the real session
 * modules) so the orchestrator is unit-testable without network or fs.
 */

import { readStream } from "../stream.js";
import { hydrateSessionFromRemote } from "../remote-hydrate.js";
import { listSessionMessageActions } from "../sync.js";

import { buildRecallIndex } from "./index-build.js";
import { recall } from "./retrieve.js";
import { createEmbedder } from "./embedder.js";
import { computeTokenCut } from "./token-stats.js";

export { buildRecallIndex } from "./index-build.js";
export { recall, RECALL_DEFAULTS, RECALL_WEIGHTS } from "./retrieve.js";
export { createEmbedder, DEFAULT_DIM } from "./embedder.js";
export { buildObservations } from "./observations.js";
export { buildEntityGraph, matchQueryEntities, EDGE_TYPES } from "./entities.js";
export { buildProvenance } from "./provenance.js";
export { computeTokenCut } from "./token-stats.js";
export { runEightNeedle } from "./needle-eval.js";

/**
 * Hydrate + build + recall for a session.
 *
 * @param {object} params
 * @param {string} params.sessionId
 * @param {string} params.need           The recall query / need.
 * @param {string} [params.targetPath]
 * @param {number} [params.k=12]
 * @param {string} [params.role]
 * @param {boolean} [params.remote=true] Hydrate from the API before indexing.
 * @param {boolean} [params.includeControlEvents=false]
 * @param {object} [params.embedder]
 * @param {number} [params.now]          ACT-R clock (default Date.now()).
 * @param {Function} [params._hydrate]   seam
 * @param {Function} [params._readStream] seam
 * @param {Function} [params._listActions] seam
 * @returns {Promise<object>} recall payload (JSON-serializable)
 */
export async function runSessionRecall({
  sessionId,
  need,
  targetPath = process.cwd(),
  k = 12,
  role = "",
  remote = true,
  includeControlEvents = false,
  embedder = createEmbedder(),
  now = Date.now(),
  _hydrate = hydrateSessionFromRemote,
  _readStream = readStream,
  _listActions = listSessionMessageActions,
} = {}) {
  const normalizedSessionId = String(sessionId || "").trim();
  const normalizedNeed = String(need || "").trim();
  if (!normalizedSessionId) {
    return { ok: false, reason: "invalid_session_id", results: [] };
  }
  if (normalizedNeed.length < 2) {
    return { ok: false, reason: "query_too_short", results: [] };
  }

  const backfill = { attempted: false, ok: false, complete: null, warning: "" };
  if (remote) {
    backfill.attempted = true;
    const hydration = await _hydrate({
      sessionId: normalizedSessionId,
      targetPath,
      includeControlEvents,
    }).catch((error) => ({ ok: false, reason: String(error?.message || error) }));
    backfill.ok = Boolean(hydration?.ok);
    backfill.complete = hydration?.eventsBackfillComplete !== false;
    if (!hydration?.ok) {
      backfill.warning = `remote hydrate skipped (${hydration?.reason || "unknown"}); indexing local mirror only`;
    } else if (hydration.eventsBackfillComplete === false) {
      backfill.warning = `remote backfill incomplete (${hydration.eventsBackfillReason || "more pages"}); recall may miss older memories`;
    }
  }

  const events = await _readStream(normalizedSessionId, { targetPath, tail: 0 }).catch(() => []);

  let messageActions = [];
  const actionsResult = await _listActions(normalizedSessionId, { targetPath, limit: 500 }).catch(() => null);
  if (actionsResult?.ok && Array.isArray(actionsResult.actions)) {
    messageActions = actionsResult.actions;
  }

  const index = buildRecallIndex({
    events,
    messageActions,
    embedder,
    sessionId: normalizedSessionId,
    includeControlEvents,
  });

  const recalled = recall(index, { query: normalizedNeed, k, role, now });
  const tokenCut = await computeTokenCut({
    observations: index.observations,
    results: recalled.results,
  });

  return {
    ok: true,
    reason: "",
    sessionId: normalizedSessionId,
    need: normalizedNeed,
    role: role || null,
    k: recalled.k,
    backfill,
    meta: index.meta,
    matchedEntities: recalled.matchedEntityIds,
    poolSize: recalled.poolSize,
    results: recalled.results,
    tokenCut,
  };
}
