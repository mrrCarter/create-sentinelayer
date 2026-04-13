# Sentinelayer CLI Roadmap PR Preparation (2026-03-31)

## Mission
Execute `SENTINELAYER_CLI_ROADMAP.md` as secure, merge-safe PR batches using `SWE_excellence_framework.md` gates and `.claude/CLAUDE.md` autonomous loop discipline.

## Execution Board (2026-04-10: Omar-Only + Admin/API Error Burn-Down)
- [ ] `PR-CLI-OMAR-ONLY` (`hardening/cli-omar-only-ci`): remove non-Omar security workflows (`semgrep`, `gitleaks`, `iac`, `sca`, `license`, `sbom`) and align required-check contracts to Omar + quality/build checks only.
- [ ] `PR-API-OMAR-ONLY` (`hardening/api-omar-only`): remove/disable multi-agent watchdog comment workflow and keep `omar-gate.yml` as the single security review path.
- [ ] `PR-API-ERROR-BATCH` (`fix/api-admin-error-batch`): stream current admin/API error surfaces (workflow failures + runtime/admin stream integration), reproduce each issue, and patch in one grouped PR.
- [ ] `PR-WEB-ERROR-BATCH` (`fix/web-admin-error-batch`) if needed: patch dashboard/admin error-stream handling regressions discovered during API burn-down.
- [ ] For each PR: run local verification, open PR, run Omar loop (`gh run watch`), resolve P0-P2 in batches, merge only after green required checks.
- [ ] Document resolved errors, evidence commands, and residual risk in this file review section before closing the batch.
- [ ] `PR-CLI-OMAR-ONLY` P2 remediation (current Omar run 24319174224): align Omar severity defaults, fail-closed fork enforcement, bind release canary to tag publish, remove gitleaks suppressions by eliminating secret-like fixtures, move file-key storage away from credentials file (with legacy migration), rerun Omar Gate and merge only on clean P0-P2.

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

## PR AppSec E2E 02 Working Plan (2026-04-05)
- [x] Create Semgrep CI workflow with pinned action/runtime and deterministic local custom rules.
- [x] Add custom Semgrep ruleset for high-risk JavaScript/Node anti-patterns (eval/new Function/weak crypto/destructive command interpolation).
- [x] Add Semgrep summary job and enforce `Semgrep Summary` in release required-check verification.
- [x] Update docs/roadmap evidence with Semgrep gate scope and execution proof.
- [x] Run `npm run verify`, open PR, run Omar Gate loop (`gh run watch`), and merge only after required checks pass.

## PR AppSec E2E 03 Working Plan (2026-04-05)
- [x] Create gitleaks CI workflow with deterministic PR-range scan and artifact output.
- [x] Add `Gitleaks Summary` job and enforce it in release required-check verification.
- [x] Update release docs to include gitleaks gate coverage.
- [x] Run `npm run verify`, open PR, run Omar Gate loop (`gh run watch`), and merge only after required checks pass.

## PR AppSec E2E 04 Working Plan (2026-04-05)
- [x] Create IaC scan workflow using deterministic Trivy config scan for workflow/infra targets.
- [x] Add `IaC Summary` job and enforce it in release required-check verification.
- [x] Update release docs and CTO revalidation execution notes for IaC gate coverage.
- [x] Run `npm run verify`, open PR, run Omar Gate loop (`gh run watch`), and merge only after required checks pass.

## PR AppSec E2E 05 Working Plan (2026-04-05)
- [x] Resolve known dependency vulnerability exposure (`yaml` stack-overflow advisory) by updating to patched version.
- [x] Add SCA policy workflow with deterministic `npm audit` artifact output and moderate+ gate.
- [x] Add `SCA Summary` required check into release pre-publish gate enforcement.
- [x] Update release docs and CTO execution evidence for SCA coverage.
- [x] Run `npm run verify`, open PR, run Omar Gate loop (`gh run watch`), and merge only after required checks pass.

## PR AppSec E2E 06 Working Plan (2026-04-05)
- [x] Add deterministic production dependency license inventory workflow.
- [x] Enforce allowlisted OSS license policy from `.github/policies/license-policy.json`.
- [x] Add `License Summary` to release pre-publish required checks.
- [x] Update release docs and CTO execution evidence for license governance.
- [x] Run `npm run verify`, open PR, run Omar Gate loop (`gh run watch`), and merge only after required checks pass.

## PR AppSec E2E 07 Working Plan (2026-04-05)
- [x] Add deterministic Dependabot governance policy file and CI workflow.
- [x] Classify Dependabot updates by semver risk and enforce auto-merge eligibility rules.
- [x] Apply governance labels/comments and enable auto-merge only for low-risk updates.
- [x] Update docs and CTO execution evidence for dependency governance coverage.
- [x] Run `npm run verify`, open PR, run Omar Gate loop (`gh run watch`), and merge only after required checks pass.

## PR AppSec E2E 08 Working Plan (2026-04-05)
- [x] Add deterministic SBOM generation workflow for both CycloneDX and SPDX JSON outputs.
- [x] Emit SBOM hash-manifest artifact and enforce generation success in CI.
- [x] Add `SBOM Summary` to release pre-publish required checks.
- [x] Update docs and CTO execution evidence for SBOM governance coverage.
- [x] Run `npm run verify`, open PR, run Omar Gate loop (`gh run watch`), and merge only after required checks pass.

## PR AppSec E2E 09 Working Plan (2026-04-05)
- [x] Add deterministic build attestation workflow for release tarball artifacts.
- [x] Verify generated attestations in CI with explicit signer-workflow policy.
- [x] Add `Attestation Summary` to release pre-publish required checks.
- [x] Update docs and CTO execution evidence for attestation governance coverage.
- [x] Run `npm run verify`, open PR, run Omar Gate loop (`gh run watch`), and merge only after required checks pass.

## PR AppSec E2E 10 Working Plan (2026-04-05)
- [x] Enforce release-artifact checksum manifest validation before publish.
- [x] Generate and verify release-workflow attestation policy at publish time.
- [x] Update docs and CTO execution evidence for release provenance enforcement.
- [x] Run `npm run verify`, open PR, run Omar Gate loop (`gh run watch`), and merge only after required checks pass.

## PR AppSec E2E 11 Working Plan (2026-04-05)
- [x] Add AST parser layer for JS/TS and Python import extraction with deterministic regex fallback.
- [x] Integrate AST parser stats into hybrid mapper strategy/summary/event artifacts.
- [x] Add unit coverage for AST parser layer and hybrid mapper AST path.
- [x] Run `npm run verify`, open PR, run Omar Gate loop (`gh run watch`), and merge only after required checks pass.

## PR AppSec E2E 12 Working Plan (2026-04-05)
- [x] Add AST-backed callgraph overlay layer for scoped JS/TS/Python files with deterministic fallback.
- [x] Integrate callgraph overlay nodes/edges + parser stats into hybrid mapper artifacts and event summaries.
- [x] Add unit tests for callgraph parser module and hybrid mapper callgraph integration path.
- [x] Run `npm run verify`, open PR, run Omar Gate loop (`gh run watch`), and merge only after required checks pass.

## PR AppSec E2E 13 Working Plan (2026-04-05)
- [x] Add deterministic hybrid handoff package builder from map artifacts with bounded path lists + budget hints.
- [x] Expose handoff command surfaces (`daemon map handoff|handoff-list|handoff-show`) for reproducible downstream assignment context.
- [x] Add unit + e2e coverage for handoff artifact generation and retrieval.
- [ ] Run `npm run verify`, open PR, run Omar Gate loop (`gh run watch`), and merge only after required checks pass.

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
- [x] Phase 2: add low-latency interactive chat mode with streaming progress UX (AWS/GH CLI style) while preserving deterministic command mode.
- [x] Phase 4: complete persistent session lifecycle (auto-rotate, session listing/resume metadata, revocation controls).
- [x] Phase 5: define plugin/template/policy extension API boundaries and load-order governance.
- [x] Phase 6: implement MCP tool registry schema + adapter contracts (including AIdenID provisioning adapter).
- [x] Phase 9: expand watch + review into full OMAR local reviewer pipeline with deterministic diff/full scan modes.
- [x] Phase 10: add multi-agent audit swarm orchestration and reconciliation report packaging.
- [x] Phase 11: expose AIdenID operations through CLI command surface (including `sl ai ...` alias plan and policy gating).
- [x] Phase 12: implement governed QA swarm runtime/dashboard with explicit token/time/tool/path/network budgets and kill/quarantine controls.

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
- [x] PR 107 command lazy-loading.

### Batch U - Scaffold and Spec Feedback Fixes (2026-04-03)
- [x] PR 137 frictionless secret setup + workflow unification (`.env` gitignore guard, repo-aware `scan init` instructions, `gh secret` verify).
- [x] PR 138 deterministic IDE/agent dictionary + per-agent scaffold config.
- [x] PR 139 project-type-aware spec generation + dynamic phase planning.
- [x] PR 140 spec-bound pre-commit review drift checks.

### Batch V - Memory and Watchdog Feedback Fixes (2026-04-03)
- [x] PR 141 shared local blackboard memory with retrieval quality gate.
- [x] PR 142 local hybrid retrieval index (deterministic + TF-IDF) with optional API delegation hook.
- [x] PR 143 daemon watchdog stuck-agent detection + Slack/Telegram alerts.
- [x] PR 144 ingest staleness refresh and hash-aware cache controls.

### Batch W - Omar Workflow Security Burn-Down (2026-04-04)
- [x] PR 145 release/release-please/omar workflow hardening (pinned actions, concurrency guards, fail-closed publish path, stricter Omar dispatch thresholds).
- [x] PR 146 immutable release artifact promotion + gate-proof checks + exact dependency pinning.

