# SentinelLayer CLI — Showcase Guide

> Bootstrap your entire security-first development workflow from a single CLI.

---

## The 13 Domain Specialist Personas

SentinelLayer deploys 13 AI personas — each an isolated specialist with their own tools, budget, and bias. They work in parallel during audits, never sharing context with each other, then reconcile through Omar Gate.

| Persona | Domain | Specialty | Bias |
|---------|--------|-----------|------|
| 🎯 **Jules Tanaka** | Frontend Runtime | React/Next.js/Vue — hydration, render cost, a11y, bundle weight, mobile | "User-perceived performance over vanity optimization" |
| 🛡️ **Nina Patel** | Security Overlay | AuthZ, secrets, injection, policy bypass, externally reachable abuse | "Assume hostile inputs until proven safe" |
| ⚙️ **Maya Volkov** | Backend Runtime | Request handling, crashes, unbounded work, validation gaps, trust boundaries | "Every request is potentially adversarial" |
| 🧪 **Priya Raman** | Testing & Correctness | Regression coverage, false confidence, broken invariants | "Tests that pass but miss real bugs are worse than no tests" |
| 🚀 **Omar Singh** | Release Engineering | CI/CD integrity, artifact provenance, bypassable gates, deploy automation | "Every deployment is a security boundary" |
| 💎 **Ethan Park** | Code Quality | Complexity hotspots, unsafe shortcuts, brittle structure, maintenance risks | "Simplicity is a security feature" |
| 🏗️ **Kat Hughes** | Infrastructure | IAM blast radius, public exposure, network posture, secrets placement | "Least privilege by default" |
| 🗄️ **Linh Tran** | Data Layer | Query safety, migration drift, integrity failures, tenancy leaks | "Data integrity is non-negotiable" |
| 📊 **Sofia Alvarez** | Observability | Missing telemetry, broken alerting, weak auditability, blind spots | "If you can't observe it, you can't secure it" |
| 🔄 **Noah Ben-David** | Reliability/SRE | Timeout safety, retry storms, backlog growth, partial failure handling | "Graceful degradation over silent failure" |
| 📝 **Samir Okafor** | Documentation | Operational drift between docs and code, missing runbook steps | "Documentation is a contract, not decoration" |
| 📦 **Nora Kline** | Supply Chain | Dependency risk, provenance gaps, pinning drift, artifact trust | "Every dependency is a trust decision" |
| 🤖 **Amina Chen** | AI Governance | Prompt injection, tool abuse, eval regressions, guardrail bypass | "AI autonomy requires proportional governance" |

---

## How Everything Works Together

```
┌─────────────────────────────────────────────────────────┐
│  1. SCAFFOLD                                             │
│  sl init → spec + prompt + guide + Omar Gate workflow    │
└─────────────────────┬───────────────────────────────────┘
                      ▼
┌─────────────────────────────────────────────────────────┐
│  2. BUILD                                                │
│  Your coding agent follows the generated prompt          │
│  (Claude Code, Cursor, Copilot, Codex — any agent)      │
└─────────────────────┬───────────────────────────────────┘
                      ▼
┌─────────────────────────────────────────────────────────┐
│  3. LOCAL REVIEW                                         │
│  sl review → 22-rule deterministic scan + AI reasoning   │
│  Catches issues BEFORE push (saves Omar Gate round-trips)│
└─────────────────────┬───────────────────────────────────┘
                      ▼
┌─────────────────────────────────────────────────────────┐
│  4. OMAR GATE (CI)                                       │
│  GitHub Action → 7-layer deterministic + LLM review      │
│  Blocks merge on P0/P1 findings                          │
└─────────────────────┬───────────────────────────────────┘
                      ▼
┌─────────────────────────────────────────────────────────┐
│  5. DEEP AUDIT                                           │
│  sl audit deep → 13 personas in parallel                 │
│  sl audit frontend → Jules Tanaka with sub-agent swarm   │
│  Lighthouse + DevTools + authenticated page inspection    │
└─────────────────────┬───────────────────────────────────┘
                      ▼
┌─────────────────────────────────────────────────────────┐
│  6. E2E TESTING WITH AIDENID                             │
│  sl ai provision-email → ephemeral identity              │
│  sl swarm run → Playwright QA with real login flows      │
│  OTP extraction → verify authenticated experience        │
└─────────────────────┬───────────────────────────────────┘
                      ▼
┌─────────────────────────────────────────────────────────┐
│  7. AUTONOMOUS FIX                                       │
│  Jules fix cycle: Jira ticket → worktree fix → PR →      │
│  Omar Gate watch → merge → Jira close → S3 archive       │
└─────────────────────┬───────────────────────────────────┘
                      ▼
┌─────────────────────────────────────────────────────────┐
│  8. MONITOR                                              │
│  Pulse daemon → stuck detection → Slack/Telegram alerts  │
│  Error routing → persona assignment → autonomous fix     │
└─────────────────────────────────────────────────────────┘
```

