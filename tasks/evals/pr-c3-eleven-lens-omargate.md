# PR-C3 Eval Evidence: OmarGate 11-Lens Evidence

## Scope

This PR changes OmarGate AI prompt behavior and evidence preservation:

- all OmarGate persona prompts include a generic 11-lens evidence contract borrowed from the Jules pattern
- both single-persona and swarm subagent paths pass persona prompts into `runAiReviewLayer`
- per-persona prompt artifacts are written under persona-specific review directories
- AI parsing and unified reconciliation preserve `lensEvidence`, `reproduction`, `userImpact`, `trafficLight`, `rootCause`, and `recommendedFix`

## Evaluation

Focused checks:

- `node --check src/review/persona-prompts.js src/review/ai-review.js src/review/omargate-orchestrator.js src/review/report.js`
- `node --test tests/unit.persona-prompts.test.mjs`
  - verifies every OmarGate persona prompt includes the 11-lens contract
  - verifies generic fallback prompts include the same contract
- `node --test tests/unit.review-ai.test.mjs`
  - verifies Jules-compatible evidence fields parse from JSON
  - verifies top-level JSON arrays still parse for legacy compatibility
  - verifies `systemPrompt` is prepended to the persisted AI prompt
- `node --test tests/unit.omargate-orchestrator.test.mjs`
  - verifies non-swarm persona prompt artifacts contain the 11-lens contract
  - verifies swarm subagent prompt artifacts contain the 11-lens contract
- `node --test tests/unit.review-report.test.mjs`
  - verifies reconciliation preserves 11-lens evidence fields

Full branch gates:

- `npm run check`
  - result: 294 files passed
- `git diff --check`
  - result: pass
- `node bin/create-sentinelayer.js review --diff --spec tasks/dd-build-spec-2026-04-26.md --json`
  - result: P0=0 P1=0 P2=0 P3=0
  - run: `review-20260428-015704-2ee60711`
- `npm run verify`
  - result: pass after installing clean-worktree dependencies with `npm ci`
  - check
  - docs build
  - 95 e2e tests
  - 1133 unit coverage tests
  - npm pack dry-run
- `node bin/create-sentinelayer.js /omargate deep --path . --json --ai-dry-run --persona security --max-cost 1`
  - result: P0=0 P1=0 P2=32 P3=0 blocking=false
  - run: `omargate-1777341743129-96e25ff3`
  - prompt artifact check: 47/47 generated security swarm prompt artifacts contained `11-lens evidence contract`, `lensEvidence`, and `trafficLight`
  - reconciled report check: evidence fields survived into `REVIEW_RECONCILED.json` (`lensEvidence`, `reproduction`, `trafficLight`, `userImpact`, `recommendedFix`)

## False-Positive Guard Measurement

The local deterministic fixture is dry-run only, so it cannot measure a live LLM false-positive rate. The measurable proxy used in this PR is evidence-contract coverage on labeled OmarGate prompt fixtures:

- Baseline on `origin/main` before PR-C3: `0/13` OmarGate persona prompts required `lensEvidence`, `reproduction`, `user_impact`, and `trafficLight`.
- PR-C3 branch: `13/13` OmarGate persona prompts require those fields and focused tests prove parser/reconciliation retain them.

This is the enforceable local proxy for the spec's false-positive-reduction goal: persona findings must now carry static evidence, user impact, reproduction data for P0/P1, traffic-light safety, and per-lens evidence before they can survive the report pipeline.

## Risk Assessment

The eval risk is medium because prompt behavior changes for all OmarGate personas. The implementation keeps the appendix compact, preserves default `/review` behavior when `systemPrompt` is absent, supports legacy array responses, and verifies artifact paths in dry-run mode without live provider dependence.
