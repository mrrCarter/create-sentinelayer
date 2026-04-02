# Release Rollback Runbook

This runbook defines the rollback path for npm releases of `create-sentinelayer`.

## Trigger Conditions

- Security regression in a newly published package version.
- Broken package behavior that blocks install/execute for operators.
- Incorrect release artifact contents.

## Rollback Workflow

1. Open GitHub Actions workflow: `Release Rollback`.
2. Provide:
   - `package_version` (published version to deprecate)
   - `reason` (user-visible deprecation reason)
   - optional `replacement_version`
   - `dry_run=true` first
3. Execute dry-run and review summary output.
4. Re-run with `dry_run=false` to perform `npm deprecate`.
5. Post incident note with:
   - deprecate command result
   - affected version
   - replacement version (if any)
   - follow-up PR/reference

## Controls

- Uses `npm-publish` environment gate.
- Requires `NPM_TOKEN` secret.
- Emits deterministic workflow summary for audit evidence.