### Batch X - Agent Tool Security Hardening (2026-04-04)
- [x] PR 147 symlink + UNC + device-path guardrails for Jules `FileRead`/`FileEdit` tools (realpath-aware root validation, Windows-safe path-prefix checks, deterministic failure codes).
- [x] PR 148 subprocess env scrub expansion + shell guardrail coverage for Jules `Shell` tool.
- [x] PR 149 network domain-allowlist guardrails for shell-based fetch commands.
- [ ] PR 150 centralize shell network allowlist policy in config schema and command-level governance.

### PR 147 Working Plan (roadmap/pr-147-auth-runtime-governance-hardening)
- [x] Add shared path-guard utility for Jules file tools:
  - Canonicalize original path + resolved realpath.
  - Reject UNC/network paths and OS device paths.
  - Enforce allowed-root containment using boundary-safe path checks.
- [x] Wire guard utility into `file-read` and `file-edit` so both read/write operations use identical enforcement rules.
- [x] Expand `tests/unit.jules-tools.test.mjs` with security regressions:
  - UNC path rejection coverage for `fileRead` and `fileEdit`.
  - Symlink escape rejection when resolved target leaves allowed root.
  - Prefix-collision defense (`<root>` vs `<root>-evil`) for allowed-root checks.
- [x] Run Omar Gate PR loop (`gh run watch`) and merge only after `Omar Gate` + required checks pass.

### PR 148 Working Plan (roadmap/pr-148-shell-subprocess-guardrail-expansion)
- [x] Expand `Shell` env scrubbing to cover broader secret/token keyspace (exact sensitive keys + deterministic suffix/prefix patterns + `INPUT_` variants).
- [x] Keep runtime-safe env keys intact while applying fail-closed stripping to sensitive keys only.
- [x] Add unit coverage for shell scrubbing behavior:
  - Explicit key removal (`OPENAI_API_KEY`, `GH_TOKEN`, etc.).
  - Pattern-based removal (`*_TOKEN`, `*_API_KEY`, `*_SECRET`, `*_PRIVATE_KEY`).
  - Confirm non-sensitive keys remain available to subprocess execution.
- [x] Run Omar Gate loop (`gh run watch`) and merge only after required checks pass.

### PR 149 Working Plan (roadmap/pr-149-shell-network-domain-allowlist)
- [x] Add deterministic host extraction for shell network commands (`curl`/`wget`) and evaluate hostnames against an allowlist.
- [x] Add config/env-driven allowlist sources with secure defaults:
  - `SENTINELAYER_ALLOWED_FETCH_HOSTS` comma-separated override.
  - Built-in safe domains for core package tooling and GitHub workflows.
- [x] Enforce domain allowlist at shell execution time:
  - Block network commands targeting non-allowlisted hosts.
  - Keep non-network shell commands unaffected.
- [x] Add unit tests for allowed and blocked domains, plus wildcard/suffix matching boundaries.
- [x] Run Omar Gate loop (`gh run watch`) and merge only after required checks pass.

### PR 150 Working Plan (roadmap/pr-150-close-pr96-supersede)
- [x] Close PR #96 as superseded — P2 fixes already landed in PRs #182-185.
- [x] Verify main has zero P0/P1 findings (11 P2 work-item markers remain, non-blocking).
- [x] Update todo.md with demo-focused PR queue (PRs 150-155).
- [ ] Run Omar Gate loop (`gh run watch`) and merge only after required checks pass.

## Execution Board (2026-04-07)

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

