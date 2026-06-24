# PR Eval Evidence: Investor-DD Usage Telemetry Progress

Date: 2026-06-24
Scope trigger: Investor-DD progress and report metadata changed in `src/review/investor-dd-orchestrator.js`, `src/review/investor-dd-persona-runner.js`, and `src/review/investor-dd-progress.js`.

## What Changed

- Added per-persona runtime timing to the deterministic Investor-DD persona runner.
- Added a `file-metrics.json` artifact with bytes and non-empty LOC per walked file.
- Added `progress.json.usageTelemetry` and `summary.json.usageTelemetry`.
- The telemetry block reports per-persona routed files, visited files, LOC, bytes, duration, tool calls, findings, and any real billing-grade session_usage token/cost ledger entries.
- The progress capability now distinguishes deterministic telemetry that exists from still-missing billing/customer-margin telemetry.

## Eval Impact Assessment

- Prompt changes: no.
- Model-route changes: no.
- Tool allowlist changes: no.
- Policy/routing changes: no.
- Report/progress behavior changes: yes. The sellable-readiness ledger is more specific and exposes auditable usage telemetry rather than a generic missing-summary gap.

## Baseline Behavior

Investor-DD progress truthfully reported that per-agent token/time/LOC/customer-price/margin telemetry was missing, but it did not expose the deterministic data already available to the run:

- routed and visited file counts,
- source LOC / bytes,
- deterministic tool invocations,
- findings per persona,
- per-persona runtime,
- real session_usage ledger entries when present.

This made DD progress less useful for product/audit review and for pricing work because every usage gap collapsed into one broad message.

## Candidate Behavior

Investor-DD progress now includes structured usage telemetry:

- deterministic per-agent work metrics are always reported when routing/file metrics exist,
- token/cost totals are folded in only from real session_usage ledger entries,
- customer cost and margin remain explicit gaps until supplied by the billing ledger,
- deterministic work never fabricates provider token usage.

## Validation Completed

- `node --import ./tests/setup-env.mjs --test tests/unit.investor-dd-progress.test.mjs tests/unit.investor-dd-orchestrator.test.mjs tests/unit.investor-dd-persona-runner.test.mjs` passed 32/32.
- `node --import ./tests/setup-env.mjs --test --test-name-pattern "investor-dd" tests/e2e.test.mjs` passed 2/2 and asserts `file-metrics.json`, `summary.usageTelemetry`, and `progress.usageTelemetry` on the command path.
- `npm run check` passed 337 files.
- `npm run test:unit` passed 1585/1585.
- `npm run test:e2e` passed 102/102.
- `node bin/sl.js omargate investor-dd --path C:\tmp\sentinelayer-api-deploy-state-20260624 --output-dir C:\tmp\sl-cli-audit-artifacts\recheck-20260624-after --dry-run --no-email --no-dashboard --no-devtestbot --json` produced 13 per-agent usage records, 435 routed files with metrics, 150,733 LOC, and zero token/cost totals because no session usage ledger was supplied.
- `node bin/sl.js review scan --path . --mode diff --json` passed with P1=0/P2=0/blocking=false after the active spec scope was updated for Investor-DD telemetry.
- `node bin/sl.js /omargate deep --path . --scope-mode diff --json` final run `omargate-1782273279131-d8a9738b` completed with P0=0/P1=0/blocking=false using managed backend/testing personas; the documentation persona degraded on a nonblocking 504 proxy denial.

## Omar P2 Adjudication

- `tests/e2e.test.mjs:1 - E2E coverage does not demonstrate critical-path flows (auth/payment/kill-switch)`: non-source-bearing for this PR. The changed runtime is Investor-DD telemetry/export shape; auth, payment, and kill-switch flows are not touched. The existing Investor-DD e2e command path now asserts `file-metrics.json`, `summary.usageTelemetry`, and `progress.usageTelemetry`.
- `tests/unit.investor-dd-orchestrator.test.mjs:1 - Unit-test-centric orchestration coverage lacks API integration verification`: partially addressed by existing command-level e2e. This PR does not add a new API endpoint; the only API-shaped behavior in the touched e2e path is the already mocked DD email API, and the telemetry artifacts are local CLI outputs.
