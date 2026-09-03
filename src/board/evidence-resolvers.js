/**
 * BOARD — resolvers: the code that actually asks whether a ticket's evidence holds.
 *
 * `done-gate.js` decides what an answer MEANS. This decides what the answer IS. The
 * split matters because the gate must stay pure and testable while the lookups are
 * inherently messy — networks time out, repos get renamed, tokens expire.
 *
 * THE ONE RULE THAT GOVERNS EVERY RESOLVER HERE:
 *
 *   true   the fact was checked and HOLDS
 *   false  the fact was checked and DOES NOT hold
 *   null   we could not find out
 *
 * `null` is not a failure to be tidied away into `false`. **"I could not reach GitHub"
 * and "the PR is not merged" are different facts, and only one of them is about the
 * work.** Collapsing them means every network blip re-opens finished tickets until
 * nobody trusts the board.
 *
 * THE SUBTLER HALF, and the one this file exists to get right: **absence is not
 * failure.** A check that has not started yet contributes no row and no conclusion.
 * Reading that silence as `false` is the same defect as reading a missing CI row as
 * green, just pointed the other way — and it is the mistake most likely to be made by
 * someone writing these resolvers in a hurry.
 *
 * Every lookup is INJECTED (`run`), so each branch above -- including every failure
 * branch -- is reachable in a test without a network.
 */

/** Shape a resolver must return. Anything else is treated as indeterminate. */
const YES = true;
const NO = false;
const UNKNOWN = null;

function parseJson(stdout) {
  try {
    return JSON.parse(String(stdout ?? ""));
  } catch {
    return undefined;
  }
}

/**
 * @param {object} deps
 * @param {(argv:string[])=>Promise<{ok:boolean,stdout?:string,stderr?:string}>} deps.run
 *        Executes a `gh` invocation. `ok:false` means the call failed for ANY reason
 *        -- that is indeterminate, never a negative verdict.
 * @param {(sha:string)=>Promise<boolean|null>} [deps.probeDeployedSha]
 *        Optional. Without it, `deploy-sha` evidence resolves to UNKNOWN rather than
 *        being guessed at -- this module will not pretend to know what is live.
 */
export function createEvidenceResolver({ run, probeDeployedSha } = {}) {
  if (typeof run !== "function") throw new TypeError("a run() is required");

  async function prMerged({ repo, number }) {
    const res = await run(["pr", "view", String(number), "--repo", repo, "--json", "state,mergedAt"]);
    if (!res || !res.ok) return UNKNOWN; // unreachable, missing, or unauthorised
    const data = parseJson(res.stdout);
    if (!data || typeof data.state !== "string") return UNKNOWN;
    if (data.state === "MERGED") return YES;
    // OPEN or CLOSED-without-merge is a real negative: the PR exists and did not merge.
    if (data.state === "OPEN" || data.state === "CLOSED") return NO;
    return UNKNOWN;
  }

  async function shaOnBranch({ repo, sha, branch }) {
    const res = await run(["api", `repos/${repo}/compare/${branch}...${sha}`, "--jq", ".status"]);
    if (!res || !res.ok) return UNKNOWN;
    const status = String(res.stdout ?? "").trim();
    // GitHub's compare status, base=branch head=sha:
    //   identical / behind -> sha is contained in branch
    //   ahead / diverged   -> it is not
    if (status === "identical" || status === "behind") return YES;
    if (status === "ahead" || status === "diverged") return NO;
    return UNKNOWN;
  }

  async function checkConclusive({ repo, ref, check }) {
    const res = await run(["api", `repos/${repo}/commits/${ref}/check-runs`, "--jq", ".check_runs"]);
    if (!res || !res.ok) return UNKNOWN;
    const runs = parseJson(res.stdout);
    if (!Array.isArray(runs)) return UNKNOWN;

    const named = runs.filter((r) => r && r.name === check);
    // ABSENCE IS NOT FAILURE. A check that never started contributes no row, so an
    // empty match means we do not know -- exactly the "missing row reads as green"
    // trap, inverted. Reporting NO here would mark finished work as incomplete
    // whenever a workflow was renamed or skipped.
    if (named.length === 0) return UNKNOWN;

    // Any still running -> the answer is not in yet.
    if (named.some((r) => r.status !== "completed")) return UNKNOWN;

    const conclusions = named.map((r) => r.conclusion);
    if (conclusions.every((c) => c === "success" || c === "skipped")) return YES;
    if (conclusions.some((c) => c === "failure" || c === "timed_out" || c === "cancelled")) return NO;
    return UNKNOWN;
  }

  async function deploySha({ sha }) {
    if (typeof probeDeployedSha !== "function") return UNKNOWN;
    try {
      const live = await probeDeployedSha(sha);
      return live === true ? YES : live === false ? NO : UNKNOWN;
    } catch {
      return UNKNOWN;
    }
  }

  const BY_KIND = {
    "pr-merged": prMerged,
    "sha-on-branch": shaOnBranch,
    "check-conclusive": checkConclusive,
    "deploy-sha": deploySha,
  };

  /**
   * The function `checkDone` expects: evidence -> true | false | null.
   * An unrecognised kind returns UNKNOWN here, though the gate refuses it before we
   * are ever called -- defence in depth, since this module is exported on its own.
   */
  return async function resolve(evidence) {
    const handler = BY_KIND[evidence?.kind];
    if (!handler) return UNKNOWN;
    return handler(evidence);
  };
}

/** A `run` backed by the real `gh` CLI. Never throws: a failure is indeterminate. */
export function createGhRunner({ spawn }) {
  return async function run(argv) {
    try {
      const res = await spawn("gh", argv);
      return { ok: res.code === 0, stdout: res.stdout, stderr: res.stderr };
    } catch (error) {
      return { ok: false, stderr: error?.message ?? String(error) };
    }
  };
}
