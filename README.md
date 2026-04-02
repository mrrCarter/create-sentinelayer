# create-sentinelayer

`npx create-sentinelayer@latest <project-name>`

Scaffolds Sentinelayer spec/prompt/guide artifacts and bootstraps `SENTINELAYER_TOKEN` without manual copy/paste, with optional `BYOK` mode.

CLI binaries:

- `create-sentinelayer` (primary)
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

## 60-second flow

1. Trigger:

```bash
npx create-sentinelayer@latest my-agent-app
```

2. Interview prompts (project goal, provider, auth mode, depth, audience, project type, optional repo connect).
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
SENTINELAYER_CLI_INTERVIEW_JSON='{"projectName":"demo-app","projectDescription":"Build an autonomous secure code review orchestrator.","aiProvider":"openai","authMode":"sentinelayer","generationMode":"detailed","audienceLevel":"developer","projectType":"greenfield","techStack":["TypeScript","Node.js"],"features":["auth","scan"],"connectRepo":false,"injectSecret":false}' \
npx create-sentinelayer@latest demo-app --non-interactive --skip-browser-open
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
- `package.json` (adds `sentinel:start`, `sentinel:omargate`, `sentinel:omargate:json`, `sentinel:audit`, `sentinel:audit:json`, `sentinel:persona:*`, `sentinel:apply` when missing)
- `.env` with `SENTINELAYER_TOKEN` (or API-provided secret name) in managed auth mode

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
- API fallback secret name is pinned to `SENTINELAYER_TOKEN` if server response is invalid
- in BYOK mode, no Sentinelayer token is created or injected

## Persistent CLI auth sessions (Phase 4 foundation slice)

For long-running agent/operator workflows, the CLI now supports persistent auth sessions:

- `sl auth login --api-url https://api.sentinelayer.com --skip-browser-open`
- `sl auth status`
- `sl auth logout`
- `sl auth sessions`
- `sl auth revoke --token-id <token-id>`

Behavior:

- login uses browser approval (`/api/v1/auth/cli/sessions/*`)
- after approval, CLI mints a long-lived API token (`/api/v1/auth/api-tokens`)
- session metadata is stored at `~/.sentinelayer/credentials.json`
- token storage uses OS keyring when `keytar` is available; file fallback is used otherwise
- near-expiry token rotation is automatic on command use for stored sessions
- env/config tokens still take precedence:
  - `SENTINELAYER_TOKEN`
  - `.sentinelayer.yml` `sentinelayerToken`

Opt-out of keyring usage:

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

## MCP registry schema foundation (Phase 6 foundation slice)

The CLI now includes deterministic MCP registry commands:

- `sl mcp schema show`
- `sl mcp schema write`
- `sl mcp registry init-aidenid`
- `sl mcp registry validate --file <path>`
- `sl mcp server init --id <server-id> --registry-file <path>`
- `sl mcp server validate --file <path>`
- `sl mcp bridge init-vscode --server-id <server-id> --server-config <path>`

Use `init-aidenid` to scaffold an Anthropic-compatible tool schema wrapper for AIdenID provisioning APIs, then customize transport/auth before runtime wiring.

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

Credential env fallbacks for live execution:

- `AIDENID_API_KEY`
- `AIDENID_ORG_ID`
- `AIDENID_PROJECT_ID`

## Manual fallback (if auto injection is skipped)

1. Set local token:

```bash
echo "SENTINELAYER_TOKEN=<your-token>" >> .env
```

2. Inject repo secret:

```bash
gh secret set SENTINELAYER_TOKEN --repo <owner/repo>
```

3. BYOK mode (no Sentinelayer token):
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

- `create-sentinelayer config list --scope resolved --json`
- `create-sentinelayer config get apiUrl --scope resolved`
- `create-sentinelayer config set defaultModelProvider openai --scope project`
- `create-sentinelayer config edit --scope project`

## Codebase ingest (PR 1.1 slice)

Run deterministic mapping and emit `CODEBASE_INGEST.json`:

- `create-sentinelayer ingest map --path .`
- `create-sentinelayer ingest map --path . --json`
- `create-sentinelayer ingest map --path . --output-file artifacts/CODEBASE_INGEST.json`

The ingest artifact includes language/LOC breakdown, framework hints, entry points, risk-surface hints, and a bounded file index to support deterministic handoff context.

## Offline spec generation (PR 1.2 slice)

Generate a local `SPEC.md` without calling the API:

- `create-sentinelayer spec list-templates`
- `create-sentinelayer spec show-template api-service`
- `create-sentinelayer spec generate --path . --template api-service --description \"Build secure autonomous review orchestration\"`
- `create-sentinelayer spec show --path .`
- `create-sentinelayer spec show --path . --plain`
- `create-sentinelayer spec regenerate --path . --dry-run --json`
- `create-sentinelayer spec regenerate --path . --max-diff-lines 120`
- `create-sentinelayer spec regenerate --path . --dry-run --quiet`

