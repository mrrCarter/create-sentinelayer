# create-sentinelayer Specification

## Goal
Deliver a deterministic, security-first CLI that scaffolds Sentinelayer artifacts, runs local Omar-compatible checks, and supports offline ingest/spec/prompt generation.

## Scope
- Stable command surface for scaffold + local governance commands.
- Authenticated Senti session coordination surfaces, including CLI/MCP inbox polling and durable message writes.
- Reproducible output artifacts under configurable output roots.
- CI workflows enforcing quality and Omar gate checks.
- Senti session coordination commands and generated agent guidance, including quiet/background listener behavior and durable presence controls.
- Managed LLM proxy client behavior in `src/ai/proxy.js` and `src/ai/client.js`, including quota/paywall denial metadata, retry policy, and structured audit/Senti fallback artifacts in `src/audit/persona-loop.js` and `src/session/daemon.js`.
- Cost governance surfaces in `src/cost/*`, including provider-aware tokenization, pricing, usage history, budget enforcement, and their unit tests.
- Investor-DD and Omar due-diligence runner surfaces in `src/review/investor-dd-*`, including `progress.json`, `summary.ddProgress`, `summary.usageTelemetry`, per-persona runtime/LOC metrics, and billing-grade session usage ledger integration when available.

## Guardrails
- Preserve backward-compatible binary aliases (`create-sentinelayer`, `sentinel`).
- Keep security workflows mandatory on pull requests.
- Keep release path auditable and versioned.

## Operational Anchors
- Setup and local verification: run `npm ci --ignore-scripts`, `npm run check`, `npm run test:unit`, and `npm run test:e2e` before release-impacting CLI changes.
- Command contract validation: CLI/API request envelopes are covered by `tests/unit.cli-api-session-contract.test.mjs`, session sync surfaces live in `src/session/sync.js`, and review/Omar command behavior is covered by `tests/e2e.test.mjs`.
- Investor-DD verification: changes to `src/review/investor-dd-*` must prove generated `plan.json`, `file-metrics.json`, `progress.json`, `summary.json`, and command-level `summary.usageTelemetry`/`progress.usageTelemetry` parity.
- Incident response: use `sl session listeners`, `sl session stop-listener`, `sl session kill --agent <id>`, and `sl session admin-kill` for stuck Senti actors; use local review scan plus `/omargate deep --scope-mode diff --json` before PR readiness.
- Architecture references: see `tasks/dd-build-spec-2026-04-26.md` for the Investor-DD roadmap and `docs/sessions.md` for Senti session operations.