### Exact Next PR Branch Order
1. `roadmap/pr-150-close-pr96-supersede` — Close stale PR #96 (superseded by #182-185)
2. `roadmap/pr-151-ai-identity-provision-alias` — Add `sl ai identity provision` alias
3. `roadmap/pr-152-mcp-list-command` — Add `sl mcp list` convenience command
4. `roadmap/pr-153-scan-setup-secrets` — Add `sl scan setup-secrets` command
5. `roadmap/pr-154-code-scaffold-templates` — Express.js starter template + scaffold generator
6. `roadmap/pr-155-readme-generation` — Add README.md generation to scaffold

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

  - PR 137 (frictionless secret setup + workflow unification) local evidence (branch `roadmap/pr-137-frictionless-secret-setup`):
    - `npm run verify` (pass, e2e `84/84`; unit tests `163/163`; coverage statements `90.12%`, branches `70.26%`, functions `91.30%`, lines `90.12%`)
    - `node bin/create-sentinelayer.js /omargate deep --path . --json` (`p1=0`, `p2=10`, `blocking=false`)
    - `node bin/create-sentinelayer.js /audit --path . --json` (`overallStatus=PASS`, `p1Total=0`, `p2Total=10`)
    - `scan init` now defaults to `.github/workflows/omar-gate.yml`, updates existing legacy `security-review.yml` when present, and emits repo-aware `gh secret set/list` instructions with the docs fallback URL.
    - Managed scaffold mode now ensures `.env` is ignored in `.gitignore` before writing tokens and verifies `gh secret set` by checking `gh secret list` output.

  - PR 138 (deterministic coding-agent/IDE dictionary and scaffold wiring) local evidence (branch `roadmap/pr-138-agent-dictionary-deterministic`):
    - `npm run verify` (pass, e2e `84/84`; unit tests `166/166`; coverage statements `90.12%`, branches `70.26%`, functions `91.30%`, lines `90.12%`)
    - `node bin/create-sentinelayer.js /omargate deep --path . --json` (`p1=0`, `p2=10`, `blocking=false`)
    - `node bin/create-sentinelayer.js /audit --path . --json` (`overallStatus=PASS`, `p1Total=0`, `p2Total=10`)
    - Added `src/config/agent-dictionary.js` with deterministic top-10 coding-agent mapping (`promptTarget`, config path) and IDE detection (`cursor` vs `vscode` via `CURSOR_TRACE_ID` precedence).
    - Scaffold interview now captures `codingAgent`, generates agent-specific handoff tuning, writes supported agent config files when absent (for example `.cursorrules`), and reports detected IDE in auth session startup payload.

  - PR 139 (project-type-aware spec generation + dynamic phase planning) local evidence (branch `roadmap/pr-139-spec-dynamic-phases`):
    - `npm run verify` (pass, e2e `84/84`; unit tests `168/168`; coverage statements `90.18%`, branches `70.50%`, functions `91.37%`, lines `90.18%`)
    - `node bin/create-sentinelayer.js /omargate deep --path . --json` (`p1=0`, `p2=10`, `blocking=false`)
    - `node bin/create-sentinelayer.js /audit --path . --json` (`overallStatus=PASS`, `p1Total=0`, `p2Total=10`)
    - Replaced fixed 3-phase `SPEC.md` generation with dynamic phase derivation (3-8 phases) based on project type, ingest risk surfaces, and scope complexity.
    - Added deterministic project-type resolution (`greenfield|add_feature|bugfix`) across `spec generate|regenerate`, including `--project-type` override, ingest/description inference, and persisted project-type metadata in the spec snapshot.
    - Updated scaffold interview normalization so existing-repo runs default to `add_feature` when `projectType` is omitted, preventing accidental greenfield payloads in non-interactive clone workflows.

  - PR 140 (spec-bound pre-commit review drift checks) local evidence (branch `roadmap/pr-140-spec-bound-review`):
    - `npm run verify` (pass, e2e `85/85`; unit tests `172/172`; coverage statements `90.18%`, branches `70.50%`, functions `91.37%`, lines `90.18%`)
    - `node bin/create-sentinelayer.js /omargate deep --path . --json` (`p1=0`, `p2=10`, `blocking=false`)
    - `node bin/create-sentinelayer.js /audit --path . --json` (`overallStatus=PASS`, `p1Total=0`, `p2Total=10`)
    - Added a deterministic spec-binding review layer (`src/review/spec-binding.js`) that enforces `SL-SPEC-001` (scope drift) and `SL-SPEC-002` (spec coverage gaps) for diff/staged pre-commit paths.
    - Wired `--spec <path>` through `review`, `review scan`, and `review replay`, and persisted spec-path/hash context into deterministic output payloads and run-context artifacts.
    - Extended AI review prompts with spec context (path/hash/endpoints/acceptance counts), and aligned unified report spec hashing with explicit `--spec` overrides for reproducible reconciliation.

  - PR 141 (shared local blackboard memory with retrieval quality gate) local evidence (branch `roadmap/pr-141-shared-memory-blackboard`):
    - `npm run verify` (pass, e2e `85/85`; unit tests `174/174`; coverage statements `90.18%`, branches `70.50%`, functions `91.37%`, lines `90.18%`)
    - `node bin/create-sentinelayer.js /omargate deep --path . --json` (`p1=0`, `p2=10`, `blocking=false`)
    - `node bin/create-sentinelayer.js /audit --path . --json` (`overallStatus=PASS`, `p1Total=0`, `p2Total=10`)
    - Added `src/memory/blackboard.js` for deterministic append/query/persist flows and 8-needle recall benchmarking (`>=95%` gate in unit tests).
    - Wired audit orchestration to seed baseline findings into blackboard, read scoped shared context per agent, append specialist findings, and persist `.sentinelayer/memory/blackboard-<runId>.json`.
    - Extended `audit` command outputs and report artifacts with shared-memory metadata (`sharedMemoryPath`, entry/query counts) for reproducible cross-agent context lineage.

  - PR 142 (local hybrid retrieval index with optional API delegation) local evidence (branch `roadmap/pr-142-hybrid-retrieval-index`):
    - `npm run verify` (pass, e2e `85/85`; unit tests `177/177`; coverage statements `90.18%`, branches `70.50%`, functions `91.37%`, lines `90.18%`)
    - `node bin/create-sentinelayer.js /omargate deep --path . --json` (`p1=0`, `p2=10`, `blocking=false`)
    - `node bin/create-sentinelayer.js /audit --path . --json` (`overallStatus=PASS`, `p1Total=0`, `p2Total=10`)
    - Added `src/memory/retrieval.js` with local hybrid retrieval scoring (`exact + token overlap + TF-IDF cosine + recency + severity`) and optional API delegation that fails closed to local results.
    - Added corpus ingestion for shared memory (`ingest summary`, `risk surfaces`, historical audit reports/findings, and `SPEC.md/docs/spec.md` when present).
    - Wired audit orchestrator to query hybrid memory per agent and persist provider/query metadata in `report.sharedMemory.retrieval`.

  - PR 143 (daemon watchdog stuck-agent detection + alert channels) local evidence (branch `roadmap/pr-143-daemon-watchdog-alerts`):
    - `npm run verify` (pass, e2e `85/85`; unit tests `179/179`; coverage statements `90.22%`, branches `70.86%`, functions `91.37%`, lines `90.22%`)
    - `node bin/create-sentinelayer.js /omargate deep --path . --json` (`p1=0`, `p2=10`, `blocking=false`)
    - `node bin/create-sentinelayer.js /audit --path . --json` (`overallStatus=PASS`, `p1Total=0`, `p2Total=10`)
    - Added `src/daemon/watchdog.js` plus `daemon watchdog`, `daemon watchdog run`, and `daemon watchdog status` command surfaces with deterministic artifact storage and smart state-change alerting.
    - Added Slack/Telegram channel normalization with env-template support, dry-run dispatch records, and state-transition recovery signaling.
    - Fixed Omar P1 finding by replacing nested await dispatch loops with batched `Promise.all` alert fan-out.

  - PR 144 (ingest staleness refresh + hash-aware cache controls) merged evidence (branch `roadmap/pr-144-ingest-refresh-staleness`):
    - `npm run verify` (pass)
    - `gh pr checks 123` (all required checks passed, including `Omar Gate`, `Quality Gates`, and `Eval Impact Gate`)
    - `gh pr view 123 --json state,mergedAt,mergeCommit` (`state=MERGED`, merge commit `f9273af2fca97d612a7ea1019d4e60ba950689a5`)
    - Added staleness-aware ingest resolver/hash metadata and `--refresh` flow across `review`, `audit`, `spec`, and `prompt` commands with refresh metadata persisted in artifacts/reports.

  - PR 107 (command lazy-loading) merged evidence (branch `roadmap/pr-107-command-lazy-loading`):
    - `npm run verify` (pass, e2e `86/86`; unit tests `182/182`; coverage statements `90.22%`, branches `70.98%`, functions `92.03%`, lines `90.22%`)
    - `node bin/create-sentinelayer.js /omargate deep --path . --json` (`p1=0`, `p2=10`, `blocking=false`)
    - `node bin/create-sentinelayer.js /audit --path . --json` (`overallStatus=PASS`, `p1Total=0`, `p2Total=10`)
    - `gh run watch 23988615495 --exit-status` (Omar Gate pass; no P0/P1, reported `P2=8` and `P3=1134`)
    - `gh pr view 113 --json state,mergedAt,mergeCommit` (`state=MERGED`, merge commit `642ce48517cdfc4c6068a27ff8929bc0d3bd5c48`)
    - Replaced eager command imports in `src/cli.js` with dynamic registrar loaders and command-scoped registration to reduce startup load while preserving command contracts.

  - PR 145 (workflow + auth poll hardening) merged evidence (branch `roadmap/pr-145-release-pipeline-hardening`):
    - `npm run verify` (pass, e2e `86/86`; unit tests `184/184`; coverage statements `90.22%`, branches `70.98%`, functions `92.03%`, lines `90.22%`)
    - `node bin/create-sentinelayer.js /omargate deep --path . --json` (`p1=0`, `p2=10`, `blocking=false`)
    - `node bin/create-sentinelayer.js /audit --path . --json` (`overallStatus=PASS`, `p1Total=0`, `p2Total=10`)
    - `gh run watch 23989238721 --exit-status` (Omar Gate pass after `security-review` deployment approval)
    - `gh pr view 125 --json state,mergedAt,mergeCommit` (`state=MERGED`, merge commit `cfd1fa24d1ee0cb4fd571b347a74ff21efabed34`)
    - Hardened release workflows with pinned action SHAs, concurrency/timeout controls, fail-closed publish credentials check, OIDC provenance publish flag, and `--ignore-scripts` install paths.
    - Hardened auth login polling to tolerate transient transport/server faults and fail fast on terminal rejection/expiry states with deterministic error codes.

  - PR 146 (immutable release artifact promotion + dependency pinning) merged evidence (branch `roadmap/pr-146-release-artifact-promotion-hardening`):
    - `npm run verify` (pass, e2e `86/86`; unit tests `184/184`; coverage statements `90.22%`, branches `70.98%`, functions `92.03%`, lines `90.22%`)
    - `node bin/create-sentinelayer.js /omargate deep --path . --json` (`p1=0`, `p2=10`, `blocking=false`)
    - `node bin/create-sentinelayer.js /audit --path . --json` (`overallStatus=PASS`, `p1Total=0`, `p2Total=10`)
    - `gh run watch 23989413005 --exit-status` (Omar Gate pass after `security-review` deployment approval)
    - `gh pr view 127 --json state,mergedAt,mergeCommit` (`state=MERGED`, merge commit `f7643749382d90fb137d6fb397657555d9b13895`)
    - Refactored release workflow to promote a single immutable tarball artifact from a dedicated build job into publish job (no rebuild during publish).
    - Added commit-level gate proof checks (`Quality Summary` + `Omar Gate`) before release publish, and pinned dependency specs in `package.json` with lockfile alignment.

  - PR 147 (Jules file-tool path guardrails) merged evidence (branch `roadmap/pr-147-auth-runtime-governance-hardening`):
    - `npm run verify` (pass, e2e `86/86`; unit tests `188/188`; coverage statements `90.22%`, branches `70.98%`, functions `92.03%`, lines `90.22%`)
    - `node bin/create-sentinelayer.js /omargate deep --path . --json` (`p1=0`, `p2=10`, `blocking=false`)
    - `node bin/create-sentinelayer.js /audit --path . --json` (`overallStatus=PASS`, `p1Total=0`, `p2Total=10`)
    - `gh run watch 23989969491 --exit-status` (Omar Gate pass after `security-review` deployment approval)
    - `gh pr view 129 --json state,mergedAt,mergeCommit` (`state=MERGED`, merge commit `d135ebfc8bdd8ed0d286cdaa0f8b444402c814d0`)
    - Added shared path guard utility for Jules tools with deterministic `PATH_*` failure codes, UNC/device namespace blocking, blocked-system path checks, and realpath-aware allowed-root enforcement.
    - Hardened both `FileRead` and `FileEdit` to use the same path-guard contract and added regression coverage for UNC rejection, symlink escape blocking, and sibling root-prefix collision attempts.

  - PR 148 (shell subprocess env scrub expansion) merged evidence (branch `roadmap/pr-148-shell-subprocess-guardrail-expansion`):
    - `npm run verify` (pass, e2e `86/86`; unit tests `189/189`; coverage statements `90.22%`, branches `70.98%`, functions `92.03%`, lines `90.22%`)
    - `node bin/create-sentinelayer.js /omargate deep --path . --json` (`p1=0`, `p2=10`, `blocking=false`)
    - `node bin/create-sentinelayer.js /audit --path . --json` (`overallStatus=PASS`, `p1Total=0`, `p2Total=10`)
    - `gh run watch 23990135795 --exit-status` (Omar Gate pass after `security-review` deployment approval)
    - `gh pr view 131 --json state,mergedAt,mergeCommit` (`state=MERGED`, merge commit `5169881704a998a4da30c36a37a8f41a210c3a6f`)
    - Expanded subprocess secret scrubbing from fixed key deletes to deterministic exact-key + prefix/suffix pattern matching, including `INPUT_` action variants.
    - Added shell coverage asserting both scrubbing logic correctness and runtime subprocess behavior (sensitive keys removed, safe keys preserved).

  - PR 149 (shell network domain allowlist) merged evidence (branch `roadmap/pr-149-shell-network-domain-allowlist`):
    - `npm run verify` (pass, e2e `86/86`; unit tests `193/193`; coverage statements `90.22%`, branches `70.98%`, functions `92.03%`, lines `90.22%`)
    - `node bin/create-sentinelayer.js /omargate deep --path . --json` (`p1=0`, `p2=10`, `blocking=false`)
    - `node bin/create-sentinelayer.js /audit --path . --json` (`overallStatus=PASS`, `p1Total=0`, `p2Total=10`)
    - `gh run watch 23990276072 --exit-status` (Omar Gate pass after `security-review` deployment approval)
    - `gh pr view 133 --json state,mergedAt,mergeCommit` (`state=MERGED`, merge commit `9a5bb1d8d33a62b9dec46feac5358d2f564869aa`)
    - Added deterministic URL-host extraction + hostname policy checks for `curl`/`wget`, with bounded wildcard matching and secure default allowlist entries.
    - Enforced runtime blocking for non-allowlisted network hosts or missing explicit URL hosts, and added unit coverage for blocked/allowed/wildcard-boundary scenarios.

