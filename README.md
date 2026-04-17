# sentinelayer-cli

`npx sentinelayer-cli@latest <project-name>`

Scaffolds Sentinelayer spec/prompt/guide artifacts and bootstraps `SENTINELAYER_TOKEN` without manual copy/paste, with optional `BYOK` mode.

CLI binaries:

- `sentinelayer-cli` (primary)
- `create-sentinelayer` (compatibility alias)
- `sentinel` (legacy alias)
- `sl` (short alias)

## What it does

- runs an interactive project interview
- opens browser auth at Sentinelayer `/cli-auth`
- receives approved auth session in terminal
- supports explicit `BYOK` mode (skip Sentinelayer browser auth/token bootstrap)
- optionally opens GitHub auth (`gh auth login -w`) and lets you arrow-select a repo
- optionally clones the selected repo into the current folder for in-place feature work
- generates `spec + build guide + execution prompt + omar workflow + todo + handoff prompt`
- issues bootstrap `SENTINELAYER_TOKEN` when managed auth mode is used
- writes token to local `.env` when managed auth mode is used
- optionally injects token to GitHub Actions secret via `gh secret set` in managed auth mode
- ensures target workspace is a git repo (`git init` + `origin` when needed)

## Current Production Bundle

Initial production scope is intentionally narrow and hardened:

- Omar baseline gate workflows and deterministic local gate checks
- Jules Tanaka deep frontend audits (`sl audit frontend --stream`)
- Reproducible review/audit artifacts and runtime telemetry

Primary commands in this shipping lane:

```bash
sl auth login --api-url https://api.sentinelayer.com
sl scan init --path . --non-interactive
sl omargate deep --path .
sl audit frontend --path ./my-react-app --stream
sl review --diff
sl watch run-events --run-id <run-id>
```

Windows PowerShell note: `sl` is a built-in alias for `Set-Location`. Use `sentinelayer-cli` (or short alias `slc`) instead.

## 60-second flow

1. Trigger:

```bash
npx sentinelayer-cli@latest my-agent-app
```

2. Interview prompts (project goal, provider, coding agent, auth mode, depth, audience, project type, optional repo connect).
3. If repo connect is enabled:
   - choose repo source: current repo, GitHub picker, or manual `owner/repo`
   - optional browser GitHub authorization
   - optional clone into local workspace for existing-codebase feature work
4. Browser auth opens automatically in managed auth mode.
5. Token + artifacts are generated.
6. CLI prints handoff and next command:

```bash
npm run sentinel:start
```

## Non-interactive mode (CI/E2E)

Use non-interactive mode to run full scaffolding in automation:

```bash
SENTINELAYER_CLI_INTERVIEW_JSON='{"projectName":"demo-app","projectDescription":"Build an autonomous secure code review orchestrator.","aiProvider":"openai","codingAgent":"codex","authMode":"sentinelayer","generationMode":"detailed","audienceLevel":"developer","projectType":"greenfield","techStack":["TypeScript","Node.js"],"features":["auth","scan"],"connectRepo":false,"injectSecret":false}' \
npx sentinelayer-cli@latest demo-app --non-interactive --skip-browser-open
```

Inputs for non-interactive mode:

- `SENTINELAYER_CLI_INTERVIEW_JSON` (JSON string)
- interview JSON supports `authMode: "sentinelayer" | "byok"` (default: `sentinelayer`)
- or `--interview-file <path-to-json>`
- `--non-interactive` is required to disable prompts
- `--skip-browser-open` avoids launching local browser in headless runs
- `--help` / `-h` prints CLI usage
- `--version` / `-v` prints CLI version
- `SENTINELAYER_GITHUB_CLONE_BASE_URL` overrides clone base (default `https://github.com`)

## Generated files

- `docs/spec.md`
- `docs/build-guide.md`
- `prompts/execution-prompt.md`
- `.github/workflows/omar-gate.yml`
- `tasks/todo.md`
- `AGENT_HANDOFF_PROMPT.md` (read order + Omar loop + local command matrix + workflow tuning options)
- coding-agent config file for selected agent when supported (examples: `CLAUDE.md`, `.cursorrules`, `.github/copilot-instructions.md`)
- `package.json` (adds `sentinel:start`, `sentinel:omargate`, `sentinel:omargate:json`, `sentinel:audit`, `sentinel:audit:json`, `sentinel:persona:*`, `sentinel:apply` when missing)
- `.env` with `SENTINELAYER_TOKEN` (or API-provided secret name) in managed auth mode

## Multi-Agent Session Workflow

Sentinelayer includes a deterministic session coordination surface for multi-agent coding loops:

- session event stream and replay (`start`, `join`, `say`, `read`, `status`, `leave`, `list`, `kill`)
- agent lifecycle controls (join/heartbeat/leave/kill)
- recap and context briefing for late-joining agents
- analytics + lineage artifacts at session closeout

Read the full guide: [docs/sessions.md](docs/sessions.md)

For strategy context, see the long-form blog draft: [docs/blog/slack-for-ai-coding-agents.md](docs/blog/slack-for-ai-coding-agents.md)

## Advanced options

When `Advanced options?` is enabled:

- `Auth mode` (`sentinelayer` or `byok`)
- `Connect a GitHub repo and inject Actions secret?`
- `How should we choose the repo?` (current / GitHub picker / manual)
- GitHub picker reads all accessible repos via paginated `gh api`
- `Clone this repo locally and build directly into it now?`
- `Inject SENTINELAYER_TOKEN into GitHub Actions secrets now?` (managed auth mode only)
- Final review step lets you proceed, restart interview, or cancel cleanly

The CLI validates repo format and secret-name format before injection.

## Existing codebase mode

When `Clone this repo locally and build directly into it now?` is enabled:

- the CLI clones `<owner>/<repo>` into `./<repo-name>` unless current folder already matches that repo
- it writes generated docs/prompts/tasks/workflow into that cloned repo
- it extracts a deterministic repo summary and includes it in generation context
- if the repo is empty, scaffolding still proceeds deterministically
- if the target folder already contains a different non-empty repo, CLI fails fast with a clear error
- if the target folder is a git repo without a detectable GitHub `origin`, CLI refuses to continue

## Token handling model

