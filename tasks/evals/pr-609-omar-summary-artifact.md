# PR 609 Eval Evidence: Omar Summary Artifact

Date: 2026-06-22
PR: create-sentinelayer#609
Scope trigger: Omar Gate workflow and scan workflow generation affect review evidence surfaces.

## What Changed

- The hosted Omar Gate workflow now stages `omar-artifacts/summary.json` for trusted runs.
- The summary captures the Omar run id, gate status, P0-P3 counts, selected threshold, action/model contract, and GitHub run URL.
- The summary is written before the existing Omar artifact secret scan and uploaded in the existing `omar-gate-artifacts` artifact.
- `scan init` generated workflows and the legacy BYOK template now upload the same summary contract.
- Workflow contract tests now require the summary artifact fields so future workflow edits cannot silently remove them.

## Eval Impact Assessment

- Prompt changes: no.
- Model-route changes: no.
- Tool allowlist changes: no.
- Policy/routing changes: no.
- Review evidence surface changes: yes. Hosted Omar runs now emit a machine-readable summary artifact in addition to the step summary and existing reports/telemetry.

## Baseline Behavior

Before this PR, hosted Omar uploaded `omar-gate-artifacts`, but runs without generated reports or telemetry only exposed `secret-scan.json`. Local-vs-hosted reconciliation had to scrape logs or GitHub step summaries to recover:

- Omar run id
- gate status
- severity counts
- threshold inputs
- GitHub run URL

That made reconciliation brittle and made it harder for agents to prove whether hosted Omar and local Omar were comparing the same run contract.

## Candidate Behavior

Trusted hosted Omar runs now always produce:

- `omar-artifacts/summary.json`
- `kind: omar_gate_summary`
- `schema_version: 1`
- numeric `findings.P0` through `findings.P3`
- `threshold.severity_gate`
- `threshold.p2_max_allowed`
- `scan.action_ref`
- `scan.managed_llm: false`
- `scan.llm_failure_policy: block`
- `github.run_url`

The file is included in the existing artifact upload path and scanned by the existing artifact secret scanner before upload.

## Validation Evidence

Focused checks:

- `python scripts\ci\check_omar_workflow_contract.py --self-test`
  - result: passed
- `node --test tests\unit.scan-parity.test.mjs`
  - result: `3/3` passed
- `node --test tests\unit.scan-parity.test.mjs tests\unit.commands-contracts.test.mjs --test-name-pattern "scan init"`
  - result: `21/21` passed
- `node --test --test-name-pattern "CLI scan init targets omar-gate workflow" tests\e2e.test.mjs`
  - result: `1/1` passed
- Root workflow YAML parse smoke
  - result: parsed `3` jobs including `omar_scan`
- Generated workflow parse/alignment smoke
  - result: generated `omar_gate` workflow parsed and `validateSecurityReviewWorkflow` reported aligned

Full branch checks:

- `npm run check`
  - result: `335` files passed
- `npm run test:unit`
  - result: `1531/1531` passed
- `npm pack --dry-run`
  - result: package dry-run passed and included the changed generator files
- `git diff --check`
  - result: passed with expected LF/CRLF warnings in changed files
- `node bin\sl.js /omargate deep --path . --no-ai --json --output-dir C:\tmp\sl-cli-audit-artifacts\omar-summary-artifact-local`
  - result: `P0=0`, `P1=0`, `P2=33`, non-blocking

## Residual Risk

This PR does not reconcile local-vs-hosted finding-count differences by itself. It gives agents a stable hosted summary artifact so the next reconciliation lane can consume hosted run metadata without scraping logs.