## 2026-04-05 - P1 Tightening Pass (Audit Revalidation)

- [x] Revalidate reported P1 findings on current `main` before remediation.
- [x] Harden `dependabot-governance.yml` metadata JSON generation against interpolation/injection by switching to `jq -n --arg`.
- [x] Add SHA256 integrity verification for downloaded `gitleaks` and `trivy` release artifacts before extraction/execution.
- [x] Fix `callgraph-overlay.js` member-expression handling for computed properties and remove dead ternary branch.
- [x] Replace undocumented callgraph fallback target cap with named deterministic constant + rationale comment.
- [x] Expand daemon parser/callgraph tests for Python AST success paths, class method resolution, computed member calls, and import edge-case deduplication.
- [x] Run verification suites for regression safety.

Review:
- Confirmed all four reported P1 items were valid and patched in this pass.
- Validation evidence:
  - `node --test tests/unit.daemon-ast-parser-layer.test.mjs tests/unit.daemon-callgraph-overlay.test.mjs` (pass: `11/11`)
  - `npm run test:unit` (pass: `306/306`)
  - `npm test` (pass: unit `306/306`, e2e `86/86`)
- Remaining known non-blocker from earlier audit still present and intentionally untouched in this pass: `FrontendAnalyze` ripgrep lookaround regex stderr noise (`check_accessibility` patterns).

## 2026-04-06 - CLI Rename + Docs/SEO Publish Prep

- [x] Rename publish-facing CLI identity from `create-sentinelayer` to `sentinelayer-cli` while preserving backwards-compatible aliases (`create-sentinelayer`, `sentinel`, `sl`).
- [x] Update release workflow/package metadata/tests to validate new package name and tarball behavior.
- [x] Update CLI README command/install docs to present `sentinelayer-cli` as primary distribution identity.
- [x] Run mandatory verification loop (`npm run verify`, local `/omargate` JSON, local `/audit` JSON) and capture evidence.
- [pending] Update Sentinelayer web docs/discovery surfaces (CLI pages, docs nav, llms.txt/sitemap generated assets) for SEO + indexability.
- [pending] Build web docs, validate generated outputs, and capture evidence.
- [pending] Commit and push `create-sentinelayer` + `sentinelayer-web` changes with clear rollout summary of shipping commands.

Review:
- `npm run verify` passed on branch `roadmap/pr168-cli-rename` (`e2e 86/86`, `unit 334/334`, coverage statements `90.56%`, functions `92.21%`, tarball `sentinelayer-cli-0.1.0.tgz`).
- `node bin/create-sentinelayer.js /omargate deep --path . --json` passed (`p1=0`, `p2=11`, `blocking=false`).
- `node bin/create-sentinelayer.js /audit --path . --json` passed (`overallStatus=PASS`, `p1Total=0`, `p2Total=11`, `blocking=false`).

## 2026-04-08 - AIdenID Async + Status Pass (Batch 1)

- [x] Fix async call-site regressions after `resolveAidenIdCredentials` became async (`provision-governance`, `identity-lifecycle`, `jules auth-audit`).
- [x] Harden lazy-fetch precedence: allow token-backed session fetch even when `session.aidenid` metadata is absent.
- [x] Restore auth status metadata surface: include `aidenid` on `resolveActiveAuthSession` and `getAuthStatus` responses.
- [x] Update unit tests for async credential resolution and add token-only lazy-fetch coverage.
- [x] Re-run targeted regression suites for changed surfaces.

Review:
- `node --test tests/unit.ai-aidenid.test.mjs` (pass: `10/10`)
- `node --test tests/unit.jules-auth-audit.test.mjs` (pass: `7/7`)
- `node --test tests/unit.auth-service.test.mjs` (pass: `5/5`)
- `npm run verify` currently fails in e2e baseline due auth-gate enforcement in this environment (many tests now require pre-seeded auth test context); `npm run check` stage passed.
- [x] CI unblock follow-up: restore workflow text contracts expected by e2e (`Omar Gate (BYOK Mode)` for BYOK scaffold, literal `scan_mode`/`severity_gate` in scan-init workflow output).
- [x] Add eval evidence artifact for AI-impacting file changes (`tasks/evals/pr-198-aidenid-async.md`).

CI follow-up review:
- `SENTINELAYER_CLI_SKIP_AUTH=1 npm run test:e2e` (pass: `89/89`)
- `npm run check` (pass)

## 2026-04-08 - Release Publish Provenance Fix (Batch R1)

- [x] Watch active `Release` run and capture the exact failing step/logs.
- [x] Confirm root cause from workflow logs (not assumptions).
- [x] Patch publish metadata mismatch causing npm provenance rejection.
- [x] Run local verification for changed files and workflow syntax.
- [x] Open PR and run full Omar Gate loop (`gh run watch` to completion).
- [x] Merge only after Omar + required checks pass.
- [x] Re-run `Release` workflow (`publish=true`) and confirm npm publish success.
- [x] Record post-merge evidence (workflow run IDs, npm version check, release status).

Review:
- PR `#202` merged (squash commit `bb3983f4828b262f751bca18ae9a70c15844bc4f`) after full gate pass.
- Omar Gate on PR `#202`: run `24113529206` passed (`P0=0`, `P1=0`).
- Required checks on merge commit were refreshed, including manual Omar Gate dispatch on `main`: run `24113605520` passed.
- Release publish retry run `24113648894` passed end-to-end (`build-release-artifact` + `publish`).
- npm registry verification after publish:
  - `npm view sentinelayer-cli version` -> `0.3.0`
  - `npm view sentinelayer-cli dist-tags --json` -> `{ "latest": "0.3.0" }`
- `npx -y sentinelayer-cli@latest --version` -> `0.3.0`
- Follow-up release-please PR `#203` (`chore(release): 0.3.1`) was Omar-reviewed (`24113740735`) and merged (squash commit `7b1f0b72fda3c0dcb1abef167f7b89f8523ec48d`), tagging `v0.3.1`.

## 2026-04-08 - Workflow Determinism Hardening (Batch R2)

- [x] Replace non-deterministic tarball selection (`ls | head`) with strict single-artifact assertions in release workflow.
- [x] Apply `npm ci --ignore-scripts` in all Quality Gates install jobs to tighten supply-chain execution.
- [x] Run local verification for changed workflow files.
- [x] Open PR and run Omar Gate + full required checks.
- [x] Merge after green and capture run evidence.

Review:
- PR `#205` merged (squash commit `996aa01ef600a1b10854a6f7ac73beb4204d6273`) with full required-check pass.
- Omar Gate on PR `#205`: run `24113961862` passed (`P0=0`, `P1=0`).
- Post-merge state: no open PRs in `create-sentinelayer`; release + quality lanes remain green on latest `main`.

## 2026-04-08 - Auth Transport + Gate Hardening (Batch P2-A1)

- [x] Add bounded retry/backoff policy for auth HTTP client (`requestJson`) on transient 408/425/429/5xx failures.
- [x] Add lightweight circuit breaker state for repeated transport/retryable failures with cooldown fail-fast.
- [x] Remove implicit `CI=true` auth bypass; keep explicit `SENTINELAYER_CLI_SKIP_AUTH=1` bypass only.
- [x] Add dedicated unit coverage for auth HTTP retry/circuit behavior and auth gate bypass semantics.
- [x] Run full local verification and deterministic local gate scans.
- [x] Open PR and run Omar Gate + required checks.
- [x] Merge after green and capture run evidence.

Review:
- PR `#207` merged (squash commit `a37e55facb10e6223d7f0816750493b293632ff6`) after full required-check pass.
- Omar Gate on PR `#207`: run `24115733566` passed (`P0=0`, `P1=0`).
- Required checks green on PR `#207` after e2e harness auth bypass fix (`tests/e2e.test.mjs`).
- Local verification before merge: `npm run verify` passed (`e2e 89/89`, `unit 359/359`, `coverage statements 90.07%`, `functions 91.64%`).

## 2026-04-08 - Omar P2 Hardening Sweep (Batch P2-A2)

- [x] Harden `release.yml` manual dispatch path to enforce deterministic main-only execution and tag-only publish.
- [x] Fix upstream gate check-run query logic to paginate and deterministically resolve latest completed required checks.
- [x] Harden `auth-audit` credential handling to avoid passing sensitive login credentials via child-process environment.
- [x] Tighten auth-flow header check redirect handling to avoid `curl -L` cross-origin header confusion.
- [x] Run `npm run verify` plus local deterministic gate commands (`/omargate deep`, `/audit`) and capture evidence.
- [x] Open PR and complete Omar Gate + required checks watch loop.
- [x] Merge after green and record run IDs/findings delta.

Review:
- PR `#209` merged (squash commit `4ec112b2d8a4d47423554850882622e5df276e26`) with all required checks green.
- Omar Gate on PR `#209`: run `24116194551` passed (`P0=0`, `P1=0`, `P2=13`).
- Local deterministic scans before merge: `/omargate deep` and `/audit` both `P1=0`, `P2=10`, `blocking=false`.

## 2026-04-08 - Omar P2 Burn-down Follow-up (Batch P2-A3)

- [x] Remove non-deterministic `npx` execution from `license-gate.yml` by pinning and invoking local lockfile toolchain.
- [x] Eliminate duplicate authenticated page navigation in `auth-audit` and reuse first response headers.
- [x] Strengthen release attestation binding by asserting attested subject digest matches manifest checksum.
- [x] Add explicit governance for manual release dispatch build path (approval or isolated non-attesting path).
- [ ] Evaluate Semgrep install determinism options and implement the safest low-risk improvement in this batch.
- [x] Run `npm run verify` plus local deterministic gate commands (`/omargate deep`, `/audit`) and capture evidence.
- [x] Open PR and complete Omar Gate + required checks watch loop.
- [x] Merge after green and record run IDs/findings delta.

