# Hosted Action Live-LLM Evidence Migration

## Classification

- Class D merge-gate integrity and supply-chain boundary.
- Batch 0I is documentation, specification, and eval criteria only.
- Batch 0J owns workflow, generator, validator, and regression-test changes.
- No prompt, model-routing, credential, production API, or remote repository state changes in 0I.

## Decision

The hosted trusted Omar lane will pin:

```text
mrrCarter/sentinelayer-v1-action@52fe9cf0d0d4656ce2b6f4af0eb5652fa07b31c5
```

The Action will run with `llm_failure_policy=block` and `severity_gate=none`. The Action owns live-execution evidence validity. The create-sentinelayer workflow independently validates the emitted outputs and artifacts, then owns repository P0/P1/P2 merge policy.

This split is intentional. It prevents a severity setting from bypassing execution evidence and prevents the consumer from claiming a live review based only on requested settings or a nominal status.

## Baseline

### Current default branch

- Baseline create-sentinelayer commit: `38db9f258b051e0f642a2e921a224de9a35cbeaf`.
- The trusted workflow pins Action commit `a496be33a466c0cc3f8616d66bbd7d78f7d3c31d`.
- That Action revision does not emit `llm_attempted`, `llm_success`, `llm_output_valid`, usage, structured-result shape, or failure-class outputs.
- The workflow's "Assert Omar LLM contract is active" step validates requested credentials/provider/model and a selected `gate_status`; it does not validate observed provider execution.
- The workflow can select a `llm_failure_policy=deterministic_only` fallback as the authoritative green result after a classified provider outage.
- The primary Action call passes six inputs not declared by `a496be3`: `openai_api_key`, `google_api_key`, `llm_provider`, `max_daily_scans`, `min_scan_interval_minutes`, and `rate_limit_fail_mode`. GitHub warns about undeclared inputs but does not make that mismatch a reliable fail-closed contract.
- For fork pull requests, `omar_enforce` accepts the deterministic-only `omar_untrusted_scan` as the successful required `Omar Gate`; no later trusted live result is required by that check.
- For same-repository pull requests, `trusted_context` is currently a constant `true` after a repository-name condition. The workflow and validation scripts come from the pull-request merge commit, so same-repository origin alone does not prove that privileged gate code is protected from the branch author.
- The `security-review` environment has a required reviewer and protected-branch policy, but no Omar job uses it and it contains no secrets. Provider, SentinelLayer, release-governance, and legacy npm credential names remain repository-level. The `package-release` environment exists with no protection rules or environment secrets. This audit inspected names and policy only, not secret values or token scopes.
- `src/scan/generator.js` and the legacy fallback advertise hosted modes `baseline`, `deep`, `audit`, and `full-depth`. They also emit bridge-only `playwright_mode`, `sbom_mode`, and `wait_for_completion` inputs. The README and parity test currently assert this incompatible surface is aligned.

These conditions can produce a false green: the deterministic scan and severity counts can pass while no live provider call succeeded.

### Hardened Action candidate

- Action commit `52fe9cf0d0d4656ce2b6f4af0eb5652fa07b31c5` is the tree released as `v1.3.9` on its hardened release branch; it is not on the Action repository's current default-branch lineage. Pin the commit, not the tag or branch.
- The candidate accepts every input in the current primary trusted call.
- The current fallback-only `artifact_name_suffix` input is unsupported and must be removed.
- The candidate accepts only `pr-diff`, `deep`, and `nightly` as `scan_mode`; generated and legacy mode lists must be corrected independently from local CLI persona modes.
- The candidate does not declare the generator's `playwright_mode`, `sbom_mode`, or `wait_for_completion` inputs.
- With `llm_failure_policy=block`, the candidate enables `require_llm_success` even when `severity_gate=none`.
- It validates the `PACK_SUMMARY.json` live evidence before severity handling and emits seven evidence outputs: attempted, success, output validity, explicit-clean flag, reported finding count, parse-error count, and failure class.

### CLI provenance incident

The globally installed CLI and the repository package both reported `0.39.2`, but the global orchestrator source hash matched the older `v0.39.2` tag while current `origin/main` contained the later AI-call evidence fix. The stale binary fabricated a P1 from zero customer price despite token-bearing provider calls. Repo-local CLI evidence at the current source commit removed the false P1.

A semantic version that maps to more than one source tree is not acceptable gate provenance. Batch 0J must use repository-local source at an exact commit for bootstrap checks, and the release follow-up must publish a new unique package version containing the evidence fix.

## Compatibility Matrix

