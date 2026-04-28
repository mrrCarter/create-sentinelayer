# PR-E2 Eval Evidence: devTestBot Swarm Persona

## Scope

This PR changes eval-impacting swarm surfaces:

- `src/commands/swarm.js`
- `src/swarm/registry.js`
- `src/swarm/runtime.js`

The change adds an invokable `devtestbot` swarm persona and routes `swarm run --agent devtestbot --scope smoke` through a governed runtime branch. It does not change model provider selection, existing audit personas, existing OmarGate prompts, or default swarm agent selection. Existing `swarm run` behavior remains mock/dry-run unless `--execute` is explicitly supplied.

The new devTestBot prompt is introduced as an artifact contract for the new persona. The prompt requires scan-only operation, no data extraction, and redacted output. It is not wired into DD auto-engagement until PR-E3.

## Evaluation

Focused checks:

- `node --import ./tests/setup-env.mjs --test tests/unit.devtestbot-definition.test.mjs tests/unit.devtestbot-system-prompt.test.mjs tests/unit.devtestbot-tool.test.mjs`
  - result: 5/5 pass
  - proves scan-only persona definition, privacy-preserving prompt, tool schema, dry-run artifact bundle, canonical agent events, finding normalization, and secret suppression
- `node --import ./tests/setup-env.mjs --test tests/unit.swarm-registry.test.mjs tests/unit.swarm-factory.test.mjs tests/unit.swarm-runtime.test.mjs tests/unit.commands-contracts.test.mjs`
  - result: 23/23 pass
  - proves built-in `devtestbot` registration, OMAR-led plan wiring, runtime dispatch through `devtestbot.run_session`, `finding` events, artifact bundle propagation, and `--agent`/`--scope`/`--identity-id` command contract
- `node --import ./tests/setup-env.mjs --test tests/e2e.test.mjs --test-name-pattern "devTestBot|swarm registry|swarm run"`
  - result: 96/96 pass because the pattern matched the broader e2e suite names
  - includes `CLI swarm run supports devTestBot --agent/--scope dry-run artifact bundle`

Full branch gates:

- `npm run check`
  - result: 301 files passed
- `npm run verify`
  - check
  - docs build
  - e2e 96/96
  - unit coverage 1167/1167 with thresholds met
  - npm pack dry-run
- `git diff --check`
  - result: pass; Windows LF/CRLF warnings only
- `node bin/create-sentinelayer.js review --diff --refresh --spec tasks/dd-build-spec-2026-04-26.md --json`
  - result: P0=0 P1=0 P2=0 P3=0
  - run: `review-20260428-065046-d0e7cc46`
- `node bin/create-sentinelayer.js /omargate deep --path . --ai-dry-run --max-cost 5 --json`
  - result: P0=0 P1=0 blocking=false
  - run: `omargate-1777359062348-5d8b4420`
- `node bin/create-sentinelayer.js /audit --path . --json`
  - result: PASS, P1=0, blocking=false
  - report: `audit-20260428-065101`

## Risk Assessment

The eval risk is low to medium. The PR changes the swarm command/runtime route and adds a new persona, but it keeps default swarm behavior unchanged and confines devTestBot execution to explicit `--agent devtestbot` selection. Browser execution remains opt-in via `--execute`; dry-run mode produces an artifact bundle and an evidence-gap finding instead of silently pretending browser evidence exists.

The primary risk is secret leakage from identity-backed browser testing. The tool resolves only local identity metadata by `identityId`, avoids returning raw credential material, redacts explicit password/token/OTP/reset-link values, and tests assert those strings do not appear in returned events or artifacts.
