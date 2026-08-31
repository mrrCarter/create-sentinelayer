// Unit tests for the SSE + fs.watch composed live source.

import test from "node:test";
import assert from "node:assert/strict";

import { mergeLiveSources, watchRemoteStream } from "../src/session/live-source.js";
import { readSessionEventSequence } from "../src/session/event-identity.js";

/**
 * Build an async iterable from a list of items so we can drive the
 * merger without real fs / network.
 */
async function* fromList(items) {
  for (const item of items) {
    // Yield on next microtask so the consumer can interleave with the
    // other source.
    await Promise.resolve();
    yield item;
  }
}

test("mergeLiveSources: yields events from both sources", async () => {
  const fsItems = [
    { source: "fs", event: { id: "1", event: "session_message", payload: { message: "a" } } },
    { source: "fs", event: { id: "2", event: "session_message", payload: { message: "b" } } },
  ];
  const sseItems = [
    { source: "sse", event: { id: "3", event: "session_message", payload: { message: "c" } } },
  ];

  const collected = [];
  const ac = new AbortController();
  const merger = mergeLiveSources({
    sessionId: "test",
    signal: ac.signal,
    _localIterator: fromList(fsItems),
    _remoteIterator: fromList(sseItems),
  });
  // Stop after we've seen all 3.
  for await (const item of merger) {
    collected.push(item);
    if (collected.length >= 3) break;
  }
  ac.abort();

  const ids = collected.map((c) => c.event.id).sort();
  assert.deepEqual(ids, ["1", "2", "3"]);
});

test("mergeLiveSources: dedups same event seen on both lanes", async () => {
  // Same event id on both — should only emit once.
  const same = { id: "X", event: "session_message", payload: { message: "shared" } };
  const fsItems = [
    { source: "fs", event: same },
    { source: "fs", event: { id: "Y", event: "session_message", payload: { message: "fs-only" } } },
  ];
  const sseItems = [{ source: "sse", event: same }];

  const collected = [];
  const ac = new AbortController();
  const merger = mergeLiveSources({
    sessionId: "test",
    signal: ac.signal,
    _localIterator: fromList(fsItems),
    _remoteIterator: fromList(sseItems),
  });
  for await (const item of merger) {
    collected.push(item);
    if (collected.length >= 2) break;
  }
  ac.abort();

  const ids = collected.map((c) => c.event.id).sort();
  assert.deepEqual(ids, ["X", "Y"]);
});

test("mergeLiveSources: dedup falls back to ts+kind when no id", async () => {
  const a = { ts: "2026-04-25T07:00:00.000Z", event: "session_message", payload: { message: "first" } };
  const b = { ts: "2026-04-25T07:00:00.000Z", event: "session_message", payload: { message: "first" } };
  const fsItems = [{ source: "fs", event: a }];
  const sseItems = [{ source: "sse", event: b }];

  const collected = [];
  const ac = new AbortController();
  const merger = mergeLiveSources({
    sessionId: "test",
    signal: ac.signal,
    _localIterator: fromList(fsItems),
    _remoteIterator: fromList(sseItems),
  });

  // Force collection within a small window.
  const loop = (async () => {
    for await (const item of merger) {
      collected.push(item);
    }
  })();
  await new Promise((resolve) => setTimeout(resolve, 50));
  ac.abort();
  await loop.catch(() => undefined);

  assert.equal(collected.length, 1, "shared ts+kind should only surface once");
});

test("mergeLiveSources: works with only the local source", async () => {
  const fsItems = [
    { source: "fs", event: { id: "1", event: "session_message" } },
    { source: "fs", event: { id: "2", event: "session_message" } },
  ];
  const collected = [];
  const ac = new AbortController();
  const merger = mergeLiveSources({
    sessionId: "test",
    signal: ac.signal,
    _localIterator: fromList(fsItems),
    _remoteIterator: null,
  });
  for await (const item of merger) {
    collected.push(item);
    if (collected.length >= 2) break;
  }
  ac.abort();
  assert.equal(collected.length, 2);
});

