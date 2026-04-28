# PR-C2 Eval Evidence: OmarGate Audit Reuse

## Scope

This PR changes the audit command surface by adding `--reuse-omargate <runId|latest>`.
The option only affects deterministic baseline sourcing:

- default audit behavior remains unchanged when reuse is not requested or unavailable
- valid reuse loads `.sentinelayer/runs/<runId>/deterministic.json`
- modern audit seeds the blackboard from the cached deterministic findings with `source=omargate-reuse`
- slash `/audit` reports the reused OmarGate run id for the spec-required CLI flow

No model prompt, persona prompt, provider routing, or agent loop behavior is changed.

## Evaluation

Focused behavior checks:

- `node --test tests/unit.omargate-cache.test.mjs`
  - writes stable cache path
  - loads explicit run id
  - resolves `latest` for the same target path only
  - fails closed on invalid/malformed cache
- `node --test tests/unit.audit-omargate-reuse.test.mjs`
  - `reuse-omargate latest` skips deterministic rerun
  - reused findings seed shared memory/blackboard
  - unavailable reuse falls back to the deterministic pipeline
- `node --test --test-name-pattern "CLI local audit can reuse latest OmarGate deterministic cache" tests/e2e.test.mjs`
  - runs `omargate deep --no-ai --json`
  - verifies `.sentinelayer/runs/<runId>/deterministic.json`
  - runs `/audit --reuse-omargate latest --json`
  - verifies the report references the prior OmarGate run id

Full branch gates:

- `npm run check`
- `git diff --check`
- `node bin/create-sentinelayer.js review --diff --spec tasks/dd-build-spec-2026-04-26.md --json`
  - result: P0=0 P1=0 P2=0 P3=0
  - run: `review-20260428-012022-eefde2d6`
- `npm run verify`
  - check
  - docs build
  - 95 e2e tests
  - 1126 unit coverage tests
  - npm pack dry-run
- `node bin/create-sentinelayer.js /omargate deep --path . --json --ai-dry-run --max-cost 5`
  - result: P0=0 P1=0 blocking=false
  - wrote cache for `omargate-1777339398563-cea7eba1`
- `node bin/create-sentinelayer.js /audit --path . --reuse-omargate latest --json`
  - result: overallStatus=PASS blocking=false
  - reused `omargate-1777339398563-cea7eba1`
- `node bin/create-sentinelayer.js /audit --path . --json`
  - result: overallStatus=PASS blocking=false

## Risk Assessment

The eval risk is low. The PR introduces cache reuse for deterministic findings and command metadata, not model behavior. The default path is explicitly covered by fallback tests and local `/audit --json`. The reused path is covered at helper, orchestrator, and CLI layers.
