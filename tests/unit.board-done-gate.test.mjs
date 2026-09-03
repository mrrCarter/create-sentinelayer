import test from "node:test";
import assert from "node:assert/strict";

import {
  EVIDENCE_KINDS,
  VERDICTS,
  checkDone,
  checkTicketDone,
  describeEvidence,
} from "../src/board/done-gate.js";

/**
 * "CANNOT VERIFY" MUST SURVIVE CONTACT WITH EVERY OTHER ANSWER.
 *
 * Two states would be easier and both collapses are tempting:
 *   fold into not-done -> the board nags about finished work until it is ignored
 *   fold into done     -> tickets close that nobody completed, and the board is worse
 *                         than useless because it is confidently wrong
 *
 * So most of this file is about the third state refusing to be absorbed. The controls
 * are the two cases that must still give a real answer -- without them a module that
 * returned cannot-verify for everything would pass every other test here.
 */

const MERGED = { kind: EVIDENCE_KINDS.PR_MERGED, repo: "mrrCarter/x", number: 851 };

const yes = { resolve: async () => true };
const no = { resolve: async () => false };

test("Unit board done-gate: CONTROL -- evidence that holds is DONE", async () => {
  const got = await checkDone(MERGED, yes);
  assert.equal(got.verdict, VERDICTS.DONE);
  assert.equal(got.kind, EVIDENCE_KINDS.PR_MERGED);
});

test("Unit board done-gate: CONTROL -- evidence that does not hold is NOT-DONE", async () => {
  const got = await checkDone(MERGED, no);
  assert.equal(got.verdict, VERDICTS.NOT_DONE);
});

test("Unit board done-gate: a resolver that THROWS is cannot-verify, never not-done", async () => {
  // An unreachable API tells us nothing about the work. Reporting "not done" here
  // would mean every network blip re-opens finished tickets.
  const got = await checkDone(MERGED, {
    resolve: async () => {
      throw new Error("GitHub API 503");
    },
  });
  assert.equal(got.verdict, VERDICTS.CANNOT_VERIFY);
  assert.match(got.reason, /resolver failed: GitHub API 503/);
});

test("Unit board done-gate: an INDETERMINATE resolver answer is cannot-verify", async () => {
  for (const answer of [null, undefined, "true", 1, {}]) {
    const got = await checkDone(MERGED, { resolve: async () => answer });
    assert.equal(
      got.verdict,
      VERDICTS.CANNOT_VERIFY,
      `resolver answer ${JSON.stringify(answer)} must not be read as a verdict`,
    );
  }
});

test("Unit board done-gate: only a literal true/false is a verdict", async () => {
  // Guards against a truthiness bug: a non-empty string or 1 must NOT mean done.
  assert.equal((await checkDone(MERGED, { resolve: async () => "yes" })).verdict, VERDICTS.CANNOT_VERIFY);
  assert.equal((await checkDone(MERGED, { resolve: async () => 0 })).verdict, VERDICTS.CANNOT_VERIFY);
  assert.equal((await checkDone(MERGED, yes)).verdict, VERDICTS.DONE);
  assert.equal((await checkDone(MERGED, no)).verdict, VERDICTS.NOT_DONE);
});

test("Unit board done-gate: an UNRECOGNISED evidence kind is cannot-verify", async () => {
  const got = await checkDone({ kind: "vibes", repo: "x" }, yes);
  assert.equal(got.verdict, VERDICTS.CANNOT_VERIFY, "an unknown kind must never be resolvable");
  assert.match(got.reason, /unrecognised evidence kind: vibes/);
});

test("Unit board done-gate: an unknown kind is refused BEFORE the resolver is consulted", async () => {
  // The closed set is the control. If the resolver were asked, a permissive resolver
  // could stamp done on a kind nobody defined.
  let consulted = false;
  const got = await checkDone(
    { kind: "vibes" },
    {
      resolve: async () => {
        consulted = true;
        return true;
      },
    },
  );
  assert.equal(got.verdict, VERDICTS.CANNOT_VERIFY);
  assert.equal(consulted, false, "an unknown kind must not reach the resolver at all");
});

