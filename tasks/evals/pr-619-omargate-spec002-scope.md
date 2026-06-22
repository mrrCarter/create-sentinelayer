# Eval Evidence: Omar SL-SPEC-002 Calibration and Default Scope

Date: 2026-06-22

## Scope

This PR changes local Omar Gate calibration and default scan scope behavior.

Touched behavior files:

- `src/review/spec-binding.js`
- `src/legacy-cli.js`

## Baseline

Before this change, `SL-SPEC-002` spec-coverage findings emitted as P2. On large repos with intentionally incomplete route/spec coverage, this inflated security-blocking P2 counts even when the finding class was governance/spec hygiene rather than an exploitable vulnerability.

Local `sl /omargate deep` also defaulted to full-repo scope unless an operator explicitly passed diff or staged mode. That made local PR/dogfood checks noisier than hosted PR checks and hid the signal from the changed files under unrelated historical findings.

## Candidate

The candidate keeps `SL-SPEC-001` severity unchanged, reclassifies only `SL-SPEC-002` to P3/non-blocking, and preserves the existing suggested fix text.

The candidate also makes local `/omargate deep` default to changed-file diff scope when the target repo has tracked or staged git deltas. Explicit `--scope-mode full` remains the escape hatch for full-repo audits, and untracked-only worktrees continue to use full scope so brand-new untracked files are not silently ignored.

Prompt text, provider routing, model selection, persona reconciliation, and deterministic finding parsing are unchanged.

## Risk Assessment

- Security risk: low. Exploit-class findings and `SL-SPEC-001` remain at their existing severities.
- Signal quality risk: reduced. Spec-coverage gaps remain visible as P3 without blocking unrelated security work.
- Backward compatibility risk: low. Operators can still force full scans with `--scope-mode full`.
- Untracked-file risk: controlled. Untracked-only repositories keep full scope by default.
- CI parity risk: reduced. Local dogfood Omar defaults now better match PR-changed-file review expectations.

## Verification

Local proof on the updated PR head after rebasing onto `0.28.1` main:

- Focused unit/Omar suite passed: `node --import ./tests/setup-env.mjs --test tests/unit.review-spec-binding.test.mjs tests/unit.omargate-orchestrator.test.mjs tests/unit.omargate-cache.test.mjs`
- Result: 17 tests passed, 0 failed.
- Tracked-delta smoke from the earlier audit showed default scope resolved to diff and scanned exactly the changed tracked files.
- Untracked-only smoke from the earlier audit showed default scope stayed full, preserving untracked-file visibility.

Hosted PR gates after branch update are expected to remain green for Omar Gate, Quality Gates, and Build Attestation before merge.