test("mergeLiveSources: passes through non-event items (errors)", async () => {
  const fsItems = [{ source: "fs", event: { id: "1" } }];
  const sseItems = [{ source: "sse", error: "HTTP 502" }];

  const collected = [];
  const ac = new AbortController();
  const merger = mergeLiveSources({
    sessionId: "test",
    signal: ac.signal,
    _localIterator: fromList(fsItems),
    _remoteIterator: fromList(sseItems),
  });
  for await (const item of merger) {
    collected.push(item);
    if (collected.length >= 2) break;
  }
  ac.abort();
  const errors = collected.filter((c) => c.error);
  const events = collected.filter((c) => c.event);
  assert.equal(errors.length, 1);
  assert.equal(events.length, 1);
});

/**
 * Build a fake SSE Response whose body yields the given frames then ends.
 * Ending the body is how we simulate a dropped connection.
 */
function sseResponse(frames) {
  const encoder = new TextEncoder();
  let i = 0;
  return {
    ok: true,
    status: 200,
    body: {
      getReader() {
        return {
          async read() {
            if (i >= frames.length) return { done: true, value: undefined };
            return { done: false, value: encoder.encode(frames[i++]) };
          },
          async cancel() {},
        };
      },
    },
  };
}

function sseFrame(sequenceId) {
  return `data: ${JSON.stringify({
    sequenceId,
    event: "session_message",
    payload: { message: `m${sequenceId}` },
  })}\n\n`;
}

/**
 * Regression: agents "going dark".
 *
 * SSE is a live push with no backlog. Reconnecting without a cursor drops every event published
 * during the gap, and a listener that missed messages is indistinguishable from a quiet room --
 * which is exactly what makes the failure so hard to notice.
 *
 * The server has supported resume all along (`fromSequence`, `after`, `Last-Event-ID`); the
 * client simply never sent one.
 */
test("watchRemoteStream: resumes from the last delivered sequence after a reconnect", async () => {
  const urls = [];
  const responses = [
    sseResponse([sseFrame(5), sseFrame(6)]),
    sseResponse([sseFrame(7)]),
  ];
  let call = 0;
  const _sseFetch = async (url) => {
    urls.push(url);
    return responses[Math.min(call++, responses.length - 1)];
  };

  const controller = new AbortController();
  const seen = [];
  for await (const item of watchRemoteStream({
    apiBaseUrl: "https://api.test",
    sessionId: "s1",
    token: "tok",
    signal: controller.signal,
    _sseFetch,
    reconnectBackoffMs: 1,
  })) {
    if (item?.event) seen.push(readSessionEventSequence(item.event));
    if (seen.length >= 3) {
      controller.abort();
      break;
    }
  }

  // Nothing was lost across the drop.
  assert.deepEqual(seen, [5, 6, 7]);
  // First attach is live -- no cursor, no history replay.
  assert.ok(!urls[0].includes("fromSequence"), `first connect should not resume: ${urls[0]}`);
  // The reconnect resumes strictly after the last event the consumer actually received.
  assert.ok(urls[1].includes("fromSequence=6"), `reconnect should resume at 6: ${urls[1]}`);
});

test("watchRemoteStream: a reconnect before any event still attaches live", async () => {
  const urls = [];
  let call = 0;
  const _sseFetch = async (url) => {
    urls.push(url);
    // First attempt fails outright, so no event was ever delivered.
    if (call++ === 0) throw new Error("connection refused");
    return sseResponse([sseFrame(9)]);
  };

  const controller = new AbortController();
  const seen = [];
  for await (const item of watchRemoteStream({
    apiBaseUrl: "https://api.test",
    sessionId: "s1",
    token: "tok",
    signal: controller.signal,
    _sseFetch,
    reconnectBackoffMs: 1,
  })) {
    if (item?.event) {
      seen.push(readSessionEventSequence(item.event));
      controller.abort();
      break;
    }
  }

  assert.deepEqual(seen, [9]);
  // With nothing delivered yet there is no floor to resume from; sending fromSequence=0 would
  // ask the server to replay the room from the beginning.
  assert.ok(urls.every((u) => !u.includes("fromSequence")), urls.join(" | "));
});
