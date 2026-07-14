# Omar AI Call Evidence

## Classification

- Class D deterministic review-gate integrity boundary.
- No prompt, model, provider-routing, billing-price, or credential contract change.

## Baseline

- Deep Omar runs `omargate-1784001480577-697c1a65` and `omargate-1784002043271-e66f185b` completed both dispatched personas with `status=ok` and returned AI findings.
- The second run's billing ledgers recorded 2,054 backend tokens at provider cost 0.004244 and 3,605 testing tokens at provider cost 0.027134.
- Internal billing returned zero/null customer cost. The orchestrator treated aggregate customer cost `0` as proof that no LLM call occurred and appended a blocking P1.

## Candidate Acceptance

- A non-dry-run persona with zero cost and no usage or successful ledger evidence still produces the blocking AI-coverage P1.
- Zero-priced token-bearing usage confirms one provider call without fabricating a cost.
- A successful zero-customer-price billing ledger confirms one provider call from token/provider-cost fields without exposing ledger identifiers.
- Every persona reporting `ok` must have its own call evidence; one proven call cannot mask another persona's silent success.
- Swarm evidence is summed once per subagent; usage and ledger copies for the same call are not counted as separate calls.
- Existing all-persona failure behavior remains a blocking P0.

## Live Evidence

- Run `omargate-1784003567736-48074a17` completed backend and testing personas with 3,996 aggregate ledger tokens and provider cost 0.008353.
- The run returned zero deterministic, AI, or orchestrator findings and exited successfully.

## Rollback

- Revert the isolated commit to restore the previous cost-only health predicate.
- No migration, remote mutation, billing-price change, credential operation, or generated-artifact rewrite is required.
