# CTO Revalidation + AppSec E2E Gap Audit (2026-04-05)

## Scope
- Revalidated the current `create-sentinelayer` posture against the quoted CTO memo.
- Audited `create-sentinelayer/src` for reusable architecture/patterns that can accelerate mature AppSec-suite behavior.
- Verified whether mapping is true AST-based, and compared current deterministic ingest + hybrid mapping against the target.
- Produced an implementation-ready PR-by-PR batch roadmap.

## Reproduction Evidence
1. `npm run verify` passed on 2026-04-05:
   - E2E: 86 passing, 0 failing.
   - Unit: 219 passing, 0 failing.
   - Coverage summary: statements 90.22%, branches 71.02%, functions 92.03%, lines 90.22%.
2. CI/workflow/security gating validated from workflow files.
3. Auth/session, schema strictness, ingest/mapping, daemon, telemetry, and MCP registry validated directly from source with line-level references below.
4. Presence/absence checks run for enterprise AppSec components (`codeql`, `semgrep`, `snyk`, `trivy`, `gitleaks`, `cyclonedx`, `spdx`, `attest-build-provenance`, `dependabot`) in `.github`, `src`, `README.md`, and `package.json`.

## Executive Revalidation (Current State)
### Confirmed
- **Promising, security-minded alpha**: confirmed.
- **Not enterprise production-ready yet**: confirmed.
- **Best fit today: pilot/internal platform incubation**: confirmed.

### Score Revalidation (evidence-based)
- Robustness: **7.5/10** (slightly higher than memo due test breadth and deterministic contracts).
- Security posture: **7.5/10** (same as memo; strong guardrails, still missing full AppSec stack depth).
- Operational maturity: **6.0/10** (slightly higher than memo because daemon/operator/watchdog lanes are now substantial).
- Enterprise production readiness: **5.5/10** (still below enterprise bar; supply-chain/SAST/compliance evidence stack incomplete).

## Evidence: What Is Strong Right Now

### 1) CLI packaging and command surface maturity
- Alpha version is explicit: `package.json:3`.
- AWS/GH-style command packaging with aliases is present: `package.json:14-18`.
- Verify pipeline is codified and deterministic: `package.json:12`.

### 2) CI/CD quality gates and release discipline
- Node matrix + coverage + E2E + pack checks in quality pipeline:
  - `.github/workflows/quality-gates.yml:52-59`
  - `.github/workflows/quality-gates.yml:79-104`
  - `.github/workflows/quality-gates.yml:106-127`
- Required quality summary aggregation:
  - `.github/workflows/quality-gates.yml:129-143`
- Release job blocks on upstream gate checks (`Quality Summary`, `Omar Gate`):
  - `.github/workflows/release.yml:46-84`
- Release uses immutable tarball artifact handoff and npm provenance publish:
  - `.github/workflows/release.yml:98-104`
  - `.github/workflows/release.yml:125-143`
- Release-please concurrency and pinned action SHA:
  - `.github/workflows/release-please.yml:18-23`

### 3) Omar Gate separation and blocking thresholds
- Dedicated Omar Gate workflow with secure environment and secrets validation:
  - `.github/workflows/omar-gate.yml:44-68`
- Runs `mrrCarter/sentinelayer-v1-action` with Codex model settings:
  - `.github/workflows/omar-gate.yml:69-85`
- Explicit P0/P1/P2 threshold enforcement and summary outputs:
  - `.github/workflows/omar-gate.yml:86-150`

### 4) Schema rigor and MCP contract safety
- Strict Zod contracts (`.strict()` across MCP/adapter/server schemas):
  - `src/mcp/registry.js:26-216`
- JSON Schema generation with `additionalProperties: false` across object levels:
  - `src/mcp/registry.js:223-334`
- AIdenID adapter-to-registry cross-validation prevents tool binding drift:
  - `src/mcp/registry.js:548-565`
- Deterministic JSON artifact writing with trailing newline:
  - `src/mcp/registry.js:578-613`

### 5) Auth/session foundations are robust
- Browser auth start + polling flow:
  - `src/auth/service.js:128-198`
- API token issuance/revocation and near-expiry rotation:
  - `src/auth/service.js:207-289`
- Persisted login/session management and lifecycle operations:
  - `src/auth/service.js:324-403`
  - `src/auth/service.js:550-799`
