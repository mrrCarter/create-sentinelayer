# create-sentinelayer Specification

## Goal
Deliver a deterministic, security-first CLI that scaffolds Sentinelayer artifacts, runs local Omar-compatible checks, and supports offline ingest/spec/prompt generation.

## Scope
- Stable command surface for scaffold + local governance commands.
- Authenticated Senti session coordination surfaces, including CLI/MCP inbox polling and durable message writes.
- Reproducible output artifacts under configurable output roots.
- CI workflows enforcing quality and Omar gate checks.
- Senti session coordination commands and generated agent guidance, including quiet/background listener behavior and durable presence controls.
- Managed LLM proxy client behavior in `src/ai/proxy.js` and `src/ai/client.js`, including quota/paywall denial metadata, retry policy, and structured audit/Senti fallback artifacts in `src/audit/persona-loop.js` and `src/session/daemon.js`.

## Guardrails
- Preserve backward-compatible binary aliases (`create-sentinelayer`, `sentinel`).
- Keep security workflows mandatory on pull requests.
- Keep release path auditable and versioned.