- browser auth JWT is used in-memory only
- in managed auth mode, CLI stores only bootstrap token in `.env`
- in managed auth mode, GitHub secret injection uses stdin (`gh secret set ...`) and never writes token to command history
- in managed auth mode, secret injection is verified with `gh secret list --repo <owner/repo>`
- API fallback secret name is pinned to `SENTINELAYER_TOKEN` if server response is invalid
- in BYOK mode, no Sentinelayer token is created or injected

## Persistent CLI auth sessions (Phase 4 foundation slice)

For long-running agent/operator workflows, the CLI now supports persistent auth sessions:

- `sl auth login --api-url https://api.sentinelayer.com --skip-browser-open`
- `sl auth status`
- `sl auth logout`
- `sl auth sessions`
- `sl auth revoke --token-id <token-id>`

On Windows PowerShell, run these as `sentinelayer-cli auth ...` or `slc auth ...`.

Behavior:

- login uses browser approval (`/api/v1/auth/cli/sessions/*`)
- after approval, CLI mints a long-lived API token (`/api/v1/auth/api-tokens`)
- session metadata is stored at `~/.sentinelayer/credentials.json`
- token storage uses OS keyring only when explicitly enabled (`SENTINELAYER_KEYRING_MODE=keyring`) and `keytar` is installed; file fallback is used otherwise
- near-expiry token rotation is automatic on command use for stored sessions
- env/config tokens still take precedence:
  - `SENTINELAYER_TOKEN`
  - `.sentinelayer.yml` `sentinelayerToken`

Opt-in to keyring usage:

- `SENTINELAYER_KEYRING_MODE=keyring` (requires `npm install keytar`)

Opt-out of keyring usage (overrides any opt-in):

- `SENTINELAYER_DISABLE_KEYRING=1`

## Runtime watch streaming (Phase 9 foundation slice)

You can stream runtime run events directly from the CLI:

- `sl watch run-events --run-id <run-id>`
- `sl watch runtime --run-id <run-id>` (alias)
- `sl watch history` (list persisted watch summaries)

Options:

- `--poll-seconds <seconds>` polling interval
- `--max-idle-seconds <seconds>` optional idle timeout
- `--output-dir <path>` artifact root override
- `--json` machine-readable event stream + summary

By default, watch output is persisted to:

- `.sentinelayer/observability/runtime-watch/<run-id>/events-<timestamp>.ndjson`
- `.sentinelayer/observability/runtime-watch/<run-id>/summary-<timestamp>.json`

## Chat command foundation (Phase 2.1 slice)

The CLI now includes a low-latency chat command surface:

- `sl chat ask --prompt "Summarize this diff" --dry-run`
- `sl chat ask --prompt "Explain this failure" --provider openai --model gpt-4o`

Each call appends reproducible transcript entries to:

- `.sentinelayer/chat/sessions/<session-id>.jsonl`

## Deterministic review pipeline (Phase 9.2 foundation slice)

The default `review` command now runs a layered deterministic pipeline:

- `sl review` (full workspace mode)
- `sl review --diff` (staged + unstaged + untracked git changes)
- `sl review --staged` (staged changes only)

Each run writes reproducible artifacts to:

- `.sentinelayer/reviews/<run-id>/REVIEW_DETERMINISTIC.md`
- `.sentinelayer/reviews/<run-id>/REVIEW_DETERMINISTIC.json`
- `.sentinelayer/reviews/<run-id>/checks/*.log` (static check output)

For compatibility, lightweight scan mode remains available:

- `sl review scan --mode full|diff|staged`
- `.sentinelayer/reports/review-scan-<mode>-<timestamp>.md`

## AI review layers (Phase 9.3 slice)

The `review` command can now add budget-governed AI reasoning on top of deterministic findings:

- `sl review --ai --provider openai --model gpt-5.3-codex`
- `sl review --ai --ai-dry-run` (no provider call; deterministic synthetic output)
- `sl review --ai --max-cost 1.0 --max-tokens 0 --max-runtime-ms 0 --max-tool-calls 0`

AI artifacts are persisted in the same run folder:

- `.sentinelayer/reviews/<run-id>/REVIEW_AI_PROMPT.txt`
- `.sentinelayer/reviews/<run-id>/REVIEW_AI.md`
- `.sentinelayer/reviews/<run-id>/REVIEW_AI.json`

AI usage, cost, and stop-class telemetry are appended to:

- `.sentinelayer/cost-history.json`
- `.sentinelayer/observability/run-events.jsonl`

## Unified review report + HITL (Phase 9.4 slice)

Every `review` run now emits reconciled findings:

- `.sentinelayer/reviews/<run-id>/REVIEW_REPORT.md`
- `.sentinelayer/reviews/<run-id>/REVIEW_REPORT.json`

Capabilities:

- `sl review show [--run-id <id>]`
- `sl review export --format sarif|json|md|github-annotations`
- `sl review accept <finding-id> --run-id <id>`
- `sl review reject <finding-id> --run-id <id>`
- `sl review defer <finding-id> --run-id <id>`

Reconciliation behavior:

- deduplicates deterministic + AI findings by location/message fingerprint
- preserves highest severity finding in each duplicate cluster
- assigns confidence (`100%` deterministic, model-derived for AI)
- persists HITL decisions in `.sentinelayer/reviews/<run-id>/REVIEW_DECISIONS.json`

## Review replay + diff (Phase 9.5 slice)

Reproducibility commands:

- `sl review replay <run-id>`
- `sl review diff <base-run-id> <candidate-run-id>`

Run metadata and comparison artifacts:

- `.sentinelayer/reviews/<run-id>/REVIEW_RUN_CONTEXT.json`
- `.sentinelayer/reviews/<run-id>/REVIEW_COMPARISON_<base>_vs_<candidate>.json`

## Audit orchestrator foundation (Phase 10.1 slice)

The CLI now includes an audit swarm orchestrator with a built-in 13-agent registry:

- `sl audit --dry-run`
- `sl audit --agents security,architecture,testing --max-parallel 3`
- `sl audit registry`
- `sl audit security`
- `sl audit architecture`
- `sl audit testing`
- `sl audit performance`
- `sl audit compliance`
- `sl audit documentation`
- `sl audit package --run-id <id>` (or omit `--run-id` to package latest run)
- `sl audit replay <run-id>`
- `sl audit diff <base-run-id> <candidate-run-id>`
- `sl audit local` (legacy compatibility path for `/audit`)

