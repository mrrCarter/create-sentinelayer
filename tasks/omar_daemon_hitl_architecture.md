# OMAR Daemon + HITL Governance Architecture (Assessment)

Date: 2026-04-01  
Status: Assessment and planning only (no product/runtime code edits in this pass)

## 1. Goal

Design a governed autonomous remediation system that:
- detects production/runtime errors reliably,
- wakes OMAR daemon workers with strict budgets,
- creates and updates Jira tickets with machine-usable handoff detail,
- assigns scoped work to isolated agents,
- streams full operator traceability in admin UI (with stop/kill controls),
- preserves reproducibility artifacts and cost/time/token telemetry for compliance and monetization.

This document merges what already exists in Sentinelayer with proven patterns observed in the `src` reference codebase.

## 2. What Exists Today (Line-Level Evidence)

### 2.1 Error ingestion and admin stream already exist
- Error capture writes to local buffer + Redis + DB:
  - `sentinelayer-api/src/middleware/error_buffer.py:39` (`sentinelayer:admin:error_stream:v1`)
  - `sentinelayer-api/src/middleware/error_buffer.py:73` (`record_error_event(...)`)
  - `sentinelayer-api/src/middleware/error_buffer.py:103` (`lpush`) and `:104` (`ltrim`)
  - `sentinelayer-api/src/middleware/error_buffer.py:109-137` (DB persistence to `admin_error_log`)
- 5xx/unhandled exception hooks call error recorder:
  - `sentinelayer-api/src/middleware/error_handler.py:75`
  - `sentinelayer-api/src/middleware/error_handler.py:108`
- Admin API exposes snapshot + SSE stream:
  - `sentinelayer-api/src/routes/admin.py:444` (`/error-log`)
  - `sentinelayer-api/src/routes/admin.py:458` (`/error-log/stream`)
- Web admin consumes stream:
  - `sentinelayer-web/src/pages/admin/Overview.tsx:73-91`
  - `sentinelayer-web/src/lib/api.ts:1806-1883`

### 2.2 Runtime loop, approvals, budgets, and evidence chain already exist
- Runtime budgets and cost/token fields:
  - `sentinelayer-api/src/schemas/runtime_runs.py:49-53` (`RunBudget`)
  - `sentinelayer-api/src/schemas/runtime_runs.py:75-77` (`token_usage`, `cost_usd`)
- Runtime/loop endpoints:
  - `sentinelayer-api/src/routes/runtime_runs.py:541-563` (MCP connectors)
  - `sentinelayer-api/src/routes/runtime_runs.py:565-606` (OMAR loop create/get)
- Loop policy controls and budget exhaustion:
  - `sentinelayer-api/src/services/runtime_run_service.py:4257-4310`
  - `sentinelayer-api/src/services/runtime_run_service.py:4829-4862`
- Tamper-evident timeline artifact chain:
  - `sentinelayer-api/src/services/runtime_run_service.py:5016-5079`
  - writes `.sentinel/timeline.ndjson` + `.sentinel/timeline.sha256`
- KPI and monetization metrics (closure, TTC, cost, tool/subagent counts, reproducibility):
  - `sentinelayer-api/src/services/runtime_run_service.py:1948-2068`
- Web runtime UI already supports start/cancel/approval/loop and live events:
  - `sentinelayer-web/src/components/studio/RuntimeRunPanel.tsx:355-368`
  - `sentinelayer-web/src/components/studio/RuntimeRunPanel.tsx:388-453`
  - `sentinelayer-web/src/components/studio/RuntimeRunPanel.tsx:488-531`
  - `sentinelayer-web/src/components/studio/RuntimeRunPanel.tsx:986-1030`

### 2.3 Governance guardrails already exist
- Sandbox orchestration caps:
  - `sentinelayer-api/src/services/audit_sandbox_service.py:219-248`
- command allowlist + env scrubbing:
  - `sentinelayer-api/src/services/audit_sandbox_service.py:1312-1316`
  - `sentinelayer-api/src/services/audit_sandbox_service.py:1320-1323`
- Watch-mode storm quarantine:
  - `sentinelayer-api/src/services/gateway_storm_guard.py:17-25`
  - `sentinelayer-api/src/services/gateway_storm_guard.py:74-83`
- Event routing pipeline:
  - `sentinelayer-api/src/services/omar_case_service.py:24-64`
  - `sentinelayer-api/src/services/case_router_service.py:35-99`

### 2.4 Key gaps for your requested daemon system
- API startup has no dedicated error daemon worker:
  - `sentinelayer-api/src/main.py:45-47` (entitlement + URL scan workers only)