Review:
- PR `#210` merged (squash commit `73735457e58ea30149a4d4ea1d20181925c1dd2c`) with all required checks green.
- Omar Gate on PR `#210`: run `24116410242` passed (`P0=0`, `P1=0`, `P2=14`).
- Local deterministic scans before merge: `/omargate deep` and `/audit` remained `P1=0`, `P2=10`, `blocking=false`.
- Semgrep integrity hash-pinning remains open; deferred to next batch to avoid destabilizing scanner runtime resolution.

## 2026-04-08 - Omar P2 Auth + Release Gate Follow-up (Batch P2-A4)

- [x] Replace `execFileSync(\"node\", ...)` with `execFileSync(process.execPath, ...)` in `auth-audit` to remove PATH hijack exposure.
- [x] Add explicit execute-path authorization guard for `provision_test_identity` in `auth-audit` (deny live provisioning unless explicitly approved).
- [x] Tighten release upstream gate policy by requiring `CodeQL Summary` success when release checks run.
- [x] Run `npm run verify` plus local deterministic gate commands (`/omargate deep`, `/audit`) and capture evidence.
- [x] Open PR and complete Omar Gate + required checks watch loop.
- [x] Merge after green and record run IDs/findings delta.

Review:
- PR `#211` merged (squash commit `2edb6ad60ec47fa1f42020661b54f5e10eef876d`) with all required checks green.
- Omar Gate on PR `#211`: run `24116591873` passed (`P0=0`, `P1=0`).
- Local deterministic scans before merge: `/omargate deep` and `/audit` remained `P1=0`, `P2=10`, `blocking=false`.

## 2026-04-08 - Omar P2 Semgrep Determinism Hardening (Batch P2-A5)

- [x] Add hash-locked Semgrep dependency manifest (`.github/policies/semgrep.in` + compiled `semgrep-requirements.txt`).
- [x] Update `.github/workflows/semgrep.yml` to install Semgrep via `pip --require-hashes` from the locked manifest.
- [x] Run `npm run verify` plus local deterministic gate commands (`/omargate deep`, `/audit`) and capture evidence.
- [x] Open PR and complete Omar Gate + required checks watch loop.
- [x] Merge after green and record run IDs/findings delta.

Review:
- PR `#212` merged (squash commit `fee18af8d0a7ad098b6cda94c1659a9bb056f03a`) with all required checks green.
- Omar Gate on PR `#212`: run `24116942389` passed (`P0=0`, `P1=0`).
- Semgrep workflow rerun details:
  - Initial run failed due `pkg_resources` import error after lock resolved `setuptools==82.0.1` (run `24116810653`).
  - Follow-up fix pinned `setuptools<81` in `.github/policies/semgrep.in`, regenerated hash lock, and reran successfully (`Semgrep` run `24116942397`).
- Local deterministic scans before merge: `/omargate deep` and `/audit` remained `P1=0`, `P2=10`, `blocking=false`.

## 2026-04-08 - Omar P2 Signal Cleanup (Batch P2-A6)

- [x] Add path-scoped exclusions for noisy generic P2 rules (hardcoded credential/work-item markers) in both scan engines (`legacy /omargate` + deterministic local review).
- [x] Keep high-signal P1 rules unchanged while suppressing test/fixture and self-rule-file false positives.
- [x] Run `npm run verify` plus local deterministic gate commands (`/omargate deep`, `/audit`) and capture evidence.
- [x] Open PR and complete Omar Gate + required checks watch loop.
- [x] Merge after green and record run IDs/findings delta.

Review:
- PR `#214` merged (squash commit `4847d533087750dcb473a88a35b050b424a93554`) with all required checks green.
- Omar Gate on PR `#214`: run `24117475972` passed (`P0=0`, `P1=0`, `P2=14`).
- Local deterministic scans before merge: `/omargate deep` and `/audit` improved to `P1=0`, `P2=0`, `blocking=false`.

## 2026-04-08 - Release Check-Identity Hardening (Batch P2-A7)

- [x] Validate latest Omar findings and scope the next deterministic P2 burn-down batch to release governance gaps.
- [x] Add reusable check-run verifier script that enforces required checks by both check name and check app identity.
- [x] Wire release tag/manual validation flows to the shared verifier script with bounded polling.
- [x] Remove unused `workflow_dispatch` release input to eliminate operator confusion and drift.
- [x] Gate `release-please` execution on upstream security/quality check completion.
- [x] Run local verification for workflow/script changes.
- [x] Open PR and complete Omar Gate + required checks watch loop.
- [x] Merge after green and record run IDs/findings delta.

Review:
- PR `#215` merged (squash commit `53616a2037c8cb355552a1ec1c5857690ef79106`) with all required checks green.
- Omar Gate on PR `#215`: run `24117783076` passed (`P0=0`, `P1=0`, `P2=13`).
- Local deterministic scans before merge: `/omargate deep` and `/audit` remained `P1=0`, `P2=0`, `blocking=false`.

## 2026-04-08 - Auth Bypass + Playwright Lifecycle Hardening (Batch P2-A8)

- [x] Harden auth gate so `SENTINELAYER_CLI_SKIP_AUTH=1` only works in trusted bypass contexts (test mode or explicit unsafe override).
- [x] Update auth-gate unit tests to cover guarded bypass, rejected unguarded bypass, and explicit unsafe override behavior.
- [x] Ensure CLI e2e harness uses a trusted bypass context (`NODE_ENV=test`) when setting skip-auth.
- [x] Fix Playwright auth-audit script lifecycle to safely close browser only when launch succeeds and keep structured error output.
- [x] Run local verification for updated auth + audit paths.
- [x] Open PR and complete Omar Gate + required checks watch loop.
- [x] Merge after green and record run IDs/findings delta.

Review:
- PR `#216` merged (squash commit `0f8f4b7be46715219c4860a1c609e343cea267e9`) with all required checks green.
- Omar Gate on PR `#216`: run `24117975510` passed (`P0=0`, `P1=0`, `P2=12`).
- Local deterministic scans before merge remained `P1=0`, `P2=0`, `blocking=false` under guarded bypass (`SENTINELAYER_CLI_SKIP_AUTH=1` + `SENTINELAYER_CLI_ALLOW_UNSAFE_AUTH_BYPASS=1`).

## 2026-04-08 - Manual Release Gate Wait-Window Hardening (Batch P2-A9)

- [x] Validate Omar feedback that `manual-validate` gate wait window can false-fail under normal CI queue/runtime.
- [x] Increase `release.yml` manual validation required-check wait window (`MAX_WAIT_SECONDS`) from `120` to `1800`.
- [x] Run local verification for workflow updates.
- [x] Open PR and complete Omar Gate + required checks watch loop.
- [x] Merge after green and record run IDs/findings delta.

Review:
- PR `#217` merged (squash commit `2a680ce763dce3a39acf632d5920c8e61a25f8ed`) with all required checks green.
- Omar Gate on PR `#217`: run `24118101317` passed (`P0=0`, `P1=0`, `P2=14`).
- Local deterministic scans before merge remained `P1=0`, `P2=0`, `blocking=false` under guarded bypass (`SENTINELAYER_CLI_SKIP_AUTH=1` + `SENTINELAYER_CLI_ALLOW_UNSAFE_AUTH_BYPASS=1`).

## 2026-04-08 - Quality Stage-Order Hardening (Batch P2-A10)

- [x] Validate Omar feedback that quality workflow stages were parallel and not encoded as explicit ordered gates.
- [x] Refactor `quality-gates.yml` so `unit-coverage` waits on `eval-impact + syntax-matrix`.
- [x] Refactor `quality-gates.yml` so `e2e-packaging` waits on `unit-coverage`.
- [x] Remove duplicated unit-test execution from `syntax-matrix` to keep deterministic stage semantics clear.
- [x] Run local verification for workflow updates.
- [x] Open PR and complete Omar Gate + required checks watch loop.
- [x] Merge after green and record run IDs/findings delta.

Review:
- PR `#219` merged (squash commit `95854458f03a2b20782c0053d9922836333e02e0`) with all required checks green.
- Omar Gate on PR `#219`: run `24159571948` passed (`P0=0`, `P1=0`, `P2=15`).
- Quality Gates on PR `#219`: run `24159571938` passed (ordered dependency chain: `eval-impact/syntax -> unit-coverage -> e2e-packaging -> summary`).
- Local deterministic scans before merge remained `P1=0`, `P2=0`, `blocking=false` under guarded bypass (`SENTINELAYER_CLI_SKIP_AUTH=1` + `SENTINELAYER_CLI_ALLOW_UNSAFE_AUTH_BYPASS=1`).

## 2026-04-08 - Auth HTTP Circuit Status Hardening (Batch P2-A11)

- [x] Validate Omar finding that repeated non-retryable auth failures (401/403) do not feed the request circuit breaker.
- [x] Update `src/auth/http.js` to track circuit failures for auth/rate-limit/unavailable status classes even when not retried.
- [x] Add/extend `tests/unit.auth-http.test.mjs` coverage for 401/403 breaker-open behavior and 400 non-tracking behavior.
- [x] Run local verification for changed auth HTTP paths.
- [x] Run deterministic local gates (`/omargate deep`, `/audit`) and capture findings delta.
- [x] Open PR and complete Omar Gate + required checks watch loop.
- [x] Merge after green and record run IDs/findings delta.

