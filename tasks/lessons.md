# Lessons

## 2026-04-17

- In this CLI, `/review` invokes interactive scaffold flow; for autonomous non-interactive pass-one gates, use `review scan --path . --json`.
- Follow the Omar handshake loop in strict order for each PR: local `review scan` first, local `/omargate deep` only when PR-ready, then open PR, `gh run watch`, and merge only after pass-two confirms `P0=0` and `P1=0`.
- Treat local Omar runs as pass-one evidence and GitHub Omar checks as pass-two authority for merge decisions.
- For pass-one, run only local review gate (`sl review` / `review scan`); do not run deep/full Omar locally until the branch is PR-ready.
- Any PR that touches eval-impact files (for example `src/prompt/generator.js`) must include a same-PR eval evidence artifact under `tasks/evals/` before opening or updating the PR.
- In session/AIdenID provisioning flows, do network provisioning work in parallel but serialize JSON registry writes to avoid race-driven lost updates.
- For lock/unlock chat directives, split `file - intent` only on spaced separators; splitting on raw `-` corrupts hyphenated file paths (`my-file.js`).
- Slash command aliases and structured commands have different option surfaces; use `review scan --path . --json` for deterministic pass-one output instead of assuming `/review` accepts command-level flags.
- Multi-PR Omar execution must stay sequenced: do `/review` locally while iterating, run `/omargate deep` only once branch is PR-ready, then wait for pass-two (`gh run watch`) and merge before starting the next PR in the chain.

## 2026-04-14

- Keep `create-sentinelayer` workflow-dispatch `scan_mode` options in lockstep with `sentinelayer-v1-action` accepted modes (`baseline`, `deep`, `audit`, `full-depth`); stale values like `nightly` create contract drift.
- Treat action reference pinning as part of runtime contract parity: fallback/scaffold templates and primary generator should use the same pinned action ref.
- Local `/omargate` and managed GitHub gate are intentionally different execution paths; document that boundary explicitly and keep mode naming aligned so operator intent does not drift between local and CI.
- Parity tests should assert semantic contracts (exact baseline/deep/full-depth persona sets), not only string presence in generated YAML.

## 2026-04-13

- PowerShell reserves `sl` for `Set-Location`; runtime auth hints and quickstart docs must resolve to a platform-safe command (`sentinelayer-cli`/`slc` on Windows) instead of hardcoding `sl`.
- When hardening auth bypass controls, run full `npm test` immediately afterward and update the e2e harness to authenticate via deterministic test token/session paths; otherwise CI can silently break with broad auth-gate failures.
- Always parse all workflow YAML files locally after workflow edits; a single indentation error creates opaque GitHub runs named by file path and can be mistaken for unrelated gate failures.

## 2026-04-12

- When the requirement is "Omar Gate only," do not rely on any multi-agent review workflows or alternative scanners; fix Omar-specific findings first and rerun the Omar Gate loop until P0-P2 are cleared.

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
- When creating worktrees, keep option order explicit (`git worktree add -b <branch> <path> origin/main`) or you can silently branch from stale `HEAD` and drift behind `origin/main`.
- Eval-gating PRs can self-block unless they include their own deterministic evidence artifact; include `tasks/evals/<pr-id>.md` when introducing or changing eval-impact rules.
- Coverage breadth expansion needs a curated include set: raising include count blindly can drop branch thresholds below gate; expand in batches and keep each batch reproducibly above floor.
- When coverage thresholds are tight, validate the exact `c8` include set with full `npm run verify` before pushing so Omar loop iterations are spent on findings, not preventable CI coverage failures.
- Command-surface regressions are best caught with registration-contract tests (subcommand tree + option flags) plus lightweight parse-level guardrail tests that fail before network/file side effects.
- For security-critical modules, JSDoc should focus on precedence rules, token/credential handling, and failure semantics so reviewers can verify guardrails without reverse-engineering implementation details.
- Governance-only PRs (Dependabot/templates/instructions) should still run full verify + Omar loop; this catches gate interactions like eval-impact or workflow syntax drift before merge.
- Treat release-tag findings as stateful: verify `release-please` manifest/version and open release PRs before cutting tags, so manual tags are never created against stale audit assumptions.
- For mechanical file splits, extract contiguous command blocks and keep a thin orchestrator entrypoint; this minimizes behavior drift while reducing top-level file size.
- When `npm run check` only validates entry files, run explicit `node --check` on newly added module files before full test runs to catch extraction syntax regressions early.

## 2026-04-04

