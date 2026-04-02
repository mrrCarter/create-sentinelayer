---
applyTo: "src/daemon/**/*.js"
---

Daemon Domain Rules

- Preserve deterministic queue ordering, assignment ownership, and replayability.
- Budget violations must remain fail-closed (`quarantine`/`kill`) with explicit reason codes.
- Never weaken kill-switch, lease, or claim-collision safeguards.
- Every new daemon side effect must be represented in reproducible artifacts.
- Do not add unbounded loops or background retries without hard timeout/budget guards.
- Daemon behavior changes require tests for both nominal flow and budget/ownership failure paths.