- Keyring support with secure file fallback and kill switch (`SENTINELAYER_DISABLE_KEYRING`):
  - `src/auth/session-store.js:65-89`
  - `src/auth/session-store.js:292-309`

### 6) Deterministic artifact philosophy is real
- JSON/NDJSON write discipline with newline termination:
  - `src/telemetry/ledger.js:266-275`
  - `src/commands/watch.js:412`
  - `src/commands/watch.js:479`
  - `src/ingest/engine.js:810`
  - `src/daemon/error-worker.js:227`
- `--json` is pervasive across command surfaces (auth/audit/scan/review/swarm/daemon/mcp/etc):
  - example anchors: `src/commands/auth.js:85`, `src/commands/review.js:237`, `src/commands/scan.js:358`, `src/commands/daemon/core.js:50`.

### 7) Daemon/control-plane foundations are materially advanced
- Error intake, dedupe, queueing, stream offsets:
  - `src/daemon/error-worker.js:445-563`
- Assignment leases + heartbeat + release + reassign:
  - `src/daemon/assignment-ledger.js:313-716`
- Jira lifecycle automation:
  - `src/daemon/jira-lifecycle.js:283-586`
- Budget lifecycle with quarantine then deterministic squash:
  - `src/daemon/budget-governor.js:13-14`
  - `src/daemon/budget-governor.js:322-331`
  - `src/daemon/budget-governor.js:516-526`
- Operator stop requires explicit confirmation and writes control events:
  - `src/daemon/operator-control.js:490`
  - `src/daemon/operator-control.js:501-502`
  - `src/daemon/operator-control.js:576-634`
- Reliability lane and maintenance billboard:
  - `src/daemon/reliability-lane.js:300-468`
- Watchdog stuck-agent + budget-warning alerts (Slack/Telegram):
  - `src/daemon/watchdog.js:285-331`
  - `src/daemon/watchdog.js:391-402`
  - `src/daemon/watchdog.js:720-964`

## Evidence: Main Gaps and Risks

### 1) Still alpha and contract stability risk
- Package remains `0.1.0`: `package.json:3`.
- Many commands exist, but semver stability policy/deprecation contract is not formalized in primary docs/workflows.

### 2) Coverage enforcement is strong but selective
- Coverage thresholds are enforced: `.c8rc.json:4-7`.
- Include list is curated to 24 files only: `.c8rc.json:9-34`.
- Source file count currently 107 (`Get-ChildItem src -Recurse -File`), so coverage gate is not full-surface.

### 3) Mapping is hybrid deterministic+semantic, not full AST/CFG
- Import graph extraction is regex/module-specifier based:
  - `src/daemon/hybrid-mapper.js:155-186`
- BFS graph expansion by resolved imports:
  - `src/daemon/hybrid-mapper.js:223-296`
- Hybrid scoring combines deterministic path, semantic content, graph distance:
  - `src/daemon/hybrid-mapper.js:379-454`
- Ingest is deterministic file fingerprint + metadata inventory:
  - `src/ingest/engine.js:122-247`
  - `src/ingest/engine.js:600-754`
- No AST parser stack found (`acorn`, `@babel/parser`, `ts-morph`, `tree-sitter`, etc.) in package/source.

### 4) Mature AppSec-suite depth missing from this repo
- Not found in `.github`/`src`/`README.md`/`package.json`:
  - `codeql`, `semgrep`, `snyk`, `trivy`, `gitleaks`, `cyclonedx`, `spdx`, `attest-build-provenance`, `dependabot`.
- SBOM appears as profile/planning signal (`sbom_mode`) rather than implemented build-and-verify SBOM pipeline:
  - `README.md:761`
  - `src/scan/generator.js:121-309`
- Threat model, SLO/SLA, incident response/on-call/retention policy docs are not formalized in primary non-task docs.

## Direct Answer: AST Mapping and Context-Bloat Control

### What exists now
- Deterministic ingest builds a bounded file index and content fingerprint:
  - `src/ingest/engine.js:700-746`
  - `src/ingest/engine.js:827-899`
- Hybrid mapper narrows scope using:
  1. deterministic token/path signals,
  2. import graph neighborhood,
  3. semantic content scoring.
  - `src/daemon/hybrid-mapper.js:379-500`
- Memory retrieval uses local hybrid ranker (exact/token/cosine/recency/severity) and optional API fallback:
  - `src/memory/retrieval.js:390-499`
  - `src/memory/retrieval.js:502-534`