- Runtime has no Jira lifecycle coupling today (no direct Jira integration in runtime service path):
  - `sentinelayer-api/src/services/runtime_run_service.py` (no `jira` refs)
- Jira integration exists mainly as connect/export/sync:
  - `sentinelayer-api/src/routes/jira.py:114-450`
  - `sentinelayer-api/src/services/jira_service.py:192-333`, `:335-471`, `:875-937`
- Runtime MCP connector model is currently lightweight (`name`, `transport_url`, `capabilities`):
  - `sentinelayer-api/src/services/runtime_run_service.py:2352-2375`

## 3. `src` Reference: How They Reduce Context Bloat and Isolate Agents

### 3.1 Mapping model in `src` (not full-repo AST monolith)
- Deterministic file index over ripgrep-collected paths:
  - `src/native-ts/file-index/index.ts:55` (explicitly says ripgrep collects files)
  - async partial-queryable index build: `src/native-ts/file-index/index.ts:83-93`
- Streaming ripgrep for low memory:
  - file counting stream: `src/utils/ripgrep.ts:235-245`
  - streaming line delivery: `src/utils/ripgrep.ts:284-343`
- On-demand semantic navigation via LSP (document/workspace symbols + call hierarchy):
  - `src/tools/LSPTool/LSPTool.ts:299-327`
  - `src/tools/LSPTool/LSPTool.ts:464-511`
- Deferred tool loading to reduce context token pressure:
  - `src/utils/toolSearch.ts:1-7`
  - threshold auto-enable logic: `src/utils/toolSearch.ts:102-109`, `:709-737`
  - deferred tool accounting: `src/utils/analyzeContext.ts:667-729`, `:1042-1061`, `:1098-1103`

### 3.2 Daemon/scheduling pattern in `src`
- Scheduler designed for daemon callers with explicit `dir`, `lockIdentity`, `isKilled`, `filter`:
  - `src/utils/cronScheduler.ts:89-127`
- Lock acquisition/recovery semantics:
  - `src/utils/cronTasksLock.ts:34-43`
  - `src/utils/cronTasksLock.ts:100-173`
- Durable task file model:
  - `src/utils/cronTasks.ts:74-83` (`.claude/scheduled_tasks.json`)

### 3.3 Sandbox/session/tool streaming pattern in `src`
- Sandbox config and fail-closed option:
  - `src/entrypoints/sandboxTypes.ts:91-103`
- Runtime wrapping with sandbox gate:
  - `src/utils/sandbox/sandbox-adapter.ts:704-724`
- Agent isolation:
  - worktree isolation schema and behavior:
    - `src/tools/AgentTool/AgentTool.tsx:99-100`
    - `src/tools/AgentTool/AgentTool.tsx:582-593`
  - in-process AsyncLocalStorage isolation:
    - `src/utils/swarm/spawnInProcess.ts:1-13`
    - `src/utils/swarm/spawnInProcess.ts:137-147`
  - frontmatter constraints (`disallowedTools`, `permissionMode`, `maxTurns`, `isolation`, `omitClaudeMd`):
    - `src/tools/AgentTool/loadAgentsDir.ts:74-98`
    - `src/tools/AgentTool/loadAgentsDir.ts:122-132`
- Command streaming/backgrounding:
  - assistant blocking budget and auto-background:
    - `src/tools/BashTool/BashTool.tsx:56-57`
    - `src/tools/BashTool/BashTool.tsx:973-983`
  - persisted output path for background command:
    - `src/tools/BashTool/BashTool.tsx:607-614`
  - foreground/background task controls and kill path:
    - `src/tasks/LocalShellTask/LocalShellTask.tsx:370-409`
    - `src/tasks/LocalShellTask/LocalShellTask.tsx:420-460`
  - read-only command governance for `gh` network behaviors:
    - `src/tools/BashTool/readOnlyValidation.ts:1139-1145`

### 3.4 Kairos mode and budget semantics (important distinction)
- Assistant-mode activation and trust/entitlement gates:
  - `src/main.tsx:1033-1087` (settings + trust dialog + gate + forced brief + team init)
  - `src/bootstrap/state.ts:1085-1090` (`getKairosActive`/`setKairosActive`)
- Main-thread responsiveness budget:
  - `src/tools/BashTool/BashTool.tsx:57` (`ASSISTANT_BLOCKING_BUDGET_MS = 15_000`)
  - `src/tools/PowerShellTool/PowerShellTool.tsx:162` (`ASSISTANT_BLOCKING_BUDGET_MS = 15_000`)
  - `src/tools/BashTool/BashTool.tsx:976-983` and `src/tools/PowerShellTool/PowerShellTool.tsx:833-840` (auto-background in assistant mode)
