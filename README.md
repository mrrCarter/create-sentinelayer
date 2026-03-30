# create-sentinelayer

`npx create-sentinelayer@latest <project-name>`

Bootstraps Sentinelayer artifacts end-to-end:

- browser auth handoff (`/cli-auth`) without manual token copy
- `SENTINELAYER_TOKEN` issuance + local `.env` injection
- optional GitHub Actions secret injection (`gh secret set`)
- generated artifacts in your project:
  - `docs/spec.md`
  - `docs/build-guide.md`
  - `prompts/execution-prompt.md`
  - `.github/workflows/omar-gate.yml`
  - `tasks/todo.md`
  - `AGENT_HANDOFF_PROMPT.md`

## Usage

```bash
npx create-sentinelayer@latest my-agent-app
```

The CLI asks interview questions, opens your browser for Sentinelayer auth, waits for approval, then writes artifacts.

## Environment Overrides

- `SENTINELAYER_API_URL` (default: `https://api.sentinelayer.com`)
- `SENTINELAYER_WEB_URL` (default: `https://sentinelayer.com`)

## Notes

- Requires Node `>=18.17`.
- GitHub secret injection requires GitHub CLI (`gh`) authenticated for the target repo.
- The CLI never writes the web auth JWT to disk; it only stores the issued `SENTINELAYER_TOKEN` in `.env`.
