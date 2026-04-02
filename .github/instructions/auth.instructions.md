---
applyTo: "src/auth/**/*.js"
---

Auth Domain Rules

- Preserve fail-closed behavior for token/session validation paths.
- Do not add insecure local fallbacks for production-authenticated flows.
- Never log raw tokens, auth headers, secrets, or full callback payloads.
- Any HTTP auth transport change must preserve timeout, retry, and circuit-breaker guards.
- Session persistence changes must keep encryption-at-rest guarantees and deterministic revocation behavior.
- Auth behavior changes require unit coverage for success and failure paths.
