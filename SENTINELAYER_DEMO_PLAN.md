# SentinelLayer CLI Demo Plan — Complete Walkthrough

> Last updated: 2026-04-07
> Status: All PRs created, awaiting Omar Gate approval

---

## What This Demo Proves

1. **End-to-end developer/agent workflow**: Install CLI → scaffold → build → security gate → merge
2. **AIdenID email identity lifecycle**: Provision → receive email → extract OTP → verify
3. **Omar Gate as a real security barrier**: PRs blocked on P0/P1 findings, agent fixes and retries
4. **Full observability**: Every CLI run visible in dashboard with findings, cost, and artifacts

---

## Prerequisites

```bash
# Node.js 18+
node --version

# GitHub CLI authenticated
gh auth status

# Resend API key (from resend.com dashboard)
export RESEND_API_KEY=re_xxx

# AIdenID credentials (from aidenid.com dashboard)
export AIDENID_API_KEY=ak_xxx
export AIDENID_ORG_ID=org_xxx
export AIDENID_PROJECT_ID=proj_xxx
```

---

## Step 1: SentinelLayer CLI Login

```bash
npx sentinelayer-cli auth login
```

This opens your browser to `sentinelayer.com/cli-auth`. Log in with GitHub or Google. The CLI polls until the browser callback completes, then stores your token locally in `~/.sentinelayer/credentials.json`.

```bash
sl auth status
# → Authenticated as carther@... (token expires 2027-04-07)
```

---

## Step 2: Create the Demo Project

```bash
npx create-sentinelayer sentinel-demo-app
cd sentinel-demo-app
```

**What gets generated:**

| Path | Content |
|------|---------|
| `src/index.js` | Express.js app with health endpoint |
| `src/routes/health.js` | Health check route |
| `tests/health.test.js` | Baseline test |
| `package.json` | Express, JWT, bcrypt, dotenv deps |
| `README.md` | Project overview with setup instructions |
| `.gitignore` | Standard Node ignores |
| `.env.example` | Environment variable template |
| `docs/spec.md` | Generated specification |
| `docs/build-guide.md` | Phase-by-phase build plan |
| `prompts/execution-prompt.md` | Agent execution prompt |
| `.github/workflows/omar-gate.yml` | Security review workflow |
| `tasks/todo.md` | Build checklist |
| `AGENT_HANDOFF_PROMPT.md` | Agent handoff instructions |

```bash
# Create GitHub repo and push
gh repo create sentinel-demo-app --public --source . --push

# Set up SentinelLayer token as GitHub secret
sl scan setup-secrets --repo mrrCarter/sentinel-demo-app
# → Secret 'SENTINELAYER_TOKEN' set on mrrCarter/sentinel-demo-app
```

---

## Step 3: Hand the Spec to Your Coding Agent

Paste the following into Claude Code, Codex, or Cursor:

```
Read the files in this project:
- docs/spec.md
- docs/build-guide.md  
- prompts/execution-prompt.md
- AGENT_HANDOFF_PROMPT.md

Then build PR 1: JWT Auth API (see spec for details).
After coding, run:
1. sl review scan --path . --json
2. sl /omargate deep --path . --json  
3. Fix any P0-P2 findings
4. git push && gh pr create
5. Watch Omar Gate: gh run watch $(gh run list --workflow "Omar Gate" --branch feat/jwt-auth --limit 1 --json databaseId --jq ".[0].databaseId") --exit-status
6. Fix if red, merge when green
```

---

## Step 4: PR 1 — JWT Auth API

**Branch:** `feat/jwt-auth`

The agent builds:
- `POST /api/auth/register` — email + password → bcrypt hash → SQLite → JWT
- `POST /api/auth/login` — email + password → verify → JWT (15min expiry)
- `GET /api/auth/me` — Bearer token → user profile
- `src/middleware/verifyToken.js` — rejects expired/invalid JWTs
- Tests: register, login, me (protected), expired token rejection

**Omar Gate Loop:**
```bash
sl review scan --path . --json          # Deterministic code review
sl /omargate deep --path . --json       # Local security scan
git push && gh pr create
# Watch Omar Gate
runId=$(gh run list --workflow "Omar Gate" --branch feat/jwt-auth --limit 1 --json databaseId --jq ".[0].databaseId")
gh run watch $runId --exit-status
# If red: fix findings, push, repeat
# If green: merge
gh pr merge --squash --delete-branch
```

