/**
 * ENGRAM §1 — path evidence (explainability-as-delight, ENGRAM §7).
 *
 * For any surfaced memory, reconstruct WHY it surfaced as a one-line path
 * from a query seed to the memory: "msg #12 (codex) -> topic:gate-policy ->
 * decision:#47 -> pr:#60 -> msg #88". Uses the same bounded bidirectional
 * BFS (meet-in-the-middle, <=4 hops each side) that §7 specifies for path
 * evidence. Deterministic tie-breaking so the explanation is reproducible.
 *
 * This is a product feature, not debug output (stack doc §2): every recall
 * hit carries its provenance.
 */

import { normalizeString } from "./text.js";

function entityLabel(index, entityId) {
  const entity = index.graph.entities.get(entityId);
  if (!entity) return entityId;
  return `${entity.kind}:${entity.label || "?"}`;
}

function obsLabel(index, obsId) {
  const obs = index.byId.get(obsId);
  if (!obs) return obsId;
  const seq = obs.sequenceId ? `#${obs.sequenceId}` : obs.kind;
  return `${obs.kind} ${seq} (${obs.agentId})`.trim();
}

/**
 * Neighbors of an observation in the recall graph: observations reachable
 * via one shared entity (bipartite obs->entity->obs) plus direct reply
 * thread links. Returns entries carrying the connecting entity (for labeling).
 *
 * `hubDegreeCap` skips generic hub entities during traversal — a prolific
 * author (agent entity bound to hundreds of observations) does not make two
 * messages *relevant* to each other, so it must not carry spreading
 * activation. This is the deterministic stand-in for §7's `type_prior x
 * edge weight`: specific entities (files, PRs, topics, decisions, mentions,
 * reply threads) carry relevance; hubs do not.
 */
function observationNeighbors(index, obsId, { hubDegreeCap = Infinity } = {}) {
  const neighbors = new Map(); // neighborObsId -> via (entityId | "reply")
  const entityIds = index.graph.obsToEntities.get(obsId);
  if (entityIds) {
    for (const entityId of entityIds) {
      const peers = index.graph.entityToObs.get(entityId);
      if (!peers) continue;
      if (peers.size > hubDegreeCap) continue; // skip hub entities
      for (const peer of peers) {
        if (peer === obsId) continue;
        if (!neighbors.has(peer)) neighbors.set(peer, entityId);
      }
    }
  }
  const replyPeers = index.graph.replyEdges.get(obsId);
  if (replyPeers) {
    for (const peer of replyPeers) {
      if (peer !== obsId && !neighbors.has(peer)) neighbors.set(peer, "reply");
    }
  }
  return neighbors;
}

/**
 * Shortest path (BFS) from any seed observation to the target, over the
 * observation graph, bounded to maxHops. Returns an array of steps or null.
 * Deterministic: neighbors visited in sorted order.
 */
function shortestPath(index, seedObsIds, targetObsId, maxHops, hubDegreeCap) {
  if (seedObsIds.has(targetObsId)) return [{ obsId: targetObsId, via: null }];
  const visited = new Set(seedObsIds);
  let frontier = Array.from(seedObsIds).sort();
  const prev = new Map(); // obsId -> {from, via}

  for (let hop = 0; hop < maxHops; hop += 1) {
    const next = [];
    for (const obsId of frontier) {
      const neighbors = observationNeighbors(index, obsId, { hubDegreeCap });
      const sortedNeighbors = Array.from(neighbors.keys()).sort();
      for (const neighbor of sortedNeighbors) {
        if (visited.has(neighbor)) continue;
        visited.add(neighbor);
        prev.set(neighbor, { from: obsId, via: neighbors.get(neighbor) });
        if (neighbor === targetObsId) {
          // Reconstruct.
          const steps = [];
          let cursor = targetObsId;
          while (cursor && !seedObsIds.has(cursor)) {
            const edge = prev.get(cursor);
            steps.unshift({ obsId: cursor, via: edge.via });
            cursor = edge.from;
          }
          steps.unshift({ obsId: cursor, via: null });
          return steps;
        }
        next.push(neighbor);
      }
    }
    if (next.length === 0) break;
    frontier = next.sort();
  }
  return null;
}

/**
 * Build a one-line provenance string for a result.
 *
 * @param {object} index
 * @param {string} targetObsId
 * @param {object} seeds  { obsIds: Set<string>, entityIds: string[], channels: string[] }
 * @param {object} [options]
 * @param {number} [options.maxHops=4]
 * @returns {string}
 */
export function buildProvenance(index, targetObsId, seeds = {}, { maxHops = 4, hubDegreeCap = Infinity } = {}) {
  const seedObsIds = seeds.obsIds instanceof Set ? seeds.obsIds : new Set(seeds.obsIds || []);

  // Direct hit: the memory matched the query itself (dense/bm25/entity).
  if (seedObsIds.has(targetObsId) || seedObsIds.size === 0) {
    const channels = Array.isArray(seeds.channels) && seeds.channels.length > 0
      ? seeds.channels.join("+")
      : "direct";
    return `direct match (${channels}): ${obsLabel(index, targetObsId)}`;
  }

  const path = shortestPath(index, seedObsIds, targetObsId, maxHops, hubDegreeCap);
  if (!path || path.length === 0) {
    // Reachable only via the query-entity seed labels (no obs path) — still
    // explain via the shared entity if there is one.
    const targetEntities = index.graph.obsToEntities.get(targetObsId);
    if (targetEntities) {
      for (const entityId of Array.from(targetEntities).sort()) {
        if ((seeds.entityIds || []).includes(entityId)) {
          return `${entityLabel(index, entityId)} -> ${obsLabel(index, targetObsId)}`;
        }
      }
    }
    return `related: ${obsLabel(index, targetObsId)}`;
  }

  const parts = [];
  path.forEach((step, i) => {
    if (i > 0 && step.via && step.via !== "reply") {
      parts.push(entityLabel(index, step.via));
    } else if (i > 0 && step.via === "reply") {
      parts.push("reply");
    }
    parts.push(obsLabel(index, step.obsId));
  });
  return parts.join(" -> ") || `related: ${obsLabel(index, targetObsId)}`;
}

export { observationNeighbors };