| Surface | `a496be3` baseline | `52fe9cf` candidate | 0J migration rule |
|---|---|---|---|
| Primary trusted inputs | Six provider/rate-limit inputs undeclared | Current primary inputs declared | Pin exact candidate SHA and contract-test every input |
| Fallback inputs | Existing call includes `artifact_name_suffix` | Suffix unsupported | Remove suffix; deterministic output is diagnostic only |
| Generated inputs | Bridge-only Playwright/SBOM/wait inputs emitted | Three generated inputs unsupported | Remove them and validate against a digest-bound fixture derived from exact-SHA `action.yml` |
| Hosted modes | Generator claims baseline/deep/audit/full-depth parity | Action accepts pr-diff/deep/nightly | Separate hosted mode vocabulary from local persona modes |
| Existing outputs | Run id, status, counts, artifact paths | Existing outputs preserved | Preserve consumer compatibility, then validate added evidence |
| Live evidence outputs | Missing | Seven structured evidence outputs | Require and cross-check all seven |
| Artifact evidence | Consumer synthesizes summary from selected outputs | Pack contains `llm_evidence` and findings hash | Retain and parse original pack/findings artifacts |
| Failure policy | Deterministic fallback can become selected green | `block` requires valid live evidence | No automated provider-outage green result |
| Severity ownership | Action and consumer both receive policy threshold | Evidence can be validated with Action severity disabled | Action `none`; consumer applies protected policy after evidence |
| Provider/model proof | Requested values recorded | Pack records observed usage metadata | Observed pack fields are authoritative |
| Pin provenance | Default-branch SHA with incomplete contract | Hardened exact SHA off current main lineage | Exact SHA plus repository contract checker; never movable ref |
| Fork pull requests | Deterministic scan can satisfy required check | Live evidence still requires privileged credentials | Diagnostic only until trusted exact-subject promotion |
| Workflow authority | Same-repo origin is treated as trusted | Action pin cannot protect branch-controlled workflow code | Prove protected workflow/validator and secret actor boundary |

## Candidate Evidence Predicate

The consumer must fail before severity evaluation unless all clauses are true.

### Invocation and outputs

1. The trusted-context predicate proves protected workflow/validator provenance and the permitted secret-consuming actor boundary; same-repository origin alone is insufficient.
2. The retained subject SHA exactly identifies the proposed head or merge candidate reviewed, and the workflow SHA identifies the protected definition that ran.
3. The Action step outcome is `success` and the action reference equals the full 40-character candidate SHA.
4. `gate_status` is exactly `passed` and `run_id` matches the bounded run-id grammar.
5. `llm_attempted`, `llm_success`, and `llm_output_valid` are exactly `true`.
6. `llm_parse_error_count` is the integer zero.
7. `llm_findings_count` is a non-negative integer.
8. Exactly one result shape is true:
   - `llm_findings_count > 0` and `llm_no_findings_reported=false`; or
   - `llm_findings_count == 0` and `llm_no_findings_reported=true`.
9. A success result has no contradictory non-empty `llm_failure_class`.

### Original artifacts

1. Resolve `pack_summary_artifact` and `findings_artifact` beneath the expected workspace/run directory using canonical paths. Reject missing files, absolute/traversal escapes, and symlink escapes.
2. Parse `PACK_SUMMARY.json` as JSON and require `writer_complete=true`.
3. Require `run_id`, P0-P3 counts, `findings_file`, and `findings_file_sha256`.
4. Resolve the pack's `findings_file` through the same path boundary and require it to identify the Action's findings artifact.
5. Recompute SHA-256 over `FINDINGS.jsonl` and compare it with `findings_file_sha256` using exact normalized hex.
6. Compute and retain a SHA-256 for `PACK_SUMMARY.json` so the consumer summary is bound to the exact pack reviewed.

### `llm_evidence`

Require `schema_version=1.0`, `attempted=true`, `success=true`, `output_valid=true`, `usage_recorded=true`, `parse_error_count=0`, non-negative `reported_finding_count`, non-empty observed `engine`, `provider`, and `model`, plus finite positive `latency_ms`.

Require the same exclusive findings-or-explicit-clean shape as the outputs. Cross-check the output evidence fields against the pack, and cross-check the Action run id and P0-P3 outputs against the pack. The pack's observed provider/model/engine/route are authoritative; requested settings and secret-presence booleans remain diagnostic metadata only.

### Consumer severity policy

Only after the predicate succeeds, apply the effective protected-ref policy to validated pack counts. Keep existing P0/P1 behavior and the configured P2 maximum. A dispatch may not weaken protected-ref policy unless the existing explicit policy permits it.

## Provider-Outage Contract

- A classified outage may run a deterministic scan for diagnostics and upload it under a distinct non-authoritative artifact name.
- The deterministic scan must not feed `omar_result`, job outputs, attestation gate status, or merge counts.
- A fork/untrusted deterministic scan follows the same non-authoritative rule. It may produce a separate diagnostic check, but the required live check remains non-green until trusted exact-subject promotion.
- The trusted gate must conclude non-green when live evidence is unavailable.
- Recovery is a rerun with valid live evidence or a separately governed human exception. The automated workflow must not encode the exception as a passing LLM review.

