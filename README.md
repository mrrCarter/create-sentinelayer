# create-sentinelayer

`npx create-sentinelayer@latest <project-name>`

Scaffolds Sentinelayer spec/prompt/guide artifacts and bootstraps `SENTINELAYER_TOKEN` without manual copy/paste.

## What it does

- runs an interactive project interview
- opens browser auth at Sentinelayer `/cli-auth`
- receives approved auth session in terminal
- generates `spec + build guide + execution prompt + omar workflow + todo + handoff prompt`
- issues bootstrap `SENTINELAYER_TOKEN`
- writes token to local `.env`
- optionally injects token to GitHub Actions secret via `gh secret set`

## 60-second flow

1. Trigger:

```bash
npx create-sentinelayer@latest my-agent-app
```

2. Interview prompts (project goal, provider, depth, audience, project type, optional repo connect).
3. Browser auth opens automatically.
4. Token + artifacts are generated.
5. CLI prints handoff and next command:

```bash
npm run sentinel:start
```

## Non-interactive mode (CI/E2E)

Use non-interactive mode to run full scaffolding in automation:

```bash
SENTINELAYER_CLI_INTERVIEW_JSON='{"projectName":"demo-app","projectDescription":"Build an autonomous secure code review orchestrator.","aiProvider":"openai","generationMode":"detailed","audienceLevel":"developer","projectType":"greenfield","techStack":["TypeScript","Node.js"],"features":["auth","scan"],"connectRepo":false,"injectSecret":false}' \
npx create-sentinelayer@latest demo-app --non-interactive --skip-browser-open
```

Inputs for non-interactive mode:

- `SENTINELAYER_CLI_INTERVIEW_JSON` (JSON string)
- or `--interview-file <path-to-json>`
- `--non-interactive` is required to disable prompts
- `--skip-browser-open` avoids launching local browser in headless runs

## Generated files

- `docs/spec.md`
- `docs/build-guide.md`
- `prompts/execution-prompt.md`
- `.github/workflows/omar-gate.yml`
- `tasks/todo.md`
- `AGENT_HANDOFF_PROMPT.md`
- `package.json` (`sentinel:start` script added when missing)
- `.env` with `SENTINELAYER_TOKEN` (or API-provided secret name)

## Advanced options

When `Advanced options?` is enabled:

- `Connect a GitHub repo and inject Actions secret?`
- `GitHub repo (owner/repo)`
- `Inject SENTINELAYER_TOKEN into GitHub Actions secrets now?`

The CLI validates repo format and secret-name format before injection.

## Token handling model

- browser auth JWT is used in-memory only
- CLI stores only bootstrap token in `.env`
- GitHub secret injection uses stdin (`gh secret set ...`) and never writes token to command history
- API fallback secret name is pinned to `SENTINELAYER_TOKEN` if server response is invalid

## Manual fallback (if auto injection is skipped)

1. Set local token:

```bash
echo "SENTINELAYER_TOKEN=<your-token>" >> .env
```

2. Inject repo secret:

```bash
gh secret set SENTINELAYER_TOKEN --repo <owner/repo>
```

3. BYOK fallback (no Sentinelayer token):
   - keep generated `docs/spec.md`, `docs/build-guide.md`, `prompts/execution-prompt.md`, and `tasks/todo.md`
   - run your coding agent directly with your provider key (`OPENAI_API_KEY` / `ANTHROPIC_API_KEY` / `GOOGLE_API_KEY`)
   - do not use the generated Omar Gate workflow in this mode

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

## Local verification

```bash
npm run verify
```

This runs:

- CLI syntax check
- end-to-end automated scaffolding tests (mock API + mock `gh`)
- package tarball dry-run

## Troubleshooting

- `Authentication timed out`: rerun and approve browser session faster.
- `GitHub CLI not installed`: install `gh` or run manual fallback.
- `Invalid repo format`: use exact `owner/repo`.
- `Missing token in workflow`: ensure `.github/workflows/omar-gate.yml` maps `sentinelayer_token: ${{ secrets.SENTINELAYER_TOKEN }}`.
