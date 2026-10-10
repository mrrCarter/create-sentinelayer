# Eval Evidence: Outbound Credential Destinations

Date: 2026-10-10

## Scope

This PR changes how the CLI attaches the user's SentinelLayer token to outbound HTTP requests. Every request that carries the token now goes through `credentialedRequest`, which binds the token to the configured API origin.

Touched AI-impacting files:

- `src/ai/proxy.js`
- `src/ai/aidenid.js`

## Baseline

`src/ai/proxy.js` built its own `Authorization` header for the managed LLM proxy request. `src/ai/aidenid.js` sent the AIdenID key to the configured AIdenID API.

## Candidate

- `src/ai/proxy.js` passes a credential object to `credentialedRequest` instead of building the header. The proxy URL, request body, model selection, provider routing, retry behaviour and response parsing are unchanged.
- `src/ai/aidenid.js` is listed as a reviewed census exception: the AIdenID key is AIdenID's own credential, sent to the AIdenID API exactly as before. Its request construction is unchanged.

Prompt text, model selection, provider routing, tool permissions and finding parsing are unchanged.

## Risk Assessment

- Prompt-output behavior risk: none. No prompts, parsers or model parameters changed.
- Provider-routing risk: low. The managed proxy is reached at the same configured API origin. A request to an origin outside the configured set is refused before it is sent.
- Retry risk: low. A destination refusal is final and is not retried; network errors, timeouts and 5xx keep their existing retry behaviour.
- Compatibility risk: low for configured setups. A per-command API origin that is not configured is now refused with an error that names `SENTINELAYER_API_URL`.

## Verification

- `tests/unit.outbound-credential-destinations.test.mjs`, `tests/unit.credential-token-sources.test.mjs` and `tests/unit.credential-census.test.mjs` cover the credential binding, the census and the proxy path.
- Existing proxy and AI tests pass unchanged.
- Full suite at `2e4a6ed`: unit 2220/2220, e2e 133/133.