Artifacts are written to:

- `.sentinelayer/audits/<run-id>/AUDIT_REPORT.md`
- `.sentinelayer/audits/<run-id>/AUDIT_REPORT.json`
- `.sentinelayer/audits/<run-id>/agents/<agent-id>.json`
- `.sentinelayer/audits/<run-id>/agents/SECURITY_AGENT_REPORT.md` (security specialist)
- `.sentinelayer/audits/<run-id>/agents/ARCHITECTURE_AGENT_REPORT.md` (architecture specialist)
- `.sentinelayer/audits/<run-id>/agents/TESTING_AGENT_REPORT.md` (testing specialist)
- `.sentinelayer/audits/<run-id>/agents/PERFORMANCE_AGENT_REPORT.md` (performance specialist)
- `.sentinelayer/audits/<run-id>/agents/COMPLIANCE_AGENT_REPORT.md` (compliance specialist)
- `.sentinelayer/audits/<run-id>/agents/DOCUMENTATION_AGENT_REPORT.md` (documentation specialist)
- `.sentinelayer/audits/<run-id>/DD_PACKAGE_MANIFEST.json`
- `.sentinelayer/audits/<run-id>/DD_FINDINGS_INDEX.json`
- `.sentinelayer/audits/<run-id>/DD_EXEC_SUMMARY.md`
- `.sentinelayer/audits/<run-id>/AUDIT_COMPARISON_<base>_vs_<candidate>.json`

## QA swarm orchestrator factory (Phase 12.1 slice)

The CLI now includes OMAR-led swarm planning commands for governed long-running runs:

- `sl swarm registry`
- `sl swarm plan --path . --scenario error_event_remediation --agents security,testing,reliability --json`

`swarm plan` outputs deterministic orchestration artifacts (assignments, budgets, and phase graph):

- `.sentinelayer/swarms/<run-id>/SWARM_PLAN.json`
- `.sentinelayer/swarms/<run-id>/SWARM_PLAN.md`

Global budgets can be set per run:

- `--max-cost-usd`
- `--max-output-tokens`
- `--max-runtime-ms`
- `--max-tool-calls`
- `--warning-threshold-percent`

## Playwright agent runtime (Phase 12.2 slice)

The swarm runtime loop can now be executed directly from CLI:

- `sl swarm run --path . --agents security,testing --json` (default mock runtime, dry-run)
- `sl swarm run --plan-file .sentinelayer/swarms/<plan-run-id>/SWARM_PLAN.json --engine playwright --execute --start-url https://example.com`

Runtime artifacts are persisted under:

- `.sentinelayer/swarms/<runtime-run-id>/runtime/SWARM_RUNTIME.json`
- `.sentinelayer/swarms/<runtime-run-id>/runtime/SWARM_RUNTIME.md`
- `.sentinelayer/swarms/<runtime-run-id>/runtime/events.ndjson`

Optional Playwright actions can be provided via playbook JSON:

- `--playbook-file <path>` where file contract is `{ "actions": [ ... ] }`

## Scenario DSL (Phase 12.3 slice)

Swarm runtime now supports a deterministic scenario DSL (`.sls`):

- `sl swarm scenario init nightly-smoke --path .`
- `sl swarm scenario validate --file .sentinelayer/scenarios/nightly-smoke.sls`
- `sl swarm run --scenario-file .sentinelayer/scenarios/nightly-smoke.sls --json`

DSL commands:

- `scenario "<id>"`
- `start_url "<url>"`
- `tag "<value>"`
- `action goto "<url>"`
- `action click "<selector>"`
- `action fill "<selector>" "<text>"`
- `action wait <ms>`
- `action screenshot "<relative-path>"`

## Realtime swarm dashboard (Phase 12.4 slice)

The CLI now supports runtime swarm dashboard snapshots and watch streaming:

- `sl swarm dashboard --run-id <runtime-run-id>`
- `sl swarm dashboard --watch --run-id <runtime-run-id> --poll-seconds 2 --max-idle-seconds 20`

Machine-readable output:

- `sl swarm dashboard --json`
- `sl swarm dashboard --watch --json`

Dashboard data includes per-agent status rows, usage counters, stop class, and recent timeline events.

## Swarm execution report (Phase 12.5 slice)

You can package runtime artifacts into a deterministic execution report bundle:

- `sl swarm report --run-id <runtime-run-id>`
- `sl swarm report --json`

Report artifacts:

- `.sentinelayer/swarms/<runtime-run-id>/runtime/SWARM_EXECUTION_REPORT.json`
- `.sentinelayer/swarms/<runtime-run-id>/runtime/SWARM_EXECUTION_REPORT.md`

The report links runtime usage, stop class, per-agent status summary, recent events, and plan/runtime artifact paths.

## Security pen-test mode (Phase 12.6 slice)

The CLI now includes a governed pen-test swarm entrypoint:

- `sl swarm create --scenario pen-test --pen-test-scenario auth-bypass --target https://app.customer.local --target-id <target-id>`
- `sl swarm create --scenario input-validation --target https://app.customer.local --target-id <target-id> --execute`

Built-in pen-test scenarios:

- `auth-bypass`
- `rate-limit-probe`
- `input-validation`
- `privilege-escalation`

Policy enforcement is strict:

- target must exist in local AIdenID target registry and be `VERIFIED`
- target must not be frozen/inactive
- target host must match `--target`
- scenario, methods, and paths must stay within target policy (`allowedScenarios`, `allowedMethods`, `allowedPaths`)

Pen-test artifacts:

- `.sentinelayer/swarms/<pentest-run-id>/pentest/REQUEST_PLAN.json`
- `.sentinelayer/swarms/<pentest-run-id>/pentest/audit.jsonl` (full request/response headers+body)
- `.sentinelayer/swarms/<pentest-run-id>/pentest/PENTEST_REPORT.json`
- `.sentinelayer/swarms/<pentest-run-id>/pentest/PENTEST_REPORT.md`

`PENTEST_REPORT` findings are keyed to OWASP categories and surface `P0-P3` severity summary + blocking status.

