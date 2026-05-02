// Test-bootstrap module: forces SENTINELAYER_SKIP_REMOTE_SYNC=1 so the
// session/event sync code paths short-circuit before hitting the user's
// stored token + the prod API. Without this guard, every test that runs
// `sl session start` on a developer machine silently posted an orphan
// session into the prod dashboard (Carter saw ~200 "<null>" sessions).
//
// Wired in via `node --import ./tests/setup-env.mjs --test ...` in
// package.json scripts. Cross-platform; no extra deps.
process.env.SENTINELAYER_SKIP_REMOTE_SYNC = "1";
process.env.SENTINELAYER_SKIP_SENTI_AUTOSTART = "1";
