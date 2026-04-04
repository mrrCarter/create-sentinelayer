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
- [x] Complete Batch E PR 6.2 foundation slice (`mcp server|bridge` runtime config + VS Code MCP bridge scaffolds).
- [x] Complete workflow correction PR (Omar Gate only path: removed multi-agent watchdog workflow and aligned threshold enforcement with active gate mode).
- [x] Complete Batch E PR 5.1 foundation slice (plugin manifest scaffold/validate/list command set).
- [x] Complete Batch E PR 5.2 foundation slice (plugin pack boundaries + deterministic load-order governance).
- [x] Complete Batch E PR 4.3 foundation slice (session inventory metadata + explicit token revocation controls).
- [x] Complete Batch H PR 11.1 foundation slice (`sl ai provision-email` command surface with dry-run/live execute and artifact trail).
- [x] Complete Batch H PR 11.2 foundation slice (`sl ai identity list|show|revoke` lifecycle controls + registry persistence).
- [x] Complete Batch H PR 11.3 foundation slice (`sl ai identity events|latest|wait-for-otp` extraction polling + confidence gating).
- [x] Complete Batch H PR 11.4 foundation slice (`sl ai identity create-child|lineage|revoke-children` delegated lineage controls).
- [x] Complete Batch H PR 11.5 foundation slice (`sl ai identity domain|target` governance flows).
- [x] Complete Batch H PR 11.6 foundation slice (`sl ai identity site create|list` callback-site workflows).
- [x] Complete Batch H PR 12.1 foundation slice (`sl swarm registry|plan` OMAR-led orchestrator factory).
- [x] Complete Batch H PR 12.2 foundation slice (`sl swarm run` governed runtime loop + optional Playwright adapter).
- [x] Complete Batch H PR 12.3 foundation slice (`sl swarm scenario init|validate` DSL contract + runtime binding).
- [x] Complete Batch H PR 12.4 foundation slice (`sl swarm dashboard` realtime swarm status snapshots + watch loop).
- [x] Complete Batch H PR 12.5 foundation slice (`sl swarm report` deterministic execution package).
- [x] Complete Batch H PR 12.6 security slice (`sl swarm create` pen-test mode + target policy gate + audit log/report bundle).
- [x] Complete Batch H PR 12.7 hardening slice (`sl ai identity audit|kill-all|legal-hold` + swarm audit-chain/identity-isolation controls).
- [x] Complete Batch J PR 13.1 daemon slice (`daemon error record|worker|queue` routed backlog foundation).
- [x] Complete Batch J PR 13.2 ledger slice (`daemon assign claim|heartbeat|release|reassign|list` global assignment queue ownership).
- [x] Complete Batch J PR 13.3 Jira lifecycle slice (`daemon jira open|start|comment|transition|list` ticket-state automation).
- [x] Complete Batch J PR 13.4 budget-governor slice (`daemon budget check|status` quarantine and deterministic kill controls).
- [x] Complete Batch J PR 13.5 operator-control slice (`daemon control|snapshot|stop` roster visibility + confirmed kill-switch actions).
- [x] Complete Batch J PR 13.6 artifact-lineage slice (`daemon lineage build|list|show` reproducibility linkage index).
- [x] Complete Batch J PR 13.7 hybrid-mapper slice (`daemon map scope|list|show` deterministic+semantic impact scoping).
- [x] Complete Batch J PR 13.8 reliability-lane slice (`daemon reliability run|status` + `maintenance status|on|off` billboard lifecycle).
- [x] Complete Batch J PR 13.9 MCP adapter slice (`mcp registry init-aidenid-adapter|validate-aidenid-adapter` + registry cross-check contract).
- [x] Complete Batch F PR 9.1 extension slice (`review scan --mode full|diff` deterministic local reviewer workflow).
- [x] Complete Batch F PR 9.2 foundation slice (`review [path] [--diff|--staged]` layered deterministic review pipeline + reproducible run artifacts).
- [x] Complete Batch D PR 2.1 foundation slice (`chat ask` low-latency command surface + transcript persistence).

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
- PR 3.2 Token/cost budget guardrails. (merged as #41)
- PR 3.5 CLI observability contract (run events + usage ledger + stop-class schema). (merged as #42)
- PR 3.6 Deterministic stop governors (token/cost/runtime/tool-call hard stops + warning thresholds + terminal stop reasons). (merged as #43)

### Batch D - UX + AI Feature Layer (P1)
- PR 2.1 Ink interactive mode. (merged as #57)
- PR 2.2 Terminal markdown renderer. (merged as #59)
- PR 2.3 Diff-aware regeneration. (merged as #60)
- PR 2.4 Progress/notifications. (merged as #61)
- PR 3.3 AI-enhanced spec generation. (merged as #44)
- PR 3.4 AI pre-scan. (merged as #45)

### Batch E - State, Extensibility, Integrations (P2)
- PR 4.1 sessions/auth persistence foundation (`sl auth login|status|logout`, long-lived API token flow). (merged as #46)
- PR 4.2 runtime history/watch bindings (session-aware event watch + run artifact trail). (merged as #47)
- PR 4.3 spec binding/version linkage. (merged as #51)
- PR 5.1 plugin architecture foundation. (merged as #50)
- PR 5.2 plugin load-order governance. (merged as #55)
- PR 5.3 custom policy packs. (merged as #62)
- PR 6.1 MCP server mode schema/registry. (merged as #48)
- PR 6.2 VS Code bridge scaffolds. (merged as #56)

### Batch F - Local Omar Gate (P1)
- PR 9.1 reviewer sandbox + isolation runtime. (merged as #53)
- PR 9.2 deterministic review pipeline. (merged as #54)
- PR 9.3 AI review layers. (merged as #63)
- PR 9.4 unified report + reconciliation. (merged as #64)
- PR 9.5 replay + reproducibility. (merged as #65)

### Batch G - Audit Swarm (P2)
- PR 10.1 orchestrator + registry. (merged as #66)
- PR 10.2 security specialist agent. (merged as #67)
- PR 10.3 architecture specialist agent. (merged as #68)
- PR 10.4 testing specialist agent. (merged as #69)
- PR 10.5 performance specialist agent. (merged as #70)
- PR 10.6 compliance specialist agent. (merged as #71)
- PR 10.7 documentation specialist agent. (merged as #72)
- PR 10.8 unified DD package. (merged as #73)
- PR 10.9 drift/replay. (merged as #74)

### Batch H - Identity + QA Swarm (P1/P2)
- PR 11.1 AIdenID SDK integration/auth. (merged as #52)
- PR 11.2 identity lifecycle CLI. (merged as #75)
- PR 11.3 OTP/verification extraction. (merged as #76)
- PR 11.4 child identities/lineage. (merged as #77)
- PR 11.5 domain/target management. (merged as #78)
- PR 11.6 AIdenID site lifecycle follow-on. (merged as #79)
- PR 12.1 swarm orchestrator factory. (merged as #80)
- PR 12.2 Playwright agent runtime. (merged as #81)
- PR 12.3 scenario DSL. (merged as #82)
- PR 12.4 realtime swarm dashboard. (merged as #83)
- PR 12.5 swarm execution report. (merged as #84)
- PR 12.6 security & pen-test mode. (merged as #85)
- PR 12.7 swarm identity hardening. (merged as #86)

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
- PR 13.1 Error event daemon worker (`admin_error_log` + stream trigger -> routed queue). (merged as #87)
- PR 13.2 Global autonomous todo/assignment ledger (agent identity, lease, SLA timers, handoff state). (merged as #88)
- PR 13.3 Jira lifecycle automation (create ticket(s), agent plan comment, in-progress/blocked/done transitions). (merged as #89)
- PR 13.4 Runtime budget governance hardening (token/time/tool/path budgets + deterministic squash/quarantine path). (merged as #90)
- PR 13.5 Operator control plane UX (agent roster, stop/confirm control, budget health colors, session timers). (merged as #91)
- PR 13.6 Artifact lineage tree (`observability/` reproducibility bundles per run/agent/loop/jira linkage). (merged as #92)
- PR 13.7 Hybrid codebase mapping overlay (deterministic ingest + on-demand semantic graph for impact scoping). (merged as #93)
- PR 13.8 Scheduled reliability lane (midnight synthetic jobs + maintenance billboard + resolution clear path). (merged as #94)
- PR 13.9 MCP tool registry schema + AIdenID provisioning adapter contract. (merged as #95)

### Batch K - Governance and Security Hardening Loop (2026-04-02 audit)
- [x] PR 97 AI governance contracts (AGENTS.md, CLAUDE.md, path-scoped instructions, PR template, CODEOWNERS).
- [x] PR 98 MCP security hardening defaults and audience validation.
- [x] PR 99 API key security and `.env` defense.
- [x] PR 100 eval-impact gating foundation.

### Batch L - Coverage Breadth and Command Tests (2026-04-02 audit)
- [x] PR 101 coverage instrumentation expansion + daemon/auth/swarm runtime test additions.
- [x] PR 102 command unit-test layer for high-risk command modules.

### Batch M - Documentation and Governance Follow-Through (2026-04-02 audit)
- [x] PR 103 JSDoc coverage for high-risk auth/ai/mcp/cost modules.
- [x] PR 104 dependabot + issue templates.
- [x] PR 105 todo sync + release tag validation.

### Batch N - Structural Follow-Through (2026-04-02 audit)
- [x] PR 106 split oversized command files (`src/commands/ai.js`, `src/commands/daemon.js`) into modular slices.
- [ ] PR 107 command lazy-loading.

### Batch O - Streaming Protocol + Tool Foundation (P0, execution layer)
- [ ] PR 115 Streaming event protocol (`src/stream/protocol.js` -- universal NDJSON envelope with agent attribution, heartbeat, progress, findings, used by ALL long-running commands).
- [ ] PR 116 Tool contract + registry (Zod-validated interface, lazy loading, deny rules, MCP assembly -- tools are INTERNAL to SL specialist agents).
- [ ] PR 117 FileRead tool (line numbers, offset/limit, binary detection, token budget awareness -- for internal audit/review agents).
- [ ] PR 118 FileEdit tool (string replacement, uniqueness check, diff generation -- for internal fix agents).
- [ ] PR 119 Shell tool (bash/powershell, security analyzer, timeout, background mode -- for internal agents running tests/linters).
- [ ] PR 120 Grep + Glob tools (ripgrep wrapper, fast file matching -- for internal agents searching codebases).

### Batch P - Agentic Loop (P0, execution layer)
- [ ] PR 121 Permission system (plan/default/execute modes, deny/allow/ask pipeline, denial tracking).
- [ ] PR 122 Query loop engine (LLM→tool→result state machine, concurrent read-only dispatch, budget-gated iteration).
- [ ] PR 123 Context management (tool result persistence, time-based micro-compact, auto-compact with circuit breaker).

### Batch Q - Agent Spawning (P0, execution layer)
- [ ] PR 124 Agent definition system (Zod schema, built-in personas, custom .sentinelayer/agents/*.json).
- [ ] PR 125 Subagent runtime (in-process isolation, worktree isolation, budget-slice clamping, tool restrictions).
- [ ] PR 126 /audit deep integration (real subagent specialists with FileRead+Grep+Glob, unified DD package).

### Batch R - Codebase Mapping + Scope (P1, execution layer)
- [ ] PR 127 Import graph resolver (JS/TS/Python import parsing, adjacency list, depth-limited).
- [ ] PR 128 Impact scope mapper (task→primary/secondary/tertiary files, deterministic-first resolution).
- [ ] PR 129 Scope-aware context injection (agent system prompt filtering, path violation tracking).

### Batch S - Entitlement + Interactive (P1, execution layer)
- [ ] PR 130 Entitlement gate (subscription tier→capability mapping, sliding-window rate limiter).
- [ ] PR 131 Interactive REPL (streaming responses, tool call indicators, permission dialogs, session transcripts).
- [ ] PR 132 Session resume + history (session list/resume/export commands).

### Batch T - Polish + Integration (P1, execution layer)
- [ ] PR 133 Terminal markdown + multi-agent progress display (streaming render, budget gauges).
- [ ] PR 134 `sl run` command (one-shot agentic execution with scope mapping and budget governance).
- [ ] PR 135 `sl fix` command (autonomous error remediation with test verification and optional PR creation).
- [ ] PR 136 Daemon upgrade (real agent execution in error remediation lane, Jira lifecycle from live agent progress).

### Batch U - Scaffold & Spec Quality (P1, from 2026-04-03 feedback)
- [ ] PR 137 Frictionless gh secret setup (auto-gitignore for .env, detect repo slug for instructions, docs link, unify workflow naming, verify after set).
- [ ] PR 138 Deterministic IDE/agent dictionary (top 10 coding agents + IDEs, no web search, per-agent config file generation during scaffold).
- [ ] PR 139 Flexible spec phases + greenfield fix (dynamic phase count from ingest, projectType-aware templates, no hardcoded 3-phase cap).
- [ ] PR 140 Spec-bound pre-commit review (spec drift detection, coverage gaps, spec hash binding, SL-SPEC-001/002 findings).

### Batch V - Shared Memory + Observability (P1, from 2026-04-03 feedback)
- [ ] PR 141 Local shared memory blackboard (cross-agent findings during orchestration, append-only, 8-needle recall gate).
- [ ] PR 142 Hybrid retrieval index (TF-IDF local, optional FAISS API delegation for enterprise, previous-run memory).
- [ ] PR 143 Stuck-agent detection + alert channels (Slack/Telegram webhooks, smart frequency on state changes, low-token payloads).
- [ ] PR 144 Stale ingest auto-refresh (git timestamp comparison, --refresh flag, content-hash caching).

## Execution Board (2026-04-03)

### Omar Gate Loop (required on every PR)
1. `git checkout main && git pull --ff-only`
2. `git checkout -b <branch-name>`
3. Implement one PR id scope only, then run `npm run verify`.
4. Run local gates: `node bin/create-sentinelayer.js /omargate deep --path . --json` and `node bin/create-sentinelayer.js /audit --path . --json`.
5. Push and open PR: `git push -u origin <branch-name>` and `gh pr create --fill`.
6. Watch Omar Gate only:
   - `$runId = gh run list --workflow "Omar Gate" --branch <branch-name> --limit 1 --json databaseId --jq ".[0].databaseId"`
   - `gh run watch $runId --exit-status`
7. If Omar Gate fails or reports blocking findings, fix P0-P2 scope issues, push, and repeat step 6 until green.
8. Merge only after Omar Gate is green: `gh pr merge <pr-number> --squash --delete-branch`.

### Exact Next PR Branch Order (Execution Layer)
1. `roadmap/pr-114-p2-burn-down-clean` (current, PR #114 open)
2. `roadmap/pr-107-command-lazy-loading` (PR #113 open)
3. `roadmap/pr-115-streaming-event-protocol`
4. `roadmap/pr-116-tool-contract-registry`
5. `roadmap/pr-117-file-edit-tool`
6. `roadmap/pr-118-file-write-tool`
7. `roadmap/pr-119-shell-tool`
8. `roadmap/pr-120-grep-glob-tools`
9. `roadmap/pr-121-permission-system`
10. `roadmap/pr-122-query-loop-engine`
11. `roadmap/pr-123-context-management`
12. `roadmap/pr-124-agent-definitions`
13. `roadmap/pr-125-subagent-runtime`
14. `roadmap/pr-126-audit-deep-integration`
15. `roadmap/pr-127-import-graph`
16. `roadmap/pr-128-scope-mapper`
17. `roadmap/pr-129-scope-injection`
18. `roadmap/pr-130-entitlement-gate`
19. `roadmap/pr-131-interactive-repl`
20. `roadmap/pr-132-session-resume`
21. `roadmap/pr-133-terminal-ui`
22. `roadmap/pr-134-sl-run`
23. `roadmap/pr-135-sl-fix`
24. `roadmap/pr-136-daemon-upgrade`
25. `roadmap/pr-137-frictionless-secret-setup`
26. `roadmap/pr-138-agent-ide-dictionary`
27. `roadmap/pr-139-flexible-spec-phases`
28. `roadmap/pr-140-spec-bound-review`
29. `roadmap/pr-141-shared-memory-blackboard`
30. `roadmap/pr-142-hybrid-retrieval-index`
31. `roadmap/pr-143-stuck-agent-alerts`
32. `roadmap/pr-144-stale-ingest-refresh`

### Exact Next PR Branch Order
1. `roadmap/pr-114-p2-burn-down-clean` (current: active Omar loop to reduce P2 findings to <=2)
2. `roadmap/pr-115-command-lazy-loading` (next after PR 114 merge)

### Active Omar Loop Status (PR 114)
- [x] Validate audit findings against active branch state and latest Omar comment thread.
- [x] Reproduce and root-cause CI blocker from latest failed run (`Quality Gates` run `23946241522`).
- [x] Fix flaky unit coverage test assertion (`tests/unit.auth-service.test.mjs`) to enforce deterministic ceiling instead of timing-sensitive exact poll count.
- [x] Run local verification (`npm run test:coverage`, `npm run verify`).
- [x] Run local Omar/Audit JSON gates and capture artifacts.
- [x] Apply targeted P2 hardening patch set for current Omar findings:
  - `release-please.yml`: merge-base fallback with fail-closed resolution for release-intent scope.
  - `release-publish.yml`: enforce branch-protection and required-context success on target commit before publish.
  - `omar-gate.yml`: limit secret leak scan to explicit output/artifact paths instead of repository-wide grep.
  - `src/config/schema.js` + `src/auth/service.js`: reject leading/trailing whitespace in secret tokens and parse env token via runtime schema before auth session resolution.
  - Added regression tests in `tests/unit.config-security.test.mjs` and `tests/unit.auth-service.test.mjs`.
- [x] Re-run post-fix verification (`npm run test:unit -- tests/unit.config-security.test.mjs tests/unit.auth-service.test.mjs`, `npm run verify`).
- [x] Apply second-cycle P2 remediation from run `83c47717-51ac-4df0-b992-a74ba8c33c43`:
  - `src/auth/service.js`: remove time-derived jitter seed fallback and require cryptographic randomness (`randomBytes` -> `webcrypto` -> fail closed).
  - `src/daemon/assignment-ledger.js`: add bounded randomized jitter to atomic rename/remove retry backoff loops.
  - `.github/workflows/release-publish.yml`: narrow `workflow_run` trigger to `main` and reject non-default upstream head branches during resolve.
- [x] Re-run post-remediation verification (`npm run test:unit -- tests/unit.auth-service.test.mjs tests/unit.daemon-assignment-ledger.test.mjs`, `npm run verify`).
- [ ] Push fix commit and watch Omar Gate run to completion via `gh run watch --exit-status`.
- [ ] If Omar findings remain above target, iterate P2 fixes and rerun loop until `P2 <= 2`.

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
  - PR 5.1 foundation slice completion:
    - #50 merged (`feat(plugin): phase 5.1 manifest scaffold/validate/list foundation`).
    - Added plugin manifest contract and `plugin init|validate|list` command surface.
  - PR 4.3 foundation slice completion:
    - #51 merged (`feat(auth): phase 4.3 session inventory and revoke controls`).
    - Added `auth sessions` inventory and `auth revoke` remote-token controls with deterministic local metadata cleanup.
  - PR 11.1 foundation slice completion:
    - #52 merged (`feat(ai): phase 11.1 AIdenID provisioning command surface`).
    - Added `ai provision-email` dry-run/live execute flow with deterministic request/response artifacts.
  - PR 11.2 foundation slice completion:
    - #75 merged (`feat(ai): phase 11.2 identity lifecycle commands`).
    - Added local registry-backed `ai identity list|show|revoke` lifecycle controls.
  - PR 11.3 foundation slice completion:
    - #76 merged (`feat(ai): phase 11.3 OTP and extraction lifecycle commands`).
    - Added `ai identity events|latest|wait-for-otp` with confidence/timeout polling + extraction source reporting.
  - PR 11.4 foundation slice completion:
    - #77 merged (`feat(ai): phase 11.4 child identity lineage workflows`).
    - Added `ai identity create-child|lineage|revoke-children` with delegated lineage registry updates.
  - PR 11.5 foundation slice completion:
    - #78 merged (`feat(ai): phase 11.5 domain and target governance commands`).
    - Added `ai identity domain create|verify|freeze` and `ai identity target create|verify|show`.
  - PR 11.6 foundation slice completion:
    - #79 merged (`feat(ai): phase 11.6 ephemeral callback domain workflows`).
    - Added `ai identity site create|list` with deterministic site-registry artifacts.
  - PR 12.1 foundation slice completion:
    - #80 merged (`feat(swarm): phase 12.1 orchestrator factory`).
    - Added `swarm registry|plan` with OMAR-led 13-agent registry, deterministic assignment planning, and swarm plan artifacts.
  - PR 12.2 foundation slice completion:
    - #81 merged (`feat(swarm): phase 12.2 runtime and playwright adapter`).
    - Added `swarm run` governed runtime loop, runtime artifact chain, and optional Playwright adapter path.
  - PR 12.3 foundation slice completion:
    - #82 merged (`feat(swarm): phase 12.3 scenario DSL`).
    - Added scenario DSL parser/validator/template flow plus `swarm run --scenario-file` execution binding.
  - PR 12.4 foundation slice completion:
    - #83 merged (`feat(swarm): phase 12.4 realtime dashboard`).
    - Added `swarm dashboard` snapshot/watch modes with per-agent runtime status rows and JSON dashboard feeds.
  - PR 9.1 extension slice completion:
    - #53 merged (`feat(review): phase 9.1 deterministic local scan command`).
    - Added `review scan --mode full|diff` deterministic local review scan flow with reproducible report artifacts.
  - PR 2.2 (terminal markdown renderer + artifact show commands) local evidence (branch `roadmap/pr-2-2-terminal-markdown-renderer`):
    - `npm run verify` (pass, e2e `45/45`; coverage statements `89.68%`, branches `71.02%`, functions `97.72%`, lines `89.68%`)
    - `node bin/create-sentinelayer.js /omargate deep --path . --json` (`p1=0`, `p2=6`, `blocking=false`)
    - `node bin/create-sentinelayer.js /audit --path . --json` (`overallStatus=PASS`, `p1Total=0`, `p2Total=6`)
  - PR 2.3 (diff-aware spec regeneration with manual section preservation) local evidence (branch `roadmap/pr-2-3-diff-aware-regeneration`):
    - `npm run verify` (pass, e2e `46/46`; coverage statements `89.68%`, branches `71.02%`, functions `97.72%`, lines `89.68%`)
    - `node bin/create-sentinelayer.js /omargate deep --path . --json` (`p1=0`, `p2=6`, `blocking=false`)
    - `node bin/create-sentinelayer.js /audit --path . --json` (`overallStatus=PASS`, `p1Total=0`, `p2Total=6`)
  - PR 2.4 (progress + notification reporter with global `--quiet`) local evidence (branch `roadmap/pr-2-4-progress-notifications`):
    - `npm run verify` (pass, e2e `46/46`; coverage statements `89.68%`, branches `71.02%`, functions `97.72%`, lines `89.68%`)
    - `node bin/create-sentinelayer.js /omargate deep --path . --json` (`p1=0`, `p2=6`, `blocking=false`)
    - `node bin/create-sentinelayer.js /audit --path . --json` (`overallStatus=PASS`, `p1Total=0`, `p2Total=6`)
  - PR 12.7 hardening slice local evidence (branch `roadmap/pr-12-7-swarm-identity-hardening`):
    - `npm run verify` (pass, e2e `76/76`; unit tests `94/94`; coverage statements `89.69%`, branches `71.54%`, functions `97.72%`, lines `89.69%`)
    - `node bin/create-sentinelayer.js /omargate deep --path . --json` (`p1=0`, `p2=10`, `blocking=false`)
    - `node bin/create-sentinelayer.js /audit --path . --json` (`overallStatus=PASS`, `p1Total=0`, `p2Total=10`)
    - Fixed deterministic identity-registry persistence by replacing concurrent `kill-all` local updates with serialized status writes (prevents dropped `SQUASHED` transitions).
  - PR 13.1 daemon slice local evidence (branch `roadmap/pr-13-1-error-event-daemon-worker`):
    - `npm run verify` (pass, e2e `77/77`; unit tests `96/96`; coverage statements `89.69%`, branches `71.54%`, functions `97.72%`, lines `89.69%`)
    - `node bin/create-sentinelayer.js /omargate deep --path . --json` (`p1=0`, `p2=10`, `blocking=false`)
    - `node bin/create-sentinelayer.js /audit --path . --json` (`overallStatus=PASS`, `p1Total=0`, `p2Total=10`)
    - Added deterministic error daemon artifacts under `.sentinelayer/observability/error-daemon/` with stream cursoring, queue dedupe, and severity escalation.
  - PR 13.2 assignment-ledger slice local evidence (branch `roadmap/pr-13-2-global-assignment-ledger`):
    - `npm run verify` (pass, e2e `78/78`; unit tests `98/98`; coverage statements `89.69%`, branches `71.54%`, functions `97.72%`, lines `89.69%`)
    - `node bin/create-sentinelayer.js /omargate deep --path . --json` (`p1=0`, `p2=10`, `blocking=false`)
    - `node bin/create-sentinelayer.js /audit --path . --json` (`overallStatus=PASS`, `p1Total=0`, `p2Total=10`)
    - Added global assignment ledger with claim/heartbeat/release/reassign lifecycle and queue-status synchronization under `.sentinelayer/observability/error-daemon/`.
  - PR 13.3 Jira lifecycle slice local evidence (branch `roadmap/pr-13-3-jira-lifecycle-automation`):
    - `npm run verify` (pass, e2e `79/79`; unit tests `100/100`; coverage statements `89.69%`, branches `71.54%`, functions `97.72%`, lines `89.69%`)
    - `node bin/create-sentinelayer.js /omargate deep --path . --json` (`p1=0`, `p2=10`, `blocking=false`)
    - `node bin/create-sentinelayer.js /audit --path . --json` (`overallStatus=PASS`, `p1Total=0`, `p2Total=10`)
    - Added daemon Jira lifecycle artifacts (`jira-lifecycle.json`, `jira-events.ndjson`) with `open|start|comment|transition|list` command flow and assignment-ledger issue-key sync.
  - PR 13.4 runtime budget governance slice local evidence (branch `roadmap/pr-13-4-runtime-budget-quarantine`):
    - `npm run verify` (pass, e2e `80/80`; unit tests `102/102`; coverage statements `89.69%`, branches `71.54%`, functions `97.72%`, lines `89.69%`)
    - `node bin/create-sentinelayer.js /omargate deep --path . --json` (`p1=0`, `p2=10`, `blocking=false`)
    - `node bin/create-sentinelayer.js /audit --path . --json` (`overallStatus=PASS`, `p1Total=0`, `p2Total=10`)
    - Added deterministic budget-governor artifacts (`budget-state.json`, `budget-events.ndjson`, `budget-runs/*.json`) with two-phase `QUARANTINE -> KILL` lifecycle enforcement.
  - PR 13.5 operator control-plane slice local evidence (branch `roadmap/pr-13-5-operator-control-plane`):
    - `npm run verify` (pass, e2e `81/81`; unit tests `104/104`; coverage statements `89.69%`, branches `71.54%`, functions `97.72%`, lines `89.69%`)
    - `node bin/create-sentinelayer.js /omargate deep --path . --json` (`p1=0`, `p2=10`, `blocking=false`)
    - `node bin/create-sentinelayer.js /audit --path . --json` (`overallStatus=PASS`, `p1Total=0`, `p2Total=10`)
    - Added unified `daemon control` snapshot/stop surface with budget-health colors, session timers, agent roster aggregates, and `--confirm`-gated operator kill-switch artifacts.
  - PR 13.6 artifact-lineage slice local evidence (branch `roadmap/pr-13-6-observability-artifact-lineage`):
    - `npm run verify` (pass, e2e `82/82`; unit tests `106/106`; coverage statements `89.69%`, branches `71.54%`, functions `97.72%`, lines `89.69%`)
    - `node bin/create-sentinelayer.js /omargate deep --path . --json` (`p1=0`, `p2=10`, `blocking=false`)
    - `node bin/create-sentinelayer.js /audit --path . --json` (`overallStatus=PASS`, `p1Total=0`, `p2Total=10`)
    - Added deterministic lineage index under `observability/error-daemon/lineage` with per-work-item linkage across queue/assignment/Jira/budget/operator artifacts and `lineage build|list|show` command surface.
  - PR 13.7 hybrid-mapper slice local evidence (branch `roadmap/pr-13-7-hybrid-mapping-overlay`):
    - `npm run verify` (pass, e2e `83/83`; unit tests `108/108`; coverage statements `89.69%`, branches `71.54%`, functions `97.72%`, lines `89.69%`)
    - `node bin/create-sentinelayer.js /omargate deep --path . --json` (`p1=0`, `p2=10`, `blocking=false`)
    - `node bin/create-sentinelayer.js /audit --path . --json` (`overallStatus=PASS`, `p1Total=0`, `p2Total=10`)
    - Added hybrid deterministic+semantic mapping overlay artifacts under `observability/error-daemon/mapping/` with import-graph expansion, semantic token scoring, and `map scope|list|show` command surface.

  - PR 101 (coverage instrumentation expansion) local evidence (branch `roadmap/pr-101-coverage-instrumentation`):
    - `npm run verify` (pass, e2e `84/84`; unit tests `124/124`; coverage statements `89.84%`, branches `70.08%`, functions `91.30%`, lines `89.84%`)
    - `node bin/create-sentinelayer.js /omargate deep --path . --json` (`p1=0`, `p2=10`, `blocking=false`)
    - `node bin/create-sentinelayer.js /audit --path . --json` (`overallStatus=PASS`, `p1Total=0`, `p2Total=10`)
    - Expanded `c8` instrumentation scope from 8 to 24 modules and added deterministic unit coverage for `auth/session-store`, `daemon/error-worker`, `daemon/budget-governor`, and `swarm/runtime` negative/budget paths.

  - PR 102 (command unit-test layer) local evidence (branch `roadmap/pr-102-command-unit-tests`):
    - `npm run verify` (pass, e2e `84/84`; unit tests `134/134`; coverage statements `89.84%`, branches `70.08%`, functions `91.30%`, lines `89.84%`)
    - `node bin/create-sentinelayer.js /omargate deep --path . --json` (`p1=0`, `p2=10`, `blocking=false`)
    - `node bin/create-sentinelayer.js /audit --path . --json` (`overallStatus=PASS`, `p1Total=0`, `p2Total=10`)
    - Added high-risk command contract tests for `ai`, `daemon`, `scan`, `review`, and `swarm` plus guardrail validation error coverage for conflicting flags and invalid inputs.

  - PR 103 (high-risk JSDoc coverage) local evidence (branch `roadmap/pr-103-jsdoc-high-risk`):
    - `npm run verify` (pass, e2e `84/84`; unit tests `134/134`; coverage statements `90.12%`, branches `70.08%`, functions `91.30%`, lines `90.12%`)
    - `node bin/create-sentinelayer.js /omargate deep --path . --json` (`p1=0`, `p2=10`, `blocking=false`)
    - `node bin/create-sentinelayer.js /audit --path . --json` (`overallStatus=PASS`, `p1Total=0`, `p2Total=10`)
    - Added API-surface JSDoc for high-risk modules: `auth/http`, `auth/service`, `auth/session-store`, `ai/client`, `mcp/registry`, `cost/budget`, and `cost/tracker`.

  - PR 104 (dependabot + issue templates) local evidence (branch `roadmap/pr-104-dependabot-templates`):
    - `npm run verify` (pass, e2e `84/84`; unit tests `134/134`; coverage statements `90.12%`, branches `70.08%`, functions `91.30%`, lines `90.12%`)
    - `node bin/create-sentinelayer.js /omargate deep --path . --json` (`p1=0`, `p2=10`, `blocking=false`)
    - `node bin/create-sentinelayer.js /audit --path . --json` (`overallStatus=PASS`, `p1Total=0`, `p2Total=10`)
    - Added `.github/dependabot.yml` and typed issue intake templates under `.github/ISSUE_TEMPLATE/` for reproducible bug/feature submissions.

  - PR 105 (todo sync + release tag validation) findings validation:
    - `npm run verify` (pass, e2e `84/84`; unit tests `134/134`; coverage statements `90.12%`, branches `70.08%`, functions `91.30%`, lines `90.12%`)
    - `node bin/create-sentinelayer.js /omargate deep --path . --json` (`p1=0`, `p2=10`, `blocking=false`)
    - `node bin/create-sentinelayer.js /audit --path . --json` (`overallStatus=PASS`, `p1Total=0`, `p2Total=10`)
    - Confirmed stale roadmap rows were corrected for merged PRs `#61`, `#94`, and `#95`.
    - Validated release state with `git ls-remote --tags origin` (no tags), `.release-please-manifest.json` (`0.1.0`), and no open release-please PR.
    - Recorded deterministic release evidence in `tasks/release-tag-validation-2026-04-02.md`; no manual `v0.2.0` tag was cut because no `0.2.0` release commit exists on `main`.

  - PR 106 (split oversized command files) local evidence (branch `roadmap/pr-106-split-oversized-command-files`):
    - `npm run verify` (pass, e2e `84/84`; unit tests `134/134`; coverage statements `90.12%`, branches `70.08%`, functions `91.30%`, lines `90.12%`)
    - `node bin/create-sentinelayer.js /omargate deep --path . --json` (`p1=0`, `p2=10`, `blocking=false`)
    - `node bin/create-sentinelayer.js /audit --path . --json` (`overallStatus=PASS`, `p1Total=0`, `p2Total=10`)
    - Reduced top-level command file size by converting `src/commands/ai.js` and `src/commands/daemon.js` into thin orchestrators and extracting grouped logic into `src/commands/ai/*` and `src/commands/daemon/*`.
    - Preserved existing command contracts and options while keeping behavior stable under full e2e and unit verification.

## PR 114 Omar P2 Burn-Down Loop (2026-04-03)
- [x] Validate `tasks/audit-report-2026-04-02.md` findings against current PR #114 Omar output.
- [x] Fix Omar workflow policy/concurrency findings (`.github/workflows/omar-gate.yml`).
- [x] Enforce strict lint -> test -> security -> build DAG (`.github/workflows/quality-gates.yml`).
- [x] Harden release required-check validation and rollback-readiness automation (`.github/workflows/release.yml`).
- [x] Add assignment-ledger atomic write + storage lock safeguards (`src/daemon/assignment-ledger.js` + tests).
- [x] Replace pinned syntax matrix patch versions with major channels (`18`, `20`) in quality gates.
- [x] Force `workflow_dispatch` release runs into deterministic dry-run mode and always validate required checks on active release paths.
- [x] Add deterministic rebuild-hash proof verification in publish path (`create-sentinelayer.sha256` vs `create-sentinelayer.rebuild.sha256`).
- [x] Replace static broad auth token scope with validated least-privilege default (`cli_session`) and explicit scoped override path.
- [x] Add assignment-ledger `.new` fallback recovery and test for missing-ledger restoration.
- [x] Pin `release-please` runner image to `ubuntu-22.04` for deterministic release automation.
- [x] Redact credential metadata paths from default `auth` terminal output; add explicit `--show-paths` opt-in.
- [x] Harden session metadata writes with temp-file fsync + post-rename parent-directory fsync (best-effort).
- [x] Add `AbortSignal.any` compatibility guard with manual abort bridging in auth HTTP client.
- [x] Harden release required-check verification by pinning matched checks to expected workflow file path + head SHA.
- [x] Make daemon assignment event append path durable with file-handle fsync and directory sync.
- [x] Pin Omar Gate runner to `ubuntu-22.04` and assert `security-review` environment required-reviewer protection before secret-backed scan.
- [x] Add build-provenance attestation to `quality-gates` build artifact pipeline.
- [x] Make key material writes atomic (`writeSecretFile` temp+fsync+rename+directory sync).
- [x] Run `npm run verify` locally.
- [x] Run local gates: `/omargate deep` and `/audit` with `p1=0`, `p2=0`.
- [x] Validate residual Omar findings against latest PR #114 comment (`run_id=3e9c8a42`, commit `478b710`): active P2 set is `quality-gates reproducibility bridge`, `release concurrency`, `release preflight dependency`, `config secrets schema`.
- [x] Commit-scoped `release.yml` hardening prepared (`preflight` depends on `verify-required-checks`; ref-scoped concurrency + cancellation).
- [x] Implement cross-workflow build-once/promote-once evidence bridge from `quality-gates` to `release` (artifact digest contract + release verification).
- [x] Harden `src/config/schema.js` to block persisted plaintext secrets by default (explicit unsafe opt-in only) and add coverage tests.
- [x] Run `npm run verify` and local `/omargate deep` + `/audit` after residual fixes.
- [x] Run `gh run watch` for Omar Gate run `23931011060` and capture residual `P2=6` findings (config opt-in, eval-impact base fallback, release rollback/manual path/concurrency, Retry-After clock skew).
- [x] Add deterministic eval-impact merge-base fallback (`quality-gates.yml`) and fail-closed behavior when merge base cannot be resolved.
- [x] Add rollback workflow contract (`.github/workflows/rollback.yml`) and release preflight rollback automation validation.
- [x] Rework release controls for single-flight promotion (`concurrency` lock) and controlled manual publish path from tagged dispatches.
- [x] Harden Retry-After HTTP-date handling with monotonic/server-date-aware delay parsing and coverage test.
- [x] Remove env-based plaintext secret persistence override; keep config secret persistence blocked by default and update auth/config tests.
- [x] Push second-cycle fixes (`4a53d73`) and run `gh run watch` (`run_id=23932048297`): Omar remains `P2=6` with new set (`HTTPS API URL`, `rollback token scope`, `release-please gate dependency`, `quality network timeout controls`, `non-tag dispatch release path`, `release check-run race`).
- [x] Third-cycle hardening applied for all six new findings: HTTPS-only non-local API URLs, rollback token step-scoping, release-please quality-gate dependency check, quality workflow network step timeouts, non-tag dispatch release-path disable, workflow-run-based required-check verification.
- [x] Push third-cycle fixes (`ab231bb`) and run `gh run watch` (`run_id=23932381636`): Omar reduced to `P2=5` (`omar-gate perms`, `quality immutable-build model`, `release production-gate recognition`, `release recency binding`, `lockfile integrity policy`).
- [x] Fourth-cycle hardening applied for three deterministic residuals: least-privilege Omar workflow permissions, lockfile immutability enforcement in quality gates, and explicit protected production authorization job before publish.
- [x] Push fourth-cycle residual fixes (`2c2268d`) and run `gh run watch` (`run_id=23932609696`): Omar scan failed during publish step due `pull-requests` read permission (`403` updating PR comment).
- [x] Restore Omar Gate PR comment permissions (`d6b235c`) and rerun `gh run watch` (`run_id=23932837347`): Omar executes successfully and reports `P2=6`.
- [x] Fifth-cycle hardening applied for active residual findings: quality gate identity pinning in Omar workflow, quality workflow non-cancel concurrency, release dispatch required-check enforcement + artifact identity binding, randomized retry jitter entropy, and assignment-ledger parent-directory fsync.
- [x] Push fifth-cycle fixes (`91250cc`) and rerun `gh run watch` (`run_id=23933147291`): Omar still reports `P2=6`; active findings shifted to workflow-dispatch quality bypass, quality concurrency policy, release flag-script clarity/build-once semantics, auth jitter fallback, and auth poll idempotency.
- [x] Sixth-cycle hardening applied for active residual findings: event-aware quality concurrency cancellation policy, Omar dispatch quality-gate binding (`TARGET_SHA` fallback + workflow-run identity lookup), release flag resolver script rewrite, deterministic non-`Math.random` jitter fallback, and poll-session idempotency/request-consistency validation with new unit coverage.
- [x] Push sixth-cycle fixes (`36549d2`) and rerun `gh run watch` (`run_id=23933483218`): Omar reduced to `P2=5` with new focus areas (`config schema plaintext bypass`, `quality stage ordering`, `poll idempotency nonce`, `release-please protected gate`, `release trusted dispatch invoker`).
- [x] Seventh-cycle hardening applied for active residual findings: persisted-config schema locked to non-secret shape, quality gate order restored (tests -> security -> build with eval-impact enforced in summary), per-attempt auth poll idempotency keys, release-management environment protection assertion in release-please, and trusted workflow_dispatch invoker validation in release pipeline.
- [x] Push seventh-cycle fixes (`96c26ed`) and rerun `gh run watch` (`run_id=23934245218`): Omar reduced to `P2=4` (`security-scan` eval dependency, config secret schema split, release environment/ref hardening).
- [x] Eighth-cycle hardening applied and pushed (`e6a4661`): `security-scan` now depends on `eval-impact`, `configSchema` persisted keys split from runtime secret schema, release preflight + required-check jobs pinned to `release-management`, and workflow_dispatch ref guards tightened.
- [x] Rerun Omar (`run_id=23935232366`): residual findings shifted to `P2=5` (`auth privileged-scope consent`, `keyring-disable fallback consent`, `quality release-readiness stage`, `release check provenance event filter`, `attestation verification`).
- [x] Ninth-cycle hardening prepared locally: auth privileged-scope explicit opt-in (`--allow-privileged-scope`), keyring downgrade explicit consent (`--no-keyring`) + metadata flag, quality `release-readiness` smoke stage, release required-check event/source filtering, and attestation verification gate in preflight.
- [x] Push ninth-cycle fixes (`3b4faec`) and rerun Omar (`run_id=23936484487`): Omar blocked early because quality-gates run `23936484488` failed in new `Release Readiness` job (`setup-node` cache executed before checkout).
- [x] Apply quality-gates hotfix: add explicit checkout step before `setup-node` in `Release Readiness` job.
- [x] Push quality-gates hotfix (`cfe4a62`) and rerun Omar (`run_id=23937429580`): Omar blocked again because `npm install` treated `quality-readiness/<tarball>` as a GitHub shorthand (missing local `./` prefix).
- [x] Apply second quality-gates hotfix: force local tarball install path to `./quality-readiness/<tarball>` in `Release Readiness` smoke stage.
- [x] Push second quality-gates hotfix (`4d1496f`) and rerun Omar (`run_id=23938362934`): Omar unblocked and reported active residual set `P2=5` (release-please Omar dependency, release tag gate deadlock, rollback proof recency, auth error-message exposure, auth jitter fallback correlation).
- [x] Tenth-cycle hardening applied for active residual findings:
  - `release-please.yml`: explicit Omar Gate verification on target SHA before release mutation.
  - `release.yml`: event-aware required-check policy and rollback-proof recency validation (`ROLLBACK_PROOF_MAX_AGE_DAYS`).
  - `auth/http.js`: per-request jitter seed threaded into deterministic fallback backoff hash path.
  - `commands/auth.js`: sanitized API error rendering by code with optional raw-detail opt-in via `SL_DEBUG_ERRORS`.
  - Added deterministic unit coverage for auth command error formatting (`tests/unit.auth-command-errors.test.mjs`).
- [x] Tenth-cycle local evidence:
  - `node --test tests/unit.auth-command-errors.test.mjs tests/unit.auth-http.test.mjs` (pass).
  - `npm run verify` (pass, e2e `84/84`; unit `155/155`; coverage statements `90.18%`, branches `70.37%`, functions `91.48%`, lines `90.18%`).
  - `node bin/create-sentinelayer.js /omargate deep --path . --json` (`p1=0`, `p2=0`, `blocking=false`).
  - `node bin/create-sentinelayer.js /audit --path . --json` (`overallStatus=PASS`, `p1Total=0`, `p2Total=0`).
- [x] Push tenth-cycle fixes (`2683eae`) and rerun Omar (`run_id=23939645056`): Omar shifted to `P2=8` with active findings in `omar-gate` concurrency policy, `quality-gates` permission/pinning controls, `release` tag replay/provenance validation, auth poll idempotency collisions, auth debug leak path, and assignment-ledger `process` import.
- [x] Eleventh-cycle hardening applied for active residual findings:
  - `.github/workflows/omar-gate.yml`: non-cancelable PR concurrency (`cancel-in-progress: false`).
  - `.github/workflows/quality-gates.yml`: least-privilege workflow permissions + build-artifact scoped `id-token/attestations`.
  - `.github/workflows/quality-gates.yml`: deterministic gitleaks SHA policy gate backed by `.github/security/action-sha-allowlist.txt`.
  - `.github/workflows/release.yml`: tag-time Omar Gate replay requirement via commit check-run verification (no skip path), plus publish-time release artifact attestation verification.
  - `src/auth/service.js`: per-login `pollClientId` in poll idempotency keys to prevent cross-client/session collisions.
  - `src/commands/auth.js`: remove raw backend-detail emission path entirely (including debug env mode).
  - `src/daemon/assignment-ledger.js`: import `node:process` for backup path generation in ESM.
  - Updated auth-service and auth-command unit coverage for new idempotency/error-redaction behavior.
- [x] Eleventh-cycle local evidence:
  - `npm run verify` (pass, e2e `84/84`; unit `155/155`; coverage statements `90.18%`, branches `70.37%`, functions `91.48%`, lines `90.18%`).
  - `node bin/create-sentinelayer.js /omargate deep --path . --json` (`p1=0`, `p2=0`, `blocking=false`).
  - `node bin/create-sentinelayer.js /audit --path . --json` (`overallStatus=PASS`, `p1Total=0`, `p2Total=0`).
- [x] Push eleventh-cycle fixes (`3ed2021`) and rerun Omar (`run_id=23940213618`): Omar reduced to `P2=5` (release-please timeout hardening, release Omar event mapping, rollback lineage gate, auth requestId normalization, auth poll idempotency semantics).
- [x] Twelfth-cycle hardening applied for active residual findings:
  - `src/auth/http.js`: preserve both `request_id` and `requestId` from upstream API error payloads.
  - `tests/unit.auth-http.test.mjs`: add regression coverage for camelCase `requestId` propagation.
  - `src/auth/service.js`: stabilize poll idempotency key per login attempt-set (`sessionId + pollClientId`) and expose attempt index via `X-Poll-Attempt`.
  - `tests/unit.auth-service.test.mjs`: update idempotency expectations for stable-key retries.
  - `.github/workflows/release-please.yml`: add explicit `timeout --preserve-status` wrappers for network-bound `gh api`/`gh run download` operations plus step-level timeout for `release-please-action`.
  - `.github/workflows/release.yml`: allow `workflow_dispatch` Omar events in required-check mapping to prevent manual-run deadlocks.
  - `.github/workflows/rollback.yml`: add execute-path rollback lineage gate (release tag -> commit -> quality manifest/artifact digest -> attestation verification) before any npm mutation.
- [x] Twelfth-cycle local evidence:
  - `node --test tests/unit.auth-http.test.mjs tests/unit.auth-service.test.mjs` (pass).
  - `npm run verify` (pass, e2e `84/84`; unit `156/156`; coverage statements `90.18%`, branches `70.37%`, functions `91.48%`, lines `90.18%`).
  - `node bin/create-sentinelayer.js /omargate deep --path . --json` (`p1=0`, `p2=0`, `blocking=false`).
  - `node bin/create-sentinelayer.js /audit --path . --json` (`overallStatus=PASS`, `p1Total=0`, `p2Total=0`).
- [x] Push twelfth-cycle fixes (`b8eb28e`) and rerun Omar (`run_id=23940593375`): Omar holds at `P2=5` with active findings in `quality-gates` npm parity, `release-please` trigger scope, `release` tag Omar deadlock handling, and auth/session request-id/key-rotation controls.
- [x] Validate `tasks/audit-report-2026-04-02.md` against active Omar findings for PR #114 (confirmed residual set is current and actionable).
- [x] Thirteenth-cycle hardening applied for active residual findings:
  - `src/auth/session-store.js`: enforce file-token key rotation coupling (`fileTokenKeyVersion` + rekey on legacy reads/login) and delete key file on file-session clear / keyring migration.
  - `src/commands/auth.js`: redact upstream `requestId` by default and emit only debug-tail diagnostics when `SL_DEBUG_ERRORS=1`.
  - `.github/workflows/quality-gates.yml`: pin npm CLI version (`10.8.2`) + deterministic locale/tz env in build-artifact reproducibility stage.
  - `.github/workflows/release-please.yml`: add push path-scoping and release-intent changed-file gate before mutating release PR state.
  - `.github/workflows/release.yml`: replace tag-time Omar polling deadlock path with fail-fast prior-run resolution on target commit.
- [x] Thirteenth-cycle local evidence:
  - `npm run test:unit -- tests/unit.auth-session-store.test.mjs tests/unit.auth-command-errors.test.mjs tests/unit.auth-http.test.mjs tests/unit.auth-service.test.mjs` (pass).
  - `npm run verify` (pass, e2e `84/84`; unit `156/156`; coverage statements `90.18%`, branches `70.37%`, functions `91.48%`, lines `90.18%`).
  - `node bin/create-sentinelayer.js /omargate deep --path . --json` (`p1=0`, `p2=0`, `blocking=false`).
  - `node bin/create-sentinelayer.js /audit --path . --json` (`overallStatus=PASS`, `p1Total=0`, `p2Total=0`).
- [x] Push thirteenth-cycle fixes (`26d1611`) and rerun Omar (`run_id=23941133816`): Omar shifted to `P2=6` with active findings in action secret handoff, release check-run identity hardening, quality reproducibility cache provenance, and auth poll idempotency semantics.
- [x] Fourteenth-cycle hardening applied for active residual findings:
  - `src/auth/service.js`: restore per-attempt poll idempotency suffix (`...:<attempt>`) while keeping explicit `X-Poll-Attempt` header.
  - `tests/unit.auth-service.test.mjs`: update poll idempotency assertions for attempt-scoped keys.
  - `.github/workflows/quality-gates.yml`: pin + reuse dedicated npm cache path and force isolated rebuild install from offline cache to reduce registry nondeterminism.
  - `.github/workflows/release.yml`: enforce branch-protection required context contract, require unambiguous single-run match for required checks, and anchor workflow-run ids against commit check-run details URL.
  - `.github/workflows/release.yml`: scope `publish` job to explicit `production` environment.
  - `.github/workflows/omar-gate.yml`: add deterministic allowlist SHA gate for `mrrCarter/sentinelayer-v1-action`.
  - `.github/security/action-sha-allowlist.txt`: register pinned Omar action SHA.
- [x] Fourteenth-cycle local evidence:
  - `npm run test:unit -- tests/unit.auth-service.test.mjs` (pass).
  - `npm run verify` (pass, e2e `84/84`; unit `156/156`; coverage statements `90.18%`, branches `70.37%`, functions `91.48%`, lines `90.18%`).
  - `node bin/create-sentinelayer.js /omargate deep --path . --json` (`p1=0`, `p2=0`, `blocking=false`).
  - `node bin/create-sentinelayer.js /audit --path . --json` (`overallStatus=PASS`, `p1Total=0`, `p2Total=0`).
- [x] Push fourteenth-cycle fixes (`21f3919`) and rerun Omar (`run_id=23941573780`): Omar exited early because `Quality Gates` run `23941572042` failed before jobs with a workflow-parse issue in `quality-gates.yml`.
- [x] Apply hotfix for `quality-gates` workflow parse failure by removing `runner` context from job-level `env` and deriving `NPM_CACHE_DIR` from `RUNNER_TEMP` at runtime in the pin step.
- [x] Push fourteenth-cycle hotfix (`54b6f29`) and rerun Omar (`run_id=23941694136`): Omar runs cleanly and reports `P2=6` with active residuals in quality-run identity anchoring, release-event mapping, rollback mutation timeout controls, auth poll idempotency semantics, and assignment-ledger event append locking.
- [x] Fifteenth-cycle hardening applied for active residual findings:
  - `.github/workflows/omar-gate.yml`: enforce unique Quality Summary run identity (single-candidate guard + commit check-run run-id anchor) before secret-backed Omar execution.
  - `.github/workflows/release-please.yml`: restrict Omar verification evidence to PR-context runs (`event == pull_request`) only.
  - `.github/workflows/release.yml`: allow `workflow_dispatch` in required-check mapping for `Quality Summary` and `Release Readiness`.
  - `.github/workflows/rollback.yml`: add bounded `timeout --preserve-status` wrappers for `npm dist-tag add` and `npm deprecate` mutation steps.
  - `src/auth/service.js`: restore stable poll-session idempotency key semantics.
  - `src/daemon/assignment-ledger.js`: add explicit file-lock around event stream appends (`assignment-events.lock`).
  - `tests/unit.auth-service.test.mjs`: update idempotency assertions for stable poll key semantics.
- [x] Fifteenth-cycle local evidence:
  - `npm run test:unit -- tests/unit.auth-service.test.mjs tests/unit.daemon-assignment-ledger.test.mjs` (pass).
  - `npm run verify` (pass, e2e `84/84`; unit `156/156`; coverage statements `90.18%`, branches `70.37%`, functions `91.48%`, lines `90.18%`).
  - `node bin/create-sentinelayer.js /omargate deep --path . --json` (`p1=0`, `p2=0`, `blocking=false`).
  - `node bin/create-sentinelayer.js /audit --path . --json` (`overallStatus=PASS`, `p1Total=0`, `p2Total=0`).
- [x] Push fifteenth-cycle fixes (`e6f36f6`) and rerun Omar (`run_id=23942073171`): Omar reports active `P2=5` in workflow-only controls (`quality-gates` clean-room reproducibility, `release-please` quality-event provenance, `release` trusted invoker/tag actor guard, `release` branch-protection strictness parity, `release` Omar event provenance).
- [x] Sixteenth-cycle hardening applied for active residual findings:
  - `.github/workflows/quality-gates.yml`: clean-room rebuild now uses isolated cache + online immutable install with lockfile hash parity guard (no warm-cache/offline reuse).
  - `.github/workflows/release-please.yml`: Quality Summary evidence is restricted to `push` workflow events for target SHA.
  - `.github/workflows/release.yml`: trusted invoker validation now covers tag `push` events with actor permission checks and bot provenance validation against successful `release-please` run on the tagged commit.
  - `.github/workflows/release.yml`: branch-protection contract now enforces strict required checks, minimum PR review count, stale-review dismissal, and release-management deployment-branch policy parity.
  - `.github/workflows/release.yml`: required-check event mapping now excludes `workflow_dispatch` for Omar and quality/readiness checks; tag Omar replay gate now accepts only `pull_request` Omar runs.
- [x] Sixteenth-cycle local evidence:
  - `npm run verify` (pass, e2e `84/84`; unit `156/156`; coverage statements `90.18%`, branches `70.37%`, functions `91.48%`, lines `90.18%`).
  - `node bin/create-sentinelayer.js /omargate deep --path . --json` (`p1=0`, `p2=0`, `blocking=false`).
  - `node bin/create-sentinelayer.js /audit --path . --json` (`overallStatus=PASS`, `p1Total=0`, `p2Total=0`).
- [x] Push sixteenth-cycle fixes (`a50f99f`) and rerun Omar (`run_id=23942528275`): Omar reports active `P2=6` with residual findings in quality-anchor tie-break (`omar-gate`), poll idempotency attempt keys (`auth/service`), config key exposure (`config/schema`), assignment lock metadata robustness (`assignment-ledger`), and release-please Omar provenance fallback.
- [x] Seventeenth-cycle hardening applied for active residual findings:
  - `.github/workflows/omar-gate.yml`: Quality Summary dependency now resolves from canonical commit check-run anchor (`Quality Summary` details_url run id), then validates workflow run path/head SHA identity.
  - `.github/workflows/release-please.yml`: Omar provenance gate now validates commit `Omar Gate` check-run first and adds fallback lineage (`target commit -> merged PR head -> Omar check-run`) for squash/merge commits without direct same-SHA PR runs.
  - `src/auth/service.js`: poll idempotency key now includes attempt ordinal (`...:<attempt>`) while preserving poll-session nonce and session challenge verification.
  - `src/config/schema.js` + `src/config/service.js`: replaced generic `CONFIG_KEYS` exposure with `PERSISTED_CONFIG_KEYS` + explicit `getAllConfigKeys({ includeSecrets })`; default key enumeration no longer includes secret-bearing keys.
  - `src/daemon/assignment-ledger.js`: file-lock metadata now includes owner token + expiry, fsync on lock metadata writes, ownership-aware release, and stale-lock reclaim with metadata compare-before-remove.
  - Added/updated coverage in `tests/unit.auth-service.test.mjs`, `tests/unit.core.test.mjs`, and `tests/unit.daemon-assignment-ledger.test.mjs`.
- [x] Seventeenth-cycle local evidence:
  - `npm run test:unit -- tests/unit.auth-service.test.mjs tests/unit.config-security.test.mjs tests/unit.core.test.mjs tests/unit.daemon-assignment-ledger.test.mjs` (pass).
  - `npm run verify` (pass, e2e `84/84`; unit `157/157`; coverage statements `90.19%`, branches `70.45%`, functions `91.51%`, lines `90.19%`).
  - `node bin/create-sentinelayer.js /omargate deep --path . --json` (`p1=0`, `p2=0`, `blocking=false`).
  - `node bin/create-sentinelayer.js /audit --path . --json` (`overallStatus=PASS`, `p1Total=0`, `p2Total=0`).
- [x] Push seventeenth-cycle fixes (`0e3d0aa`) and rerun Omar (`run_id=23943129963`): Omar remains `P2=6` with new focus on auth CLI error surface verbosity, quality-gates PR concurrency policy, deterministic clean-tree build proof rigor, release tag-signature provenance checks, and long-lived secret exposure in third-party Omar action inputs.
- [x] Eighteenth-cycle hardening applied for active residual findings:
  - `src/commands/auth.js`: `formatApiError` now emits only safe user message by default; `[code] status` remains debug-only behind `SL_DEBUG_ERRORS`.
  - `tests/unit.auth-command-errors.test.mjs`: updated assertions for default redaction and debug-only code/status exposure.
  - `.github/workflows/quality-gates.yml`: required quality workflow concurrency is now non-canceling (`cancel-in-progress: false`) to avoid PR check race instability.
  - `.github/workflows/quality-gates.yml`: build reproducibility now runs from two independent clean git clones (`checkout --detach` + `git clean -ffdqx`), compares sha256 and sorted packed file list parity, and uploads file-list proofs.
  - `.github/workflows/release.yml`: trusted-invoker gate now enforces cryptographic verification for annotated tags and tag target commits before release path execution.
- [x] Eighteenth-cycle local evidence:
  - `npm run verify` (pass, e2e `84/84`; unit `157/157`; coverage statements `90.19%`, branches `70.45%`, functions `91.51%`, lines `90.19%`).
  - `node bin/create-sentinelayer.js /omargate deep --path . --json` (`p1=0`, `p2=0`, `blocking=false`).
  - `node bin/create-sentinelayer.js /audit --path . --json` (`overallStatus=PASS`, `p1Total=0`, `p2Total=0`).
- [x] Push eighteenth-cycle fixes and continue Omar loop until PR #114 reaches `P2<=2`.
- [x] Push nineteenth-cycle workflow hardening (`237b9ce`) and run required gate watch sequence:
  - `gh run watch 23966066781 --exit-status` (Quality Gates: pass).
  - Approve `security-review` pending deployment for Omar run `23966066778`.
  - `gh run watch 23966066778 --exit-status` (Omar Gate: pass, `P0=0`, `P1=0`, `P2=9`).
- [x] Re-anchor remediation scope to latest Omar reviewer payload (`run_id=06975831-5845-4a29-98b4-a8df31fa9937`) and capture active `P2` set.
- [x] Twentieth-cycle hardening applied locally for active residual findings:
  - `scripts/ci/verify-action-shas.sh`: replace grep/sed YAML scraping with `yaml` parser traversal and fail-closed parse handling.
  - `src/auth/http.js`: Retry-After absolute-date fallback now uses `Date.now()` wall-clock basis (not monotonic-derived pseudo-epoch).
  - `src/auth/service.js`: localhost HTTP API endpoints now require explicit `SENTINELAYER_ALLOW_INSECURE_LOCAL_HTTP=true` and remain blocked when `CI=true`.
  - `src/config/schema.js`: add strict printable ASCII secret charset guard (`SL-CONFIG-SECRET-CHARSET`) before provider-shape validation.
  - `.github/workflows/omar-gate.yml`: broaden post-run secret-leak assertions from summary-only to workspace/artifact scan coverage.
  - `.github/workflows/release-please.yml`: add rollback-readiness freshness gate (successful rollback run + freshness window + artifact proof).
  - `.github/workflows/rollback.yml`: remove `repository_dispatch` trigger surface and keep manual/reusable/scheduled pathways.
  - `.github/workflows/release.yml`: replace rollback request dispatch with `gh workflow run rollback.yml`; add quality release-input lock enforcement and remove `execute_publish` toggle path.
  - `.github/workflows/quality-gates.yml`: emit `quality-release-input.lock.json` immutable promotion contract artifact.
  - `.github/workflows/release-publish.yml` (new): dedicated publish workflow consuming immutable verified release bundle.
  - Added/updated coverage in `tests/unit.auth-http.test.mjs`, `tests/unit.auth-service.test.mjs`, `tests/unit.config-security.test.mjs`, and `tests/e2e.test.mjs`.
- [x] Twentieth-cycle local evidence:
  - `npm run test:unit -- tests/unit.auth-http.test.mjs tests/unit.auth-service.test.mjs tests/unit.config-security.test.mjs` (pass).
  - `npm run verify` (pass, e2e `84/84`; unit `173/173`; coverage statements `90.21%`, branches `70.57%`, functions `91.54%`, lines `90.21%`).
- [x] Commit/push twentieth-cycle fixes (`8959d18`) and rerun Omar (`run_id=23966639262`): Omar reduced active findings to `P2=5` (`P0=0`, `P1=0`).
- [x] Re-anchor remediation scope to latest Omar reviewer payload (`run_id=3127a13a-ff18-4eab-9e46-dc9c0494b5fd`) and apply twenty-first-cycle hardening:
  - `.github/workflows/quality-gates.yml`: capture immutable `npm audit` evidence artifacts and enforce artifact integrity in downstream `build-artifact`.
  - `.github/workflows/release-publish.yml`: add explicit least-privilege job permissions to `publish-dry-run`, `authorize-production-publish`, and `publish`.
  - `.github/workflows/release.yml`: restore guarded `workflow_dispatch` `publish` input so manual production publishes remain deterministic and auditable.
  - `src/auth/service.js`: replace monotonic-time jitter coupling with per-login `pollJitterSeed` to avoid cross-process fallback correlation.
  - `tests/unit.auth-service.test.mjs`: add deterministic coverage proving distinct jitter seeds produce distinct cooldowns.
  - `src/config/schema.js`: add placeholder credential and token-diversity validation gates (`SL-CONFIG-SECRET-PLACEHOLDER`, `SL-CONFIG-SECRET-STRENGTH`).
  - `tests/unit.config-security.test.mjs`: add regression tests for placeholder/low-diversity rejection and update valid fixture to provider-shaped non-placeholder key.
- [x] Twenty-first-cycle local evidence:
  - `npm run test:unit -- tests/unit.auth-service.test.mjs tests/unit.config-security.test.mjs` (pass, `175/175`).
  - `npm run verify` (pass, e2e `84/84`; unit `175/175`; coverage statements `90.25%`, branches `70.60%`, functions `91.60%`, lines `90.25%`).
- [x] Commit/push twenty-first-cycle fixes (`1fd9172`) and rerun Omar (`run_id=c98684fd-5f63-4fc8-88ee-9ccaf7ca6ff4`): Omar reduced active findings to `P2=4` (`P0=0`, `P1=0`).
- [x] Re-anchor remediation scope to latest Omar reviewer payload (`run_id=c98684fd-5f63-4fc8-88ee-9ccaf7ca6ff4`) and apply twenty-second-cycle hardening:
  - `.github/workflows/quality-gates.yml`: harden audit evidence capture to fail on invalid exit/error payloads, record structured status metadata, and verify evidence contract + checksum before artifact promotion.
  - `.github/workflows/release.yml`: set release concurrency `cancel-in-progress: false` to prevent in-flight release validation aborts.
  - `.github/workflows/release-publish.yml`: migrate production publish path to OIDC trusted publishing (`id-token: write`) and remove `NPM_TOKEN` secret dependency.
  - `src/auth/session-store.js`: force plaintext token scrubbing migration whenever encrypted metadata is present and fail closed on residual plaintext token fields.
  - `tests/unit.auth-session-store.test.mjs`: add regression coverage proving plaintext token tamper data is scrubbed and never returned over ciphertext truth.
- [x] Twenty-second-cycle local evidence:
  - `npm run test:unit -- tests/unit.auth-session-store.test.mjs tests/unit.auth-service.test.mjs tests/unit.config-security.test.mjs` (pass, `176/176`).
  - `npm run verify` (pass, e2e `84/84`; unit `176/176`; coverage statements `90.25%`, branches `70.60%`, functions `91.60%`, lines `90.25%`).
- [x] Commit/push twenty-second-cycle fixes (`6f16dca`) and rerun Omar (`run_id=9b46220c-6992-490b-b874-fbfd3965e92f`): Omar regressed to `P2=6` (`P0=0`, `P1=0`) with new workflow-governance and auth-surface residuals.
- [x] Re-anchor remediation scope to latest Omar reviewer payload (`run_id=9b46220c-6992-490b-b874-fbfd3965e92f`) and apply twenty-third-cycle hardening:
  - `src/auth/http.js`: remove predictable process/time jitter fallback salt path, add CSPRNG fallback via `crypto.webcrypto.getRandomValues`, and fail closed on entropy unavailability.
  - `src/commands/auth.js`: constrain `--verbose-errors` detail emission to JSON output only (interactive terminal path remains safe-message only).
  - `.github/workflows/release-publish.yml`: add `workflow_run` trigger chaining from successful `Release` runs, require `break_glass=true` for manual dispatch, and resolve release tags deterministically from target commit.
  - `.github/workflows/release-publish.yml`: promote `prepare-release-bundle` and `publish-dry-run` into `release-management` protected environment.
  - `.github/workflows/quality-gates.yml`: add `security-events: write`, generate deterministic npm-audit SARIF summary, and upload SARIF via GitHub code-scanning API with fail-closed upload checks.
  - `.github/workflows/release.yml`: record release initiator identity and enforce dual-control by requiring at least one production approval identity distinct from the initiator.
- [x] Twenty-third-cycle local evidence:
  - `npm run test:unit -- tests/unit.auth-http.test.mjs tests/unit.auth-command-errors.test.mjs tests/unit.auth-session-store.test.mjs` (pass, `176/176`).
  - `npm run verify` (pass, e2e `84/84`; unit `176/176`; coverage statements `90.25%`, branches `70.60%`, functions `91.60%`, lines `90.25%`).
- [x] Commit/push twenty-third-cycle fixes and rerun Omar loop on PR #114 (`5be0118`, `5e83fec`; latest Omar run `db0b85ef-86b0-4b12-a9cc-02c4fb9d097a`, `P2=5`).
- [x] Re-anchor remediation scope to latest Omar reviewer payload (`run_id=db0b85ef-86b0-4b12-a9cc-02c4fb9d097a`) and apply twenty-fourth-cycle hardening:
  - `src/auth/service.js`: add local privileged-scope guardrails for `github_app_bridge` (explicit opt-in + interactive TTY + policy confirmation token `SENTINELAYER_PRIVILEGED_SCOPE_CONFIRM`), propagate env-aware scope validation through issue/rotation flows, and add monotonic `poll_sequence` replay rejection path.
  - `tests/unit.auth-service.test.mjs`: add coverage for non-increasing poll-sequence replay handling and privileged-scope runtime controls (interactive requirement + policy-confirmation requirement); keep privileged allow path validated with mocked TTY and consent token.
  - `.github/workflows/release-publish.yml`: force `workflow_dispatch` into dry-run mode and block production publish jobs unless trigger is `workflow_run`.
  - `.github/workflows/rollback.yml`: emit rollback lineage execute-path booleans (`executeMode`, `productionGateVerified`, `npmMutationPathVerified`) and maintain freshness timestamp updates in final summary stage.
  - `.github/workflows/release-please.yml`: rollback freshness gate now requires fresh execute-mode rollback lineage artifacts with all execute/mutation proof booleans true.
  - `.github/workflows/quality-gates.yml`: strengthen deploy lane with immutable deploy-stage proof validation, rollback-drill freshness linkage, npm canary health checks, and uploaded deploy proof artifact.
- [x] Twenty-fourth-cycle local evidence:
  - `npm run test:unit -- tests/unit.auth-service.test.mjs` (pass, `182/182`).
  - `npm run verify` (pass, e2e `84/84`; unit `182/182`; coverage statements `90.21%`, branches `70.58%`, functions `91.63%`, lines `90.21%`).
- [x] Commit/push twenty-fourth-cycle fixes (`589d3dc`, `275e272`, `7dae800`) and rerun Omar (`run_id=1194e434-7ed7-49ce-b8e6-873b588c62d7`): Omar remained non-blocking at `P2=6` (`P0=0`, `P1=0`) with residual findings in gate threshold overrides, request-id sanitization, break-glass execute path, sleep abort cleanup, workflow permissions policy assertions, and release artifact handoff contract outputs.
- [x] Re-anchor remediation scope to latest Omar reviewer payload (`run_id=1194e434-7ed7-49ce-b8e6-873b588c62d7`) and apply twenty-fifth-cycle hardening:
  - `.github/workflows/omar-gate.yml`: add protected-branch gate-policy resolver forcing `severity_gate=P1` on default-branch protected refs and route all threshold enforcement through resolved policy outputs.
  - `src/auth/http.js`: sanitize backend `request_id` / `requestId` values with strict charset + length policy and apply identical sanitization in `SentinelayerApiError` for defense in depth.
  - `tests/unit.auth-http.test.mjs`: add tainted-request-id regression coverage asserting invalid identifiers are rejected (`requestId=null`).
  - `src/auth/service.js`: replace custom abort/timer Promise in `sleepWithAbortSignal` with `timers/promises` signal-aware sleep and canonical `AbortError -> CLI_AUTH_ABORTED` mapping.
  - `tests/unit.auth-service.test.mjs`: add cancellation regression coverage proving aborted poll wait resolves to `CLI_AUTH_ABORTED` (`499`).
  - `.github/workflows/quality-gates.yml`: add explicit workflow permissions policy enforcement step in `lint`, declare `quality-summary` least-privilege permissions, and wire shared policy checker into local `npm run check` contract.
  - `scripts/ci/verify-workflow-permissions.js` + `package.json`: new YAML-structural policy checker ensuring explicit top-level + per-job permissions with allowlisted scopes/values.
  - `.github/workflows/release-publish.yml`: restore guarded break-glass execute path for `workflow_dispatch` (`break_glass=true`, admin/maintain actor, validated `incident_id`), emit immutable dispatch evidence artifact, and allow production publish only for execute-mode dispatches or provenance-anchored `workflow_run` triggers.
  - `.github/workflows/release.yml`: add explicit preflight immutable artifact contract outputs (`artifact_name`, digests, commit/run provenance) and require publish-path lineage checks to match those outputs before any npm mutation.
- [x] Twenty-fifth-cycle local evidence:
  - `npm run check` (pass).
  - `npm run test:unit -- tests/unit.auth-http.test.mjs tests/unit.auth-service.test.mjs` (pass, `184/184`).
  - `npm run verify` (pass, e2e `84/84`; unit `184/184`; coverage statements `90.21%`, branches `70.58%`, functions `91.63%`, lines `90.21%`).
- [x] Commit/push twenty-fifth-cycle fixes (`5247376`) and rerun full gate loop:
  - `gh run watch 23969294998 --exit-status` (Quality Gates: pass).
  - Approve `security-review` pending deployment for Omar run `23969294996`.
  - `gh run watch 23969294996 --exit-status` (Omar Gate: pass, `P0=0`, `P1=0`, `P2=4`, `run_id=552453eb-ec45-46a5-b5af-4ab30619bdff`).
- [x] Re-anchor remediation scope to latest Omar reviewer payload (`run_id=552453eb-ec45-46a5-b5af-4ab30619bdff`) and apply twenty-sixth-cycle hardening:
  - `scripts/ci/verify-workflow-permissions.js`: migrate from schema-only checks to policy-map enforcement (`required` + `max`) with per-job least-privilege validation and fail-closed drift detection.
  - `.github/security/workflow-permissions-policy.json`: add checked-in workflow/job permission contract for `quality-gates`, `omar-gate`, `release`, `release-publish`, and `rollback` workflows.
  - `.github/workflows/quality-gates.yml`: replace regex/string deploy-chain contract assertion with structural YAML graph validator; expand permission-policy enforcement to all release-critical workflows.
  - `scripts/ci/verify-quality-gate-graph.js`: new structural DAG validator for required deploy promotion chain (`deploy-readiness -> deploy-stage -> deploy -> quality-summary`).
  - `.github/workflows/release.yml`: remove `workflow_dispatch` `publish` input (validation-only dispatch), and add explicit permissions for previously unscoped jobs (`resolve-release-flags`, `rollback-readiness`, `authorize-production-publish`, `publish`).
  - `.github/workflows/release-publish.yml`: require `workflow_dispatch` `release_run_id` and bind manual dispatch to an exact successful `release.yml` run whose `head_sha` matches the requested `release_tag` commit.
  - `.github/workflows/rollback.yml`: add explicit least-privilege job permissions to `rollback` and `rollback-readiness-drill` for policy conformance.
  - `package.json`: wire `verify-quality-gate-graph` and multi-workflow permission policy checks into `npm run check` for local/CI parity.
- [x] Twenty-sixth-cycle local evidence:
  - `npm run check` (pass).
  - `npm run verify` (pass, e2e `84/84`; unit `184/184`; coverage statements `90.21%`, branches `70.58%`, functions `91.63%`, lines `90.21%`).
- [x] Commit/push twenty-sixth-cycle fixes (`9d805d4`) and rerun Omar loop on PR #114 (`gh run watch 23969662889 --exit-status`): failed early in `Lint` because `verify-quality-gate-graph` depended on `yaml` before `npm ci`.
- [x] Apply corrective gate-order hotfix: in `.github/workflows/quality-gates.yml` run `Assert deploy gate-chain contract is present` after `Setup Node` + `Install dependencies (lockfile immutable)`; local `npm run check` passes.
- [ ] Commit/push corrective hotfix and rerun full gate loop (Quality Gates watch + Omar Gate watch/approval) until `P2<=2`.
