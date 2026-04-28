import test from "node:test";
import assert from "node:assert/strict";

import { parseMentions, enrichEventWithMentions } from "../src/session/mentions.js";

test("parseMentions: extracts simple @handles, lowercased, deduped, in order", () => {
  const out = parseMentions("ping @Codex and @claude — also @CODEX again");
  assert.deepEqual(out.handles, ["codex", "claude"]);
  assert.deepEqual(out.broadcast, []);
});

test("parseMentions: separates broadcast handles", () => {
  const out = parseMentions("@all please ack — and @claude follow up — @here too");
  assert.deepEqual(out.handles, ["claude"]);
  assert.deepEqual(out.broadcast, ["all", "here"]);
});

test("parseMentions: ignores email-y @ usage", () => {
  const out = parseMentions("ping carther@example.com about @claude please");
  assert.deepEqual(out.handles, ["claude"]);
});

test("parseMentions: supports dots, dashes, underscores in handles up to 64 chars", () => {
  const out = parseMentions("hi @human-mrrcarter and @claude.verifier and @codex_1");
  assert.deepEqual(out.handles, ["human-mrrcarter", "claude.verifier", "codex_1"]);
});

test("parseMentions: empty / non-string → empty arrays", () => {
  assert.deepEqual(parseMentions("").handles, []);
  assert.deepEqual(parseMentions(null).handles, []);
  assert.deepEqual(parseMentions(undefined).handles, []);
});

test("enrichEventWithMentions: populates payload.to + payload.mentions from message text", () => {
  const event = {
    event: "session_message",
    agent: { id: "human-mrrcarter" },
    payload: { message: "Where are we with demoing @codex?" },
  };
  const out = enrichEventWithMentions(event);
  assert.deepEqual(out.payload.to, ["codex"]);
  assert.deepEqual(out.payload.mentions, { handles: ["codex"], broadcast: [] });
  // original event not mutated
  assert.equal(event.payload.to, undefined);
  assert.equal(event.payload.mentions, undefined);
});

test("enrichEventWithMentions: respects an explicit caller-supplied 'to'", () => {
  const event = {
    event: "session_message",
    agent: { id: "human-mrrcarter" },
    payload: { message: "ping @codex and @claude", to: ["codex"] },
  };
  const out = enrichEventWithMentions(event);
  // 'to' kept as caller's choice; mentions still reported for transparency
  assert.deepEqual(out.payload.to, ["codex"]);
  assert.deepEqual(out.payload.mentions, { handles: ["codex", "claude"], broadcast: [] });
});

test("enrichEventWithMentions: pulls text from payload.text and payload.detail too", () => {
  const evtText = enrichEventWithMentions({
    event: "session_message",
    payload: { text: "ack @claude" },
  });
  assert.deepEqual(evtText.payload.to, ["claude"]);
  const evtDetail = enrichEventWithMentions({
    event: "agent_join",
    payload: { detail: "joined; cc @codex" },
  });
  assert.deepEqual(evtDetail.payload.to, ["codex"]);
});

test("enrichEventWithMentions: no mentions → returns original event unchanged", () => {
  const event = { event: "session_message", payload: { message: "hello world" } };
  const out = enrichEventWithMentions(event);
  assert.equal(out, event); // identity, no shallow-copy
});

test("enrichEventWithMentions: malformed event passes through", () => {
  assert.equal(enrichEventWithMentions(null), null);
  assert.equal(enrichEventWithMentions(undefined), undefined);
  const noPayload = { event: "x" };
  assert.equal(enrichEventWithMentions(noPayload), noPayload);
});