- Keep scaffold token safety deterministic: whenever `.env` is written automatically, ensure `.gitignore` contains `.env` in the same execution path.
- Workflow generator commands must converge on a single canonical path (`.github/workflows/omar-gate.yml`) and carry legacy-path compatibility (`security-review.yml`) only as an update/read fallback to avoid duplicate PR workflows.
- Secret injection success should be validated, not assumed: after `gh secret set`, confirm visibility with `gh secret list --repo <slug>` and fail closed when the secret is not listed.
- Deterministic agent identity needs an explicit dictionary module: map coding-agent id -> prompt target -> config file so scaffold, prompting, and handoff all use one source of truth.
- IDE detection order must be explicit and precedence-safe (`CURSOR_TRACE_ID` before `TERM_PROGRAM=vscode`) so telemetry does not misclassify Cursor sessions as VS Code.
- Existing-repo scaffolds should not default to `greenfield` when `projectType` is omitted; derive `add_feature` automatically when repo-connect + clone/reuse context is present.
- Keep `SPEC.md` phase plans parseable for downstream tooling: add phase metadata as non-numbered lines, but preserve numbered implementation tasks under each `### Phase` heading for guide parser compatibility.
- Spec drift checks should be mode-aware: enforce scope-bound findings (`SL-SPEC-001`) in `diff|staged` paths to prevent pre-commit noise on full-repo sweeps.
- When adding explicit `--spec` overrides, thread the same spec path through deterministic review, AI prompt context, replay context, and unified report hashing to avoid hash/source mismatches across layers.
- Eval-impact gating treats `src/commands/audit.js` as AI-impacting scope; include a `tasks/evals/*.md` artifact in the same PR whenever that command surface changes.
- In this Windows environment, avoid invoking bash-only helper scripts directly (`bash ...`) because WSL may be unavailable; run equivalent checks via PowerShell/Node or rely on CI execution.
- Hybrid memory retrieval should fail closed to local deterministic results when API delegation fails or returns malformed payloads; never block audit orchestration on remote retrieval availability.
- `node --test --test-name-pattern` is not a reliable shortcut for this suite in current tooling; assume full-file execution and budget validation time accordingly.
- Ingest content-hash caches must exclude generated artifact roots (for example `.sentinelayer/`) or the ingest file invalidates its own fingerprint and appears perpetually stale.
- Keep staleness semantics explicit during refresh flows: preserve stale-before-refresh reasoning for traceability, but report post-refresh state as non-stale to avoid misleading operator dashboards.
- When a feature branch is attached to another git worktree, local branch checkout/deletion operations in the primary worktree will fail; either execute directly in the attached worktree or detach/remove it first.
- Omar Gate runs on protected environments can remain in `waiting` until deployment approval; use `gh api repos/<org>/<repo>/actions/runs/<runId>/pending_deployments` to approve and unblock `gh run watch`.
- `gh pr merge --delete-branch` can partially succeed (PR merged, local branch delete fails) when the branch is checked out in a different worktree; always verify merge state with `gh pr view --json state,mergedAt,mergeCommit`.
- Avoid exposing a `severity_gate=none` option in Omar workflow dispatch for production repos; keep threshold choices bounded to enforce review policy by default.
- Polling-based auth flows should treat transient network/5xx/429 errors as retryable and handle terminal states (`rejected`, `expired`) explicitly so login sessions fail deterministically and quickly.
- Release workflows should fail closed when publish is requested without credentials, and use pinned action SHAs plus concurrency controls to prevent overlapping mutable release runs.
- Promote one immutable tarball from build stage to publish stage in release workflows; avoid rebuilding artifacts in publish jobs to preserve provenance lineage.
- When pinning dependency specs from ranges to exact versions, regenerate and commit `package-lock.json` in the same PR to keep `npm ci` deterministic.
- Gate-proof API checks in workflows should use bounded network behavior (`curl` max-time/retry or equivalent); unbounded remote checks can reintroduce release nondeterminism.
- File-tool sandboxing should use one shared path-guard implementation; duplicated read/write path checks drift quickly and reopen traversal holes.
- Allowed-root enforcement must validate both the requested path and its `realpath`; checking only `path.resolve(...)` allows symlink escape into out-of-scope files.
- Keep deterministic `PATH_*` error codes in guardrail failures so policy dashboards and tests can assert exact stop reasons instead of parsing free-form text.
- Subprocess env scrubbing is safer when combining an explicit sensitive-key set with deterministic prefix/suffix rules and `INPUT_` aliases, rather than relying on a short static list.
- Verify credential scrubbing at two layers: pure env-sanitizer unit checks and an end-to-end shell subprocess assertion that sensitive vars are actually absent at runtime.
- Network-command guardrails should parse and validate explicit URL hosts before execution; if host extraction fails (`curl $VAR`), fail closed instead of guessing.
- Wildcard allowlist matching must use dot-boundary suffix checks (`*.example.com`) so lookalike hosts (`evilexample.com`) cannot bypass policy.

## 2026-04-05

- When a reviewer reports concrete P1 workflow/code risks, treat the report as a verification input, not an opinion: reproduce each claim on current `main`, patch only confirmed gaps, and attach post-fix test evidence in `tasks/todo.md`.
- Any CI workflow that downloads release binaries directly must verify artifact integrity (`sha256` from release checksum manifests) before extraction; version pinning alone is insufficient.
- Avoid shell heredoc JSON construction for metadata envelopes in security-sensitive workflows; use `jq -n --arg` to guarantee escaping and valid JSON under adversarial input values.

