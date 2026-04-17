# Eval Evidence - PR #335 (Spec + Prompt Session Coordination)

Date: 2026-04-17  
PR: https://github.com/mrrCarter/create-sentinelayer/pull/335  
Scope trigger: AI-impacting prompt surface changed (`src/prompt/generator.js`)

## What changed
- `src/spec/generator.js`: add conditional multi-agent coordination phase generation.
- `src/commands/spec.js`: detect `AGENTS.md` guidance and active `.sentinelayer/sessions/*/metadata.json` sessions during spec generate/regenerate.
- `src/prompt/generator.js`: append session coordination operating rules when spec content includes coordination/session context.
- `src/legacy-cli.js`: scaffold session coordination guidance into TODO/handoff outputs and emit `.sentinelayer/AGENTS_SESSION_GUIDE.md`.
- `tests/unit.spec-session.test.mjs` and `tests/e2e.test.mjs`: add deterministic unit/e2e coverage for new coordination behavior.

## Eval impact assessment
- No model-route/provider changes.
- No tool allowlist changes.
- No auth/token policy changes.
- Prompt behavior change is deterministic and context-gated by generated spec text (`coordination protocol`/`session` keywords).

## Validation evidence
- `node bin/create-sentinelayer.js review --json` (`p0=0`, `p1=0`, `blocking=false`)
- `npm run verify` (pass)
- `node bin/create-sentinelayer.js /omargate deep --path . --json` (`p0=0`, `p1=0`, `blocking=false`)

## Risk summary
- Primary risk: false-positive session-rule injection in generic prompts.
- Mitigation: keyword-gated `shouldAppendSessionGuidance()` + unit coverage for both include and omit paths.
- Residual risk: low; no runtime execution permissions or external API contracts were expanded.
