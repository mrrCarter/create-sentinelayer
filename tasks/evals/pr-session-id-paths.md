# Eval Evidence: Session Id Paths

Date: 2026-10-10

## Scope

This PR holds every session id to one directory directly under its sessions root (`src/session/paths.js`), and applies the same rule where an id names a file or directory elsewhere.

Touched AI-impacting files:

- `src/commands/chat.js`

## Baseline

`sl chat` took `--session-id` as given and wrote the transcript to `chat/sessions/<sessionId>.jsonl` under the output root. When no id was given, it generated one.

## Candidate

- An explicit `--session-id` goes through `normalizeSessionId` before the transcript path is built. A valid id produces the same transcript path as before. An id outside the rule is refused with an error before anything is written or sent.
- Generated ids are unchanged, and all of them pass the rule.

Prompts, model selection, provider routing, request bodies, streaming, cost estimation, usage recording and response handling are unchanged.

## Risk Assessment

- Prompt-output behavior risk: none. No prompts, parsers or model parameters changed.
- Provider-routing risk: none.
- Compatibility risk: low. An explicit chat session id must now be 1-128 letters, digits, `.`, `_` or `-`, start with a letter or digit, not end with `.`, and not be a reserved device name. Generated ids and every id observed on a development machine fit.

## Verification

- `tests/unit.session-id-paths.test.mjs` runs `sl chat ask --dry-run` with a valid id, which writes its transcript inside the target. Ids outside the rule are refused and leave the file tree unchanged.
- Existing chat tests pass unchanged.
