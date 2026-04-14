# SentinelLayer Persona Architecture Roast and Hardening Plan v1

Date: 2026-04-14

## Verdict

The architecture is ambitious and materially ahead of most "single-agent + tool" wrappers, but it currently overloads a persona implementation with three separate responsibilities:

1. domain-specialist review,
2. sub-orchestration/swarm management,
3. autonomous remediation / PR execution.

That makes it powerful, but it also creates avoidable trust, testability, and safety debt.

## What is strong

- Domain persona identity is explicit, typed, and budget-governed.
- Isolation is better than most agent systems: sub-agents have separate conversations, separate budget slices, and only append to a shared blackboard.
- Coverage accounting is more honest than most systems because it attempts confirmed-read accounting instead of counting only seed files.
- The streaming event model is already close to a real machine-readable operations protocol.
- The swarm structure (scan -> hunt -> converge -> coverage verify) is directionally correct for large codebases.

## What is weak / risky

### 1. Persona + orchestrator coupling

A persona file should not simultaneously define:
- persona identity,
- prompt builder,
- query loop,
- swarm coordination,
- background daemon routing,
- fix-cycle automation,
- Slack/Telegram alerting.

This is too much responsibility for one persona package.

### 2. Blackboards are being used too early for synthesis

For blind review, domain personas should not consume peer findings during their first-pass reasoning.
They can append to a blackboard early, but synthesis should happen only after the blind pass is complete.

### 3. Fix-cycle is too operationally powerful for the current trust level

The current fix-cycle design claims Jira lifecycle, worktree create, push, PR create, Omar watch, merge, and S3 upload from inside the persona flow.
That is too much authority for a domain persona. Those steps should be executed by a separate governed executor with explicit stage approvals.

### 4. Prompt output contracts are under-typed

The persona output JSON is still too close to a plain findings array.
It needs richer machine structure:
- finding_fingerprint
- evidence_refs
- claim_status
- scope_type
- repro_type
- automation_safety
- export_eligibility
- confidence_reason

### 5. Tooling is still persona-local instead of role-classified

Tools should be attached by role-class and permission tier, not handcrafted per persona in ad hoc ways.
Example classes:
- read_index_tools
- semantic_scope_tools
- runtime_probe_tools
- repo_mutation_tools
- ticketing_tools
- alerting_tools

### 6. Swarm thresholds are static and frontend-specific

Thresholds like file count, LOC, or route groups are useful, but they should be generated from a common pack/runtime policy layer, not live inside one persona definition.

### 7. Cost accounting is approximate

The loop currently estimates output tokens by char/4 and uses a hardcoded output-price heuristic.
That is okay for local guardrails but not for authoritative audit or enterprise billing.

### 8. Coverage verification still misses semantic reachability

Confirmed-read accounting is good, but import-string discovery is not enough. You need semantic reachability overlays (symbol/call/router edges) for backend and data personas especially.

## Hardening changes

### A. Split persona runtime into 4 layers

1. persona definition
2. persona prompt builder
3. persona executor
4. persona helper factories

The domain persona should not own the final fix-cycle executor.

### B. Enforce blind-first review protocol

- stage 1: Omar Core builds evidence substrate
- stage 2: persona receives scoped pack + evidence refs + memory recall only
- stage 3: persona produces findings without peer/baseline anchoring
- stage 4: reconcile later

### C. Introduce canonical finding schema before more UI/export work

Every finding should include:
- canonical_finding_id
- finding_fingerprint
- evidence_payload_hash
- policy_version
- prompt_schema_version
- tool_trace_refs

### D. Replace raw repro commands with typed repro actions

Instead of only storing shell commands, store:
- tool_name
- args schema
- cwd
- expected result
- policy tags
- network allowance
- file scope

UI can still render them as commands.

### E. Demote persona-owned fix-cycle to proposal mode

Persona should produce:
- fix proposal
- risk class
- files touched suggestion
- verification plan

Separate governed executor handles:
- worktree
- git
- PR
- Jira transition
- merge

### F. Introduce role-class tool bundles

Common bundles:
- `core_readonly`: FileRead, Grep, Glob
- `semantic_scope`: symbol graph, route map, import/call expansion
- `runtime_verify`: headers, perf, smoke probes
- `repo_write_gated`: FileEdit, FileWrite
- `exec_gated`: Shell
- `ops_gated`: Jira, Slack, email, S3

### G. Move alerting out of personas

Pulse/alerts should be platform-level, not persona-local. Personas can emit state; platform alerting decides what to send.

### H. Add reviewer/bias metrics

Track per persona:
- agreement with HITL
- overturn rate
- false-positive contribution
- duplicate finding rate
- repro success rate

## Architectural direction

### Keep
- isolated sub-agent conversations
- per-agent budget slices
- append-only blackboard
- coverage ledger
- event stream protocol

### Change
- persona-local operational powers
- persona-local alerting ownership
- early blackboard synthesis
- weakly typed findings contract

### Add
- canonical finding identity
- common pack policy layer
- typed repro actions
- governed executor boundary
- persona calibration telemetry

## Bottom line

This is not bad architecture. It is actually better than most of the market. But right now it is too persona-centric.

The system should become:
- Omar Core = truth substrate
- persona executors = blind domain reviewers
- reconciler = conflict resolver
- governed executor = any write/PR/ticket side effects
- HITL = final approval for risky/exportable outcomes

That separation will make the whole system safer, easier to benchmark, easier to explain, and easier to scale to the other 12 personas.
