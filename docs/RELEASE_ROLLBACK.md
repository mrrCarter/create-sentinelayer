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
3. Execute dry-run and review summary output:
   - confirms target version resolves
   - resolves fallback `last-known-good` version
   - prints existing deprecation marker
4. Re-run with `dry_run=false` to execute full rollback path:
   - deprecate bad package version on npm
   - promote fallback package version to `latest` dist-tag
   - execute environment rollback command
   - run healthcheck verification
5. Post incident note with:
   - deprecate command result
   - affected version
   - fallback version promoted to `latest`
   - environment rollback + healthcheck status
   - follow-up PR/reference

## Controls

- Uses `npm-publish` environment gate.
- Requires `NPM_TOKEN` secret.
- Requires `ROLLBACK_DEPLOY_COMMAND` secret for deterministic environment rollback execution.
- Requires `ROLLBACK_HEALTHCHECK_URL` repository variable for post-rollback health validation.
- Emits deterministic workflow summary for audit evidence.
