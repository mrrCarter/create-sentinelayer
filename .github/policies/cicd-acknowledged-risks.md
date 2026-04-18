# CI/CD Acknowledged-Risk Register

Static corroboration for findings that recur on every Omar Gate scan because static analysis cannot see the full protection model (environment reviewers, token scopes, repo variables). Each item below is a deliberate design choice with compensating controls.

This file is structured so both LLM and deterministic scanners can key on the cited file:line and match the justification to the finding text.

---

## Risk 1 — `attestations.yml` reviewer enforcement warn-only default

**File:** `.github/workflows/attestations.yml:154-176`
**Recurring finding text:** "Attestation environment reviewer enforcement is warn-only by default on protected refs, allowing attestation execution without human approval unless repo var opt-in is set."

**Design:** default warn-only; strict mode opt-in via repo var `ATTESTATION_REQUIRE_ENV_REVIEWERS_ON_PROTECTED_REF=true`.

**Rationale:**
- Flipping to strict-default without reviewer pre-provisioning blocks the release pipeline entirely. We tried this in PR #336/#339 and had to revert after it blocked the overnight release train.
- The attestation workflow emits a GitHub Actions `::warning::` when reviewers are missing on a protected ref. Warnings are visible on every run's summary page and surface to release operators.
- Compensating controls: (a) attestations are audited artifacts, not code paths; (b) cosign-sign step has separate OIDC-identity check; (c) attestation provenance is cryptographically verifiable out-of-band.

**When to flip:** once the `artifact-attestation` environment in repo settings has at least one required reviewer provisioned. At that point set the repo var and remove this acknowledgment.

**Signed off:** carther / 2026-04-18

---

## Risk 2 — `release-please.yml` branch-protection preflight bypass path

**File:** `.github/workflows/release-please.yml:41-82`
**Recurring finding text:** "Branch-protection preflight contains an explicit bypass (`ALLOW_RELEASE_PREFLIGHT_BYPASS=true`) that permits release automation to proceed when protection validation fails."

**Design:** fail-closed by default; bypass only when (a) admin token `RELEASE_GOVERNANCE_TOKEN` is NOT configured AND (b) repo var `ALLOW_RELEASE_PREFLIGHT_BYPASS=true` is set explicitly. Bypass emits audit metadata to `GITHUB_STEP_SUMMARY` with actor, timestamp, and remediation note.

**Rationale:**
- The preflight uses `branches/main/protection` API, which requires admin-scoped token. Many CI tokens don't have that scope.
- Without the bypass, release automation cannot run at all for repos that haven't provisioned an admin-scoped governance token. That creates a chicken-and-egg where you can't ship until someone ships the governance token config, which requires a release.
- Compensating controls: (a) bypass is only used when admin token is missing (dual condition); (b) every bypass run emits an auditable step summary; (c) downstream jobs still enforce environment reviewers on `package-release`; (d) `actions/setup-node` + OIDC trusted publishing provide cryptographic identity regardless of preflight outcome.

**When to remove:** once every active SentinelLayer repo has `RELEASE_GOVERNANCE_TOKEN` provisioned with admin scope. At that point remove the bypass branch entirely.

**Signed off:** carther / 2026-04-18

---

## Risk 3 — `release.yml` `workflow_dispatch` trigger available

**File:** `.github/workflows/release.yml:7-12`
**Recurring finding text:** "`workflow_dispatch` bypasses actor/signing policy checks, allowing manual release execution without signed-tag provenance enforcement."

**Design:** `workflow_dispatch` is available alongside `push: tags: v*.*.*` so operators can trigger a release from the Actions UI when auto-tagging fails.

**Rationale:**
- `workflow_dispatch` does NOT bypass the `environment: package-release` gate. Every publish/promote job is gated by that environment regardless of trigger source. The environment is configured with required reviewers.
- Trigger source is not a substitute for downstream enforcement. The LLM finding conflates "trigger available" with "trigger bypasses checks"; deterministic inspection of the job graph (see release.yml header comment inserted in this PR) confirms no job with write access runs without environment reviewer approval.
- Compensating controls: (a) `release-authorize`, `release-approval`, `publish-approval`, `publish-candidate`, `promote-latest` all have `environment: package-release`; (b) release tags are SHA-bound so tag-triggered vs dispatch-triggered runs resolve to the same artifacts; (c) SLSA provenance is emitted on both paths.

**Signed off:** carther / 2026-04-18

---

## How this register works

- Omar Gate reads `.github/policies/cicd-acknowledged-risks.md` during deterministic_scan stage.
- Findings that match `(file, line-range, finding-text-prefix)` against an entry in this register are downgraded from P2 to P3 (informational) with a "policy-acknowledged" tag.
- To retire an entry, either (a) ship the behavior change described in "When to flip/remove" and delete the entry, or (b) present new evidence that the compensating controls have regressed and re-open the finding.

## What is NOT in this register

- Anything classified P0 or P1 by Omar. Those require behavior fixes.
- Findings on code paths (not `.github/workflows/`). Code-level findings have their own review path.
- Findings where the compensating control is "we'll add a test later". Those stay open P2 until the test lands.
