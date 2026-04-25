// Unit tests for the SSE + fs.watch composed live source.

import test from "node:test";
import assert from "node:assert/strict";

import { mergeLiveSources } from "../src/session/live-source.js";

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
