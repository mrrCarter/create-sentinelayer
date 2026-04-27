# PR-A2 Persona Isolation Eval Evidence

Date: 2026-04-27
Branch: `dd/pr-a2-persona-isolation`

## Scope

PR-A2 hardens the audit persona loop so each persona has an explicit isolated context and the `/audit` command can run personas in `strict` or `relaxed` isolation mode. It also adds a deterministic-seed opt-out for tests and future verifier runs that need to prove personas start without routed baseline findings.

## AI-Sensitive Surfaces

- `src/audit/persona-loop.js`
  - Creates per-persona client, message history, blackboard, event emitter, tool dispatcher, and budget context.
  - Emits isolation and seed-count metadata on `agent_start`.
- `src/audit/orchestrator.js`
  - Controls whether deterministic baseline findings are routed into persona seed prompts and shared blackboard context.
- `src/commands/audit.js`
  - Exposes `--isolation strict|relaxed` and `--no-seed-from-deterministic`.

## Expected Behavior

- `createIsolatedPersonaContext()` returns a fresh `messageHistory` array for every persona context.
- No two persona contexts share client, blackboard, agent context, or tool dispatcher references unless a caller deliberately supplies shared external state.
- `/audit --isolation strict --no-seed-from-deterministic` starts personas with zero seed findings and zero deterministic-baseline findings in the persona prompt contract.
- Default `/audit` behavior remains `strict` isolation with deterministic seed routing enabled for backward compatibility.

## Validation

- `node --check src/audit/persona-loop.js` - pass
- `node --check src/audit/orchestrator.js` - pass
- `node --check src/commands/audit.js` - pass
- `node --test tests/unit.audit-persona-loop.test.mjs` - pass, 5 tests
- `node --test tests/unit.session-recap.test.mjs` - pass, 3 tests after stabilizing the coverage-timeout recap fixture exposed by `npm run verify`
- `node --test --test-name-pattern "CLI audit" tests/e2e.test.mjs` - pass, 11 tests
- `npm run check` - pass, 293 files
- `npm run verify` - pass, includes check, docs build, full e2e, unit coverage, and package dry-run
- `node bin/create-sentinelayer.js review --diff --json` - pass, run `review-20260427-074235-09921cbb`, P0/P1/P2/P3 all zero
- `git diff --check` - pass