## Swarm identity hardening (Phase 12.7 slice)

Identity security controls now include:

- zero-trust swarm identity manifest per run (`IDENTITY_ISOLATION.json`)
- cryptographic audit chain on pen-test request logs (`previousEntryHash` + `entryHash` + `entryHmac`)
- crash-safe cleanup contract artifact (`CLEANUP_CONTRACT.json`) for post-run squash scheduling
- legal-hold guardrails on revoke/revoke-children commands

New identity lifecycle commands:

- `sl ai identity audit --stale --json`
- `sl ai identity legal-hold status <identity-id> --json`
- `sl ai identity kill-all --tags <tag1,tag2> [--execute] --json`

`kill-all --execute` blocks legal-hold identities and marks eligible tagged identities as `SQUASHED` in local registry with campaign metadata.

## Error daemon worker (Phase 13.1 slice)

The CLI now includes an OMAR daemon lane for deterministic error intake and routed queue generation:

- `sl daemon error record --service sentinelayer-api --endpoint /v1/runtime/runs --error-code RUNTIME_TIMEOUT --severity P1 --message "runtime timeout"`
- `sl daemon error worker --max-events 200 --json`
- `sl daemon error queue --json`

Daemon artifacts:

- `.sentinelayer/observability/error-daemon/admin-error-stream.ndjson` (append-only intake stream)
- `.sentinelayer/observability/error-daemon/queue.json` (deduped routed queue work items)
- `.sentinelayer/observability/error-daemon/worker-state.json` (stream cursor + aggregate stats)
- `.sentinelayer/observability/error-daemon/intake/intake-*.json` (per-event intake snapshots)
- `.sentinelayer/observability/error-daemon/runs/error-daemon-run-*.json` (worker tick execution evidence)

Queue routing behavior:

- events are fingerprinted from service, endpoint, error code, stack fingerprint, and commit sha
- matching open fingerprints are deduped with `occurrenceCount` increments and severity escalation
- worker cursor tracks processed stream offset for deterministic resumability across ticks

## Global assignment ledger (Phase 13.2 slice)

Daemon assignment controls now support explicit claim/heartbeat/release/reassign flow with lease tracking:

- `sl daemon assign claim <work-item-id> --agent maya.markov@sentinelayer.local --lease-ttl-seconds 1800 --stage triage --run-id run_001 --jira-issue-key SL-101`
- `sl daemon assign heartbeat <work-item-id> --agent maya.markov@sentinelayer.local --stage analysis --run-id run_002`
- `sl daemon assign reassign <work-item-id> --from-agent maya.markov@sentinelayer.local --to-agent mark.rao@sentinelayer.local --stage fix`
- `sl daemon assign release <work-item-id> --agent mark.rao@sentinelayer.local --status DONE --reason "fix merged"`
- `sl daemon assign list --status DONE --agent mark.rao@sentinelayer.local --json`

Ledger artifacts:

- `.sentinelayer/observability/error-daemon/assignment-ledger.json` (current assignment state)
- `.sentinelayer/observability/error-daemon/assignment-events.ndjson` (claim/heartbeat/reassign/release event history)

Tracked assignment fields include:

- `workItemId`
- `assignedAgentIdentity`
- `leasedAt`
- `leaseTtlSeconds`
- `leaseExpiresAt`
- `status`
- `stage`
- `runId`
- `jiraIssueKey`
- `budgetSnapshot`

## Jira lifecycle automation (Phase 13.3 slice)

Daemon Jira lifecycle commands now support ticket create/start/comment/transition traces tied to work items:

- `sl daemon jira open <work-item-id> --issue-key-prefix SL`
- `sl daemon jira start <work-item-id> --plan "1) reproduce 2) patch 3) verify" --actor maya.markov@sentinelayer.local --assignee maya.markov@sentinelayer.local`
- `sl daemon jira comment --work-item-id <work-item-id> --type checkpoint --message "patch applied"`
- `sl daemon jira transition --work-item-id <work-item-id> --to DONE --reason "fix merged"`
- `sl daemon jira list --status DONE --work-item-id <work-item-id> --json`

Lifecycle artifacts:

- `.sentinelayer/observability/error-daemon/jira-lifecycle.json` (issue state, comments, transitions)
- `.sentinelayer/observability/error-daemon/jira-events.ndjson` (append-only lifecycle event feed)

When an assignment exists for the same work item, Jira issue keys are synced into assignment ledger records for deterministic handoff continuity.

## Runtime budget quarantine (Phase 13.4 slice)

Daemon budget governor commands now enforce hard-limit transitions with quarantine grace and deterministic kill path:

- `sl daemon budget check <work-item-id> --usage-json '{"tokensUsed":150}' --budget-json '{"maxTokens":100,"quarantineGraceSeconds":30}'`
- `sl daemon budget status --work-item-id <work-item-id> --json`

Lifecycle states:

- `WITHIN_BUDGET`
- `WARNING_THRESHOLD`
- `HARD_LIMIT_QUARANTINED`
- `HARD_LIMIT_SQUASHED`

Governor behavior:

- crossing a hard limit transitions the work item into quarantine (`action=QUARANTINE`, queue/assignment status `BLOCKED`)
- if hard-limit usage persists past `quarantineGraceSeconds`, governor triggers deterministic kill (`action=KILL`, queue/assignment status `SQUASHED`)
- warning thresholds (`warningThresholdPercent`) surface near-limit signals without blocking

Budget artifacts:

- `.sentinelayer/observability/error-daemon/budget-state.json`
- `.sentinelayer/observability/error-daemon/budget-events.ndjson`
- `.sentinelayer/observability/error-daemon/budget-runs/budget-check-*.json`

## Operator control plane (Phase 13.5 slice)

Daemon operator control commands now provide unified queue/assignment/jira/budget visibility with explicit stop controls:

- `sl daemon control --json`
- `sl daemon control snapshot --status ASSIGNED,BLOCKED --agent maya.markov@sentinelayer.local --json`
- `sl daemon control stop <work-item-id> --mode QUARANTINE --reason "manual triage hold" --confirm --json`
- `sl daemon control stop <work-item-id> --mode SQUASH --reason "kill switch activated" --confirm --json`

Control-plane snapshot fields include:

