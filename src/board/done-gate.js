/**
 * BOARD — the deterministic done-gate.
 *
 * Carter's ask (room 431032) was "the free in-house model checks to see if items are
 * done and marks them done, so I know it's done." A model deciding done-ness defeats
 * the thing the board is for: the instant "done" means "Gemma believed it", the mark
 * is worth nothing and he is back to checking everything himself. **A ticket wrongly
 * marked done is worse than one left open** — an open ticket still has his attention,
 * a closed one has left his field of view.
 *
 * So: the model may PROPOSE a link between a ticket and some evidence. Only a
 * deterministic check of a verifiable fact may STAMP it. Model proposes, evidence
 * disposes. Nothing in this file imports a model, and that is structural, not stylistic.
 *
 * THREE STATES, NOT TWO — the point of the module:
 *
 *   done           the evidence was checked and it holds
 *   not-done       the evidence was checked and it does not hold
 *   cannot-verify  the check could not be made
 *
 * `cannot-verify` must never collapse into either neighbour. Folding it into
 * `not-done` nags about finished work until the board is ignored; folding it into
 * `done` closes tickets nobody completed, which is the failure that makes the whole
 * board worthless. An unknown answer gets its own name and refuses — the same shape as
 * `absent | building | ready` in the engram lifecycle.
 *
 * PURE BY CONSTRUCTION: the actual lookups are INJECTED as a resolver. This module
 * decides what the evidence MEANS; it never fetches anything. That makes every branch
 * — including every failure branch — reachable in a test without a network.
 */

export const VERDICTS = Object.freeze({
  DONE: "done",
  NOT_DONE: "not-done",
  CANNOT_VERIFY: "cannot-verify",
});

/**
 * The evidence kinds a ticket may claim. CLOSED SET: an unrecognised kind resolves to
 * `cannot-verify`, never to a guess. Adding a kind is a deliberate edit here plus a
 * resolver that can answer it.
 */
export const EVIDENCE_KINDS = Object.freeze({
  /** A pull request is merged. { repo, number } */
  PR_MERGED: "pr-merged",
  /** A commit is an ancestor of the named branch. { repo, sha, branch } */
  SHA_ON_BRANCH: "sha-on-branch",
  /** A named check concluded successfully on a ref. { repo, ref, check } */
  CHECK_CONCLUSIVE: "check-conclusive",
  /** A deployment is serving the named build. { service, sha } */
  DEPLOY_SHA: "deploy-sha",
});

const KIND_REQUIRED_FIELDS = Object.freeze({
  [EVIDENCE_KINDS.PR_MERGED]: ["repo", "number"],
  [EVIDENCE_KINDS.SHA_ON_BRANCH]: ["repo", "sha", "branch"],
  [EVIDENCE_KINDS.CHECK_CONCLUSIVE]: ["repo", "ref", "check"],
  [EVIDENCE_KINDS.DEPLOY_SHA]: ["service", "sha"],
});

function cannotVerify(reason) {
  return { verdict: VERDICTS.CANNOT_VERIFY, reason };
}

/**
 * Validate an evidence descriptor's SHAPE before anything is looked up.
 *
 * A malformed descriptor is `cannot-verify`, never `not-done`: we did not learn that
 * the work is incomplete, only that the ticket does not say how to check it.
 */
export function describeEvidence(evidence) {
  if (!evidence || typeof evidence !== "object") {
    return cannotVerify("evidence is missing");
  }
  const kind = typeof evidence.kind === "string" ? evidence.kind.trim() : "";
  if (!kind) return cannotVerify("evidence has no kind");
  const required = KIND_REQUIRED_FIELDS[kind];
  if (!required) return cannotVerify(`unrecognised evidence kind: ${kind}`);
  const missing = required.filter((field) => {
    const value = evidence[field];
    return value === undefined || value === null || (typeof value === "string" && !value.trim());
  });
  if (missing.length > 0) {
    return cannotVerify(`evidence kind ${kind} is missing: ${missing.join(", ")}`);
  }
  return { verdict: null, kind, required };
}

/**
 * Decide whether a ticket's evidence holds.
 *
 * @param {object} evidence   the ticket's evidence claim
 * @param {object} deps
 * @param {(evidence:object)=>Promise<boolean|null>} deps.resolve
 *        Performs the lookup. `true` -> the fact holds, `false` -> it does not,
 *        `null`/`undefined` -> INDETERMINATE. A thrown error is also indeterminate:
 *        an unreachable API tells us nothing about the work, so it must not be
 *        reported as either answer.
 * @returns {Promise<{verdict:string, reason?:string, kind?:string}>}
 */
export async function checkDone(evidence, { resolve } = {}) {
  const shape = describeEvidence(evidence);
  if (shape.verdict === VERDICTS.CANNOT_VERIFY) return shape;

  if (typeof resolve !== "function") {
    return cannotVerify("no resolver was provided");
  }

  let answer;
  try {
    answer = await resolve(evidence);
  } catch (error) {
    // An unreachable resolver is not evidence of incompleteness.
    const detail = error && error.message ? error.message : String(error);
    return { ...cannotVerify(`resolver failed: ${detail}`), kind: shape.kind };
  }

  if (answer === true) return { verdict: VERDICTS.DONE, kind: shape.kind };
  if (answer === false) return { verdict: VERDICTS.NOT_DONE, kind: shape.kind };
  return { ...cannotVerify("resolver returned an indeterminate answer"), kind: shape.kind };
}

/**
 * Decide a whole ticket, which may carry several pieces of evidence.
 *
 * ALL of them must hold. One `not-done` makes the ticket not done; otherwise a single
 * `cannot-verify` makes the whole ticket unverifiable. A ticket is never `done` on a
 * partial reading of its own evidence — that would let an unreachable check quietly
 * become a passing one, which is `cannot-verify` collapsing into `done` by the back
 * door rather than the front.
 *
 * A ticket claiming NO evidence is `cannot-verify`: nothing about it can be checked,
 * and it must not be closable by a checker.
 */
export async function checkTicketDone(ticket, deps = {}) {
  const claims = Array.isArray(ticket?.evidence) ? ticket.evidence : [];
  if (claims.length === 0) {
    return { verdict: VERDICTS.CANNOT_VERIFY, reason: "ticket claims no evidence", results: [] };
  }

  const results = [];
  for (const claim of claims) {
    results.push(await checkDone(claim, deps));
  }

  const notDone = results.find((r) => r.verdict === VERDICTS.NOT_DONE);
  if (notDone) {
    return { verdict: VERDICTS.NOT_DONE, reason: notDone.reason ?? "an evidence claim does not hold", results };
  }
  const unverifiable = results.find((r) => r.verdict === VERDICTS.CANNOT_VERIFY);
  if (unverifiable) {
    return { verdict: VERDICTS.CANNOT_VERIFY, reason: unverifiable.reason, results };
  }
  return { verdict: VERDICTS.DONE, results };
}