---

## Step 5: PR 2 — Email Verification + AIdenID E2E Test

**Branch:** `feat/email-verify`

The agent adds:
- `POST /api/auth/register` now sends 6-digit OTP via Resend
- `POST /api/auth/verify-email` — accepts { email, code } → marks user verified
- `GET /api/auth/me` includes `emailVerified: true/false`
- Unverified users get 403 on protected routes

**After coding, same Omar Gate loop as PR 1.**

---

## Step 6: AIdenID E2E — The Money Shot

After PR 2 is merged and the app is running locally:

```bash
# 1. Provision a throwaway test email from AIdenID
sl ai identity provision --tags demo,e2e --execute --json
# → { identityId: "id_abc123", email: "test-abc@aidenid.dev" }

# 2. Register with that email (app sends OTP via Resend)
curl -X POST http://localhost:3000/api/auth/register \
  -H "Content-Type: application/json" \
  -d '{"email":"test-abc@aidenid.dev","password":"securepass"}'

# 3. Poll AIdenID until OTP arrives (Resend → Cloudflare → extraction)
sl ai identity wait-for-otp id_abc123 --timeout 30 --json
# → { otp: "482917", confidence: 0.95, source: "RULES" }

# 4. Verify the email
curl -X POST http://localhost:3000/api/auth/verify-email \
  -H "Content-Type: application/json" \
  -d '{"email":"test-abc@aidenid.dev","code":"482917"}'

# 5. Confirm it worked
curl -H "Authorization: Bearer <jwt>" http://localhost:3000/api/auth/me
# → { email: "test-abc@aidenid.dev", emailVerified: true }
```

---

## Step 7: Full Audit

```bash
# Static audit (no running app needed)
sl audit frontend --path . --json

# Runtime audit (with running app + Lighthouse + headers)
sl audit frontend --path . --url http://localhost:3000 --json --stream
# --stream emits NDJSON events in real-time
```

---

## Step 8: Dashboard

### sentinelayer.com/dashboard/runs
- See each CLI run (omargate, review, audit) with timestamps
- Click into a run → Findings tab shows P0/P1/P2/P3
- Audit tab shows full report
- Snapshot tab shows codebase state

### sentinelayer.com/admin/cli
- **Stat cards:** total users, runs, top commands
- **Recent runs table:** command, persona, tokens, cost, duration, status
- **Error stream:** recent failures with request IDs

---

## Extra Demo Features

### 1. Swarm Planning
```bash
sl swarm plan --path . --json
# Shows multi-agent swarm plan (which agents, budget, parallelism)
```

### 2. Interactive Spec Builder
```bash
sl spec list-templates
# → api-service, saas-app, cli-tool, library, mobile-app

sl spec generate --template api-service --path . --json
# Interactive spec generation from template
```

### 3. Cost Tracking
```bash
sl cost --json
# Accumulated cost tracking across all runs (tokens, USD, tool calls)
```

### 4. Policy Packs
```bash
sl policy list
# Shows available policy packs

sl policy use strict
# Switches to strict mode (lower P2 threshold)
```

### 5. Incremental Review
```bash
sl review scan --mode diff --path .
# Reviews only changed files (great for showing incremental scan)
```

### 6. Identity Lineage
```bash
sl ai identity lineage id_abc123 --json
# Shows identity family tree (parent/child relationships)
```

### 7. MCP Registry
```bash
sl mcp list --json
# Lists all MCP registries, adapters, and server configs
```

### 8. Public Scanner
Visit `sentinelayer.com/scan` — enter any URL for a free security scan (3/day limit for anonymous users).

### 9. Pricing Page
Visit `sentinelayer.com/pricing` — shows Free, Pro ($49/mo), and Supporter tiers.

---

## Command Reference (Demo-Relevant)