- per-work-item budget health color (`GREEN`, `YELLOW`, `RED`)
- session timers (`sessionElapsedSeconds`, `sessionIdleSeconds`)
- assignment + Jira linkage (`assignedAgentIdentity`, `assignmentStatus`, `jiraIssueKey`, `jiraStatus`)
- agent roster aggregates (`activeWorkItemCount`, `blockedCount`, `squashedCount`, longest-session duration)

Operator control artifacts:

- `.sentinelayer/observability/error-daemon/operator-control-state.json`
- `.sentinelayer/observability/error-daemon/operator-events.ndjson`
- `.sentinelayer/observability/error-daemon/operator-snapshots/operator-snapshot-*.json`

## Artifact lineage tree (Phase 13.6 slice)

Daemon lineage commands now index reproducibility links across queue, assignment, Jira, budget, and operator artifacts:

- `sl daemon lineage build --json`
- `sl daemon lineage list --status ASSIGNED,BLOCKED --json`
- `sl daemon lineage show <work-item-id> --json`

Lineage index fields include:

- work-item links (`agentIdentity`, `assignmentStatus`, `loopRunId`, `jiraIssueKey`, `budgetLifecycleState`)
- artifact pointers (queue/ledger/jira/budget/operator state files + per-work-item run artifacts)
- reproducibility run catalogs (`errorDaemonRuns`, `budgetChecks`, `operatorSnapshots`)

Lineage artifacts:

- `.sentinelayer/observability/error-daemon/lineage/lineage-index.json`
- `.sentinelayer/observability/error-daemon/lineage/lineage-events.ndjson`

## Hybrid mapping overlay (Phase 13.7 slice)

Daemon hybrid mapping commands now combine deterministic signal routing with on-demand import-graph expansion and semantic scoring:

- `sl daemon map scope <work-item-id> --max-files 40 --graph-depth 2 --json`
- `sl daemon map list --work-item-id <work-item-id> --json`
- `sl daemon map show <work-item-id> --json`

Hybrid scope map output includes:

- deterministic seed files from endpoint/error/service token matches
- import-graph overlay (`graphDepth`) from seed files
- semantic scoring from endpoint/signal token matches in file content
- ranked scoped file set with per-file reasons (`deterministic_path_match`, `semantic_content_match`, `import_graph_distance`)

Hybrid mapping artifacts:

- `.sentinelayer/observability/error-daemon/mapping/hybrid-map-index.json`
- `.sentinelayer/observability/error-daemon/mapping/hybrid-map-events.ndjson`
- `.sentinelayer/observability/error-daemon/mapping/runs/hybrid-map-*.json`

## Midnight reliability lane (Phase 13.8 slice)

Daemon reliability commands now support scheduled synthetic checks and maintenance-billboard automation:

- `sl daemon reliability run --region us-east-1 --timezone America/New_York --json`
- `sl daemon reliability run --simulate-failure aidenid_password_reset_flow --json`
- `sl daemon reliability status --json`
- `sl daemon maintenance status|on|off --json`

Lane behavior:

- failures enqueue deterministic daemon error events (`source=reliability_lane`) and execute one worker tick
- failures can auto-enable maintenance billboard for operator/HITL visibility
- passing runs can automatically clear reliability-opened maintenance state
- manual maintenance controls remain available (`maintenance on|off`) with reason/actor audit trail

Reliability artifacts:

- `.sentinelayer/observability/error-daemon/reliability/lane-config.json`
- `.sentinelayer/observability/error-daemon/reliability/maintenance-billboard.json`
- `.sentinelayer/observability/error-daemon/reliability/reliability-events.ndjson`
- `.sentinelayer/observability/error-daemon/reliability/runs/reliability-lane-*.json`

## MCP registry schema foundation (Phase 6 foundation slice)

The CLI now includes deterministic MCP registry commands:

- `sl mcp schema show`
- `sl mcp schema write`
- `sl mcp registry init-aidenid`
- `sl mcp registry init-aidenid-adapter`
- `sl mcp registry validate --file <path>`
- `sl mcp registry validate-aidenid-adapter --file <path> [--registry-file <path>]`
- `sl mcp server init --id <server-id> --registry-file <path>`
- `sl mcp server validate --file <path>`
- `sl mcp bridge init-vscode --server-id <server-id> --server-config <path>`

Use `init-aidenid` to scaffold an Anthropic-compatible tool schema wrapper for AIdenID provisioning APIs, then customize transport/auth before runtime wiring.
Use `init-aidenid-adapter` to scaffold a deterministic AIdenID provisioning API contract (tool binding -> HTTP path/method -> response field mapping) and cross-check it against the registry with `validate-aidenid-adapter`.

## Plugin governance foundation (Phase 5.2 slice)

The CLI now includes deterministic plugin/template/policy pack governance commands:

- `sl plugin init --id <plugin-id> --pack-type plugin|template_pack|policy_pack|hybrid --stage pre_scan|scan|post_scan|reporting`
- `sl plugin validate --file <manifest.json>`
- `sl plugin list`
- `sl plugin order [--stage <stage>]` (deterministic load-order resolution + cycle detection)

## Policy packs (Phase 5.3 slice)

The CLI now includes policy-pack selection commands:

- `sl policy list`
- `sl policy use strict --scope project`
- `sl policy use compliance-soc2 --scope global`

Built-in packs: `community` (default), `strict`, `compliance-soc2`, `compliance-hipaa`.
Policy selection is stored in config (`defaultPolicyPack`) and applied during `scan init` / `scan validate` / `scan precheck` profile resolution.

## AIdenID CLI foundation (Phase 11 foundation slice)

The CLI now includes an `sl ai` surface for AIdenID identity provisioning:

