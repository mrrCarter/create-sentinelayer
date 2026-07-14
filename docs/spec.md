# create-sentinelayer Specification

## Goal
Deliver a deterministic, security-first CLI that scaffolds Sentinelayer artifacts, runs local Omar-compatible checks, and supports offline ingest/spec/prompt generation.

## Scope
- Stable command surface for scaffold + local governance commands.
- Authenticated Senti session coordination surfaces, including CLI/MCP inbox polling and durable message writes.
- Reproducible output artifacts under configurable output roots.
- CI workflows enforcing quality and Omar gate checks.
- Hosted Omar Action integration with immutable action provenance, live-LLM execution evidence, artifact integrity validation, and consumer-owned severity policy.
- Senti session coordination commands and generated agent guidance, including quiet/background listener behavior and durable presence controls.
- Managed LLM proxy client behavior in `src/ai/proxy.js` and `src/ai/client.js`, including quota/paywall denial metadata, retry policy, and structured audit/Senti fallback artifacts in `src/audit/persona-loop.js` and `src/session/daemon.js`.
- Cost governance surfaces in `src/cost/*`, including provider-aware tokenization, pricing, usage history, budget enforcement, and their unit tests.
- Investor-DD and Omar due-diligence runner surfaces in `src/review/investor-dd-*`, including `progress.json`, `summary.ddProgress`, `summary.usageTelemetry`, per-persona runtime/LOC metrics, and billing-grade session usage ledger integration when available.
- Deterministic persona tool registries in `src/agents/*`, including per-persona domain tools, mode/run-persona wiring, and investor-DD persona registry integration.

## Guardrails
- Preserve backward-compatible binary aliases (`create-sentinelayer`, `sentinel`).
- Keep security workflows mandatory on pull requests.
- Keep release path auditable and versioned.
- Treat a hosted AI gate as passed only when a pinned action reports a successful, structurally valid live review and the consumer independently validates the action's `PACK_SUMMARY.json` and `FINDINGS.jsonl` integrity. Requested credentials, requested provider/model values, zero findings, or `gate_status=passed` are not execution evidence by themselves.
- Keep deterministic provider-outage scans diagnostic. They must not replace a required live-LLM result or become a selectable green merge result.
- Validate live execution evidence before applying repository severity thresholds. The action owns evidence validity; the consuming workflow owns P0/P1/P2 merge policy.
- Do not treat same-repository pull-request origin as sufficient workflow trust. Merge authority requires a protected workflow/validator definition or documented actor and environment controls that prevent a branch author from changing privileged gate code and consuming secrets.
- Protect the complete credential boundary, not only LLM provider keys. Gate, release-governance, and package-publication authority must be purpose-scoped to reviewed environments and protected workflow definitions; remove or revoke obsolete repository-level credentials.
- Keep fork and other untrusted deterministic scans non-authoritative for a required live gate. They may provide diagnostics, but the required check stays non-green until a trusted review is bound to the exact proposed commit.
- Generated and legacy workflows must use only inputs and scan modes declared by the pinned Action interface. Local CLI persona modes are a separate contract and must not be presented as hosted Action modes.

## Operational Anchors
- Setup and local verification: run `npm ci --ignore-scripts`, `npm run check`, `npm run test:unit`, and `npm run test:e2e` before release-impacting CLI changes.
- Command contract validation: CLI/API request envelopes are covered by `tests/unit.cli-api-session-contract.test.mjs`, session sync surfaces live in `src/session/sync.js`, and review/Omar command behavior is covered by `tests/e2e.test.mjs`.
- Hosted Action migrations must satisfy `tasks/evals/2026-07-14-action-live-llm-evidence-migration.md`, including exact action and CLI provenance, positive live proof, negative fail-closed proof, and cross-channel artifact checks.
- Investor-DD verification: changes to `src/review/investor-dd-*` must prove generated `plan.json`, `file-metrics.json`, `progress.json`, `summary.json`, and command-level `summary.usageTelemetry`/`progress.usageTelemetry` parity.
- Incident response: use `sl session listeners`, `sl session stop-listener`, `sl session kill --agent <id>`, and `sl session admin-kill` for stuck Senti actors; use local review scan plus `/omargate deep --scope-mode diff --json` before PR readiness.
- Architecture references: see `tasks/dd-build-spec-2026-04-26.md` for the Investor-DD roadmap and `docs/sessions.md` for Senti session operations.