### What does not exist yet
- Full AST parse graph (typed AST), call graph, data flow graph, symbol graph across languages.
- SSA/CFG/taint-ready IR for deep secure code reasoning.

### Can deterministic ingest + handoff rival current `src` approach?
- **Yes, partially** on speed and controllability for large repos.
- **No** on deep semantic/security precision until AST + dataflow layers are added.

### Best path
- Keep deterministic ingest as the governance backbone.
- Add on-demand AST/call-graph overlays only for scoped files.
- Preserve bounded context handoff through deterministic artifacts + scoped graph slices.

## Reusable `src` Patterns to Lift Immediately

### Pattern A: strict schema + cross-contract validation
- Source: `src/mcp/registry.js:26-216`, `src/mcp/registry.js:535-565`
- Reuse for all plugin/tool/daemon artifacts.

### Pattern B: deterministic JSON/NDJSON artifact writing
- Source: `src/mcp/registry.js:578-613`, `src/telemetry/ledger.js:266-275`, `src/commands/watch.js:412-479`
- Reuse for reproducible audit and compliance evidence bundles.

### Pattern C: secure auth session lifecycle with auto-rotation
- Source: `src/auth/service.js:240-289`, `src/auth/service.js:324-403`, `src/auth/session-store.js:65-89`
- Reuse for persistent enterprise CLI login with minimal operator friction.

### Pattern D: event daemon with dedupe + offset cursor
- Source: `src/daemon/error-worker.js:445-563`
- Reuse for backend error-stream intake and exactly-once-like queue progression.

### Pattern E: lease-based assignment governance
- Source: `src/daemon/assignment-ledger.js:313-716`
- Reuse for distributed agent ownership without shared-memory coupling.

### Pattern F: quarantine-then-squash budget enforcement
- Source: `src/daemon/budget-governor.js:322-331`, `src/daemon/budget-governor.js:516-526`
- Reuse for deterministic rogue-agent suppression.

### Pattern G: operator HITL stop control
- Source: `src/daemon/operator-control.js:490-634`
- Reuse in admin dashboard stop button and incident controls.

### Pattern H: reliability lane + maintenance billboard
- Source: `src/daemon/reliability-lane.js:300-468`
- Reuse for scheduled synthetic jobs and user-facing maintenance state.

### Pattern I: watchdog with external channel alerts
- Source: `src/daemon/watchdog.js:285-331`, `src/daemon/watchdog.js:720-964`
- Reuse for early stuck-agent detection and incident paging.

### Pattern J: hybrid deterministic/semantic retrieval
- Source: `src/memory/retrieval.js:390-534`
- Reuse for low-bloat context retrieval before invoking expensive model calls.

## What Must Be Added Beyond `src` for Mature AppSec E2E

1. Multi-engine static analysis stack (CodeQL + Semgrep + custom rules + secret scan + IaC scan).
2. Dependency and supply-chain pipeline (SCA, reachability, license policy, transitive risk gating).
3. SBOM generation/verification (CycloneDX/SPDX) + signed attestations + provenance verification policy.
4. Runtime security controls integration (container/image scan, admission policies, runtime anomaly hooks).
5. Compliance evidence platform (retention policy, tamper-evident chain hashing, signed export bundles).
6. Formal threat model docs + risk register + control mapping (SOC 2 / ISO 27001 / EU AI Act style evidence).
7. SLO/SLA, incident response, on-call runbook, and postmortem lifecycle.
8. Enterprise identity/policy enforcement (OIDC workload identity, fine-grained RBAC/ABAC, policy-as-code).

## AppSec E2E PR Batch Roadmap (Proposed)

### Gate Policy for Every PR
1. `npm run verify` must pass.
2. Omar Gate must run and pass threshold policy.
3. `gh run watch` required before merge.
4. Fix P0-P2 findings prior to merge (or explicit approved exception record).

### Batch A: AppSec Core Scanners
1. `roadmap/pr-appsec-e2e-01-codeql-sast`
2. `roadmap/pr-appsec-e2e-02-semgrep-custom-rules`
3. `roadmap/pr-appsec-e2e-03-secrets-gitleaks-stack`
4. `roadmap/pr-appsec-e2e-04-iac-scan-terraform-k8s`