- `sl ai provision-email --json` (dry-run artifact generation)
- `sl ai provision-email --execute --api-key <key> --org-id <id> --project-id <id>` (live API call)
- `sl ai identity list --json` (list locally tracked identities)
- `sl ai identity show <identity-id> --json`
- `sl ai identity revoke <identity-id> --execute --api-key <key> --org-id <id> --project-id <id>`
- `sl ai identity create-child <parent-identity-id> --event-budget 25 --execute --api-key <key> --org-id <id> --project-id <id>`
- `sl ai identity lineage <identity-id> --json`
- `sl ai identity revoke-children <parent-identity-id> --execute --api-key <key> --org-id <id> --project-id <id>`
- `sl ai identity domain create|verify|freeze ...` (domain proof + freeze lifecycle controls)
- `sl ai identity target create|verify|show ...` (managed target policy/proof controls)
- `sl ai identity site create <identity-id> --domain-id <domain-id> --execute ...`
- `sl ai identity site list [--identity-id <identity-id>]`
- `sl ai identity events <identity-id> --json` (list inbound events with cursor/limit support)
- `sl ai identity latest <identity-id> --json` (latest event + extraction metadata)
- `sl ai identity wait-for-otp <identity-id> --min-confidence 0.8 --timeout 60 --json`

Identity lifecycle records are persisted to:

- `.sentinelayer/aidenid/identity-registry.json`

Credential env fallbacks for live execution:

- `AIDENID_API_KEY`
- `AIDENID_ORG_ID`
- `AIDENID_PROJECT_ID`

Extraction responses include deterministic source metadata (`RULES` vs `LLM`) and confidence scores.

## Manual fallback (if auto injection is skipped)

1. Set local token:

```bash
echo "SENTINELAYER_TOKEN=<your-token>" >> .env
```

2. Inject repo secret:

```bash
gh secret set SENTINELAYER_TOKEN --repo <owner/repo>
gh secret list --repo <owner/repo>
```

3. For manual setup details: `https://sentinelayer.com/docs/getting-started/install-workflow`

4. BYOK mode (no Sentinelayer token):
   - keep generated `docs/spec.md`, `docs/build-guide.md`, `prompts/execution-prompt.md`, and `tasks/todo.md`
   - run your coding agent directly with your provider key (`OPENAI_API_KEY` / `ANTHROPIC_API_KEY` / `GOOGLE_API_KEY`)
   - generated workflow is a BYOK reminder workflow; wire `SENTINELAYER_TOKEN` later to enable Omar Gate action

## Environment overrides

- `SENTINELAYER_API_URL` (default: `https://api.sentinelayer.com`)
- `SENTINELAYER_WEB_URL` (default: `https://sentinelayer.com`)
- `SENTINELAYER_DISABLE_KEYRING=1` (force file-based credential storage)
- `AIDENID_API_KEY`, `AIDENID_ORG_ID`, `AIDENID_PROJECT_ID` (used by `sl ai provision-email --execute`)

## Layered config (PR 0.2)

The CLI supports layered config resolution:

- global: `~/.sentinelayer/config.yml`
- project: `.sentinelayer.yml` at repo root
- env overrides: `SENTINELAYER_API_URL`, `SENTINELAYER_WEB_URL`, `SENTINELAYER_TOKEN`, `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `GOOGLE_API_KEY`

Commands:

- `sentinelayer-cli config list --scope resolved --json`
- `sentinelayer-cli config get apiUrl --scope resolved`
- `sentinelayer-cli config set defaultModelProvider openai --scope project`
- `sentinelayer-cli config edit --scope project`

## Codebase ingest (PR 1.1 slice)

Run deterministic mapping and emit `CODEBASE_INGEST.json`:

- `sentinelayer-cli ingest map --path .`
- `sentinelayer-cli ingest map --path . --json`
- `sentinelayer-cli ingest map --path . --output-file artifacts/CODEBASE_INGEST.json`

The ingest artifact includes language/LOC breakdown, framework hints, entry points, risk-surface hints, and a bounded file index to support deterministic handoff context.

## Offline spec generation (PR 1.2 slice)

Generate a local `SPEC.md` without calling the API:

- `sentinelayer-cli spec list-templates`
- `sentinelayer-cli spec show-template api-service`
- `sentinelayer-cli spec generate --path . --template api-service --description \"Build secure autonomous review orchestration\"`
- `sentinelayer-cli spec show --path .`
- `sentinelayer-cli spec show --path . --plain`
- `sentinelayer-cli spec regenerate --path . --dry-run --json`
- `sentinelayer-cli spec regenerate --path . --max-diff-lines 120`
- `sentinelayer-cli spec regenerate --path . --dry-run --quiet`

The generator uses deterministic ingest context plus template architecture/security checklists.

## AI-enhanced spec generation (PR 3.3 slice)

Generate a deterministic base spec, then optionally refine it with a provider model:

- `sentinelayer-cli spec generate --path . --template api-service --description "Harden auth and release workflows" --ai`
- `sentinelayer-cli spec generate --path . --ai --provider openai --model gpt-5.3-codex --max-cost 1 --warn-at-percent 80`

`--ai` mode behavior:

- deterministic `SPEC.md` draft is always generated first
- AI refinement prompt includes ingest summary + template context + base markdown
- usage is recorded in `.sentinelayer/cost-history.json`
- telemetry usage/stop events are recorded in `.sentinelayer/observability/run-events.jsonl`
- budget governors apply (`--max-cost`, `--max-tokens`, `--max-runtime-ms`, `--max-tool-calls`, `--max-no-progress`)

## Prompt generation (PR 1.3 slice)

Generate execution prompts directly from `SPEC.md`:

- `sentinelayer-cli prompt generate --path . --agent codex`
- `sentinelayer-cli prompt preview --path . --agent claude --max-lines 40`
- `sentinelayer-cli prompt show --path . --agent codex`
- `sentinelayer-cli prompt show --path . --file docs/PROMPT_codex.md --plain`

Supported targets: `claude`, `cursor`, `copilot`, `codex`, `generic`.

## Omar workflow generation (PR 1.4 slice)

Generate and validate a spec-aligned security workflow:

- `sentinelayer-cli scan init --path . --non-interactive`
- `sentinelayer-cli scan init --path . --has-e2e-tests yes --playwright-mode auto`
- `sentinelayer-cli scan validate --path . --json`

`scan init` writes `.github/workflows/omar-gate.yml` and derives:

- `scan_mode` + `severity_gate` from spec risk profile
- `playwright_mode` from spec signals + optional E2E wizard/flags
- `sbom_mode` from supply-chain/dependency signals in spec
- Action bridge parity: generated `scan_mode` options align to `sentinelayer-v1-action` (`baseline`, `deep`, `audit`, `full-depth`) and use the pinned action ref.