The generator uses deterministic ingest context plus template architecture/security checklists.

## AI-enhanced spec generation (PR 3.3 slice)

Generate a deterministic base spec, then optionally refine it with a provider model:

- `create-sentinelayer spec generate --path . --template api-service --description "Harden auth and release workflows" --ai`
- `create-sentinelayer spec generate --path . --ai --provider openai --model gpt-5.3-codex --max-cost 1 --warn-at-percent 80`

`--ai` mode behavior:

- deterministic `SPEC.md` draft is always generated first
- AI refinement prompt includes ingest summary + template context + base markdown
- usage is recorded in `.sentinelayer/cost-history.json`
- telemetry usage/stop events are recorded in `.sentinelayer/observability/run-events.jsonl`
- budget governors apply (`--max-cost`, `--max-tokens`, `--max-runtime-ms`, `--max-tool-calls`, `--max-no-progress`)

## Prompt generation (PR 1.3 slice)

Generate execution prompts directly from `SPEC.md`:

- `create-sentinelayer prompt generate --path . --agent codex`
- `create-sentinelayer prompt preview --path . --agent claude --max-lines 40`
- `create-sentinelayer prompt show --path . --agent codex`
- `create-sentinelayer prompt show --path . --file docs/PROMPT_codex.md --plain`

Supported targets: `claude`, `cursor`, `copilot`, `codex`, `generic`.

## Omar workflow generation (PR 1.4 slice)

Generate and validate a spec-aligned security workflow:

- `create-sentinelayer scan init --path . --non-interactive`
- `create-sentinelayer scan init --path . --has-e2e-tests yes --playwright-mode auto`
- `create-sentinelayer scan validate --path . --json`

`scan init` writes `.github/workflows/security-review.yml` and derives:

- `scan_mode` + `severity_gate` from spec risk profile
- `playwright_mode` from spec signals + optional E2E wizard/flags
- `sbom_mode` from supply-chain/dependency signals in spec

`scan validate` checks workflow drift against the current spec profile and exits non-zero when mismatched.

AI-assisted pre-scan triage (budgeted + telemetry-instrumented):

- `create-sentinelayer scan precheck --path . --provider openai --model gpt-5.3-codex`
- `create-sentinelayer scan precheck --path . --max-cost 0.5 --warn-at-percent 80 --json`

`scan precheck` writes an AI report to `.sentinelayer/reports/scan-precheck-*.md` (or configured output root), records usage in `.sentinelayer/cost-history.json`, and emits usage/stop events to `.sentinelayer/observability/run-events.jsonl`.

## Build guide generation (PR 1.5 slice)

Generate phase-by-phase implementation guides from `SPEC.md`:

- `create-sentinelayer guide generate --path .`
- `create-sentinelayer guide generate --path . --output-file docs/BUILD_GUIDE.md`
- `create-sentinelayer guide show --path .`
- `create-sentinelayer guide show --path . --plain`

Export phases as issue-ready payloads:

- `create-sentinelayer guide export --path . --format jira`
- `create-sentinelayer guide export --path . --format linear`
- `create-sentinelayer guide export --path . --format github-issues`

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

- `create-sentinelayer cost show --path .`
- `create-sentinelayer cost record --path . --provider openai --model gpt-5.3-codex --input-tokens 1000 --output-tokens 500`

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

- `create-sentinelayer telemetry show --path .`
- `create-sentinelayer telemetry record --path . --event-type tool_call --tool-calls 1`
- `create-sentinelayer telemetry record --path . --event-type run_stop --stop-class MAX_RUNTIME_MS_EXCEEDED --reason-codes MAX_RUNTIME_MS_EXCEEDED --blocking`

Ledger contract:

- file: `.sentinelayer/observability/run-events.jsonl`
- event types: `run_start`, `run_step`, `tool_call`, `usage`, `budget_check`, `run_stop`
- stop classes: `MAX_COST_EXCEEDED`, `MAX_OUTPUT_TOKENS_EXCEEDED`, `DIMINISHING_RETURNS`, `MAX_RUNTIME_MS_EXCEEDED`, `MAX_TOOL_CALLS_EXCEEDED`, `MANUAL_STOP`, `ERROR`, `UNKNOWN`

## Requirements

- Node `>=18.17`
- network access to Sentinelayer API/web
- optional: GitHub CLI (`gh`) authenticated for secret injection

## Release to npm

This repo includes `.github/workflows/release.yml`.
Automated version/tag PR flow is handled by `.github/workflows/release-please.yml`.

Prerequisites:

- npm package name is available (`create-sentinelayer`)
- repository secret `NPM_TOKEN` is set with publish access

Release options:

1. Merge to `main` and let `Release Please` open/update the release PR and tag.
2. Push a tag like `v0.1.1` to publish automatically (or via release-please tag creation).
3. Run `Release` manually in verify-only mode (`publish=false`, default) to validate and upload tarball artifact.
4. Run `Release` manually with `publish=true` to publish from Actions.
5. If `NPM_TOKEN` is not configured, publish is skipped with an explicit workflow message (verification + tarball still succeed).

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

- `create-sentinelayer init <project-name>` runs scaffold/auth generation (legacy top-level invocation still works)
- `create-sentinelayer omargate deep --path <repo>` runs a local credential/policy scan and writes `.sentinelayer/reports/omargate-deep-*.md` (non-zero exit if P1 findings exist)
- `create-sentinelayer audit [--agents <ids>] [--max-parallel <n>]` runs orchestrated audit agents and writes `.sentinelayer/audits/<run-id>/AUDIT_REPORT.{md,json}`
- `create-sentinelayer audit registry` lists built-in/customized audit-agent registry records
- `create-sentinelayer audit security` runs the security specialist agent and writes a dedicated `SECURITY_AGENT_REPORT.md`
- `create-sentinelayer audit architecture` runs the architecture specialist agent and writes a dedicated `ARCHITECTURE_AGENT_REPORT.md`
- `create-sentinelayer audit testing` runs the testing specialist agent and writes a dedicated `TESTING_AGENT_REPORT.md`
- `create-sentinelayer audit performance` runs the performance specialist agent and writes a dedicated `PERFORMANCE_AGENT_REPORT.md`
- `create-sentinelayer audit compliance` runs the compliance specialist agent and writes a dedicated `COMPLIANCE_AGENT_REPORT.md`
- `create-sentinelayer audit documentation` runs the documentation specialist agent and writes a dedicated `DOCUMENTATION_AGENT_REPORT.md`
- `create-sentinelayer audit package [--run-id <id>]` builds/rebuilds unified DD package artifacts from the requested (or latest) run
- `create-sentinelayer audit replay <run-id>` reruns the same selected agent set and writes a replay comparison artifact
- `create-sentinelayer audit diff <base-run-id> <candidate-run-id>` compares two runs and emits reproducibility drift deltas
- `create-sentinelayer audit local --path <repo>` runs legacy readiness + scan audit and writes `.sentinelayer/reports/audit-*.md`
- `create-sentinelayer persona orchestrator --mode <builder|reviewer|hardener> --path <repo>` generates mode-specific execution instructions with repo context
- `create-sentinelayer apply --plan tasks/todo.md --path <repo>` parses plan tasks into deterministic execution order preview
- `create-sentinelayer auth login|status|logout` manages persistent CLI sessions for long-running automation
- `create-sentinelayer auth sessions|revoke` supports session inventory and explicit token revocation controls
- `create-sentinelayer watch run-events --run-id <id>` streams runtime events with local artifact persistence
- `create-sentinelayer mcp schema|registry|server|bridge ...` manages MCP registry schema, server configs, and VS Code bridge scaffolds
- `create-sentinelayer plugin init|validate|list|order` manages plugin/template/policy packs and deterministic load-order governance
- `create-sentinelayer policy list|use <pack-id>` manages active policy pack selection (`community`, `strict`, `compliance-soc2`, `compliance-hipaa`, plugin packs)
- `create-sentinelayer ai provision-email` scaffolds and optionally executes AIdenID identity provisioning requests
- `create-sentinelayer chat ask` runs low-latency prompt/response chat with transcript persistence
- `create-sentinelayer review [path] [--diff|--staged]` runs layered deterministic review and writes reproducible artifacts under `.sentinelayer/reviews/<run-id>/`
- `create-sentinelayer review [path] [--diff|--staged] [--ai]` adds budget-governed AI reasoning over deterministic findings
- `create-sentinelayer review show|export|accept|reject|defer ...` manages reconciled unified reports and HITL adjudication
- `create-sentinelayer review replay|diff ...` runs reproducibility replay and run-to-run drift comparisons
- `create-sentinelayer review scan --mode full|diff|staged` runs lightweight deterministic scan mode for compatibility
- add `--json` to `omargate`, `audit`, `persona orchestrator`, or `apply` for machine-readable summaries in CI
- add `--output-dir <dir>` to local commands to write reports outside the default `.sentinelayer/reports`

Legacy slash commands are still supported:

- `create-sentinelayer /omargate deep --path .`
- `sentinel /omargate deep --path .`

Roadmap:

- persona orchestrator command set for specialized review/execution modes

## Troubleshooting

- `Authentication timed out`: rerun and approve browser session faster.
- `GitHub CLI not installed`: install `gh` or run manual fallback.
- `Invalid repo format`: use exact `owner/repo`.
- `Missing token in workflow`: ensure `.github/workflows/omar-gate.yml` maps `sentinelayer_token: ${{ secrets.SENTINELAYER_TOKEN }}`.