### Batch B: Supply Chain and Dependency Security
5. `roadmap/pr-appsec-e2e-05-sca-dependency-policy`
6. `roadmap/pr-appsec-e2e-06-license-and-reachability-gates`
7. `roadmap/pr-appsec-e2e-07-dependabot-autofix-governance`

### Batch C: SBOM, Attestation, Provenance
8. `roadmap/pr-appsec-e2e-08-sbom-cyclonedx-spdx-generation`
9. `roadmap/pr-appsec-e2e-09-build-attestations-and-verify`
10. `roadmap/pr-appsec-e2e-10-release-provenance-policy-enforcement`

### Batch D: AST + Semantic Deep Mapping
11. `roadmap/pr-appsec-e2e-11-ast-parser-layer-js-ts-py`
12. `roadmap/pr-appsec-e2e-12-callgraph-dataflow-overlay`
13. `roadmap/pr-appsec-e2e-13-hybrid-deterministic-ast-handoff`

### Batch E: Runtime Guardrails and Policy
14. `roadmap/pr-appsec-e2e-14-runtime-policy-engine`
15. `roadmap/pr-appsec-e2e-15-agent-path-tool-network-budget-hardening`
16. `roadmap/pr-appsec-e2e-16-quarantine-prison-workflow-and-forensics`

### Batch F: Compliance and Operations Maturity
17. `roadmap/pr-appsec-e2e-17-threat-model-and-control-mapping`
18. `roadmap/pr-appsec-e2e-18-slo-sla-incident-runbooks`
19. `roadmap/pr-appsec-e2e-19-retention-and-evidence-governance`
20. `roadmap/pr-appsec-e2e-20-siem-export-and-enterprise-audit-pack`

### Batch G: Dashboard + HITL Enterprise Controls
21. `roadmap/pr-appsec-e2e-21-admin-traceability-and-kill-switch-ui`
22. `roadmap/pr-appsec-e2e-22-jira-bi-directional-lifecycle-sync`
23. `roadmap/pr-appsec-e2e-23-token-time-tool-cost-monetization-ledger`

## Final Validation Against Original CTO Memo
- Memo is directionally accurate and mostly confirmed.
- The repo has improved operationally beyond a bare alpha scaffold.
- To claim “mature AppSec suite E2E,” the missing stack listed above must be implemented and policy-enforced in CI/CD and runtime.

## Execution Updates (2026-04-05, post-baseline)
- PR #145 (`feat(appsec): add semgrep custom-rule gate and release enforcement`) merged:
  - Added `.github/workflows/semgrep.yml`.
  - Added `.semgrep/rules/sentinelayer-cli.yml`.
  - Added release required check enforcement for `Semgrep Summary`.
- PR #144 (`fix(ci): pin setup-python to valid v5 SHA`) merged:
  - Fixed Semgrep workflow action pin so CI resolves setup action correctly.
- PR #147 (merged): `Gitleaks Summary` is now active in CI and release pre-publish gate checks.
- PR #148 (merged): `IaC Summary` is now active in CI and release pre-publish gate checks.
- PR #149 (merged): `SCA Summary` is now active and `npm audit` baseline is zero vulnerabilities.
- PR #150 (merged):
  - Adds `.github/workflows/license-gate.yml` (`License Summary`) with deterministic production license inventory.
  - Adds explicit allowlist policy file `.github/policies/license-policy.json`.
  - Adds release required check enforcement for `License Summary`.
- PR #151 (merged):
  - Adds `.github/workflows/dependabot-governance.yml` for policy-governed Dependabot auto-merge decisions.
  - Adds deterministic governance policy file `.github/policies/dependabot-governance.json`.
  - Adds deterministic decision artifact generation via `scripts/dependabot-governance.mjs`.
- PR #152 (merged):
  - Adds `.github/workflows/sbom.yml` to generate CycloneDX/SPDX JSON SBOMs.
  - Adds deterministic SBOM hash-manifest artifact output.
  - Adds release required check enforcement for `SBOM Summary`.
- PR #153 (merged):
  - Adds `.github/workflows/attestations.yml` for build-provenance attestation generation and verification.
  - Adds release required check enforcement for `Attestation Summary`.
- PR #154 (in progress on this branch):
  - Adds release-time checksum manifest enforcement before publish.
  - Adds release-time attestation generation and verification bound to `.github/workflows/release.yml`.
