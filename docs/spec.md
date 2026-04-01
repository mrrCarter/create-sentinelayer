# create-sentinelayer Specification

## Goal
Deliver a deterministic, security-first CLI that scaffolds Sentinelayer artifacts, runs local Omar-compatible checks, and supports offline ingest/spec/prompt generation.

## Scope
- Stable command surface for scaffold + local governance commands.
- Reproducible output artifacts under configurable output roots.
- CI workflows enforcing quality and Omar gate checks.

## Guardrails
- Preserve backward-compatible binary aliases (`create-sentinelayer`, `sentinel`).
- Keep security workflows mandatory on pull requests.
- Keep release path auditable and versioned.
