# PR-D1 Coordination Autoinject Eval Evidence

Date: 2026-04-28
Branch: `dd/pr-d1-coordination-autoinject`
Spec: `tasks/dd-build-spec-2026-04-26.md` PR-D1

## Change Class

Prompt/spec/guide generation behavior change.

## Baseline Gap

- `origin/main` only emitted the spec coordination phase when `sessionActive`, collaboration wording, or 2+ agent instructions were present.
- `origin/main` prompt generation appended session rules only when the source spec already mentioned sessions/coordination.
- `origin/main` guide exports did not carry coordination etiquette into Jira, Linear, or GitHub issue descriptions.
- Session setup-guide text existed, but spec/prompt/guide/generated agent config paths did not share one canonical etiquette source.

## Implemented Guard

- Added `src/session/coordination-guidance.js` as the shared source for coordination etiquette.
- Spec generation now emits the coordination phase by default when session tooling is available.
- Prompt generation always includes the coordination rules.
- Build guide markdown and Jira/Linear/GitHub issue exports include coordination rules.
- Generated coding-agent config files and session setup guides reuse the same canonical text.

## Required Etiquette Coverage

The canonical rules include:

- find/join the recent Senti session for this codebase
- post plan and file claims
- claim/release files with `lock:` and `unlock:`
- poll with `session sync` + `session read` every 5 minutes
- run `sl review --diff` for finished files or PR-ready diffs
- post findings with `sl session say`
- ask for help instead of stopping
- offer non-conflicting work to peers
- run `sl --help` when stuck
- leave the session after final status/evidence

## Verification

- `node --check src/session/coordination-guidance.js src/session/setup-guides.js src/spec/generator.js src/prompt/generator.js src/guide/generator.js src/legacy-cli.js`
- `node --test tests/unit.spec-session.test.mjs tests/unit.session-setup-guides.test.mjs tests/unit.core.test.mjs`
  - Result: 20/20 tests passed.
- `node --test --test-name-pattern "CLI spec commands expose templates and generate SPEC.md offline|CLI prompt commands generate and preview agent-targeted prompts from spec|CLI guide generate creates BUILD_GUIDE.md|CLI guide export emits jira" tests/e2e.test.mjs`
  - Result: 4/4 command-level tests passed.
- `npm run check`
  - Result: passed, 295 files checked.
- `git diff --check`
  - Result: passed.
- `node bin/create-sentinelayer.js review --diff --refresh --spec tasks/dd-build-spec-2026-04-26.md --json`
  - Result: `review-20260428-024641-0b3b4284`, scoped 12 files, P0=0/P1=0/P2=0/P3=0.
- `npm run verify`
  - Result: passed after `npm ci`, including check, docs build, 95 e2e tests, 1142 unit coverage tests, and pack dry-run.
- `node bin/create-sentinelayer.js /omargate deep --path . --json --ai-dry-run --max-cost 5`
  - Result: `omargate-1777344725374-ac2378f0`, P0=0/P1=0, only baseline non-blocking P2/P3 findings.
- `node bin/create-sentinelayer.js /audit --path . --json`
  - Result: PASS, 559 files scanned, P1=0, P2=3 non-blocking.

## Scope Guard

No D2/D3 runtime behavior was implemented in this PR. Session title/resume/ensure and `sl session listen` remain outside this branch except where D1 documentation tells agents how to coordinate with currently available commands.