- Kairos async orchestration behavior:
  - `src/tools/AgentTool/AgentTool.tsx:559-567` (assistant mode forces async subagents)
  - `src/utils/processUserInput/processSlashCommand.tsx:90-103` (fire-and-forget slash command subagents in assistant mode)
- Token-target continuation is separate from Kairos:
  - `src/query/tokenBudget.ts:3-4` (`COMPLETION_THRESHOLD=0.9`, `DIMINISHING_THRESHOLD=500`)
  - `src/query/tokenBudget.ts:45-92` (continue/stop decision model)
  - `src/query.ts:1308-1354` (continuation nudges + completion event)
  - `src/screens/REPL.tsx:2893-2896` (parse/snapshot budget from user prompt)
- API-side task budget is also separate:
  - `src/main.tsx:982-987` (`--task-budget` parsing)
  - `src/services/api/claude.ts:468-500` (`output_config.task_budget`)
  - `src/query.ts:193-197` (distinction comment between task_budget and token-target continuation)

Conclusion:
- Kairos itself is primarily an orchestration mode to keep the assistant responsive and coordinated.
- Real spend/safety controls are composed from token-budget logic, API task-budget plumbing, and command/runtime guardrails.
- Sentinelayer should adopt this split intentionally: keep orchestration responsiveness controls independent from deterministic security budgets.

### 3.5 `src` observability + stop enforcement model
- Session and model-usage aggregation:
  - `src/bootstrap/state.ts:704-742` (input/output/cache usage totals + turn-budget counters)
  - `src/cost-tracker.ts:250-305` (cost + token accumulation and counters)
- SDK result and task schemas include duration/cost/usage:
  - `src/entrypoints/sdk/coreSchemas.ts:1407-1449` (`result` success/error includes `duration_ms`, `total_cost_usd`, `usage`, `modelUsage`)
  - `src/entrypoints/sdk/coreSchemas.ts:1694-1761` (`task_notification`/`task_progress` usage fields)
- Background task usage feed:
  - `src/utils/task/sdkProgress.ts:10-35` (emits `total_tokens`, `tool_uses`, `duration_ms`)
  - `src/tasks/LocalAgentTask/LocalAgentTask.tsx:250-257` (terminal usage summary in task notifications)
- Hard-stop enforcement points:
  - `src/QueryEngine.ts:971-1001` (stop on `maxBudgetUsd` with `error_max_budget_usd`)
  - `src/query.ts:1705-1712` and `src/QueryEngine.ts:842-873` (stop on max turns)
  - token-target continuation is guidance/continuation logic, not a strict spend kill-switch (`src/query/tokenBudget.ts:45-92`)

Comparison outcome:
- `src` combines broad observability with explicit execution-path stop checks.
- Sentinelayer API is already strong on runtime telemetry/event lineage, but Sentinelayer CLI (`create-sentinelayer`) still lacks a first-class run-event usage ledger and deterministic stop governor layer.
- Recommendation: build CLI run-event contract first, then align API/CLI stop-class taxonomy and dashboard rendering to one canonical schema.

## 4. Deterministic Ingest vs `src` Mapping: Recommendation

### Current Sentinelayer ingest baseline
- CLI ingest summary is top-level deterministic metadata only:
  - `create-sentinelayer/bin/create-sentinelayer.js:683-723`
  - file scan traversal: `create-sentinelayer/bin/create-sentinelayer.js:748-781`
- No AST/LSP mapping in current CLI code path:
  - no mapping engine references in `create-sentinelayer` (search audit)
- API deterministic ingest is stronger with pack assignments and deterministic payloads:
  - `sentinelayer-api/src/services/repo_ingest_sandbox.py:11-120`
  - deterministic ingest payload: `sentinelayer-api/src/services/repo_ingest_sandbox.py:224-255`
  - candidate file routing from ingest/high-signal paths:
    - `sentinelayer-api/src/services/builder_service_repo_context_mixin.py:176-233`
    - `sentinelayer-api/src/services/builder_service_repo_context_mixin.py:358-430`

### Verdict
- `src` is superior for interactive semantic navigation precision (LSP/call hierarchy on demand).
- Sentinelayer is superior for deterministic, policy-friendly ingest artifacts and handoff consistency.
- Best approach: hybrid.
  - Keep deterministic ingest + pack routing as first-pass scope.
  - Add semantic overlay service (LSP/AST on demand, not whole-repo precompute) for endpoint/file impact narrowing.
  - Persist both provenance chains: deterministic ingest hash + semantic query evidence.

