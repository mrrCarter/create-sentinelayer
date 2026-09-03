import test from "node:test";
import assert from "node:assert/strict";

import { createEvidenceResolver, createGhRunner } from "../src/board/evidence-resolvers.js";
import { VERDICTS, checkDone } from "../src/board/done-gate.js";

/**
 * "I COULD NOT FIND OUT" MUST SURVIVE EVERY LOOKUP FAILURE.
 *
 * The done-gate already refuses to collapse `cannot-verify`. That guarantee is worth
 * nothing if the RESOLVER quietly turns "GitHub timed out" into `false` before the
 * gate ever sees it -- the collapse would just happen one layer lower, where nobody
 * is looking for it.
 *
 * So the bulk of this file is failure-shaped: unreachable API, malformed JSON,
 * unexpected state strings, and -- the one most likely to be got wrong -- a check that
 * has not started, which contributes NO ROW and must read as unknown rather than as
 * a failure. That is the "missing row reads as green" trap pointed the other way.
 *
 * The controls are the cases that must still produce a real verdict; without them a
 * resolver that returned `null` for everything would pass every other test here.
 */

const okJson = (obj) => async () => ({ ok: true, stdout: JSON.stringify(obj) });
const okText = (s) => async () => ({ ok: true, stdout: s });
const failed = async () => ({ ok: false, stderr: "gh: API rate limit exceeded" });

const PR = { kind: "pr-merged", repo: "mrrCarter/x", number: 851 };
const SHA = { kind: "sha-on-branch", repo: "mrrCarter/x", sha: "a6bb012", branch: "main" };
const CHK = { kind: "check-conclusive", repo: "mrrCarter/x", ref: "a6bb012", check: "Native Quality Gates" };

// --------------------------------------------------------------------------------
// CONTROLS -- without these, "returns null" would satisfy everything below
// --------------------------------------------------------------------------------

test("Unit board resolvers: CONTROL -- a merged PR resolves TRUE", async () => {
  const resolve = createEvidenceResolver({ run: okJson({ state: "MERGED", mergedAt: "2026-09-03T08:00:00Z" }) });
  assert.equal(await resolve(PR), true);
});

test("Unit board resolvers: CONTROL -- an open PR resolves FALSE", async () => {
  // A real negative: the PR exists and has not merged. This IS about the work.
  const resolve = createEvidenceResolver({ run: okJson({ state: "OPEN" }) });
  assert.equal(await resolve(PR), false);
  const closed = createEvidenceResolver({ run: okJson({ state: "CLOSED" }) });
  assert.equal(await closed(PR), false, "closed-without-merge is a genuine not-done");
});

// --------------------------------------------------------------------------------
// THE PROPERTY -- lookup failure is never a verdict
// --------------------------------------------------------------------------------

test("Unit board resolvers: an UNREACHABLE api is unknown, never false", async () => {
  const resolve = createEvidenceResolver({ run: failed });
  for (const ev of [PR, SHA, CHK]) {
    assert.equal(await resolve(ev), null, `${ev.kind}: a failed lookup must not be a verdict`);
  }
});

test("Unit board resolvers: MALFORMED or unexpected output is unknown", async () => {
  const garbage = createEvidenceResolver({ run: okText("<html>502 Bad Gateway</html>") });
  assert.equal(await garbage(PR), null);
  assert.equal(await garbage(CHK), null);

  const weirdState = createEvidenceResolver({ run: okJson({ state: "SOMETHING_NEW" }) });
  assert.equal(await weirdState(PR), null, "an unrecognised state must not be guessed at");

  const weirdCompare = createEvidenceResolver({ run: okText("who knows") });
  assert.equal(await weirdCompare(SHA), null);
});

test("Unit board resolvers: a check that NEVER STARTED is unknown, not failed", async () => {
  // The trap. An unstarted check contributes no row; reading that silence as a
  // failure marks finished work incomplete whenever a workflow is renamed or skipped.
  const noRows = createEvidenceResolver({ run: okJson([]) });
  assert.equal(await noRows(CHK), null, "no matching check row means UNKNOWN");

  const otherChecks = createEvidenceResolver({ run: okJson([{ name: "Lint", status: "completed", conclusion: "success" }]) });
  assert.equal(await otherChecks(CHK), null, "a different check's success says nothing about this one");
});

