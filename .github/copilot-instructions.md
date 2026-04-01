# Sentinelayer CLI Repository Instructions

Scope:
- Repository: `create-sentinelayer`
- Mission: deterministic CLI scaffolding, local security/audit tools, and secure workflow automation.

Engineering rules:
- Keep changes PR-scoped and reversible.
- Preserve backward compatibility for `create-sentinelayer` and `sentinel` binaries.
- Never weaken security gates in workflows (`Quality Gates`, `Omar Gate`).
- Keep local command mode deterministic and machine-readable (`--json` output stability).
- Add or update tests for behavior changes before merge.

Security rules:
- Do not hardcode secrets or tokens.
- Treat workflow permission scopes as least-privilege; justify expansions.
- Preserve pinned actions or pinned major versions with rationale.

Release rules:
- Versioning is automated via release-please.
- npm publish path must validate packaged install before publish.
