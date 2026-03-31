# create-sentinelayer

`npx create-sentinelayer@latest <project-name>`

Scaffolds Sentinelayer spec/prompt/guide artifacts and bootstraps `SENTINELAYER_TOKEN` without manual copy/paste, with optional `BYOK` mode.

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
- `AGENT_HANDOFF_PROMPT.md`
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

## Requirements

- Node `>=18.17`
- network access to Sentinelayer API/web
- optional: GitHub CLI (`gh`) authenticated for secret injection

## Release to npm

This repo includes `.github/workflows/release.yml`.

Prerequisites:

- npm package name is available (`create-sentinelayer`)
- repository secret `NPM_TOKEN` is set with publish access

Release options:

1. Push a tag like `v0.1.1` to publish automatically.
2. Run `Release` manually in verify-only mode (`publish=false`, default) to validate and upload tarball artifact.
3. Run `Release` manually with `publish=true` to publish from Actions.
4. If `NPM_TOKEN` is not configured, publish is skipped with an explicit workflow message (verification + tarball still succeed).

## Local verification

```bash
npm run verify
```

This runs:

- CLI syntax check
- end-to-end automated scaffolding tests (mock API + mock `gh`)
- package tarball dry-run

## Local commands (MVP)

The CLI now supports local command mode:

- `/omargate deep --path <repo>` runs a local credential/policy scan and writes `.sentinelayer/reports/omargate-deep-*.md` (non-zero exit if P1 findings exist)
- `/audit --path <repo>` runs local readiness + scan audit and writes `.sentinelayer/reports/audit-*.md` (non-zero exit if blocking findings exist)
- `/persona orchestrator --mode <builder|reviewer|hardener> --path <repo>` generates mode-specific execution instructions with repo context
- `/apply --plan tasks/todo.md --path <repo>` parses plan tasks into deterministic execution order preview
- add `--json` to `/omargate`, `/audit`, `/persona`, or `/apply` for machine-readable summaries in CI

You can run these via either binary:

- `create-sentinelayer /omargate deep --path .`
- `sentinel /omargate deep --path .`

Roadmap:

- persona orchestrator command set for specialized review/execution modes

## Troubleshooting

- `Authentication timed out`: rerun and approve browser session faster.
- `GitHub CLI not installed`: install `gh` or run manual fallback.
- `Invalid repo format`: use exact `owner/repo`.
- `Missing token in workflow`: ensure `.github/workflows/omar-gate.yml` maps `sentinelayer_token: ${{ secrets.SENTINELAYER_TOKEN }}`.
