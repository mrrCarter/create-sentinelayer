# Audit Severity Calibration Eval Evidence

## Change

This PR calibrates LOC-only audit specialist findings so large files remain visible as non-blocking P2 maintainability signals while tests, generated files, lockfiles, docs/tasks, workflow files, fixtures, mocks, snapshots, and other support artifacts are excluded from LOC-only hotspot rules.

## Why

The local `sl audit --path . --no-session --json` path produced blocking P1 floods from architecture, performance, testing, and documentation specialist seed findings. Those findings were based on file size alone, including tests and support artifacts, and made local audit noisier than hosted Omar.

P1 should be reserved for evidence-backed security, correctness, reliability, or release-blocking impact. Pure LOC-only hotspot evidence should not block by itself.

## Local Proof

- `node --import ./tests/setup-env.mjs --test tests/unit.audit-architecture.test.mjs tests/unit.audit-performance.test.mjs tests/unit.audit-testing.test.mjs tests/unit.audit-documentation.test.mjs`
  - Passed `12/12`.
- `npm run check`
  - Passed, `333 files passed`.
- `git diff --check`
  - Passed.
- `node bin\sl.js audit --path . --no-session --json`
  - Exited `0`.
  - Summary: `P0=0`, `P1=0`, `P2=106`, `P3=0`, `blocking=false`.
  - Architecture: `P1=0`, `P2=21`.
  - Performance: `P1=0`, `P2=24`.
  - Testing: `P1=0`, `P2=19`.
  - Documentation: `P1=0`, `P2=27`.

## Residual Risk

This does not remove findings or claim the codebase is clean. It changes only LOC-only severity and source/support path classification for deterministic specialist seeds. Follow-up audit work still needs to reconcile local Omar-vs-hosted Omar counts, Investor-DD frontend persona parity, budget/cost telemetry, and local LLM/quota behavior.