Review:
- PR `#220` merged (squash commit `b334022ebc79710d4b961008c18ec32fceaaaa98`) with all required checks green.
- Omar Gate on PR `#220`: run `24159926839` passed (`P0=0`, `P1=0`, `P2=14`).
- Quality Gates on PR `#220`: run `24159926807` passed.
- Local deterministic scans before merge remained `P1=0`, `P2=0`, `blocking=false` under guarded bypass (`SENTINELAYER_CLI_SKIP_AUTH=1` + `SENTINELAYER_CLI_ALLOW_UNSAFE_AUTH_BYPASS=1`).

## 2026-04-08 - Auth Gate Fail-Closed Test-Only Bypass (Batch P2-A12)

- [x] Validate Omar finding that non-test env auth bypass remains possible via `SENTINELAYER_CLI_ALLOW_UNSAFE_AUTH_BYPASS`.
- [x] Refactor `src/auth/gate.js` so env bypass is accepted only for explicit test contexts (`NODE_ENV=test` or `SENTINELAYER_CLI_TEST_MODE=1`).
- [x] Update `tests/unit.auth-gate.test.mjs` to remove unsafe override success path and enforce fail-closed behavior in production env.
- [x] Run local verification for changed auth-gate paths.
- [x] Run deterministic local gates (`/omargate deep`, `/audit`) and capture findings delta.
- [x] Open PR and complete Omar Gate + required checks watch loop.
- [x] Merge after green and record run IDs/findings delta.

Review:
- PR `#221` merged (squash commit `f202a9f9fa8c1577605a52977b5778f585d1c4be`) with all required checks green.
- Omar Gate on PR `#221`: run `24160181753` passed (`P0=0`, `P1=0`, `P2=14`).
- Quality Gates on PR `#221`: run `24160181757` passed.
- Local deterministic scans before merge remained `P1=0`, `P2=0`, `blocking=false` under test-only bypass (`NODE_ENV=test` + `SENTINELAYER_CLI_SKIP_AUTH=1`).

## 2026-04-08 - Release Tag Main-Ancestry Guard (Batch P2-A13)

- [x] Validate Omar finding that tag-triggered release can run from non-main lineage commits.
- [x] Add a deterministic main-ancestry guard in `build-release-artifact` so tagged commit must be reachable from `origin/main`.
- [x] Ensure checkout/fetch strategy in `release.yml` provides sufficient git history for ancestry checks (`merge-base --is-ancestor`).
- [x] Run local verification for workflow updates.
- [x] Run deterministic local gates (`/omargate deep`, `/audit`) and capture findings delta.
- [x] Open PR and complete Omar Gate + required checks watch loop.
- [x] Merge after green and record run IDs/findings delta.

Review:
- PR `#222` merged (squash commit `23b4d7bdaa9656d21eda528610d5b98fcc09e41e`) with all required checks green.
- Omar Gate on PR `#222`: run `24160427570` passed (`P0=0`, `P1=0`, `P2=12`).
- Quality Gates on PR `#222`: run `24160427807` passed.
- Local deterministic scans before merge remained `P1=0`, `P2=0`, `blocking=false` under test-only bypass (`NODE_ENV=test` + `SENTINELAYER_CLI_SKIP_AUTH=1`).

## 2026-04-08 - Auth Audit Header Fetch Retry Hardening (Batch P2-A14)

- [x] Validate Omar finding that auth-flow header fetch is single-shot and can false-negative on transient failures.
- [x] Add bounded retry/backoff for auth-flow header fetch in `src/agents/jules/tools/auth-audit.js` (retry timeout/5xx/429, preserve redirect-hop cap).
- [x] Extend `tests/unit.jules-auth-audit.test.mjs` with retry success and retry exhaustion behavior.
- [x] Run local verification for changed auth-audit paths.
- [x] Run deterministic local gates (`/omargate deep`, `/audit`) and capture findings delta.
- [x] Open PR and complete Omar Gate + required checks watch loop.
- [x] Merge after green and record run IDs/findings delta.

Review:
- PR `#223` merged (squash commit `8015977b7717ca062dda56b995c3cf2dfd4b0918`) with all required checks green.
- Omar Gate on PR `#223`: run `24160785047` passed (`P0=0`, `P1=0`, `P2=12`).
- Quality Gates on PR `#223`: run `24160785029` passed.
- Local deterministic scans before merge remained `P1=0`, `P2=0`, `blocking=false` under test-only bypass (`NODE_ENV=test` + `SENTINELAYER_CLI_SKIP_AUTH=1`).

## 2026-04-08 - Quality Workflow Concurrency Guard (Batch P2-A15)

- [x] Validate Omar finding that quality workflow lacks explicit concurrency and can run overlapping matrices per PR ref.
- [x] Add workflow-level concurrency group keyed by branch ref with `cancel-in-progress: true` in `.github/workflows/quality-gates.yml`.
- [x] Run local verification for workflow updates.
- [x] Run deterministic local gates (`/omargate deep`, `/audit`) and capture findings delta.
- [x] Open PR and complete Omar Gate + required checks watch loop.
- [x] Merge after green and record run IDs/findings delta.

Review:
- PR `#224` merged (squash commit `f7d5ae1cac5bd28e20da07527e5db20b651d8894`) with all required checks green.
- Omar Gate on PR `#224`: run `24161022764` passed (`P0=0`, `P1=0`, `P2=14`).
- Quality Gates on PR `#224`: run `24161022748` passed.
- Local deterministic scans before merge remained `P1=0`, `P2=0`, `blocking=false` under test-only bypass (`NODE_ENV=test` + `SENTINELAYER_CLI_SKIP_AUTH=1`).

## 2026-04-08 - Release Rollback-Readiness Drill Guard (Batch P2-A16)

- [x] Validate Omar finding that release workflow lacks rollback-readiness coverage in the effective tag/manual release paths.
- [x] Add deterministic rollback-readiness script at `.github/scripts/release-rollback-readiness.sh` to emit dry-run rollback plan artifacts/summary from npm metadata.
- [x] Wire manual dispatch validation path to execute rollback-readiness checks after `manual-validate`.
- [x] Wire tag release path to execute rollback-readiness checks before `publish`, and gate publish on that check.
- [x] Run local verification for workflow/script updates.
- [x] Run deterministic local gates (`/omargate deep`, `/audit`) and capture findings delta.
- [x] Open PR and complete Omar Gate + required checks watch loop.
- [x] Merge after green and record run IDs/findings delta.

Review:
- PR `#225` merged (squash commit `ff8a620bdc03a691590013154de68fb9da38fcb0`) with all required checks green.
- Omar Gate on PR `#225`: run `24161280389` passed (`P0=0`, `P1=0`, `P2=13`).
- Quality Gates on PR `#225`: run `24161280432` passed.
- Local deterministic scans before merge remained `P1=0`, `P2=0`, `blocking=false` under test-only bypass (`NODE_ENV=test` + `SENTINELAYER_CLI_SKIP_AUTH=1`).

## 2026-04-08 - Auth Audit Early Console Capture (Batch P2-A17)

- [x] Validate Omar finding that Playwright console listener registration can miss early runtime errors by being attached after target navigation.
- [x] Move Playwright `console`/`pageerror` listener registration to execute immediately after page creation in `src/agents/jules/tools/auth-audit.js`.
- [x] Add a regression guard in `tests/unit.jules-auth-audit.test.mjs` that enforces listener registration order before target navigation.
- [x] Run local verification for changed auth-audit paths.
- [x] Run deterministic local gates (`/omargate deep`, `/audit`) and capture findings delta.
- [x] Open PR and complete Omar Gate + required checks watch loop.
- [x] Merge after green and record run IDs/findings delta.

Review:
- PR `#226` merged (squash commit `74ebc2363bbc9f6a4bdf275f5198d6cb562f2510`) with all required checks green.
- Omar Gate on PR `#226`: run `24161512187` passed (`P0=0`, `P1=0`, `P2=13`).
- Quality Gates on PR `#226`: run `24161512239` passed.
- Local deterministic scans before merge remained `P1=0`, `P2=0`, `blocking=false` under test-only bypass (`NODE_ENV=test` + `SENTINELAYER_CLI_SKIP_AUTH=1`).

## 2026-04-08 - Rollback Readiness Enforcement Guard (Batch P2-A18)

- [x] Validate Omar finding that rollback-readiness checks are informational and do not enforce recoverability criteria.
- [x] Harden `.github/scripts/release-rollback-readiness.sh` to fail closed when rollback target resolution/metadata integrity checks fail.
- [x] Add deterministic dry-run rollback command plan output and include enforcement check state in `release-rollback-readiness.json`.
- [x] Run local verification for rollback-readiness script updates.
- [x] Run deterministic local gates (`/omargate deep`, `/audit`) and capture findings delta.
- [x] Open PR and complete Omar Gate + required checks watch loop.
- [x] Merge after green and record run IDs/findings delta.

Review:
- PR `#227` merged (squash commit `6d60ac193f22aa22267ca193249f66f9ea6a06e3`) with all required checks green.
- Omar Gate on PR `#227`: run `24161733358` passed (`P0=0`, `P1=0`, `P2=15`).
- Quality Gates on PR `#227`: run `24161733341` passed.
- Local deterministic scans before merge remained non-blocking under test-only auth bypass.

## 2026-04-08 - Auth Flow HTTPS Downgrade Guard (Batch P2-A19)

