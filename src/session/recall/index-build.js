/**
 * SentinelLayer session adapter for the pure ENGRAM recall-index builder.
 *
 * Raw session events are filtered and normalized here. Detachable ENGRAM
 * consumers import index-core.js directly and therefore never pull the
 * SentinelLayer session runtime into their dependency closure.
 */

import { buildObservations } from "./observations.js";
import { buildRecallIndex as buildCoreRecallIndex } from "./index-core.js";

export { BM25_K1, BM25_B } from "./index-core.js";

export function buildRecallIndex({
  events = [],
  observations: prebuiltObservations = null,
  messageActions = [],
  embedder,
  sessionId = "",
  includeControlEvents = false,
} = {}) {
  const built = Array.isArray(prebuiltObservations)
    ? {
        observations: prebuiltObservations,
        droppedControlEvents: 0,
        materialCount: prebuiltObservations.length,
      }
    : buildObservations(events, { sessionId, includeControlEvents });

  return buildCoreRecallIndex({
    observations: built.observations,
    messageActions,
    embedder,
    sessionId,
    droppedControlEvents: built.droppedControlEvents,
    materialCount: built.materialCount,
  });
}