test("Unit board resolvers: a check still RUNNING is unknown", async () => {
  const running = createEvidenceResolver({
    run: okJson([{ name: "Native Quality Gates", status: "in_progress", conclusion: null }]),
  });
  assert.equal(await running(CHK), null);
});

test("Unit board resolvers: a RUNNING check with a STALE conclusion is still unknown", async () => {
  // GitHub can report a previous run's conclusion while a re-run is queued or in
  // flight. Trusting `conclusion` without checking `status` would read that stale
  // success as a current one -- a green that belongs to a run nobody asked about.
  // Found by mutating away the status guard and watching the suite stay green.
  const staleSuccess = createEvidenceResolver({
    run: okJson([{ name: "Native Quality Gates", status: "in_progress", conclusion: "success" }]),
  });
  assert.equal(await staleSuccess(CHK), null, "a conclusion from a previous run is not this run's answer");

  const queuedFailure = createEvidenceResolver({
    run: okJson([{ name: "Native Quality Gates", status: "queued", conclusion: "failure" }]),
  });
  assert.equal(await queuedFailure(CHK), null, "and a stale failure is equally not an answer");
});

test("Unit board resolvers: check conclusions map correctly", async () => {
  const pass = createEvidenceResolver({
    run: okJson([{ name: "Native Quality Gates", status: "completed", conclusion: "success" }]),
  });
  assert.equal(await pass(CHK), true);

  const fail = createEvidenceResolver({
    run: okJson([{ name: "Native Quality Gates", status: "completed", conclusion: "failure" }]),
  });
  assert.equal(await fail(CHK), false);

  // A skipped-but-completed check is not a failure -- Omar Gate Fork Static skips on
  // every non-fork PR and treating that as red would fail every ticket.
  const skipped = createEvidenceResolver({
    run: okJson([{ name: "Native Quality Gates", status: "completed", conclusion: "skipped" }]),
  });
  assert.equal(await skipped(CHK), true);
});

test("Unit board resolvers: sha containment maps from compare status", async () => {
  for (const [status, expected] of [["identical", true], ["behind", true], ["ahead", false], ["diverged", false]]) {
    const resolve = createEvidenceResolver({ run: okText(`${status}\n`) });
    assert.equal(await resolve(SHA), expected, `compare status ${status}`);
  }
});

test("Unit board resolvers: deploy-sha is unknown without a prober -- it will not guess", async () => {
  const noProbe = createEvidenceResolver({ run: failed });
  assert.equal(await noProbe({ kind: "deploy-sha", service: "api", sha: "a6bb012" }), null);

  const probed = createEvidenceResolver({ run: failed, probeDeployedSha: async () => true });
  assert.equal(await probed({ kind: "deploy-sha", service: "api", sha: "a6bb012" }), true);

  const throwing = createEvidenceResolver({ run: failed, probeDeployedSha: async () => { throw new Error("dns"); } });
  assert.equal(await throwing({ kind: "deploy-sha", service: "api", sha: "a6bb012" }), null);
});

// --------------------------------------------------------------------------------
// END TO END -- resolver + gate, which is the pair that decides a ticket
// --------------------------------------------------------------------------------

test("Unit board resolvers: END TO END -- an unreachable lookup yields CANNOT-VERIFY, not NOT-DONE", async () => {
  const resolve = createEvidenceResolver({ run: failed });
  const got = await checkDone(PR, { resolve });
  assert.equal(got.verdict, VERDICTS.CANNOT_VERIFY, "the collapse must not happen at the resolver layer either");
});

test("Unit board resolvers: END TO END -- a merged PR closes, an open one does not", async () => {
  const merged = createEvidenceResolver({ run: okJson({ state: "MERGED" }) });
  assert.equal((await checkDone(PR, { resolve: merged })).verdict, VERDICTS.DONE);

  const open = createEvidenceResolver({ run: okJson({ state: "OPEN" }) });
  assert.equal((await checkDone(PR, { resolve: open })).verdict, VERDICTS.NOT_DONE);
});

test("Unit board resolvers: the gh runner never throws -- a spawn failure is indeterminate", async () => {
  const run = createGhRunner({ spawn: async () => { throw new Error("ENOENT: gh not installed"); } });
  const res = await run(["pr", "view", "1"]);
  assert.equal(res.ok, false, "a missing gh binary must not crash the checker");
  const resolve = createEvidenceResolver({ run });
  assert.equal(await resolve(PR), null);
});