test("Unit board done-gate: a MALFORMED descriptor is cannot-verify, not not-done", async () => {
  // We did not learn the work is incomplete -- only that the ticket does not say how
  // to check it. Those are different facts and only one of them is about the work.
  assert.equal((await checkDone(undefined, yes)).verdict, VERDICTS.CANNOT_VERIFY);
  assert.equal((await checkDone({}, yes)).verdict, VERDICTS.CANNOT_VERIFY);
  const missing = await checkDone({ kind: EVIDENCE_KINDS.PR_MERGED, repo: "mrrCarter/x" }, yes);
  assert.equal(missing.verdict, VERDICTS.CANNOT_VERIFY);
  assert.match(missing.reason, /missing: number/);

  const blank = await checkDone({ kind: EVIDENCE_KINDS.SHA_ON_BRANCH, repo: "x", sha: "   ", branch: "main" }, yes);
  assert.equal(blank.verdict, VERDICTS.CANNOT_VERIFY, "a whitespace-only field is not a value");
});

test("Unit board done-gate: a missing resolver is cannot-verify", async () => {
  assert.equal((await checkDone(MERGED, {})).verdict, VERDICTS.CANNOT_VERIFY);
  assert.equal((await checkDone(MERGED)).verdict, VERDICTS.CANNOT_VERIFY);
});

test("Unit board done-gate: every declared kind validates its own required fields", () => {
  // Keeps the closed set honest: a kind added without required fields would silently
  // accept anything shaped like an object.
  for (const kind of Object.values(EVIDENCE_KINDS)) {
    const bare = describeEvidence({ kind });
    assert.equal(bare.verdict, VERDICTS.CANNOT_VERIFY, `${kind} must require fields`);
    assert.match(bare.reason, /is missing:/);
  }
});

// --------------------------------------------------------------------------------
// WHOLE TICKETS -- where cannot-verify is most tempting to lose
// --------------------------------------------------------------------------------

test("Unit board done-gate: a ticket is DONE only when EVERY claim holds", async () => {
  const ticket = { evidence: [MERGED, { kind: EVIDENCE_KINDS.DEPLOY_SHA, service: "api", sha: "a6bb012" }] };
  assert.equal((await checkTicketDone(ticket, yes)).verdict, VERDICTS.DONE);

  let calls = 0;
  const firstOnly = { resolve: async () => (++calls === 1 ? true : false) };
  assert.equal((await checkTicketDone(ticket, firstOnly)).verdict, VERDICTS.NOT_DONE);
});

test("Unit board done-gate: one unverifiable claim makes the TICKET unverifiable", async () => {
  // The back-door collapse: if a ticket could be DONE while one of its claims could
  // not be checked, an unreachable check quietly becomes a passing one.
  const ticket = {
    evidence: [MERGED, { kind: EVIDENCE_KINDS.DEPLOY_SHA, service: "api", sha: "a6bb012" }],
  };
  let calls = 0;
  const secondUnreachable = {
    resolve: async () => {
      if (++calls === 1) return true;
      throw new Error("timeout");
    },
  };
  const got = await checkTicketDone(ticket, secondUnreachable);
  assert.equal(got.verdict, VERDICTS.CANNOT_VERIFY, "a ticket must not be done on a partial reading");
  assert.equal(got.results.length, 2);
});

test("Unit board done-gate: NOT-DONE outranks cannot-verify on a ticket", async () => {
  // If one claim is definitively false, the ticket is not done regardless of whether
  // another could be checked -- that answer IS about the work.
  const ticket = {
    evidence: [{ kind: "vibes" }, MERGED],
  };
  assert.equal((await checkTicketDone(ticket, no)).verdict, VERDICTS.NOT_DONE);
});

test("Unit board done-gate: a ticket with NO evidence can never be closed by the checker", async () => {
  for (const ticket of [{ evidence: [] }, {}, { evidence: null }, undefined]) {
    const got = await checkTicketDone(ticket, yes);
    assert.equal(got.verdict, VERDICTS.CANNOT_VERIFY, "no evidence must never mean done");
    assert.match(got.reason, /claims no evidence/);
  }
});
