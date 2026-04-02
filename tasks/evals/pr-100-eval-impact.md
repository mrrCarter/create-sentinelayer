# PR 100 Eval Impact Note

- Date: 2026-04-02
- PR Scope: Eval impact gating foundation only (`quality-gates.yml`, `scripts/eval/eval-check.sh`, `.github/instructions/ai-eval.instructions.md`)
- Behavioral AI Path Changes: none (no prompt/model/provider runtime logic changed)
- Expected Runtime Impact: CI gate adds mandatory evidence check for AI-impacting diffs
- Regression Risk: low

## Baseline vs Candidate

- Baseline: PRs can change AI-impacting files without explicit eval evidence.
- Candidate: AI-impacting diffs must include deterministic evidence under approved eval artifact paths.

## Acceptance

- Quality workflow includes `Eval Impact Gate` job.
- Gate fails when AI-impacting files change without eval evidence.
- Gate passes when approved eval evidence file is included.