`scan validate` checks workflow drift against the current spec profile and exits non-zero when mismatched.

AI-assisted pre-scan triage (budgeted + telemetry-instrumented):

- `sentinelayer-cli scan precheck --path . --provider openai --model gpt-5.3-codex`
- `sentinelayer-cli scan precheck --path . --max-cost 0.5 --warn-at-percent 80 --json`

`scan precheck` writes an AI report to `.sentinelayer/reports/scan-precheck-*.md` (or configured output root), records usage in `.sentinelayer/cost-history.json`, and emits usage/stop events to `.sentinelayer/observability/run-events.jsonl`.

## Build guide generation (PR 1.5 slice)

Generate phase-by-phase implementation guides from `SPEC.md`:

- `sentinelayer-cli guide generate --path .`
- `sentinelayer-cli guide generate --path . --output-file docs/BUILD_GUIDE.md`
- `sentinelayer-cli guide show --path .`
- `sentinelayer-cli guide show --path . --plain`

Export phases as issue-ready payloads:

- `sentinelayer-cli guide export --path . --format jira`
- `sentinelayer-cli guide export --path . --format linear`
- `sentinelayer-cli guide export --path . --format github-issues`

`guide generate` writes `BUILD_GUIDE.md` with per-phase effort estimates, dependencies, implementation tasks, and acceptance criteria. `guide export` transforms phases into tracker-friendly artifacts.

## Multi-provider AI client contract (PR 3.1 slice)

`src/ai/client.js` now provides a reusable contract for future AI-enabled commands:

