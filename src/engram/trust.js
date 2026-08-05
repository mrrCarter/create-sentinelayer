/**
 * ENGRAM §2 — the trust seal on write.
 *
 * Vocabulary is DELIBERATELY aligned with the server-side `ServiceTrustLevel`
 * subsystem (sentinelayer-api `src/models/service_trust.py`: L0_connected ->
 * L5_remediation_ready) so §2.1 converges onto that existing certification
 * system instead of forking a divergent trust model. P0 stays CLI-local and
 * does NOT touch the server subsystem — it only borrows the vocabulary.
 *
 * Rule (from the convergence + guest-token model): only VERIFIED writes are
 * AUTHORITATIVE; untrusted/guest/unverified writes are retrievable-but-marked,
 * never authoritative, never a governed-action trigger. `sealed`/`revoked`
 * memories are never surfaced to an unauthorized scope (the §10 analog).
 *
 * Real verification (AIdenID provider-signature / delegation-proof) is
 * external (§2.1); P0 classifies from local identity signals.
 */

export const TRUST_LEVELS = Object.freeze([
  "L0_connected",
  "L1_audited",
  "L2_memory_certified",
  "L3_watch_enabled",
  "L4_governance_grade",
  "L5_remediation_ready",
]);

const RANK = new Map(TRUST_LEVELS.map((level, index) => [level, index]));

/** Writes at or above this level are AUTHORITATIVE. */
export const AUTHORITATIVE_FLOOR = "L2_memory_certified";

export function trustRank(level) {
  return RANK.has(level) ? RANK.get(level) : 0;
}

export function isAuthoritative(level) {
  return trustRank(level) >= trustRank(AUTHORITATIVE_FLOOR);
}

/**
 * Classify a write's trust level from the caller. AIdenID verification is
 * external (§2.1); until then a caller is authoritative only if it presents a
 * verified identity.
 * @param {object} [caller]  { id, kind?, verified?, trustLevel? }
 * @returns {string} a TRUST_LEVELS value
 */
export function classifyWrite(caller = {}) {
  if (!caller || !caller.id || caller.kind === "guest") return "L0_connected";
  if (caller.verified === true) {
    return caller.trustLevel && RANK.has(caller.trustLevel) ? caller.trustLevel : "L2_memory_certified";
  }
  return "L1_audited"; // known but unverified -> retrievable, NOT authoritative
}

/**
 * Classify a source-adapter observation (e.g. a session event) from its
 * author when the item carried no explicit trust.
 * @param {object} obs
 * @returns {string}
 */
export function classifyObservation(obs = {}) {
  const agentId = String(obs.agentId || "").toLowerCase();
  if (!agentId || agentId === "unknown" || agentId === "cli-user" || agentId.startsWith("guest") || agentId.startsWith("agent-")) {
    return "L0_connected";
  }
  return "L1_audited";
}

/**
 * Attach the trust seal to an item at write time.
 * @param {object} item
 * @param {object} ctx  { caller }
 * @returns {object} item with { trust, sealed, revoked }
 */
export function sealItem(item, { caller } = {}) {
  // Trust is DERIVED from the caller's identity, never self-asserted. A caller
  // MAY downgrade their own write (mark it less trusted); they may NEVER upgrade
  // above their identity-derived ceiling — otherwise an unverified/guest caller
  // could forge an AUTHORITATIVE memory by supplying `trust` in the payload,
  // defeating the "unverified -> never authoritative" invariant above.
  const derived = classifyWrite(caller);
  const asserted = item?.trust && RANK.has(item.trust) ? item.trust : derived;
  const trust = trustRank(asserted) <= trustRank(derived) ? asserted : derived;
  return {
    ...item,
    trust,
    sealed: item?.sealed === true,
    revoked: item?.revoked === true,
  };
}

/**
 * Recall visibility gate: revoked memory NEVER surfaces; sealed memory
 * surfaces only to an authorized scope. Untrusted memory DOES surface (marked
 * non-authoritative by the caller).
 * @param {object} obs
 * @param {object} [ctx]  { authorized }
 * @returns {boolean}
 */
export function visibleUnderScope(obs, { authorized = false } = {}) {
  if (obs?.revoked === true) return false;
  if (obs?.sealed === true && !authorized) return false;
  return true;
}