---

## Use Case 1: Developer Scaffolding a New Project

**Who:** Solo developer starting a SaaS app
**Time:** 5 minutes from zero to fully governed project

```bash
# Install
npm install -g sentinelayer-cli

# Authenticate
sl auth login

# Scaffold — generates spec, prompt, guide, Omar Gate workflow
npx sentinelayer-cli my-saas-app

# The CLI:
# ✅ Generates docs/spec.md with phases, schema, endpoints, security checklist
# ✅ Generates prompts/execution-prompt.md for your coding agent
# ✅ Generates docs/build-guide.md with phase-by-phase instructions
# ✅ Generates .github/workflows/omar-gate.yml
# ✅ Injects SENTINELAYER_TOKEN into GitHub secrets
# ✅ Creates tasks/todo.md and AGENT_HANDOFF_PROMPT.md

# Your coding agent can now follow the prompt and build
# Every PR goes through Omar Gate automatically
```

---

## Use Case 2: Frontend Team Deep Audit

**Who:** React/Next.js team before a release
**Time:** 2-5 minutes depending on codebase size

```bash
# Run Jules Tanaka on your frontend
sl audit frontend --path . --stream

# Jules will:
# 🎯 Detect framework (Next.js 14, App Router, Zustand, Tailwind)
# 🎯 Run 24 deterministic checks (security sinks, state hooks, a11y, bundle, etc.)
# 🎯 Spawn sub-agent swarm for large codebases (FileScanner + PatternHunter)
# 🎯 Stream findings in real time to your terminal
# 🎯 Produce JULES_AUDIT.json with evidence-backed findings

# With a deployed URL — also runs Lighthouse + security headers
sl audit frontend --path . --url https://app.example.com --stream

# Jules checks:
# 📊 Lighthouse performance, accessibility, SEO scores
# 🔒 Security headers (HSTS, CSP, X-Frame-Options)
# 🍪 Cookie security (httpOnly, Secure, SameSite flags)
# 📱 Network waterfall timing (DNS, TLS, TTFB)
```

---

## Use Case 3: Security Team Full DD Audit

**Who:** CISO or security engineer before a major release or acquisition
**Time:** 10-15 minutes for comprehensive 13-persona audit

```bash
# Run all 13 personas in parallel
sl audit deep --path . --stream --max-cost 25.00

# Dispatches:
# 🛡️ Nina Patel checking authZ, secrets, injection paths
# ⚙️ Maya Volkov checking backend request handling
# 🎯 Jules Tanaka checking frontend hydration, XSS, a11y
# 🧪 Priya Raman checking test coverage gaps
# 🚀 Omar Singh checking CI/CD integrity
# 💎 Ethan Park checking code complexity
# 🏗️ Kat Hughes checking infrastructure blast radius
# 🗄️ Linh Tran checking data layer safety
# 📊 Sofia Alvarez checking observability gaps
# 🔄 Noah Ben-David checking reliability patterns
# 📝 Samir Okafor checking documentation drift
# 📦 Nora Kline checking supply chain risks
# 🤖 Amina Chen checking AI governance surfaces

# Produces unified DD package with:
# - Per-persona findings with evidence
# - Cross-persona reconciliation
# - Executive summary
# - Compliance-ready artifact chain
```