- [x] Validate Omar finding that auth-flow header checks can follow insecure HTTP redirect targets.
- [x] Harden `src/agents/jules/tools/auth-audit.js` to fail closed on HTTPS downgrade targets, with localhost test-mode exception only.
- [x] Add deterministic unit regression tests for downgrade rejection and localhost exception behavior.
- [x] Run local verification (`npm run verify`) for the changed surface.
- [x] Run deterministic local gates (`/omargate deep`, `/audit`) and capture findings delta.
- [x] Open PR and complete Omar Gate + required checks watch loop.
- [x] Merge after green and record run IDs/findings delta.

Review:
- PR `#228` merged (squash commit `b9626c15dfcb8b6e9050c97fcf985b5153233e38`) with all required checks green.
- Omar Gate on PR `#228`: run `24162124775` passed (`P0=0`, `P1=0`, `P2=13`).
- Quality Gates on PR `#228`: run `24162124792` passed.
- Local deterministic scans before merge: `/omargate deep` (`p1=0`, `p2=0`, `blocking=false`), `/audit` (`overallStatus=PASS`, `p1=0`, `p2=0`), both under trusted test bypass (`NODE_ENV=test`, `SENTINELAYER_CLI_SKIP_AUTH=1`).

## 2026-04-08 - Auth Audit Playwright Retry Hardening (Batch P2-A20)

- [x] Validate Omar finding that `authenticatedPageCheck` Playwright subprocess execution has no bounded retry/backoff path.
- [x] Add deterministic retry/backoff helper for Playwright subprocess execution in `src/agents/jules/tools/auth-audit.js`.
- [x] Include attempt-count detail in failure reason when retry budget is exhausted.
- [x] Add unit coverage for retry success and retry exhaustion behavior without invoking real Playwright.
- [x] Run local verification (`npm run verify`) for changed auth-audit surface.
- [x] Run deterministic local gates (`/omargate deep`, `/audit`) and capture findings delta.
- [x] Open PR and complete Omar Gate + required checks watch loop.
- [x] Merge after green and record run IDs/findings delta.

Review:
- PR `#229` merged (squash commit `9b8d30add31290e926eda90161390864308491da`) with all required checks green.
- Omar Gate on PR `#229`: run `24162372551` passed (`P0=0`, `P1=0`, `P2=14`).
- Quality Gates on PR `#229`: run `24162372572` passed.
- Local deterministic scans before merge: `/omargate deep` (`p1=0`, `p2=0`, `blocking=false`), `/audit` (`overallStatus=PASS`, `p1=0`, `p2=0`), both under trusted test bypass (`NODE_ENV=test`, `SENTINELAYER_CLI_SKIP_AUTH=1`).

## 2026-04-08 - Rollback Readiness NPM Query Fail-Closed Guard (Batch P2-A21)

- [x] Validate Omar finding that rollback-readiness npm queries mask transport/auth failures through silent JSON fallbacks.
- [x] Harden `.github/scripts/release-rollback-readiness.sh` to fail closed on npm query failures by default.
- [x] Add explicit non-blocking diagnostics mode (`NON_BLOCKING_DIAGNOSTICS=1`) with warning telemetry instead of silent fallback.
- [x] Ensure rollback metadata extraction paths (`dist-tags`, `versions`, `dist`) use guarded query helpers with parse-safe behavior.
- [x] Run local verification for rollback-readiness script changes.
- [x] Run deterministic local gates (`/omargate deep`, `/audit`) and capture findings delta.
- [x] Open PR and complete Omar Gate + required checks watch loop.
- [x] Merge after green and record run IDs/findings delta.

Review:
- PR `#230` merged (squash commit `209f90c96541cfe795b9428eafe85066871a7def`) with all required checks green.
- Omar Gate on PR `#230`: run `24162586803` passed (`P0=0`, `P1=0`, `P2=14`).
- Quality Gates on PR `#230`: run `24162586780` passed.
- Local deterministic scans before merge: `/omargate deep` (`p1=0`, `p2=0`, `blocking=false`), `/audit` (`overallStatus=PASS`, `p1=0`, `p2=0`), both under trusted test bypass (`NODE_ENV=test`, `SENTINELAYER_CLI_SKIP_AUTH=1`).

## 2026-04-08 - Tool Installer Pinned Digest Policy (Batch P2-A22)

- [x] Validate Omar finding that installer workflows rely on release checksum files without repo-pinned digest policy.
- [x] Add `.github/policies/tool-digests.json` with approved SHA256 digests for current pinned Gitleaks and Trivy versions.
- [x] Update `.github/workflows/gitleaks.yml` installer to verify downloaded archive against policy digest and fail closed on mismatch/missing policy.
- [x] Update `.github/workflows/iac-scan.yml` installer to verify downloaded archive against policy digest and fail closed on mismatch/missing policy.
- [x] Run local verification for workflow/policy updates.
- [x] Run deterministic local gates (`/omargate deep`, `/audit`) and capture findings delta.
- [x] Open PR and complete Omar Gate + required checks watch loop.
- [x] Merge after green and record run IDs/findings delta.

Review:
- PR `#231` merged (squash commit `1ccc75c`) with all required checks green.
- Omar Gate on PR `#231`: run `24162811005` passed (`P0=0`, `P1=0`, `P2=13`).
- Quality Gates on PR `#231`: run `24162811003` passed.
- Local deterministic scans before merge: `/omargate deep` (`p1=0`, `p2=0`, `blocking=false`), `/audit` (`overallStatus=PASS`, `p1=0`, `p2=0`) under trusted test bypass (`NODE_ENV=test`, `SENTINELAYER_CLI_SKIP_AUTH=1`).

## 2026-04-08 - Attestation Upstream Gate Enforcement (Batch P2-A23)

- [x] Validate Omar finding that attestation workflow can run before quality/security check completion on the same commit.
- [x] Add fail-closed upstream check gating in `.github/workflows/attestations.yml` using `.github/scripts/require-check-runs.sh`.
- [x] Add `checks: read` permission to attestation workflow for check-run polling.
- [x] Make required-check policy event-aware (`pull_request` includes Omar Gate, `push` excludes PR-only Omar gate).
- [x] Run local verification for workflow updates.
- [x] Run deterministic local gates (`/omargate deep`, `/audit`) and capture findings delta.
- [x] Open PR and complete Omar Gate + required checks watch loop.
- [x] Merge after green and record run IDs/findings delta.

Review:
- PR `#232` merged (squash commit `de7bff9`) with all required checks green.
- Omar Gate on PR `#232`: run `24163057783` passed (`P0=0`, `P1=0`, `P2=10`).
- Quality Gates on PR `#232`: run `24163057793` passed.
- Local deterministic scans before merge: `/omargate deep` (`p1=0`, `p2=0`, `blocking=false`), `/audit` (`overallStatus=PASS`, `p1=0`, `p2=0`) under trusted test bypass (`NODE_ENV=test`, `SENTINELAYER_CLI_SKIP_AUTH=1`).

## 2026-04-08 - Release Publish Global Serialization (Batch P2-A24)

- [x] Validate Omar finding that release publish concurrency is scoped per tag and can run multiple publishes in parallel.
- [x] Update `.github/workflows/release.yml` publish `concurrency.group` to a global lock (`release-publish-prod`) to serialize npm publish across all tags.
- [x] Run local verification for workflow updates.
- [x] Run deterministic local gates (`/omargate deep`, `/audit`) and capture findings delta.
- [x] Open PR and complete Omar Gate + required checks watch loop.
- [x] Merge after green and record run IDs/findings delta.

Review:
- PR `#233` merged (squash commit `0afa911`) with all required checks green.
- Omar Gate on PR `#233`: run `24163248070` passed (`P0=0`, `P1=0`, `P2=13`).
- Quality Gates on PR `#233`: run `24163248057` passed.
- Local deterministic scans before merge: `/omargate deep` (`p1=0`, `p2=0`, `blocking=false`), `/audit` (`overallStatus=PASS`, `p1=0`, `p2=0`) under trusted test bypass (`NODE_ENV=test`, `SENTINELAYER_CLI_SKIP_AUTH=1`).

## 2026-04-08 - Release Dispatch Approval Symmetry (Batch P2-A25)

- [x] Validate Omar finding that `workflow_dispatch` release validation path lacks explicit environment approval parity with tag publish path.
- [x] Add `environment: package-release` to `manual-validate` in `.github/workflows/release.yml` so manual validation and publish use the same protected approval boundary.
- [x] Run local verification for workflow updates.
- [x] Run deterministic local gates (`/omargate deep`, `/audit`) and capture findings delta.
- [x] Open PR and complete Omar Gate + required checks watch loop.
- [x] Merge after green and record run IDs/findings delta.

Review:
- PR `#234` merged (squash commit `32ddfa9`) with all required checks green.
- Omar Gate on PR `#234`: run `24163429461` passed (`P0=0`, `P1=0`, `P2=12`).
- Quality Gates on PR `#234`: run `24163429382` passed.
- Local deterministic scans before merge: `/omargate deep` (`p1=0`, `p2=0`, `blocking=false`), `/audit` (`overallStatus=PASS`, `p1=0`, `p2=0`) under trusted test bypass (`NODE_ENV=test`, `SENTINELAYER_CLI_SKIP_AUTH=1`).

## 2026-04-08 - Release Workflow Global Concurrency Lock (Batch P2-A26)

- [x] Validate Omar finding that release workflow lacks a top-level concurrency lock and can overlap workflow-dispatch and tag runs.
- [x] Add workflow-level `concurrency` to `.github/workflows/release.yml` (`group: release-workflow-global`, `cancel-in-progress: false`) to serialize release pipeline runs.
- [x] Run local verification for workflow updates.
- [x] Run deterministic local gates (`/omargate deep`, `/audit`) and capture findings delta.
- [x] Open PR and complete Omar Gate + required checks watch loop.
- [x] Merge after green and record run IDs/findings delta.

