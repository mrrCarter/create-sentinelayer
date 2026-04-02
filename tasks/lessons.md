# Lessons

## 2026-03-31

- When a roadmap spans multiple repos, baseline every dependent repo before starting feature PRs; unresolved upstream drift can invalidate downstream design decisions.
- For this CLI, treat monolith extraction as a behavior-preservation problem first; lock existing e2e coverage before introducing architecture changes.
- Move CI and test-hardening work earlier than originally planned when later phases depend on sandboxing, agent orchestration, and reproducibility.
- Keep deterministic and AI-assisted paths separately testable and separately budgeted; never couple release-critical deterministic checks to optional model availability.
- Apply Definition-of-Ready and Definition-of-Done checklists per PR id to prevent scope creep across 56-roadmap-PR execution.
- Explicitly record evidence artifacts (commands, reports, hashes) in each PR to satisfy SWE framework provenance and release-control expectations.
- Treat missing instruction-topology files (`.github/copilot-instructions.md`, path-scoped instructions) as governance debt, not documentation polish.
- For identity-dependent phases (11/12), require an integration checkpoint with the external AIdenID codebase before opening implementation PRs.
- Maintain a strict one-PR-at-a-time flow inside each batch; batching is for planning/dependency grouping, not for mixing multiple roadmap PR scopes into one change set.
- Run the Omar loop as a first-class quality gate, but pair it with deterministic local checks so failures are diagnosable without cloud dependencies.
- Reference `src` does not rely on a single full-repo AST map; it combines deterministic ripgrep/file indexing with on-demand LSP symbol/call-hierarchy tooling, which is the better model to mirror for low-latency context control.
- For Sentinelayer, keep deterministic ingest as the governance backbone and add semantic overlays (LSP/AST on demand) only for impact scoping and handoff precision.
- Kairos-style assistant mode should be treated as an orchestration responsiveness profile (forced async subagents + auto-backgrounding long shell work), not as a complete safety-budget system.
- Separate "responsiveness budgets" (e.g., 15s main-thread blocking cap) from "governance budgets" (tokens, cost, wall time, tool/path/network budgets) and enforce both explicitly.
- Runtime budget schemas are not enough by themselves; wire hard stop predicates into loop execution paths so token/cost/time limits are actually enforced, not only logged.
- Treat telemetry schema and stop-governor schema as paired contracts: every hard stop should emit deterministic machine-readable reason codes with usage snapshots.
- Mirror `src` separation of concerns: analytics/observability plumbing can be extensive, but budget enforcement must stay in execution loop code paths (not just dashboards or summaries).
- For Sentinelayer CLI parity, prioritize an internal run-event ledger (`duration_ms`, `token_usage`, `cost_usd`, `tool_uses`, `stop_class`) before adding optional external telemetry exporters.
- Place canonical provisioning semantics in AIdenID and expose them in Sentinelayer via MCP adapter/registry contracts; avoid duplicating identity business logic in Sentinelayer runtime.
- Treat autonomous error remediation as an event-driven control plane (ingest -> route -> assign -> execute -> verify -> close) with explicit budget and kill-switch primitives, not as a UI-only streaming feature.
- Jira integration should be lifecycle-native (ticket create + plan comment + status transitions + closure evidence), not only export/sync snapshots.
- During multi-PR autonomous runs, cut a fresh feature branch before each PR scope; committing directly on `main` causes avoidable local divergence even when GitHub squash-merge succeeds.
- When upgrading deterministic ingest summaries, preserve backward-compatible summary fields (`package scripts`) used by downstream prompts/tests before adding richer metadata.
- Keep ingest outputs bounded (`indexedFiles.limit`) so deterministic context remains scalable and avoids artifact bloat on large repositories.
- Reuse one deterministic ingest engine across commands (`ingest`, `spec`, existing-repo scaffolding) to avoid drift between generated context artifacts and prompt payload summaries.
- Keep prompt generation decoupled from providers and API calls; derive prompts purely from local spec artifacts so CI and offline flows stay deterministic.
- Local deterministic secret-pattern scanning can catch test fixture literals; preserve test intent by composing sensitive test strings at runtime instead of embedding direct patterns in source.
- For CLI package repos, use service-repo parity selectively: copy Omar review/watchdog patterns, but keep ECS/migration/worker deploy pipelines in backend service repos.
- Spec-derived workflow generation should stay deterministic but always allow explicit operator overrides (`--playwright-mode`, `--has-e2e-tests`) to avoid hidden inference errors.
- Add a dedicated drift validator for generated CI artifacts and make it fail closed (non-zero exit) so config regressions are caught before merge.
- For offline planning artifacts, keep `SPEC.md` as the single source of truth and derive both human-readable guides and tracker exports from the same parsed phase graph.
- Coverage gates are only stable when thresholds align with branch-path tests; add explicit negative-path unit tests (error branches, invalid inputs) before raising branch thresholds.
- For multi-provider integrations, keep transport logic dependency-injected (`fetchImpl`) so retry/streaming behavior is unit-testable without live API keys.
- Budget governors are easier to operationalize when every stop condition emits deterministic reason codes (`MAX_COST_EXCEEDED`, `MAX_OUTPUT_TOKENS_EXCEEDED`, `DIMINISHING_RETURNS`).
- A JSONL run-event ledger with explicit `eventType` and `stopClass` enums is a low-friction way to unify CLI observability now while staying forward-compatible with richer runtime telemetry sinks later.
- Deterministic governors are more operator-friendly when hard-stop reasons and near-limit warnings are both first-class (`MAX_*` stop codes plus `*_NEAR_LIMIT` warning codes) and emitted from the same budget contract.
- For AI-enhanced generation commands, keep deterministic artifacts as the first pass and layer AI refinement on top, then route usage through the same cost/telemetry governors to avoid a second ungoverned execution path.
- For AI pre-scan features, write reports into the same artifact root contract (`.sentinelayer/reports`) and emit the same cost/telemetry schema as generation commands so HITL dashboards can reason about both flows uniformly.

