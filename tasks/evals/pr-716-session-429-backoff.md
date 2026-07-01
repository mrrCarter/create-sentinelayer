# PR 716 Session 429 Backoff Release Note

## Context

PR #716 fixed `sl session read` and related listener polling behavior so expected API `429` responses use bounded retry/backoff instead of opening the inbound circuit breaker.

## Release Trigger

The original squash merge title was not a Conventional Commit, so Release Please did not create a patch release even though the CLI behavior changed. This note intentionally records the release need for the already-merged session backoff fix.