| Command | What It Does |
|---------|-------------|
| `sl auth login` | Browser OAuth → token mint → local storage |
| `sl auth status` | Show current session |
| `npx create-sentinelayer <name>` | Full project scaffold (docs + code + workflow) |
| `sl scan init` | Generate omar-gate.yml from spec |
| `sl scan setup-secrets --repo <slug>` | Inject SENTINELAYER_TOKEN via gh CLI |
| `sl review scan --path . --json` | Deterministic code review |
| `sl /omargate deep --path . --json` | Local security scan (P0/P1/P2 findings) |
| `sl audit frontend --path . --json --stream` | Full Jules audit with NDJSON streaming |
| `sl ai identity provision --execute --json` | Provision AIdenID email identity |
| `sl ai identity wait-for-otp <id> --timeout 30` | Poll for OTP extraction |
| `sl spec generate` | Generate spec from template |
| `sl cost --json` | Cost tracking summary |
| `sl policy use strict` | Switch policy pack |
| `sl swarm plan --path . --json` | Multi-agent planning |
| `sl mcp list --json` | List MCP registries |

---

## Architecture Flow

```
┌─────────────────────────────────────────────────────────┐
│                    Developer / AI Agent                   │
│                                                          │
│  sl auth login → sl init → code → sl review → push      │
└──────────┬───────────────────────────────────────────────┘
           │
           ▼
┌──────────────────────┐    ┌──────────────────────┐
│   Omar Gate Action    │    │   SentinelLayer API   │
│   (GitHub Actions)    │───▶│   (FastAPI/ECS)       │
│   mrrCarter/          │    │   api.sentinelayer.com │
│   sentinelayer-v1-    │    │                        │
│   action@v1           │    │   - Auth CLI sessions  │
│                       │    │   - Telemetry ingest   │
│   Triggers scan,      │    │   - Spec builder       │
│   polls status,       │    │   - Runs/findings      │
│   blocks PR if P0/P1  │    │   - Admin stats        │
└──────────────────────┘    └──────────┬─────────────┘
                                       │
                                       ▼
                            ┌──────────────────────┐
                            │   SentinelLayer Web   │
                            │   sentinelayer.com     │
                            │                        │
                            │   - /cli-auth          │
                            │   - /dashboard/runs    │
                            │   - /admin/cli         │
                            │   - /pricing           │
                            │   - /scan              │
                            └──────────────────────┘

┌──────────────────────┐
│       AIdenID         │
│   api.aidenid.com     │
│                       │
│   - Identity CRUD     │
│   - Email extraction  │
│   - OTP polling       │
│   - SSE realtime      │
│                       │
│   Cloudflare Worker   │
│   receives email →    │
│   R2 → extraction     │
└──────────────────────┘
```

---

## PR Status Tracker

| PR | Repo | Branch | GH PR | Omar Gate | Status |
|----|------|--------|-------|-----------|--------|
| 150 | create-sentinelayer | `roadmap/pr-150-close-pr96-supersede` | #186 | Waiting | Awaiting approval |
| 151 | create-sentinelayer | `roadmap/pr-151-ai-identity-provision-alias` | #187 | Waiting | Awaiting approval |
| 152 | create-sentinelayer | `roadmap/pr-152-mcp-list-command` | #188 | Waiting | Awaiting approval |
| 153 | create-sentinelayer | `roadmap/pr-153-scan-setup-secrets` | #189 | Waiting | Awaiting approval |
| 154 | create-sentinelayer | `roadmap/pr-154-code-scaffold-templates` | #190 | Waiting | Awaiting approval |

---

## DNS Requirement for AIdenID E2E

For the Resend → AIdenID email flow to work in production:

1. **Cloudflare Email Routing** must be configured for the `aidenid.dev` domain
2. **Resend domain verification** must be completed for `aidenid.dev`
3. **MX records** must route to Cloudflare worker
4. **Fallback for local testing:** Use `POST /v1/internal/inbound-events` to simulate email delivery

---

## Pricing Tiers (sentinelayer.com/pricing)

| Tier | Price | Includes |
|------|-------|----------|
| Free | $0 | Unlimited repos, community policy pack, fail-closed gate |
| Pro | $49/mo | Unlimited managed Omar Gate runs, fast-lane capacity, billing dashboard |
| Supporter | Any amount | Donation model, extends free-tier capacity |

---

## Risk Items

1. **Omar Gate environment approval required** — Each PR needs manual approval of `security-review` environment in GitHub Actions before the scan runs
2. **AIdenID DNS routing** — Email E2E requires domain verification on both Resend and Cloudflare
3. **API uptime** — `api.sentinelayer.com` must be running and healthy for auth, telemetry upload, and spec generation
4. **npm publish** — For `npx create-sentinelayer` to work with latest scaffold changes, a new version must be published after PRs merge