## 5. Proposed System: OMAR Daemon Control Plane (ODCP)

### 5.1 Core services (new)

1. `error_event_daemon`
- Process source: `admin_error_log`, watch events, runtime `run_failed` signals.
- Trigger modes:
  - real-time wake for critical/P0 events,
  - scheduled sweep (midnight regional rollup) for backlog and synthetic reliability jobs.
- Dedup key: `{service, endpoint, error_code, stack_fingerprint, commit_sha?}`.

2. `triage_and_scope_engine`
- Produces `IssueScopeEnvelope`:
  - deterministic pack focus,
  - candidate files,
  - endpoint/service mapping,
  - optional semantic overlay (symbols/call hierarchy evidence),
  - strict tool/path budget envelope.

3. `assignment_registry` (global todo ledger)
- Shared queue independent of model context.
- Fields: `work_item_id`, `assigned_agent_identity`, `leased_at`, `lease_ttl`, `status`, `stage`, `run_id`, `jira_issue_key`, `budget_snapshot`.
- Supports “claim/heartbeat/release/reassign”.

4. `jira_lifecycle_orchestrator`
- Create or dedupe ticket(s) from fingerprints.
- Agent start:
  - post plan comment (exact step plan),
  - transition to `In Progress`.
- During execution:
  - post checkpoint comments (blocked/approval/budget warning).
- Completion:
  - attach evidence refs, transition to resolved state, or mark blocked.

5. `runtime_executor_bridge`
- Creates governed runtime run + OMAR loop with explicit budgets and approval mode.
- Enforces allowed tool/path constraints from `IssueScopeEnvelope`.
- Emits heartbeat for dashboard and assignment ledger.

6. `operator_control_plane`
- Admin dashboard additions:
  - active daemon sessions grid,
  - assigned agent + start time + elapsed time,
  - budget gauges (green/yellow/red),
  - stop/confirm kill button,
  - quarantine/squash controls.
- Maintenance billboard state machine:
  - `MAINTENANCE_ON` when severe ongoing unresolved incidents,
  - `MAINTENANCE_OFF` when clean threshold restored.

### 5.2 Artifact model (`observability/`)

Store per-work-item artifacts (DB + object store) with deterministic paths:

`observability/<date>/<work_item_id>/`
- `intake_event.json`
- `scope_envelope.json`
- `jira_lifecycle.json`
- `runtime_run_summary.json`
- `timeline.ndjson` (chain-linked)
- `timeline.sha256`
- `handoff_fix_plan.json`
- `validation_report.json`
- `closeout.json`

All artifacts carry:
- `work_item_id`,
- `agent_identity` (email/id),
- `request_id`,
- `run_id/loop_id`,
- `token_usage`,
- `cost_usd`,
- `started_at`, `ended_at`, `duration_ms`.

### 5.3 Budget governance model

Per work item:
- token budget,
- wall-clock budget,
- command/tool-call budget,
- filesystem/path budget,
- network domain budget.

Policy transitions:
- `within_budget` -> `warning_threshold` -> `hard_limit`.
- At hard limit:
  - quarantine run,
  - grace delay (seconds),
  - forced kill/squash if still active.

Deterministic stop predicates (day-one recommendation):
- `stop_if(tokens_used >= max_tokens)`
- `stop_if(cost_usd >= max_cost_usd)`
- `stop_if(elapsed_ms >= max_runtime_minutes * 60_000)`
- `stop_if(tool_calls >= max_tool_calls)`
- `stop_if(path_out_of_scope_hits >= 1)` for strict scope runs
- `stop_if(network_domain_violations >= 1)` in restricted runtime profiles

Warning predicates:
- `warn_if(tokens_used / max_tokens >= 0.8)`
- `warn_if(cost_usd / max_cost_usd >= 0.8)`
- `warn_if(elapsed_ms / (max_runtime_minutes * 60_000) >= 0.8)`

### 5.4 HITL + approvals

- Default for write-capable flows: explicit approval required before PR/push stage.
- Existing runtime approval mechanics can be reused:
  - checkpoint + decision paths in runtime service.
- Human-visible stream must always show:
  - what is being changed,
  - why,
  - what budget remains,
  - what policy gate is currently active.

## 6. Scheduling Strategy for Your AIdenID Reliability Job

Your request: run AIdenID password-reset reliability checks on schedule (midnight), not on every live error.