Review:
- PR `#235` merged (squash commit `00e319d`) with all required checks green.
- Omar Gate on PR `#235`: run `24163617005` passed (`P0=0`, `P1=0`, `P2=13`).
- Quality Gates on PR `#235`: run `24163616942` passed.
- Local deterministic scans before merge: `/omargate deep` (`p1=0`, `p2=0`, `blocking=false`), `/audit` (`overallStatus=PASS`, `p1=0`, `p2=0`) under trusted test bypass (`NODE_ENV=test`, `SENTINELAYER_CLI_SKIP_AUTH=1`).

## 2026-04-08 - SBOM Manifest Deterministic Metadata (Batch P2-A27)

- [x] Validate Omar finding that `sbom-manifest.json` includes non-deterministic wall-clock `generated_at` metadata.
- [x] Replace wall-clock manifest metadata in `.github/workflows/sbom.yml` with deterministic commit-bound metadata (`source_commit: $GITHUB_SHA`).
- [x] Run local verification for workflow updates.
- [x] Run deterministic local gates (`/omargate deep`, `/audit`) and capture findings delta.
- [x] Open PR and complete Omar Gate + required checks watch loop.
- [x] Merge after green and record run IDs/findings delta.

Review:
- PR `#236` merged (squash commit `8b8286f`) with all required checks green.
- Omar Gate on PR `#236`: run `24163781743` passed (`P0=0`, `P1=0`, `P2=13`).
- Quality Gates on PR `#236`: run `24163781735` passed.
- Local deterministic scans before merge: `/omargate deep` (`p1=0`, `p2=0`, `blocking=false`), `/audit` (`overallStatus=PASS`, `p1=0`, `p2=0`) under trusted test bypass (`NODE_ENV=test`, `SENTINELAYER_CLI_SKIP_AUTH=1`).

## 2026-04-08 - Quality Matrix EOL Runtime Removal (Batch P2-A28)

- [x] Validate Omar finding that quality workflow matrix includes EOL Node runtime (`18`).
- [x] Update `.github/workflows/quality-gates.yml` syntax matrix to remove Node `18` and keep supported runtime matrix only.
- [x] Run local verification for workflow updates.
- [x] Run deterministic local gates (`/omargate deep`, `/audit`) and capture findings delta.
- [x] Open PR and complete Omar Gate + required checks watch loop.
- [x] Merge after green and record run IDs/findings delta.

Review:
- PR `#237` merged (squash commit `735dfa3`) with all required checks green.
- Omar Gate on PR `#237`: run `24164038983` passed (`P0=0`, `P1=0`, `P2=13`).
- Quality Gates on PR `#237`: run `24164038984` passed.
- Local deterministic scans before merge: `/omargate deep` (`p1=0`, `p2=0`, `blocking=false`), `/audit` (`overallStatus=PASS`, `p1=0`, `p2=0`) under trusted test bypass (`NODE_ENV=test`, `SENTINELAYER_CLI_SKIP_AUTH=1`).

## 2026-04-08 - Release Tarball Script Execution Guard (Batch P2-A29)

- [x] Validate Omar finding that release artifact tarball build can execute package lifecycle scripts via `npm pack` default behavior.
- [x] Update `.github/workflows/release.yml` tarball build step to use `npm pack --ignore-scripts` so packaging follows install-time script suppression policy.
- [x] Run local verification for workflow updates.
- [x] Run deterministic local gates (`/omargate deep`, `/audit`) and capture findings delta.
- [x] Open PR and complete Omar Gate + required checks watch loop.
- [x] Merge after green and record run IDs/findings delta.

Review:
- PR `#238` merged (squash commit `7a722fb`) with all required checks green.
- Omar Gate on PR `#238`: run `24164204806` passed (`P0=0`, `P1=0`, `P2=10`).
- Quality Gates on PR `#238`: run `24164204769` passed.
- Local deterministic scans before merge: `/omargate deep` (`p1=0`, `p2=0`, `blocking=false`), `/audit` (`overallStatus=PASS`, `p1=0`, `p2=0`) under trusted test bypass (`NODE_ENV=test`, `SENTINELAYER_CLI_SKIP_AUTH=1`).

## 2026-04-08 - Release Publish Explicit Approval Gate (Batch P2-A30)

- [x] Validate Omar finding that tag-triggered publish path should include an explicit approval gate dependency before `publish`.
- [x] Add `release-approval` job in `.github/workflows/release.yml` bound to `environment: package-release`, and make `publish` depend on `release-approval`.
- [x] Run local verification for workflow updates.
- [x] Run deterministic local gates (`/omargate deep`, `/audit`) and capture findings delta.
- [x] Open PR and complete Omar Gate + required checks watch loop.
- [x] Merge after green and record run IDs/findings delta.

Review:
- PR `#239` merged (squash commit `27e982d`) with all required checks green.
- Omar Gate on PR `#239`: run `24164391496` passed (`P0=0`, `P1=0`, `P2=12`).
- Quality Gates on PR `#239`: run `24164391478` passed.
- Local deterministic scans before merge: `/omargate deep` (`p1=0`, `p2=0`, `blocking=false`), `/audit` (`overallStatus=PASS`, `p1=0`, `p2=0`) under trusted test bypass (`NODE_ENV=test`, `SENTINELAYER_CLI_SKIP_AUTH=1`).

## 2026-04-08 - SCA Audit JSON Validation Hardening (Batch P2-A31)

- [x] Validate Omar finding that `npm audit` JSON parsing path tolerates malformed/truncated payloads without strict schema validation.
- [x] Harden `.github/workflows/sca-audit.yml` to fail closed on empty/invalid `npm-audit.json` and require `metadata.vulnerabilities` integer keys (`info|low|moderate|high|critical|total`).
- [x] Run local verification for workflow updates.
- [x] Run deterministic local gates (`/omargate deep`, `/audit`) and capture findings delta.
- [x] Open PR and complete Omar Gate + required checks watch loop.
- [x] Merge after green and record run IDs/findings delta.

Review:
- PR `#240` merged (squash commit `44176ac`) with all required checks green.
- Omar Gate on PR `#240`: run `24164565086` passed (`P0=0`, `P1=0`, `P2=14`).
- Quality Gates on PR `#240`: run `24164565098` passed.
- Local deterministic scans before merge: `/omargate deep` (`p1=0`, `p2=0`, `blocking=false`), `/audit` (`overallStatus=PASS`, `p1=0`, `p2=0`) under trusted test bypass (`NODE_ENV=test`, `SENTINELAYER_CLI_SKIP_AUTH=1`).

## 2026-04-08 - Auth Audit Secret Redaction Hardening (Batch P2-A32)

- [x] Validate Omar finding that auth-audit Playwright error capture redaction is too narrow for token/JWT/cookie-like payloads.
- [x] Harden Playwright-script-side sanitizer in `src/agents/jules/tools/auth-audit.js` to redact bearer credentials, key-value secrets, JWT-like tokens, known API-token families, long hex strings, and long token-like blobs before logging.
- [x] Add unit regression assertions in `tests/unit.jules-auth-audit.test.mjs` to lock sanitizer + typed error-capture contract (`console|pageerror|playwright`).
- [x] Run local verification for changed auth-audit surfaces.
- [x] Run deterministic local gates (`/omargate deep`, `/audit`) and capture findings delta.
- [ ] Open PR and complete Omar Gate + required checks watch loop.
- [ ] Merge after green and record run IDs/findings delta.

## 2026-04-09 - Non-Blocking Burn-Down (Batch P2-A33)

- [x] Finalize pending workflow hardening in `create-sentinelayer` (`release.yml`, `attestations.yml`, `license-gate.yml`) to remove weak fallback paths and runtime drift.
- [x] Run `npm run verify` in the hardening worktree and ensure no local regressions.
- [ ] Open PR from `hardening/nonblocking-p2-batch1`, run Omar Gate loop (`gh run watch`), merge on green.
- [ ] Pull latest `sentinelayer-api` main and reproduce current non-blocking findings from latest Omar run evidence.
- [ ] Implement low-risk non-blocking fixes in one batch PR (entropy false positives + static quality debt with no runtime behavior change).
- [ ] Run API checks (`ruff check`, targeted pytest), open PR, run Omar Gate loop (`gh run watch`), merge on green.
- [ ] Re-run post-merge Omar run inventory across CLI/API/Web and capture remaining non-blocking backlog (if any) for next batch.

## 2026-04-12 - PR-CLI-OMAR-ONLY P2 Remediation (hardening/cli-omar-only-ci)

- [x] `npm run verify` (local): check + e2e + unit coverage + npm pack succeeded.
- [x] `/omargate deep` (local, test bypass): P1=15, P2=85, blocking=true (deterministic baseline; report saved under `.sentinelayer/reports/`).
- [x] `/audit` (local, test bypass): P1=0, P2=8, blocking=false.
- [ ] Plan: harden Omar Gate gating (disallow weaker workflow_dispatch severity, reject non-PR check runs) in `omar-gate.yml` and `quality-gates.yml`.
- [ ] Plan: align release provenance to use attested artifact from `attestations.yml` (no re-pack in release workflow).
- [ ] Plan: enforce HTTPS API base URL normalization (allow localhost http only).
- [ ] Implement the above fixes on `hardening/cli-omar-only-ci`.
- [ ] Re-run Omar Gate on PR `hardening/cli-omar-only-ci` and fix any remaining P0-P2 findings.
- [ ] Merge after Omar Gate passes; record run IDs and findings delta.
