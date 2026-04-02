---
applyTo: "src/{ai,review,commands}/**/*.js"
---

AI Eval Gate Rules

- Treat any prompt/model-route/provider-selection behavior change as eval-impacting.
- Pair AI-impacting code changes with deterministic eval evidence under `tasks/evals/`, `.sentinelayer/evals/`, `evals/`, `tests/evals/`, `docs/evals/`, or `reports/evals/`.
- Eval evidence should include baseline and candidate comparison context (input set, observed output deltas, and regression notes).
- Do not bypass eval-impact gates by moving AI logic to unscoped files; keep AI paths explicit and reviewable.
- If behavior is intentionally changed, document expected impact and acceptance criteria in the same PR.
