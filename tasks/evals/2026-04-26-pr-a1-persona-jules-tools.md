# Eval Evidence - PR-A1 Audit Persona Tool Loop

Date: 2026-04-26
Branch: `dd/pr-a1-persona-jules-tools`
PR: create-sentinelayer#428
Spec section: Batch A / PR-A1 in `tasks/dd-build-spec-2026-04-26.md`

## Impacted AI-Sensitive Surface

- `src/commands/audit.js` adds `audit --stream` event forwarding for persona execution.
- `src/audit/persona-loop.js` adds the audit-owned non-Jules agentic persona loop.
- `src/audit/orchestrator.js` routes non-frontend personas through the new loop.
- `src/audit/registry.js` grants canonical audit persona tools.

## Change Class

- Functional enhancement for audit persona execution.
- Tool allowlist change: built-in audit personas receive `FileRead`, `Grep`, `Glob`, `Shell`, and `FileEdit`; plan mode keeps `FileEdit` granted but unavailable.
- Model/provider route: unchanged. The new loop uses the existing provider path and deterministic local test client under CLI test mode.
- Prompt/policy impact: bounded persona prompt with an evidence contract and tool-result grounding. No Jules imports or shared Jules runtime coupling.

## Eval Evidence

1. Focused persona-loop and registry unit coverage
- Command: `node --test tests/unit.audit-persona-loop.test.mjs tests/unit.audit-registry.test.mjs`
- Result: pass.
- Coverage: tool call dispatch, tool result event emission, JSON finding extraction, output token accounting, tool alias normalization, inherited custom-registry grants.

2. Audit suite regression coverage
- Command: `node --test tests/unit.audit*.test.mjs`
- Result: pass, 22 tests.

3. CLI stream contract coverage
- Command: `node --test --test-name-pattern "CLI audit" tests/e2e.test.mjs`
- Result: pass, 11 tests.
- Coverage: `audit --stream` emits canonical NDJSON events including `agent_start`, `tool_call`, `tool_result`, and `agent_complete`.

4. Full repository verification
- Command: `npm run verify`
- Result: pass.

5. Local agentic audit smoke
- Command: `node bin/create-sentinelayer.js audit --path . --agents security --stream`
- Result: pass.
- Observed: non-Jules `security` persona emitted tool lifecycle events and `usage.outputTokens=64`.

6. Local gate evidence
- Command: `node bin/create-sentinelayer.js /omargate deep --path . --json`
- Result: pass; `p0=0`, `p1=0`, `blocking=false`.
- Command: `node bin/create-sentinelayer.js /audit --path . --json`
- Result: pass; `overallStatus=PASS`, `p1Total=0`, `blocking=false`.
- Command: `node bin/create-sentinelayer.js review --diff --json`
- Result: pass; `p0=0`, `p1=0`, `p2=0`, `blocking=false`.

## Acceptance Mapping

- Non-Jules audit personas can use Jules-style tools: covered by registry tests and persona-loop tool dispatch tests.
- Streamed events use the existing canonical event spine: covered by unit and e2e stream assertions.
- Jules frontend flow remains preserved: orchestrator routes frontend persona through the existing path and labels the preserved flow.
- Token usage is surfaced on completion: covered by persona-loop assertions and local stream smoke.

## Risk Summary

- Primary risk: tool execution could escape the audit target path. Mitigated by shared-tool dispatch with target-rooted inputs and focused tests around path-safe tool calls.
- Secondary risk: long-running agent loops. Mitigated by bounded turn and budget checks plus `budget_warning` and `budget_stop` events.
- Residual risk: low; the change is covered by deterministic unit/e2e tests and local gate runs.
