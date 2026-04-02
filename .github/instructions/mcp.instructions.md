---
applyTo: "src/mcp/**/*.js"
---

MCP Domain Rules

- Identity-provisioning and external-action tools must default to human approval.
- Validate audience, auth mode, and secret reference fields for MCP server configs.
- Keep MCP schema contracts strict (`additionalProperties: false` or equivalent strict parsing).
- Do not broaden network/tool budgets without explicit security rationale.
- Preserve deterministic adapter/registry validation; reject mismatched bindings.
- MCP security changes require tests for both valid and rejected configuration paths.