## 2026-04-07

- When a P2 burn-down PR falls 100+ commits behind main, close it and verify that subsequent PRs already absorbed its fixes rather than rebasing a stale branch — rebase conflicts on a large branch waste more time than incremental fix PRs.
- Before claiming a command or endpoint is missing, always verify by reading the actual source registration code (e.g., `commander` `.command()` calls, FastAPI `@router.get` decorators) — agent summaries and memory can be stale.
- When a core helper switches from sync to async, patch all call sites in the same PR (commands + tools + tests) and add one regression test that would fail on Promise misuse (`missing.length` on unresolved Promise).
- In this repo, full `npm run verify` can fail from environment-level auth-gate requirements unrelated to scoped code changes; always capture passing targeted suites for changed modules and record why e2e auth gating failed.
- npm provenance publish with `--provenance` validates `package.json` repository metadata against the workflow source repo; if `repository.url` is blank or mismatched, npm returns `E422` even when tarball/attestation generation succeeds.

## 2026-04-08

- Hash-locked Python workflows can still break at runtime if lock resolution drifts across major behavior changes (`setuptools` 82 removed `pkg_resources`); pin known-compatible upper bounds in the `.in` source and regenerate hashes, then confirm by executing the tool binary (`semgrep --version`) in CI.
- When a user requests Omar-only gating, remove supplemental security workflows entirely (not just make them non-blocking) so the active CI contract matches policy intent.
- Reusable-workflow digest policies must hash canonical git blob bytes (`git show HEAD:<path>`), not platform working-tree bytes, or Windows CRLF conversion will cause false digest mismatches in Linux CI.

## 2026-04-09

- When Omar reports multiple workflow-level P2 findings, address them in one cohesive hardening batch (auth/tooling + CI provenance + rollback auth), then run targeted checks plus full `npm run verify` before pushing to avoid spending Omar iterations on local regressions.
- In `quality-gates`, never block on CodeQL `analyses` ID availability for PR head SHAs; enforce policy from `code-scanning/alerts` with deterministic PR-first/ref-fallback queries so required checks do not fail on analysis-index lag.
- In bash workflows using `set -e`, do not rely on `if ! cmd; then $?` to capture command exit values; run under `set +e` for the command, capture status explicitly, then re-enable `set -e` for deterministic timeout/failure handling.
- For required-check policy scripts, bind check-runs to immutable workflow metadata (`workflow_path`, `head_sha`) from Actions run API, not just check name/app, to prevent provenance ambiguity across similarly named checks.
- Workflow hardening should enforce both pinned digest and annotation quality; broad `vN` comments around SHA-pinned actions drift into false confidence and should fail policy checks.
- When Omar raises workflow-only P2s, treat them as a live queue and batch-fix by control-plane theme (trust boundary, release lineage, rollback integrity) before the next watch cycle.
- Avoid `pull_request_target` for workflows that mint provenance or run packaging steps on PR head code; keep PR checks in `pull_request` context and reserve trusted attestation minting for `push`/trusted calls.
- For release hardening, implement progressive rollout as a concrete gate (`next` canary publish + registry install validation + explicit `latest` promotion) rather than documenting strategy without enforcement.

## 2026-04-10

- When the policy direction is "Omar-only", remove supplemental scanner workflows and their policy plumbing entirely; marking them non-blocking still violates expected governance.
- Keep documentation and required-check narratives in lockstep with live workflows; stale README gate lists create false confidence and operator confusion during incident review.
- Treat auth/session regressions as source-of-truth issues, not user-environment issues: any command that needs SentinelLayer auth must resolve credentials via `resolveActiveAuthSession (env -> config -> session)` rather than direct `readStoredSession()` reads.
- CLI login should issue API tokens with a scope designed for general CLI endpoints; using a narrow `github_app_bridge` scope causes `/auth/me` and telemetry validation failures downstream.

## 2026-04-12

- When Omar Gate is the required security path, do not rely on multi-agent review workflows or substitute checks; ensure the Omar Gate workflow is the only enforcement path and is actually executed per PR.
- If Omar LLM analysis is required, explicitly set `sentinelayer_managed_llm: "true"` (or equivalent action input) and verify the workflow is not running in a skipped/LLM-disabled mode before merging.

## 2026-04-13

- Workflow-bound required-check resolvers must filter check-runs to GitHub Actions URLs (`/actions/runs/<run_id>`) before provenance validation; otherwise non-workflow checks with the same name can cause false failures.
- Any local deterministic CLI command used inside CI (for example `sl review scan`) must receive a deterministic auth context (`SENTINELAYER_TOKEN`) even when it does not call privileged APIs, or auth-gate will fail the workflow.
- Guard clauses intended for `workflow_dispatch` can accidentally suppress required PR jobs; keep PR build/deploy lanes gated by upstream job success instead of event-type branch-protection shortcuts.
- For PR workflows, provenance manifests must write the PR head SHA (not `GITHUB_SHA` merge ref) when downstream attestation gates validate against head-commit check-runs.
