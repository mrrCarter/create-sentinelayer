# Omar Gate AI Analysis — Reference

## Overview

Omar Gate is SentinelLayer's security review engine. It runs two phases:

1. **Deterministic** (~2s) — 22 pattern-based rules (credentials, injection, XSS, CORS, etc.)
2. **AI Analysis** (~30s–5min) — 13 domain-specific personas analyze code via LLM

## Scan Modes

| Mode | Personas | Time | Cost | Use Case |
|------|----------|------|------|----------|
| `baseline` | 1 (security) | ~30s | ~$0.25 | Quick pre-push check |
| `deep` | 6 (security, architecture, testing, performance, compliance, reliability) | ~2min | ~$1.50 | Default PR review |
| `full-depth` | 13 (all personas) | ~5min | ~$5.00 | Release gate, audit |

## Commands

```bash
# Default deep scan (6 personas)
sl omargate deep --path . --json

# Full 13-persona scan with streaming
sl omargate deep --scan-mode full-depth --stream

# Security-only baseline
sl omargate deep --scan-mode baseline --json

# Deterministic only (no AI, fastest)
sl omargate deep --no-ai --json

# Custom budget and model
sl omargate deep --scan-mode deep --max-cost 3.00 --model gpt-5.3-codex

# Dry-run (no LLM calls, generates prompts only)
sl omargate deep --ai-dry-run --json
```

## Flags

| Flag | Default | Description |
|------|---------|-------------|
| `--path <path>` | `.` | Target repository path |
| `--scan-mode <mode>` | `deep` | Scan depth: baseline, deep, full-depth |
| `--no-ai` | false | Skip AI layer (deterministic only) |
| `--ai-dry-run` | false | Generate prompts without calling LLM |
| `--model <id>` | `gpt-5.3-codex` | LLM model override |
| `--provider <name>` | auto-detect | Provider: sentinelayer, openai, anthropic, google |
| `--max-cost <usd>` | `5.0` | Global cost ceiling |
| `--max-parallel <n>` | `4` | Max concurrent persona calls |
| `--stream` | false | Emit NDJSON events to stdout |
| `--json` | false | Machine-readable output |

## Personas

| ID | Name | Domain | Confidence Floor |
|----|------|--------|-----------------|
| security | Nina Patel | AuthZ, secrets, injection, crypto | 0.85 |
| architecture | Maya Volkov | Coupling, complexity, boundaries | 0.82 |
| testing | Priya Raman | Coverage gaps, flaky tests | 0.80 |
| performance | Arjun Mehta | N+1 queries, latency, memory | 0.80 |
| compliance | Leila Farouk | PII, GDPR, SOC2, HIPAA | 0.82 |
| reliability | Noah Ben-David | Timeouts, retries, circuit breakers | 0.80 |
| release | Omar Singh | CI/CD integrity, artifact signing | 0.80 |
| observability | Sofia Alvarez | Telemetry gaps, alerting | 0.78 |
| infrastructure | Kat Hughes | IAM, network, encryption | 0.78 |
| supply-chain | Nora Kline | CVEs, pinning, SBOM | 0.82 |
| frontend | Jules Tanaka | XSS, a11y, bundle, CLS | 0.76 |
| documentation | Samir Okafor | Runbooks, API docs | 0.75 |
| ai-governance | Amina Chen | Prompt injection, guardrails | 0.76 |

## LLM Provider Resolution

1. Explicit `--provider` flag
2. Config file `defaultProvider`
3. Environment variable detection (`OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, etc.)
4. Stored SentinelLayer session → proxy via `POST /api/v1/proxy/llm`
5. Fallback: `openai`

After `sl auth login`, the SentinelLayer proxy is auto-detected. Users never need their own API keys.

## NDJSON Streaming Events

When `--stream` is enabled, events are emitted as one JSON object per line:

```jsonl
{"stream":"sl_event","event":"omargate_start","payload":{"runId":"...","mode":"deep","personas":["security","architecture",...]}}
{"stream":"sl_event","event":"persona_start","payload":{"personaId":"security"}}
{"stream":"sl_event","event":"persona_finding","payload":{"personaId":"security","severity":"P1","file":"src/auth.js","line":42,...}}
{"stream":"sl_event","event":"persona_complete","payload":{"personaId":"security","findings":3,"costUsd":0.25}}
{"stream":"sl_event","event":"persona_skipped","payload":{"personaId":"documentation","reason":"global_budget_exhausted"}}
{"stream":"sl_event","event":"omargate_complete","payload":{"findings":12,"summary":{"P0":0,"P1":2,"P2":7,"P3":3},"totalCostUsd":1.45}}
```

## Budget Governance

- Global ceiling: `--max-cost` (default $5.00)
- Per-persona: `max(0.25, global / persona_count)`
- Running cost tracker skips remaining personas when budget exhausted
- `persona_skipped` event emitted with reason

## Output Schema (--json)

```json
{
  "command": "/omargate deep",
  "targetPath": "/path/to/repo",
  "scannedFiles": 234,
  "p0": 0, "p1": 2, "p2": 7, "p3": 3,
  "blocking": true,
  "deterministic": {
    "findings": 90,
    "summary": { "P0": 0, "P1": 14, "P2": 76, "P3": 0 }
  },
  "ai": {
    "findings": 12,
    "summary": { "P0": 0, "P1": 2, "P2": 7, "P3": 3 },
    "model": "gpt-5.3-codex",
    "costUsd": 1.45,
    "dryRun": false
  }
}
```

## Integration with Dashboard

After each scan, results are synced to `sentinelayer.com/dashboard/runs` via fire-and-forget telemetry. The dashboard shows:
- Per-persona findings, cost, and duration
- Combined severity counts
- Run history with trending
