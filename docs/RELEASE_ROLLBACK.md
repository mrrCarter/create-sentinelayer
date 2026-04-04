# Release Rollback Runbook

## Purpose
Provide a deterministic rollback path for `create-sentinelayer` npm releases when a published version introduces regression or operational risk.

## Preconditions
- A previous known-good npm package version exists.
- GitHub Actions release checks (`Omar Gate`, `Quality Summary`) are green.
- Rollback operator has permission to publish to npm for this package.

## Validation (Dry)
1. Identify current and previous package versions.
2. Install the previous published version in an isolated prefix.
3. Execute a CLI smoke check:
   - `create-sentinelayer --version`
   - `sentinel --version`
4. Confirm expected version output and non-zero exit absence.

## Execute Rollback
1. Deprecate the bad version (recommended):
   - `npm deprecate create-sentinelayer@<bad-version> "Rollback in progress due to regression"`
2. Re-promote prior stable version by re-publishing from immutable artifact if required.
3. Verify install from registry:
   - `npm install -g create-sentinelayer@<rollback-version>`
   - `create-sentinelayer --version`
4. Announce rollback completion in release notes and incident channel.

## Post-Rollback
- Capture incident summary, root cause, and preventative actions.
- Open remediation PR with failing scenario test coverage before next release.
