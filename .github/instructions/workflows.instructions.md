---
applyTo: ".github/workflows/**/*.yml"
---

Workflow Authoring Rules

- Keep permissions minimal for every job.
- Prefer deterministic checks (`npm ci`, `npm run verify`).
- Guard deployment/publish steps behind explicit conditions.
- Use pinned action SHAs for high-trust workflows when feasible.
- Any new secret dependency must be documented in workflow comments.
- Do not add long-lived cloud deploy logic to this CLI package repo; backend deploy workflows belong in service repos.
