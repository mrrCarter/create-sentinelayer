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