## Bootstrap Without Circular Trust

The old hosted gate cannot certify the migration because it is the faulty boundary being replaced. Publication of 0J requires all of the following evidence from the exact candidate commit:

1. A manual `workflow_dispatch` against the exact 0J head with a real provider route.
2. A successful live result whose original pack and findings artifacts are retained and whose hashes, run id, evidence fields, and observed provider/model pass the candidate validator.
3. Hosted execution of the same validator tests proving at minimum these cases block: `attempted=false`, `success=false`, `output_valid=false`, parse errors, missing usage, invalid clean/findings shape, blank observed provider/model/engine, non-positive latency, pack/findings hash mismatch, output/pack mismatch, deterministic selection, workflow/subject SHA mismatch, and untrusted-fork promotion without a trusted run.
4. Repository deterministic quality gates and an exact-diff peer review.
5. The bootstrap record names the workflow commit, Action SHA, validator commit, GitHub run id, pack SHA-256, findings SHA-256, and observed route without exposing credentials or raw provider responses.

No existing count-only Omar check may be cited as proof that these clauses passed.

## 0J Implementation Surface

Update every Action pin and generated contract together:

- `.github/workflows/omar-gate.yml`
- the Action lock/contract checker
- the workflow generator and generated-workflow tests
- the legacy workflow template
- wrapper/contract fixtures that pin the Action SHA
- the README's hosted-mode contract and a digest-bound fixture derived from exact-SHA Action `action.yml` and `models.py`

Extract the evidence validation into one testable structured-data validator reused by the workflow. Do not duplicate shell string checks across primary, generated, and legacy paths. Remove unsupported inputs, preserve existing public workflow outputs, retain original Action artifacts, and extend the summary with immutable provenance and evidence digests.

## Implementation Sequencing

- 0J implements the immutable pin, evidence validator, artifact retention, provider-outage behavior, generated/legacy interface parity, and exact-subject binding.
- 0K establishes protected workflow-definition authority and trusted promotion for fork/untrusted changes, or proves an equivalent GitHub actor/environment policy. It must treat proposed code as data, must not execute branch-controlled commands with secrets, and must move all still-required provider, SentinelLayer, and release-governance credentials out of repository scope into purpose-specific reviewed environments. Obsolete repository-level credentials must be revoked or removed.
- 0L configures `package-release` with reviewed protected-ref deployment, binds npm trusted publishing to the protected release workflow and environment, publishes a uniquely versioned CLI package containing the post-`#778` evidence code, and records its tarball integrity. It must not rely on a repository-level classic npm token.
- 0J must not be described or activated as a trustworthy merge gate until 0K is proven. The 0J/0K train uses the non-circular bootstrap evidence rather than the old count-only check.

## Security References

- [GitHub: Securely using `pull_request_target`](https://docs.github.com/en/actions/reference/security/securely-using-pull_request_target)
- [GitHub: Workflow execution protections](https://docs.github.com/en/repositories/managing-your-repositorys-settings-and-features/actions-policies/workflow-execution-protections)

## Acceptance Cases

| Case | Evidence validator | Consumer severity gate |
|---|---|---|
| Live explicit-clean result, valid usage and hashes, zero blocking counts | Pass | Pass |
| Live valid findings result with P1 | Pass | Block |
| Action says `passed`, but `attempted=false` | Block | Not evaluated |
| Action says `passed`, but usage is absent | Block | Not evaluated |
| Requested OpenAI/Google/managed route exists, but observed provider is blank | Block | Not evaluated |
| Pack reports clean while output reports findings | Block | Not evaluated |
| Findings bytes do not match pack SHA-256 | Block | Not evaluated |
| Provider outage followed by deterministic clean scan | Block | Not evaluated |
| Fork deterministic scan is clean but no trusted exact-subject run exists | Block | Not evaluated |
| Same-repo origin with branch-controlled privileged workflow and no actor/environment proof | Block | Not evaluated |
| Valid live artifacts are bound to a different subject or workflow SHA | Block | Not evaluated |
| Generated workflow emits unsupported Action input or mode | Contract failure | Not evaluated |
| Movable Action ref or unexpected SHA | Block | Not evaluated |
| Stale global CLI reports the expected semantic version only | Not admissible | Not evaluated |

## Rollback

- Revert the isolated 0J commit and leave the trusted gate non-green until the previous behavior is deliberately reauthorized.
- Do not restore deterministic fallback as an automated green path.
- No credential rotation, data migration, API mutation, or retained-artifact deletion is required for rollback.

## 0I Verification

- Documentation links and formatting pass.
- The exact candidate Action source and current workflow are the evidence for the matrix above.
- No workflow or runtime file changes in this batch.
- Claude exact-diff review is required before 0J implementation is considered review-complete.
