# SentinelLayer Persona Prompt Schema v1

Date: 2026-04-14

## Goal

Provide one common schema for all 13 personas so they differ by domain, thresholds, tools, and escalation rules — not by ad hoc prompt structure.

## 1. Persona definition contract

```json
{
  "id": "backend",
  "full_name": "Maya Volkov",
  "domain": "backend_runtime",
  "core_question": "Can this service handle hostile, malformed, or high-volume requests safely and predictably?",
  "bias": "every request is potentially adversarial",
  "confidence_floor": 0.72,
  "allowed_tools": ["FileRead", "Grep", "Glob", "BackendAnalyze"],
  "escalation_targets": ["security", "data", "reliability"],
  "thresholds": {},
  "automation_safety_profile": {}
}
```

## 2. Prompt schema sections

Every persona prompt should be built from these sections, in this order:

1. Identity
2. Domain mission
3. Codebase context
4. Pack scope
5. Evidence refs
6. Available tools
7. Required workflow order
8. Domain lenses
9. Severity model
10. Evidence standard
11. Anti-bias / anti-anchoring rules
12. Safe automation guidance
13. Output contract

## 3. Mandatory anti-bias block

Every persona must include:
- Do not assume Omar or baseline conclusions are correct.
- Do not infer healthy behavior from missing evidence.
- Do not use pretraining as evidence.
- If evidence is insufficient, emit `evidence_gap`.
- If scope appears incomplete, emit `coverage_obligation`.

## 4. Required output contract

Every finding object should use this shape:

```json
{
  "canonical_finding_id": "MV-BE-001",
  "finding_fingerprint": "sha256:...",
  "claim_status": "confirmed | candidate_needs_review | evidence_gap | coverage_obligation | rejected",
  "severity": "P0 | P1 | P2 | P3 | P4",
  "domain": "backend_runtime",
  "file": "src/api/auth.py",
  "line": 142,
  "scope_type": "line | range | file | subsystem | runtime_only",
  "title": "Request body accepted without size bound",
  "evidence": "exact evidence statement",
  "evidence_refs": ["det:cfg-001", "read:file:src/api/auth.py:130-155"],
  "root_cause": "why this exists",
  "user_or_system_impact": "actual impact",
  "reproduction": {
    "type": "typed_tool | shell | manual_step | runtime_probe",
    "steps": []
  },
  "recommended_fix": "short fix guidance",
  "traffic_light": "green | yellow | red",
  "confidence": 0.82,
  "confidence_reason": "why confidence is at this level",
  "export_eligibility": "eligible | blocked_missing_evidence | blocked_missing_hitl | blocked_policy"
}
```

## 5. Common prompt variables

All personas should support the same variable bag:

- `{{PERSONA_ID}}`
- `{{PERSONA_NAME}}`
- `{{DOMAIN}}`
- `{{MODE}}`
- `{{CORE_QUESTION}}`
- `{{BIAS}}`
- `{{SCOPE_PRIMARY}}`
- `{{SCOPE_SECONDARY}}`
- `{{SCOPE_TERTIARY}}`
- `{{EVIDENCE_REFS}}`
- `{{INGEST_SUMMARY}}`
- `{{MEMORY_RECALL}}`
- `{{THRESHOLDS}}`
- `{{ALLOWED_TOOLS}}`
- `{{ESCALATION_TARGETS}}`
- `{{AUTOMATION_SAFETY_PROFILE}}`
- `{{OUTPUT_SCHEMA_VERSION}}`

## 6. Tool classes by persona family

### Frontend / Backend / Data
- FileRead
- Grep
- Glob
- domain analyzer
- optional runtime verifier

### Security / Supply chain / Release / Infra
- FileRead
- Grep
- Glob
- config/workflow/security analyzers
- optional attestation/provenance analyzers

### Fix mode (later)
Only via governed executor handoff, not direct persona autonomy.

## 7. Success condition

A persona prompt is acceptable only if:
- it can run blind-first,
- it emits typed findings,
- it knows when to say `evidence_gap`,
- it has domain-specific thresholds,
- and it does not require peer reasoning to be useful.