---

## Use Case 4: AIdenID E2E Login Flow Testing

**Who:** QA engineer testing signup/login/verification
**Time:** 2-3 minutes for full flow

```bash
# Provision an ephemeral test identity
sl ai provision-email --tags "e2e-signup-test" --ttl 3600 --execute
# → Returns: test-abc123@aidenid.com

# Run swarm with Playwright to test signup flow
sl swarm run --scenario-file scenarios/signup.sls --engine playwright --execute

# The scenario:
# 1. Navigate to /signup
# 2. Fill email with provisioned AIdenID address
# 3. Fill password
# 4. Submit form
# 5. Wait for OTP email

# Extract OTP from inbound email
sl ai identity wait-for-otp <identity-id> --timeout 60
# → Returns: { otp: "483921", confidence: 0.99 }

# Complete verification
# (Agent uses extracted OTP to complete signup)

# Audit the authenticated experience
sl audit frontend --url https://app.example.com --stream
# Jules logs in with the test identity and audits:
# - Cookie security on authenticated pages
# - Console errors after login
# - DOM structure of dashboard
# - Security headers on protected routes

# Clean up
sl ai identity revoke <identity-id>
```

---

## Use Case 5: End-to-End — From Idea to Production

**Scenario:** Build a login system with email/password auth (no Google/GitHub — pure in-house)

### Phase 1: Scaffold

```bash
npx sentinelayer-cli secure-login-app
# Description: "In-house email/password login system with OTP verification,
#               session management, and password reset flow"
# The spec generator detects auth patterns and auto-adds:
# → AIdenID E2E Verification phase
# → Security-focused acceptance criteria
```

### Phase 2: Build

Your coding agent (Claude Code, Cursor, etc.) follows the generated prompt:
```bash
# Agent reads prompts/execution-prompt.md and builds:
# - /signup route with email + password
# - /login route with session cookie
# - /verify-email route with OTP input
# - /forgot-password route
# - /reset-password route
# - Server-side session management
# - Rate limiting on auth endpoints
```

### Phase 3: Local Review Before Push

```bash
sl review --diff
# 22-rule deterministic scan catches:
# - Hardcoded secrets in auth config
# - Missing rate limiting patterns
# - SQL injection in query construction
# - Missing CSRF tokens on forms
```

### Phase 4: Omar Gate on PR

```bash
git push origin feature/login-system
gh pr create
# Omar Gate automatically:
# - Runs 7-layer deterministic analysis
# - Checks spec compliance (does implementation match spec?)
# - Posts findings as PR comment
# - Blocks merge on P0/P1 issues
```

### Phase 5: Deep Frontend Audit

```bash
sl audit frontend --path . --url http://localhost:3000 --stream
# Jules checks:
# - Login form accessibility (labels, keyboard nav, focus management)
# - Password field autocomplete attributes
# - Session token storage (localStorage vs httpOnly cookie)
# - CSRF protection on login/signup forms
# - Error message information leakage
# - Rate limiting UI feedback
```

### Phase 6: AIdenID Live E2E Test

```bash
# Provision test identity
sl ai provision-email --tags "login-e2e" --execute
# → test-user@aidenid.com

# Run E2E: signup → receive OTP → verify → login → authenticated dashboard
sl swarm run --engine playwright --execute \
  --start-url http://localhost:3000/signup

# AIdenID extracts OTP from inbound email
sl ai identity wait-for-otp <id> --timeout 60
# → { otp: "738291" }

# Verify the full flow worked:
# ✅ Account created in database
# ✅ OTP email received and extracted
# ✅ Verification completed
# ✅ Login successful with session cookie
# ✅ Authenticated dashboard accessible
# ✅ Cookie has httpOnly + Secure + SameSite=Lax

# Clean up
sl ai identity revoke <id>
```

### Phase 7: Merge and Monitor

```bash
# Omar Gate passed, PR merged
# Pulse daemon monitors for production errors
# If auth errors detected → Jules auto-triages → Jira ticket → fix cycle
```

---

## Use Case 6: Vibe Coder Safety Net

