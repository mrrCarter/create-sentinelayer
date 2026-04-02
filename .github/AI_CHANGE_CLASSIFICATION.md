# AI Change Classification

Use this taxonomy in every PR description.

## Class A - Deterministic Only
- No model/prompt/persona logic changed.
- No eval run required.
- Examples: parser bug fix, non-AI command UX adjustment, doc-only changes.

## Class B - Prompt or Persona Surface
- Prompt templates, persona instructions, or generated rubric logic changed.
- Eval-impact check is required.
- Include before/after prompt artifacts in PR evidence.

## Class C - Model Routing or Provider Behavior
- Provider selection, fallback routing, retry semantics, or model IDs changed.
- Eval-impact check is required.
- Include cost/rate-limit risk note and rollback plan.

## Class D - Autonomous Governance or Security Boundary
- Changes to auth, MCP, daemon budgets, approval gates, workflow permissions, or kill-switch controls.
- Security review checklist is required.
- Include explicit threat/risk note and deterministic test evidence.
