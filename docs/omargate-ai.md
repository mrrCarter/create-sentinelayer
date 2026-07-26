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

## Hosted GitHub Gate Contract

The trusted GitHub lane is a two-stage gate. The pinned Action proves that a live review occurred and produced valid artifacts; the consuming workflow then applies this repository's severity policy. Neither stage may infer the other.

### Immutable runtime

- Pin `mrrCarter/sentinelayer-v1-action` to commit `52fe9cf0d0d4656ce2b6f4af0eb5652fa07b31c5`. Do not use a branch or movable tag for merge authority.
- Invoke the Action with `llm_failure_policy: block` and `severity_gate: none`. In this mode, the Action must validate live-LLM evidence before returning `passed`; the consuming workflow remains responsible for the effective P0/P1/P2 threshold.
- Record the exact Action SHA, workflow commit SHA, run id, and observed evidence digest in the retained gate summary.
- Supporting CLI evidence must name an immutable repository commit or a uniquely versioned package artifact. A global binary whose semantic version can resolve to different source trees is not merge evidence.

### Workflow authority

The trusted-context predicate must prove who controls the workflow, validator, and complete secret set, not only where the pull-request branch is hosted. A same-repository `pull_request` workflow is branch-controlled and therefore is privileged only when documented actor restrictions and secret/environment approvals make every permitted branch author part of the trusted computing base. Otherwise, merge authority must run from a protected base workflow or an equivalent external check that treats the proposed code as data and never executes repository-controlled scripts with secrets.

The 2026-07-14 configuration audit found that `security-review` has a required reviewer and protected-branch policy but contains no secrets, while `omar-gate.yml` binds no job to it. Provider, SentinelLayer, release-governance, and legacy npm credential names remain repository-level. The `package-release` environment exists but currently has no protection rules or environment secrets. Secret values and scopes were not read. Before activation, move every still-required privileged credential behind its purpose-specific reviewed environment and protected workflow definition; revoke or remove stale credentials rather than retaining them at repository scope.

Fork and other untrusted pull requests may run a deterministic diagnostic scan with a read-only token and no secrets. That result cannot satisfy the required live gate. The required check remains non-green until a maintainer-mediated trusted run binds the protected workflow commit, exact proposed head/merge commit, Action SHA, and validated artifacts. A `pull_request_target` or `workflow_run` design must not check out and execute untrusted code in a privileged context.

Release authority is part of the same boundary. A uniquely versioned package is admissible only when the publish workflow is protected, the `package-release` environment enforces reviewed protected-ref deployment, and npm trusted publishing is bound to that workflow and environment. A repository-level `RELEASE_GOVERNANCE_TOKEN` or unused legacy `NPM_TOKEN` must not remain available to branch-controlled workflows; move a required governance credential into the reviewed environment and remove or revoke an obsolete npm token.

### Generated workflow parity

The pinned Action accepts hosted scan modes `pr-diff`, `deep`, and `nightly`. The CLI's local `baseline`, `audit`, and `full-depth` persona modes are a different engine contract and must not be emitted as Action inputs or described as hosted parity.

Generated and legacy workflows must derive their accepted input set and mode enum from `action.yml` and `models.py` at the exact pinned Action SHA, with a digest-bound local fixture for hermetic tests. Inputs from the retired bridge surface, including `playwright_mode`, `sbom_mode`, and `wait_for_completion`, are invalid for `52fe9cf0d0d4656ce2b6f4af0eb5652fa07b31c5` and must be removed rather than tolerated as GitHub warnings.

### Required evidence

A trusted run may proceed to severity evaluation only when all of these conditions hold:

1. The Action step completed successfully and emitted `gate_status=passed` from the exact pinned SHA.
2. Action outputs report `llm_attempted=true`, `llm_success=true`, `llm_output_valid=true`, `llm_parse_error_count=0`, and a valid result shape: either a positive `llm_findings_count` with `llm_no_findings_reported=false`, or zero findings with `llm_no_findings_reported=true`.
3. `PACK_SUMMARY.json` is complete and contains `llm_evidence.schema_version=1.0`, `attempted=true`, `success=true`, `output_valid=true`, `usage_recorded=true`, zero parse errors, a non-empty observed engine/provider/model, and positive latency.
4. The summary's reported finding count and explicit-clean flag form the same exclusive result shape as the Action outputs. Requested provider, model, credential presence, and route are diagnostics only; observed values come from `llm_evidence`.
5. `PACK_SUMMARY.json` has `writer_complete=true`, identifies `FINDINGS.jsonl`, and its SHA-256 matches the exact findings file. Run id and P0-P3 counts must agree across Action outputs, the pack summary, and the consumer summary.
6. Artifact paths resolve beneath the expected workspace/run directory after canonicalization and do not escape through absolute paths, traversal, or symlinks.
7. The retained record binds the protected workflow/validator commit and the exact reviewed subject commit. A green result for a different head, merge candidate, or workflow definition is not reusable.

Any missing, malformed, contradictory, or unbound field is a gate error. Validation must parse the JSON artifacts; logs, step-summary prose, requested settings, and a synthetic consumer summary are not substitutes.

### Severity ownership

After live evidence passes, the consumer applies the repository policy to the validated pack counts:

- `P0`: block when P0 is non-zero.
- `P1`: block when P0 or P1 is non-zero.
- `P2`: block when P0/P1 is non-zero or P2 exceeds the configured maximum.

Protected refs may harden this policy but may not relax it unless an explicit protected-ref policy permits that operation. Evidence validation always precedes severity bypass or threshold evaluation.

### Provider outage behavior

A provider-outage classifier may trigger a deterministic diagnostic scan and retain its artifacts. That scan must end non-green for the trusted live-LLM gate and must never be selected as the authoritative `gate_status`, run id, or finding counts. Recovery requires a later valid live run or an explicit human-approved workflow outside the automated merge gate.

### Bootstrap proof

The first workflow that enforces this contract cannot certify itself through the older count-only gate. Before publication it requires:

- an exact-head `workflow_dispatch` run using the pinned Action and a real credential route;
- retained, hash-bound `PACK_SUMMARY.json` and `FINDINGS.jsonl` proving a valid live result;
- hosted tests of the same validator proving at least `attempted=false`, `success=false`, invalid output shape, missing usage, and hash mismatch all block;
- contract tests proving fork diagnostics cannot turn the required check green, subject/workflow SHA mismatches block, and generated inputs/modes are a subset of the pinned Action interface;
- an exact-diff peer review and the repository's deterministic quality gates.

See `tasks/evals/2026-07-14-action-live-llm-evidence-migration.md` for the baseline, compatibility matrix, and acceptance cases.

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