**Who:** Non-technical founder using AI to build a product
**Problem:** AI-generated code accumulates tech debt 3x faster

```bash
# After AI generates code, run review before pushing
sl review --path .
# Catches the things AI gets wrong:
# - Hardcoded API keys the AI generated
# - eval() calls the AI thought were fine
# - Missing input validation on user-facing forms
# - XSS vulnerabilities from dangerouslySetInnerHTML

# One command to know if your AI-built code is safe to ship
sl audit deep --path . --json
# Returns structured P0/P1/P2/P3 findings
# P0 = stop everything, P1 = fix before launch
```

---

## Use Case 7: Enterprise Compliance (SOC 2 / EU AI Act)

**Who:** Compliance officer or CISO
**Need:** Audit trail proving AI-generated code was reviewed

```bash
# Every SentinelLayer operation produces tamper-evident artifacts:
ls .sentinelayer/reports/
# JULES_AUDIT.json          — findings with evidence
# OMAR_BASELINE.json        — deterministic baseline results
# RECONCILIATION.json       — how findings were reconciled
# timeline.ndjson           — chain-hashed event log
# timeline.sha256           — integrity verification

# Artifacts uploaded to S3 with AES-256 encryption + object lock
# Delegation chain: every AI action traces to a human decision-maker
# Budget enforcement: agents can never exceed allocated spend

# Export for auditors
sl audit deep --path . --json > audit-evidence.json
```

---

## Cross-Product Integration Map

```
sentinelayer-cli (npm)
    ├── sl init           → Generates spec + prompts + Omar Gate workflow
    ├── sl spec generate  → Project specification from codebase analysis
    ├── sl review         → Local 22-rule + AI review before push
    ├── sl audit deep     → 13-persona parallel audit
    ├── sl audit frontend → Jules Tanaka frontend specialist
    ├── sl swarm run      → Playwright QA with governed agents
    ├── sl daemon         → Error intake + Jira lifecycle + budget governance
    └── sl ai provision   → AIdenID ephemeral identity provisioning

Omar Gate (GitHub Action)
    ├── Automatic on every PR (push trigger)
    ├── 7-layer deterministic analysis
    ├── LLM-enhanced deep scan
    ├── Spec binding (finds drift from spec)
    └── Merge blocking on P0/P1

AIdenID (aidenid.com)
    ├── Ephemeral email provisioning
    ├── OTP extraction (regex → LLM fallback)
    ├── Child identity hierarchies
    ├── Temporary callback domains
    └── Identity lifecycle: create → activate → use → expire → squash

Builder Studio (sentinelayer.com)
    ├── Web-based spec builder
    ├── Runtime dashboard with live action timeline
    ├── URL scanner (Lighthouse + security headers)
    ├── Run history and evidence viewer
    └── Admin dashboard with error streams
```

---

## Quick Reference: All CLI Commands

| Command | What It Does |
|---------|-------------|
| `sl init` | Scaffold project with full governance setup |
| `sl spec generate` | Generate SPEC.md from codebase |
| `sl spec regenerate` | Update spec preserving manual edits |
| `sl prompt generate` | Generate AI execution prompt |
| `sl guide generate` | Generate build guide |
| `sl scan init` | Generate Omar Gate workflow |
| `sl review` | Local deterministic + AI review |
| `sl review --diff` | Review only changed files |
| `sl audit deep` | Full 13-persona parallel audit |
| `sl audit frontend` | Jules Tanaka frontend audit |
| `sl audit security` | Nina Patel security audit |
| `sl ai provision-email` | Provision AIdenID identity |
| `sl ai identity list` | List active identities |
| `sl ai identity wait-for-otp` | Wait for OTP extraction |
| `sl swarm run` | Execute governed QA swarm |
| `sl daemon error` | Error event intake |
| `sl daemon jira` | Jira ticket lifecycle |
| `sl daemon budget` | Budget governance status |
| `sl config set` | Set configuration |
| `sl cost show` | Cost tracking summary |
| `sl auth login` | Authenticate |

---

*Built by SentinelLayer. Every agent action governed. Every finding evidence-backed. Every artifact tamper-evident.*
