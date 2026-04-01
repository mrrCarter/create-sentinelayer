# Sentinelayer CLI Roadmap PR Preparation (2026-03-31)

## Mission
Execute `SENTINELAYER_CLI_ROADMAP.md` as secure, merge-safe PR batches using `SWE_excellence_framework.md` gates and `.claude/CLAUDE.md` autonomous loop discipline.

## Plan
- [x] Audit roadmap scope, dependencies, and phase ordering.
- [x] Audit implementation baseline across `create-sentinelayer`, `sentinelayer-api`, `sentinelayer-web`, `sentinellayer-v1-action`, `sentinellayer-aws-terraform`.
- [x] Validate baseline quality checks in active repos (CLI verify, API lint/compile/targeted tests, web lint/tsc).
- [x] Define PR batch strategy with dependency-safe sequence and gate rules.
- [x] Validate reference `src` mapping/orchestration model (indexing, LSP navigation, sandboxing, scheduler/daemon patterns) with line-level evidence.
- [x] Audit Sentinelayer runtime/error/watch/jira surfaces for OMAR daemon + HITL feasibility and governance gaps.
- [x] Audit `src` Kairos mode controls (assistant activation, async spawn model, blocking/time budgets, token/task budget distinctions) with line-level evidence.
- [x] Audit `src` telemetry/observability and budget-stop enforcement (time/tool/token/cost capture + hard-stop paths) and compare against Sentinelayer API + CLI gaps.
- [x] Publish architecture prep doc for OMAR daemon swarm + observability + Jira + budgets + kill-switch controls.
- [x] Create Batch 0 branch plan and PR templates (DoR/DoD evidence fields).
- [x] Start Phase 0 PR 0.1 (Commander + modular CLI skeleton) with behavior parity tests.
- [x] Complete Batch A foundation PRs (0.1, 0.2, 0.3) with merged OMAR review comments.
- [x] Complete Batch B PR 1.1 (deterministic codebase ingest engine + artifact output).
- [x] Complete Batch B PR 1.2 (template-based offline spec generation).
- [x] Complete Batch B PR 1.3 (offline prompt generator from SPEC.md).
- [x] Complete workflow hardening PR (repo-level Omar Gate + watchdog + release-please automation + npm release smoke install).
- [x] Complete Batch B PR 1.4 (Omar Gate config generator: `scan init` + `scan validate`).
- [x] Complete Batch B PR 1.5 (build guide generator + export formats).
- [x] Complete Batch C PR 8.3 (unit coverage gates + CI quality pipeline hardening).
- [x] Complete Batch C PR 3.1 (multi-provider API client contract + retries + streaming).
- [x] Complete Batch C PR 3.2 (cost tracking + token budget stop governors + `cost` CLI command).
- [x] Complete Batch C PR 3.5 (CLI observability contract: run events + usage ledger + stop-class schema).
- [x] Complete Batch C PR 3.6 (deterministic stop governors: token/cost/runtime/tool-call hard stops + warnings + terminal stop reasons).
- [x] Complete Batch D PR 3.3 (AI-enhanced spec generation with cost+telemetry governance).
- [x] Complete Batch D PR 3.4 (AI pre-scan triage command with governed cost/telemetry outputs).
- [x] Complete Batch E PR 4.1 foundation slice (persistent `sl auth` sessions, keyring/file token store, near-expiry rotation).
- [x] Complete Batch F PR 9.0 foundation slice (`sl watch run-events` runtime stream + reproducible watch artifacts).
- [x] Complete Batch E PR 4.2 foundation slice (`watch history` session/readback for reproducible handoffs).
- [x] Complete Batch E PR 6.1 foundation slice (`mcp schema|registry` contract + AIdenID template scaffold).
- [x] Complete workflow correction PR (Omar Gate only path: removed multi-agent watchdog workflow and aligned threshold enforcement with active gate mode).
- [ ] Complete Batch E PR 5.1 foundation slice (plugin manifest scaffold/validate/list command set).

## Cross-Repo Audit Snapshot
- `create-sentinelayer`: monolith CLI (`bin/create-sentinelayer.js`) is 1948 lines; local `/omargate` and `/audit` are deterministic MVP only; no TypeScript project skeleton yet; no first-class run telemetry/budget enforcement stream yet; `npm run verify` passes (17 e2e tests).
- `sentinelayer-api`: builder/persona/pack services and CLI auth bridge are production-grade; `ruff` + targeted builder guardrails pass.
- `sentinelayer-web`: CLI auth route and GitHub App/HITL UI surfaces are present; `lint` + `tsc --noEmit` pass.
- `sentinellayer-v1-action`: mature bridge action with quality gates and tests.
- `sentinellayer-aws-terraform`: mature infra guardrails and drift workflows.
- `AIdenID`: repository is present and audited as the canonical identity/provisioning control plane; integration should remain adapter-based from Sentinelayer runtime.