- provider support: `openai`, `anthropic`, `google`
- provider auto-detection from `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `GOOGLE_API_KEY`
- model resolution defaults per provider with explicit override support
- retry + exponential backoff on retryable statuses (`429`, `5xx`)
- non-stream and streaming invocation APIs with provider-normalized text output

## Cost tracking and budgets (PR 3.2 slice)

The CLI now includes deterministic cost-ledger commands:

- `sentinelayer-cli cost show --path .`
- `sentinelayer-cli cost record --path . --provider openai --model gpt-5.3-codex --input-tokens 1000 --output-tokens 500`

Ledger path:

- `.sentinelayer/cost-history.json` (or configured output root)

Budget controls in `cost record`:

- `--max-cost <usd>` (default `1`)
- `--max-tokens <count>` (default `0`, disabled)
- `--max-runtime-ms <n>` (default `0`, disabled)
- `--max-tool-calls <n>` (default `0`, disabled)
- `--max-no-progress <count>` diminishing-returns guard (default `3`)
- `--warn-at-percent <n>` near-limit warning threshold (default `80`)

Usage counters tracked per invocation/session:

- `--duration-ms <n>`
- `--tool-calls <n>`

Each `cost record` call now emits observability events to:

- `.sentinelayer/observability/run-events.jsonl`

including normalized usage snapshots and blocking stop-class events when budgets are exceeded.

## Observability telemetry contract (PR 3.5 slice)

The CLI now supports a deterministic run-event ledger and stop-class schema:

- `sentinelayer-cli telemetry show --path .`
- `sentinelayer-cli telemetry record --path . --event-type tool_call --tool-calls 1`
- `sentinelayer-cli telemetry record --path . --event-type run_stop --stop-class MAX_RUNTIME_MS_EXCEEDED --reason-codes MAX_RUNTIME_MS_EXCEEDED --blocking`

Ledger contract:

- file: `.sentinelayer/observability/run-events.jsonl`
- event types: `run_start`, `run_step`, `tool_call`, `usage`, `budget_check`, `run_stop`
- stop classes: `MAX_COST_EXCEEDED`, `MAX_OUTPUT_TOKENS_EXCEEDED`, `DIMINISHING_RETURNS`, `MAX_RUNTIME_MS_EXCEEDED`, `MAX_TOOL_CALLS_EXCEEDED`, `MANUAL_STOP`, `ERROR`, `UNKNOWN`

## Requirements

- Node `>=20.0`
- network access to Sentinelayer API/web
- optional: GitHub CLI (`gh`) authenticated for secret injection

## Release to npm

This repo includes `.github/workflows/release.yml`.
Automated version/tag PR flow is handled by `.github/workflows/release-please.yml`.
Primary gate enforcement is Omar-first:
- `.github/workflows/omar-gate.yml` (`Omar Gate`) for AppSec findings and merge thresholds
- `.github/workflows/quality-gates.yml` (`Quality Summary`) for deterministic build/test/package checks
- `.github/workflows/attestations.yml` (`Attestation Summary`) for provenance verification

Prerequisites:

- npm package name is available (`sentinelayer-cli`)
- one publish auth path is configured:
  - repository secret `NPM_TOKEN` with publish access, or
  - npm trusted publishing for this repository/tag workflow

Release options:

1. Merge to `main` and let `Release Please` open/update the release PR and tag.
2. Push a tag like `v0.1.1` to publish automatically (or via release-please tag creation).
3. Run `Release` manually (`workflow_dispatch`) to validate gates and rollback readiness without publishing.
4. Tag-triggered publish resolves auth mode at runtime (`NPM_TOKEN` first, otherwise trusted publishing OIDC).
5. If neither auth mode is available, publish fails closed with an explicit workflow error.

Release publish now enforces tarball checksum-manifest validation and attestation verification bound to `.github/workflows/release.yml` before `npm publish`.

Release guardrails now require successful upstream checks on the target commit:

- `Quality Summary`
- `Omar Gate`
- `Attestation Summary`

## Local verification

```bash
npm run verify
```

This runs:

- CLI syntax check
- unit tests for core offline generators/config/cost tracking
- end-to-end automated scaffolding tests (mock API + mock `gh`)
- coverage enforcement (`>=80%` lines/functions/statements, `>=70%` branches for core modules)
- package tarball dry-run

Additional test commands:

- `npm run test:unit`
- `npm run test:e2e`
- `npm run test:coverage`

## Local commands (MVP)

The CLI now supports a command tree, while keeping slash-command compatibility:

- `sentinelayer-cli init <project-name>` runs scaffold/auth generation (legacy top-level invocation still works)
- `sentinelayer-cli omargate deep --path <repo>` runs a local credential/policy scan and writes `.sentinelayer/reports/omargate-deep-*.md` (non-zero exit if P1 findings exist)
- Local `/omargate` is a local preflight engine; GitHub PR gate execution runs through `sentinelayer-v1-action` -> Sentinelayer API (`/api/v1/github-app/trigger` + `/api/v1/github-app/runs/{id}/status`).
- `sentinelayer-cli audit [--agents <ids>] [--max-parallel <n>]` runs orchestrated audit agents and writes `.sentinelayer/audits/<run-id>/AUDIT_REPORT.{md,json}`
- `sentinelayer-cli audit registry` lists built-in/customized audit-agent registry records
- `sentinelayer-cli audit security` runs the security specialist agent and writes a dedicated `SECURITY_AGENT_REPORT.md`
- `sentinelayer-cli audit architecture` runs the architecture specialist agent and writes a dedicated `ARCHITECTURE_AGENT_REPORT.md`
- `sentinelayer-cli audit testing` runs the testing specialist agent and writes a dedicated `TESTING_AGENT_REPORT.md`
- `sentinelayer-cli audit performance` runs the performance specialist agent and writes a dedicated `PERFORMANCE_AGENT_REPORT.md`
- `sentinelayer-cli audit compliance` runs the compliance specialist agent and writes a dedicated `COMPLIANCE_AGENT_REPORT.md`
- `sentinelayer-cli audit documentation` runs the documentation specialist agent and writes a dedicated `DOCUMENTATION_AGENT_REPORT.md`
- `sentinelayer-cli audit package [--run-id <id>]` builds/rebuilds unified DD package artifacts from the requested (or latest) run
- `sentinelayer-cli audit replay <run-id>` reruns the same selected agent set and writes a replay comparison artifact
- `sentinelayer-cli audit diff <base-run-id> <candidate-run-id>` compares two runs and emits reproducibility drift deltas
- `sentinelayer-cli audit local --path <repo>` runs legacy readiness + scan audit and writes `.sentinelayer/reports/audit-*.md`
- `sentinelayer-cli persona orchestrator --mode <builder|reviewer|hardener> --path <repo>` generates mode-specific execution instructions with repo context
- `sentinelayer-cli apply --plan tasks/todo.md --path <repo>` parses plan tasks into deterministic execution order preview
- `sentinelayer-cli auth login|status|logout` manages persistent CLI sessions for long-running automation
- `sentinelayer-cli auth sessions|revoke` supports session inventory and explicit token revocation controls
- `sentinelayer-cli watch run-events --run-id <id>` streams runtime events with local artifact persistence
- `sentinelayer-cli daemon error record|worker|queue` ingests admin errors and routes deterministic daemon queue work items
- `sentinelayer-cli daemon assign claim|heartbeat|release|reassign|list` manages shared daemon assignment leases and lifecycle states
- `sentinelayer-cli daemon jira open|start|comment|transition|list` manages Jira lifecycle evidence tied to daemon work items
- `sentinelayer-cli daemon budget check|status` enforces budget warning/quarantine/kill governance with reproducible artifacts
- `sentinelayer-cli daemon control|snapshot|stop` provides operator roster snapshots and explicit confirmed stop controls
- `sentinelayer-cli daemon lineage build|list|show` indexes reproducible work-item artifact lineage across queue/assignment/jira/budget/operator runs
- `sentinelayer-cli daemon map scope|list|show` builds hybrid deterministic+semantic impact scopes with import-graph overlay for daemon work items
- `sentinelayer-cli daemon reliability run|status` and `daemon maintenance status|on|off` operate the midnight synthetic lane and maintenance billboard lifecycle
- `sentinelayer-cli mcp schema|registry|server|bridge ...` manages MCP registry schema, server configs, and VS Code bridge scaffolds
- `sentinelayer-cli plugin init|validate|list|order` manages plugin/template/policy packs and deterministic load-order governance
- `sentinelayer-cli policy list|use <pack-id>` manages active policy pack selection (`community`, `strict`, `compliance-soc2`, `compliance-hipaa`, plugin packs)
- `sentinelayer-cli ai provision-email` scaffolds and optionally executes AIdenID identity provisioning requests
- `sentinelayer-cli ai identity list|show|revoke|create-child|lineage|revoke-children` manages local identity lifecycle and lineage workflows
- `sentinelayer-cli ai identity domain create|verify|freeze` manages domain proof registration and containment controls
- `sentinelayer-cli ai identity target create|verify|show` manages target policy registration and verification controls
- `sentinelayer-cli ai identity site create|list` manages ephemeral callback site provisioning and local lifecycle tracking
- `sentinelayer-cli ai identity events|latest|wait-for-otp` manages extraction/event polling for OTP and verification-link retrieval
- `sentinelayer-cli chat ask` runs low-latency prompt/response chat with transcript persistence
- `sentinelayer-cli review [path] [--diff|--staged]` runs layered deterministic review and writes reproducible artifacts under `.sentinelayer/reviews/<run-id>/`
- `sentinelayer-cli review [path] [--diff|--staged] [--ai]` adds budget-governed AI reasoning over deterministic findings
- `sentinelayer-cli review show|export|accept|reject|defer ...` manages reconciled unified reports and HITL adjudication
- `sentinelayer-cli review replay|diff ...` runs reproducibility replay and run-to-run drift comparisons
- `sentinelayer-cli review scan --mode full|diff|staged` runs lightweight deterministic scan mode for compatibility
- add `--json` to `omargate`, `audit`, `persona orchestrator`, or `apply` for machine-readable summaries in CI
- add `--output-dir <dir>` to local commands to write reports outside the default `.sentinelayer/reports`

Legacy slash commands are still supported:

- `sentinelayer-cli /omargate deep --path .`
- `sentinel /omargate deep --path .`

Roadmap:

- persona orchestrator command set for specialized review/execution modes

## Troubleshooting

- `Authentication timed out`: rerun and approve browser session faster.
- `GitHub CLI not installed`: install `gh` or run manual fallback.
- `Invalid repo format`: use exact `owner/repo`.
- `Missing token in workflow`: ensure `.github/workflows/omar-gate.yml` maps `sentinelayer_token: ${{ secrets.SENTINELAYER_TOKEN }}`.

