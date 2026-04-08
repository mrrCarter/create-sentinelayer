# Eval Evidence - PR 197 AIdenID Spec/Prompt Guidance

Date: 2026-04-08
Branch: roadmap/pr-161-aidenid-spec-prompt-guidance

## Impacted AI Surface
- `src/spec/generator.js` (AIdenID E2E phase wording for auth/login specs)
- `src/prompt/generator.js` (execution prompt AIdenID operating guidance)
- `src/legacy-cli.js` (BYOK artifact generation AIdenID phase + guidance)

## Risk
- Agents may miss AIdenID auto-provisioning path and require manual env vars.
- Auth-flow project specs could skip deterministic E2E identity verification.
- BYOK scaffold prompts could diverge from SentinelLayer login/provisioning flow.

## Deterministic Verification
- `node --test tests/unit.core.test.mjs` -> pass
- `$env:SENTINELAYER_CLI_SKIP_AUTH='1'; node --test tests/e2e.test.mjs` -> pass (89/89)

## Assertions Verified
- Prompt generation now injects AIdenID operational rules when spec includes AIdenID.
- Spec generation AIdenID phase now starts with `sl auth status` auto-provisioning confirmation.
- BYOK-generated `spec_sheet` and `builder_prompt` include AIdenID E2E verification flow.