## Roadmap Validation
- Core roadmap direction is valid and aligned with current platform capabilities.
- Recommended execution adjustment: pull Phase 8.3 (`test suite + CI hardening`) forward into early batches, before Phase 9/10 complexity.
- Keep Phase 7 as explicit stretch and block it behind stable replay/evals from Phase 9/10.
- Keep identity-dependent work (Phase 11/12) behind an explicit AIdenID integration contract checkpoint.
- Additional validated expansion for enterprise demos:
  - Add an OMAR daemon + observability governance track after runtime foundations, with strict budget enforcement, deterministic+semantic scoping, Jira lifecycle automation, and operator kill/quarantine controls.

## PR Batch Queue (one PR at a time, grouped by dependency)

### Batch A - Foundation (P0)
- PR 0.1 CLI entrypoint + Commander subcommand tree. (merged as #30)
- PR 0.2 Layered config system. (merged as #31)
- PR 0.3 Artifact writer + `.sentinelayer/` output contract. (merged as #32)

### Batch B - Offline Generation Core (P0)
- PR 1.1 Codebase ingestion engine. (merged as #33)
- PR 1.2 Template-based spec generation. (merged as #34)
- PR 1.3 Prompt generator. (merged as #35)
- PR 1.4 Omar config generator. (merged as #37)
- PR 1.5 Build guide generator. (merged as #38)

### Batch C - Quality & Cost Safety Baseline (P0/P1)
- PR 8.3 Test suite + CI pipeline hardening (moved earlier). (merged as #39)
- PR 3.1 Multi-provider API client contract. (merged as #40)
- PR 3.2 Token/cost budget guardrails.
- PR 3.5 CLI observability contract (run events + usage ledger + stop-class schema).
- PR 3.6 Deterministic stop governors (token/cost/runtime/tool-call hard stops + warning thresholds + terminal stop reasons).

### Batch D - UX + AI Feature Layer (P1)
- PR 2.1 Ink interactive mode.
- PR 2.2 Terminal markdown renderer.
- PR 2.3 Diff-aware regeneration.
- PR 2.4 Progress/notifications.
- PR 3.3 AI-enhanced spec generation.
- PR 3.4 AI pre-scan.

### Batch E - State, Extensibility, Integrations (P2)
- PR 4.1 sessions/auth persistence foundation (`sl auth login|status|logout`, long-lived API token flow).
- PR 4.2 runtime history/watch bindings (session-aware event watch + run artifact trail).
- PR 4.3 spec binding/version linkage.
- PR 5.1/5.2/5.3 plugin + template + policy packs.
- PR 6.1/6.2 MCP server mode + VS Code bridge.

### Batch F - Local Omar Gate (P1)
- PR 9.1 reviewer sandbox + isolation runtime.
- PR 9.2 deterministic review pipeline.
- PR 9.3 AI review layers.
- PR 9.4 unified report + reconciliation.
- PR 9.5 replay + reproducibility.

### Batch G - Audit Swarm (P2)
- PR 10.1 orchestrator + registry.
- PR 10.2-10.7 specialist agents.
- PR 10.8 unified DD package.
- PR 10.9 drift/replay.

### Batch H - Identity + QA Swarm (P1/P2)
- PR 11.1-11.6 AIdenID identity engine.
- PR 12.1-12.7 QA swarm runtime, DSL, dashboard, security mode.

## Requested Phase Expansion Plan (2026-04-01 update)
- [ ] Phase 2: add low-latency interactive chat mode with streaming progress UX (AWS/GH CLI style) while preserving deterministic command mode.
- [ ] Phase 4: complete persistent session lifecycle (auto-rotate, session listing/resume metadata, revocation controls).
- [ ] Phase 5: define plugin/template/policy extension API boundaries and load-order governance.
- [ ] Phase 6: implement MCP tool registry schema + adapter contracts (including AIdenID provisioning adapter).
- [ ] Phase 9: expand watch + review into full OMAR local reviewer pipeline with deterministic diff/full scan modes.
- [ ] Phase 10: add multi-agent audit swarm orchestration and reconciliation report packaging.
- [ ] Phase 11: expose AIdenID operations through CLI command surface (including `sl ai ...` alias plan and policy gating).
- [ ] Phase 12: implement governed QA swarm runtime/dashboard with explicit token/time/tool/path/network budgets and kill/quarantine controls.

### Batch I - Stretch / Deferred (P3)
- PR 7.1 interactive AI refinement.
- PR 7.2 hooks/lifecycle.
- PR 8.1 telemetry opt-in.
- PR 8.2 diagnostics/error reporting.

### Batch J - OMAR Daemon + Enterprise Observability Overlay (P1/P2, cross-repo)
- PR 13.1 Error event daemon worker (`admin_error_log` + stream trigger -> routed queue).
- PR 13.2 Global autonomous todo/assignment ledger (agent identity, lease, SLA timers, handoff state).
- PR 13.3 Jira lifecycle automation (create ticket(s), agent plan comment, in-progress/blocked/done transitions).
- PR 13.4 Runtime budget governance hardening (token/time/tool/path budgets + deterministic squash/quarantine path).
- PR 13.5 Operator control plane UX (agent roster, stop/confirm control, budget health colors, session timers).
- PR 13.6 Artifact lineage tree (`observability/` reproducibility bundles per run/agent/loop/jira linkage).
- PR 13.7 Hybrid codebase mapping overlay (deterministic ingest + on-demand semantic graph for impact scoping).
- PR 13.8 Scheduled reliability lane (midnight synthetic jobs + maintenance billboard + resolution clear path).
- PR 13.9 MCP tool registry schema + AIdenID provisioning adapter contract.

### Workflow hardening (current)
- Enforce repo-level `.github/workflows/omar-gate.yml` as the single Omar review path for PRs.
- Remove `.github/workflows/omar-review-watchdog.yml` to avoid comment-triggered multi-agent scan path drift.
- Add release automation (`release-please`) and harden npm release workflow with packaged install verification.
- Add instruction-topology files (`.github/copilot-instructions.md`, `.github/instructions/*.instructions.md`).
- Confirm local Omar deep scan and local audit return zero P0-P2 before merge.

## Definition Of Ready (per PR)
- [ ] Clear PR scope mapped to exactly one roadmap PR id.
- [ ] Dependency preconditions from prior PR ids are completed.
- [ ] Security and permission impact documented.
- [ ] Test additions identified before implementation.
- [ ] Cost impact identified for AI-invoking paths.

## Definition Of Done (per PR)
- [ ] `npm run verify` (or superseding expanded quality gate set) passes.
- [ ] Omar loop evidence captured (`/omargate deep` + `/audit` outputs or CI equivalent).
- [ ] SWE framework mandatory gates satisfied for changed surface.
- [ ] Provenance/evidence notes added to PR description.
- [ ] `tasks/todo.md` review section updated with commands and outcomes.

## Omar Autonomous Loop Contract (from CLAUDE.md)
- [ ] Plan first in `tasks/todo.md` before coding.
- [ ] Execute one PR scope at a time.
- [ ] Run verification before marking done.
- [ ] Update `tasks/lessons.md` after corrections or misses.
- [ ] Keep merge state clean and reproducible.

## Review
- Completed assessment only (no product code edits).
- Verified baseline commands:
  - `create-sentinelayer`: `npm run verify`.
  - `sentinelayer-api`: `python -m ruff check src tests`; `python -m compileall -q src`; `python -m pytest tests/test_builder_service.py -q -k "phase5_score_guardrails or phase6_score_guardrails or phase8_score_guardrails"`.
  - `sentinelayer-web`: `npm run lint`; `npx tsc --noEmit`.
- Immediate governance gap to address before Batch A implementation:
  - missing AI instruction topology artifacts (`.github/copilot-instructions.md`, path-scoped `.github/instructions/*.instructions.md`) in active repos.
- New governance gaps captured from full audit (see `tasks/omar_daemon_hitl_architecture.md`):
  - No dedicated API startup worker for error-daemon dispatch (`sentinelayer-api/src/main.py` starts entitlement + URL scan workers only).
  - Runtime loop has strong approvals/budgets/artifact chain, but no Jira-linked lifecycle comments/transition automation.
  - CLI ingest is deterministic/topology-light today; no AST/LSP semantic overlay yet.
  - Runtime MCP connector model exists but is minimal and not yet a full registry schema contract.
- Telemetry and budget-governance gaps from latest `src` comparison:
  - `src` has mature telemetry layers (analytics sink + OTel + SDK usage schemas + task progress usage payloads), while `create-sentinelayer` has no equivalent structured run-event telemetry plane yet.
  - `src` enforces hard stops for `max_budget_usd` and `max_turns`; Sentinelayer should mirror this pattern with explicit stop classes for token/cost/runtime/tool-call thresholds in CLI and runtime loop paths.
  - Sentinelayer API already emits rich runtime telemetry (`duration_ms`, `token_usage`, `cost_usd`, tool/subagent events, chain-hashed timeline), so CLI should converge on compatible event contracts.
- Kairos-specific findings to guide Sentinelayer guardrail design:
  - Kairos is an assistant-orchestration mode and does not by itself enforce end-to-end spend ceilings; hard budget controls come from separate token/task budget paths.
  - `src` enforces a 15-second main-thread blocking budget in assistant mode and auto-backgrounds long Bash/PowerShell commands to preserve coordinator responsiveness.
  - `src` token-budget continuation logic is explicit and deterministic (90% target threshold + diminishing-return early-stop checks), which is a reusable pattern for Sentinelayer daemon remediation loops.
  - Sentinelayer runtime schemas expose token/cost/runtime budget fields, but current runtime service enforcement is primarily iteration-based; explicit token/cost/runtime stop checks should be added in early governance hardening.
- Execution progress after baseline:
  - Batch A shipped and merged with OMAR review comments captured on each PR:
    - #30 (`feat(cli): command tree + legacy bridge`)
    - #31 (`feat(cli): layered config + config commands`)
    - #32 (`feat(cli): output root contract for local artifacts`)
  - Quality gate remained green after each merge via `npm run verify`.
  - Batch B progress:
    - #33 merged (`feat(cli): deterministic codebase ingest engine + CODEBASE_INGEST artifact`).
    - #34 merged (`feat(cli): offline template-based spec generation`).
    - #35 merged (`feat(cli): offline prompt generation from SPEC artifacts`).
  - Workflow hardening progress:
    - #36 merged (`ci(workflows): add Omar Gate/watchdog + release automation hardening`).
  - Batch B completion:
    - #37 merged (`feat(cli): spec-driven scan workflow init/validate`).
    - #38 merged (`feat(cli): build guide generation + jira/linear/github-issues export`).
  - Batch C progress:
    - #39 merged (`test(ci): unit coverage gates + hardened quality workflow`).
    - #40 merged (`feat(ai): multi-provider API client contract + retry/streaming`).
    - #41 merged (`feat(cost): add cost tracking and budget stop governors (PR 3.2)`).
    - #42 merged (`feat(telemetry): add CLI run-event observability contract (PR 3.5)`).
    - #43 merged (`feat(cost): add deterministic runtime/tool governors with warnings (PR 3.6)`).
  - Batch D progress:
    - #44 merged (`feat(spec): add AI-enhanced generation with budgeted cost telemetry (PR 3.3)`).
  - PR 1.4 (`scan init` + `scan validate`) local evidence (branch `roadmap/pr-1-4-omar-config-generator`):
    - `npm run verify` (pass, 28/28 e2e)
    - `node bin/create-sentinelayer.js /omargate deep --path . --json` (`p1=0`, `p2=0`, `blocking=false`)
    - `node bin/create-sentinelayer.js /audit --path . --json` (`overallStatus=PASS`, `p1Total=0`, `p2Total=0`)
  - PR 1.5 (`guide generate` + `guide export`) local evidence (branch `roadmap/pr-1-5-build-guide-generator`):
    - `npm run verify` (pass, 30/30 e2e)
    - `node bin/create-sentinelayer.js /omargate deep --path . --json` (`p1=0`, `p2=0`, `blocking=false`)
    - `node bin/create-sentinelayer.js /audit --path . --json` (`overallStatus=PASS`, `p1Total=0`, `p2Total=0`)
  - PR 8.3 (test suite + CI hardening) local evidence (branch `roadmap/pr-8-3-test-suite-ci-hardening`):
    - `npm run verify` (pass, e2e `30/30`; unit coverage statements `96.78%`, branches `81.51%`, functions `96.96%`, lines `96.78%`)
    - `node bin/create-sentinelayer.js /omargate deep --path . --json` (`p1=0`, `p2=0`, `blocking=false`)
    - `node bin/create-sentinelayer.js /audit --path . --json` (`overallStatus=PASS`, `p1Total=0`, `p2Total=0`)
  - PR 3.1 (multi-provider API client contract) local evidence (branch `roadmap/pr-3-1-multi-provider-api-client`):
    - `npm run verify` (pass, e2e `30/30`; unit coverage statements `88.62%`, branches `73.89%`, functions `96.07%`, lines `88.62%`)
    - `node bin/create-sentinelayer.js /omargate deep --path . --json` (`p1=0`, `p2=0`, `blocking=false`)
    - `node bin/create-sentinelayer.js /audit --path . --json` (`overallStatus=PASS`, `p1Total=0`, `p2Total=0`)
  - PR 3.2 (cost tracking + budget governors) local evidence (branch `roadmap/pr-3-2-cost-budget-system`):
    - `npm run verify` (pass, e2e `32/32`; unit coverage statements `89.6%`, branches `71.7%`, functions `96.77%`, lines `89.6%`)
    - `node bin/create-sentinelayer.js /omargate deep --path . --json` (`p1=0`, `p2=0`, `blocking=false`)
    - `node bin/create-sentinelayer.js /audit --path . --json` (`overallStatus=PASS`, `p1Total=0`, `p2Total=0`)
  - PR 3.5 (CLI observability contract) local evidence (branch `roadmap/pr-3-5-cli-observability-contract`):
    - `npm run verify` (pass, e2e `33/33`; unit coverage statements `89.1%`, branches `70.94%`, functions `97.4%`, lines `89.1%`)
    - `node bin/create-sentinelayer.js /omargate deep --path . --json` (`p1=0`, `p2=0`, `blocking=false`)
    - `node bin/create-sentinelayer.js /audit --path . --json` (`overallStatus=PASS`, `p1Total=0`, `p2Total=0`)
  - PR 3.6 (deterministic stop governors) local evidence (branch `roadmap/pr-3-6-deterministic-stop-governors`):
    - `npm run verify` (pass, e2e `34/34`; unit coverage statements `89.63%`, branches `71.02%`, functions `97.72%`, lines `89.63%`)
    - `node bin/create-sentinelayer.js /omargate deep --path . --json` (`p1=0`, `p2=0`, `blocking=false`)
    - `node bin/create-sentinelayer.js /audit --path . --json` (`overallStatus=PASS`, `p1Total=0`, `p2Total=0`)
  - PR 3.3 (AI-enhanced spec generation) local evidence (branch `roadmap/pr-3-3-ai-enhanced-spec-generation`):
    - `npm run verify` (pass, e2e `34/34`; unit coverage statements `89.68%`, branches `71.02%`, functions `97.72%`, lines `89.68%`)
    - `node bin/create-sentinelayer.js /omargate deep --path . --json` (`p1=0`, `p2=0`, `blocking=false`)
    - `node bin/create-sentinelayer.js /audit --path . --json` (`overallStatus=PASS`, `p1Total=0`, `p2Total=0`)
  - PR 3.4 (AI pre-scan triage) local evidence (branch `roadmap/pr-3-4-ai-pre-scan`):
    - `npm run verify` (pass, e2e `34/34`; unit coverage statements `89.68%`, branches `71.02%`, functions `97.72%`, lines `89.68%`)
    - `node bin/create-sentinelayer.js /omargate deep --path . --json` (`p1=0`, `p2=0`, `blocking=false`)
    - `node bin/create-sentinelayer.js /audit --path . --json` (`overallStatus=PASS`, `p1Total=0`, `p2Total=0`)
  - PR 4.1 + 9.0 foundation slice (persistent auth + runtime watch streaming) local evidence:
    - `npm run verify` (pass, e2e `34/34`; unit tests `20/20`; coverage statements `89.68%`, branches `71.02%`, functions `97.72%`, lines `89.68%`)
    - Added `sl` binary alias and `auth` command set (`login`, `status`, `logout`) with API-token-backed persistent sessions.
    - Added `watch run-events` (`watch runtime` alias) with polling stream + reproducible artifacts under `.sentinelayer/observability/runtime-watch/`.
  - PR 4.2 foundation slice completion:
    - #47 merged (`feat(watch): add runtime watch history readback command`).
    - Added `watch history` (`--run-id`, `--limit`, `--json`) backed by persisted summary artifacts.
  - PR 6.1 foundation slice completion:
    - #48 merged (`feat(mcp): add schema + registry tooling with AIdenID template`).
    - Added `mcp schema show|write`, `mcp registry init-aidenid`, and `mcp registry validate`.
  - Omar workflow correction:
    - #49 merged (`ci: enforce Omar Gate-only PR workflow`).
    - Removed comment-triggered multi-agent watchdog path and aligned threshold enforcement to the active `severity_gate`.