Recommended:
- Keep production error daemon for defect triage/remediation only.
- Add separate scheduled reliability lane:
  - `00:00` in each configured AWS region (or project timezone),
  - runs synthetic AIdenID password reset/invite health scenarios,
  - files tickets only when deterministic failure criteria hit,
  - never blocks live-user paths.

Existing AIdenID scheduler/internal endpoints confirm good fit:
- internal scheduler endpoints:
  - `AIdenID/apps/api/app/routes/internal.py:23`
  - `AIdenID/apps/api/app/routes/internal.py:108`
  - `AIdenID/apps/api/app/routes/internal.py:126`
- scheduler worker invokes lifecycle + simulation drains:
  - `AIdenID/workers/scheduler/src/index.ts:31-50`
  - `AIdenID/workers/scheduler/src/index.ts:70-79`

## 7. MCP Registry + AIdenID Placement Decision

### 7.1 What belongs in AIdenID
- Canonical identity provisioning semantics and policy constraints:
  - `/v1/identities`, `/bulk`, `/children`, `/lineage`, `/squash`:
    - `AIdenID/apps/api/app/routes/identities.py:46`, `:80`, `:122`, `:170`, `:252`, `:274`
- Budget envelopes and lineage constraints:
  - `AIdenID/apps/api/app/services/identity_service.py:339-359`, `:389-395`, `:451`, `:470`
- Audit events:
  - `AIdenID/apps/api/app/services/identity_service.py:194`, `:248`, `:377`, `:510`

### 7.2 What belongs in Sentinelayer
- MCP tool registry schema and runtime adapter registry.
- Tool contract versioning, auth policy, telemetry, and gateway governance.
- Mapping from agent runtime requests -> AIdenID API calls with policy checks.

### 7.3 Practical split
- Build MCP schema/adapters in Sentinelayer.
- Keep business rules/quotas/lifecycle inside AIdenID.
- Do not reimplement AIdenID identity lifecycle logic in Sentinelayer.

## 8. PR-Batch Integration (Proposed)

Use the new Batch J sequence in `tasks/todo.md` after core runtime batches are stable:
- 13.1 error daemon worker and queue,
- 13.2 global assignment ledger,
- 13.3 Jira lifecycle automation,
- 13.4 budget enforcement + quarantine,
- 13.5 dashboard control plane enhancements,
- 13.6 artifact lineage structure,
- 13.7 hybrid deterministic+semantic mapper,
- 13.8 midnight reliability lane + maintenance billboard,
- 13.9 MCP registry schema + AIdenID adapter.

Execution discipline:
- one roadmap PR id per PR,
- preserve SWE framework gates and Omar gate evidence,
- avoid merging any autonomous write path without explicit kill-switch tests.

## 9. Direct Answer to “Can We Rival/Beat Their Mapping?”

Yes, if we combine strengths correctly:
- we should not copy a “full repo AST preload” model (they are not doing that either),
- we should keep Sentinelayer deterministic ingest as the first pass,
- then add semantic lookup only where needed for triage/fix precision.

That hybrid can outperform either approach alone for enterprise governance:
- faster deterministic routing,
- lower context bloat,
- better explainability and reproducibility,
- stronger guardrails for autonomous remediation.

## 10. Immediate Next Prep Steps (No Feature Code Yet)

1. Finalize DB contracts for:
- `daemon_work_items`,
- `agent_assignment_leases`,
- `jira_lifecycle_events`,
- `observability_artifacts_index`.

2. Finalize envelope schemas:
- `IssueScopeEnvelope`,
- `BudgetEnvelope`,
- `HandoffPlan`,
- `OperatorSessionTrace`.

3. Lock acceptance criteria for 13.1-13.3 before implementation:
- daemon wake latency target,
- duplicate suppression threshold,
- mandatory Jira lifecycle transitions,
- stop/kill success SLO.

4. Define cross-surface telemetry contract (CLI + runtime API):
- `RunEvent` envelope (`event_type`, `actor`, `ts`, `duration_ms`, `token_usage`, `cost_usd`, `tool_calls`, `stop_class`, `stop_code`, `run_id`, `loop_id`, `work_item_id`).
- `RunResult` envelope with terminal reason taxonomy (clean, budget_exhausted, blocked_by_policy, awaiting_hitl, infra_error, validation_error, manual_stop).
- explicit warning thresholds and hard-stop predicates mapped to deterministic policy gates.

5. Define early PR acceptance criteria for CLI telemetry/governor work (Batch C additions):
- deterministic fixture tests for stop predicates (token/cost/runtime/tool-call),
- event-chain reproducibility checks for CLI-generated artifacts,
- parity checks ensuring CLI stop reasons map losslessly to runtime API stop classes.
