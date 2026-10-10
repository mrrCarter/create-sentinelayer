# Eval Evidence: URL Path Segments

Date: 2026-10-10

## Scope

This PR keeps every identifier the CLI places in an API URL path to exactly one path segment, through one helper, `urlPathSegment` (`src/net/url-path.js`). The credential sender also refuses a URL whose path contains a `.` or `..` segment in any spelling.

Touched AI-impacting files:

- `src/ai/aidenid.js`
- `src/ai/client.js`

## Baseline

`src/ai/aidenid.js` built identity, domain and target URLs with `encodeURIComponent(id)`. `src/ai/client.js` built the Gemini model URL with `encodeURIComponent(model)`. `encodeURIComponent` leaves `.` unchanged, so an identifier of `.` or `..` became a dot segment in the path.

## Candidate

- `src/ai/aidenid.js` builds the same URLs with `urlPathSegment(id, { label })`. For every identifier that is not empty, `.`, `..`, and has no `/`, `\` or control character, the URL is byte-identical to the baseline. Any other identifier is refused before a request is sent.
- `src/ai/client.js` builds the Gemini model URL the same way. Model names in use (for example `gemini-1.5-pro`) produce the same URL as before.

Prompt text, model selection, provider routing, request bodies, retries, tool permissions and response parsing are unchanged.

## Risk Assessment

- Prompt-output behavior risk: none. No prompts, parsers or model parameters changed.
- Provider-routing risk: none for valid identifiers; the URL is the same string.
- Compatibility risk: low. An identifier that is empty, `.`, `..`, or contains a separator or control character is now refused with an error naming the identifier, instead of being sent.

## Verification

- `tests/unit.url-path-segments.test.mjs` covers the helper, the sender refusal, and the CLI and MCP paths end to end.
- `tests/unit.credential-census.test.mjs` fails on a URL path built with `encodeURIComponent` outside the helper.
- Existing AIdenID and AI client tests pass unchanged.