## 2026-04-01

- Persistent CLI auth should use API-token minting after browser approval, because current `/auth/me` JWTs are short-lived and there is no dedicated refresh endpoint.
- Keyring storage must be optional and fail-safe; provide deterministic file fallback and an explicit kill switch (`SENTINELAYER_DISABLE_KEYRING=1`) for CI/headless environments.
- Runtime watch commands need durable artifacts (`events.ndjson` + summary json) so autonomous agents can stream live output and still hand off reproducible traces after the terminal session ends.
- Session auto-rotation is safest as "rotate on use near expiry" before introducing daemonized background refresh loops, because it keeps failure modes local and observable.
- Session history should be sourced from local watch artifacts first (`watch history`) so operators and agents can reconstruct run timelines even when API access is limited.
- Keep GitHub review orchestration on one path: PR checks should rely on `.github/workflows/omar-gate.yml` only, while comment-triggered watchdog flows stay disabled to avoid mixed scan semantics.
- Plugin extensibility should start schema-first (`plugin init|validate|list`) with explicit load-order/security/budget fields before adding runtime execution hooks.
- Auth lifecycle controls should separate concerns: `auth sessions` is local metadata inventory, while `auth revoke` performs explicit remote token revocation and clears matching local metadata deterministically.
- AIdenID command execution should default to dry-run artifact generation and require explicit `--execute` for network calls, so agents can prepare reproducible requests without accidental live identity churn.
- Diff-scoped local review must source staged + unstaged + untracked files together to match real developer workflows; scanning only one git state misses actionable findings.
- Deterministic review should preserve a lightweight compatibility command (`review scan`) while promoting a richer layered pipeline (`review`) with per-run artifacts and check logs under a stable directory contract.
- Plugin ecosystem governance needs explicit `pack_type` boundaries and deterministic topological ordering checks (`plugin order`) to prevent ambiguous or cyclic runtime load behavior.
- MCP rollout should include both registry schema contracts and runtime server/bridge scaffolds so local CLI and editor integrations share one validated server config source of truth.
- Chat ergonomics should still produce deterministic artifacts (session IDs + JSONL transcripts) so interactive/streaming UX remains auditable for enterprise workflows.

## 2026-04-02

- Keep an explicit execution board with exact next branch names to avoid branch drift during long autonomous runs.
- Treat `gh run watch` on the `Omar Gate` workflow as a required blocking merge step on every PR; do not merge from status assumptions.
- Implement terminal markdown as a shared utility and reuse it across artifact show/preview commands (`spec`, `prompt`, `guide`) so styling changes stay centralized and testable.
- Diff-aware spec regeneration can preserve operator intent without a stored baseline by treating section deltas as manual edits and surfacing explicit add/remove previews before write.
- Progress/notification signals should be centralized in one reporter and always suppressed under `--quiet` (and JSON mode) to avoid corrupting machine-readable output.
- Pen-test swarm execution should fail closed on target governance: verified target state, host match, and strict path/method/scenario policy checks are safer defaults than best-effort probing.
- For file-backed identity registries, do not run per-identity status writes concurrently (`Promise.all`) against the same JSON file; serialize writes (or batch transactionally) to avoid lost updates.
- Error-daemon intake should stay append-only with a persisted stream offset cursor; this gives deterministic replay/resume semantics and avoids duplicate queue routing across worker ticks.
- Assignment ledgers should enforce lease-collision checks by default; a second agent claim must fail while an active non-expired lease exists, then rely on explicit release/reassign transitions for ownership changes.
- Jira lifecycle automation should keep both a mutable state registry and an append-only events stream; this preserves operator-friendly status views while retaining full transition/comment provenance for reproducible audits.
- Budget enforcement is safer as a two-stage control (`HARD_LIMIT_QUARANTINED` then `HARD_LIMIT_SQUASHED` after a grace window) so operators can inspect/override before deterministic kill while still guaranteeing bounded runtime.
- Operator kill-switch actions should be explicit and auditable: require `--confirm`, persist a dedicated operator event stream, and mirror queue+assignment status updates so dashboard state and enforcement state cannot drift.
- Reproducibility artifacts become operationally useful only after indexing cross-file linkage (`loopRunId`, `jiraIssueKey`, budget state, operator snapshots) into a single lineage index keyed by `workItemId`.
- A practical hybrid mapper can stay deterministic-first by seeding from endpoint/error/service path tokens, then constrain semantic expansion to import-graph neighborhoods rather than scanning the entire repository context blindly.
- Boolean normalization helpers must preserve native `false` inputs (not coerce through `value || ""`), or operator kill/maintenance toggles can silently fail and corrupt control-plane state.
- MCP adapter contracts should be validated against the registry file they bind to; schema-only validation misses tool-name drift that breaks runtime dispatch.
- Validate reported audit findings against the active branch before starting remediation PRs, then scope each PR to current confirmed gaps only.
- For long autonomous PR chains, spawn each new PR from a fresh `origin/main` worktree; this avoids hidden local `main` divergence during `--ff-only` pulls.
