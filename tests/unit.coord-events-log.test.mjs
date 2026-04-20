// Unit tests for coord/events-log.js (#A9 append-only events.jsonl).

import test from "node:test";
import assert from "node:assert/strict";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  KNOWN_EVENT_TYPES,
  appendEvent,
  readEvents,
} from "../src/coord/events-log.js";

async function makeTempRoot() {
  return fsp.mkdtemp(path.join(os.tmpdir(), "senti-coord-events-"));
}

test("appendEvent + readEvents: single event round-trip", async () => {
  const targetPath = await makeTempRoot();
  try {
    const appended = await appendEvent(
      {
        type: "lock_granted",
        path: "app/layout.tsx",
        agent: "frontend",
        token: "abc",
        ttlSeconds: 120,
        expiresAt: "2026-04-18T00:00:00.000Z",
        ts: "2026-04-18T00:00:00.000Z",
      },
      { targetPath }
    );
    assert.equal(appended.type, "lock_granted");
    assert.equal(appended.schemaVersion, "1.0.0");

    const events = await readEvents({ targetPath });
    assert.equal(events.length, 1);
    assert.equal(events[0].type, "lock_granted");
    assert.equal(events[0].path, "app/layout.tsx");
  } finally {
    await fsp.rm(targetPath, { recursive: true, force: true });
  }
});

test("appendEvent preserves order across calls", async () => {
  const targetPath = await makeTempRoot();
  try {
    await appendEvent({ type: "lock_granted", path: "a.ts", agent: "backend", token: "t1" }, { targetPath });
    await appendEvent({ type: "lock_denied", path: "a.ts", agent: "frontend" }, { targetPath });
    await appendEvent({ type: "lock_released", path: "a.ts", agent: "backend", token: "t1" }, { targetPath });

    const events = await readEvents({ targetPath });
    assert.deepEqual(
      events.map((e) => e.type),
      ["lock_granted", "lock_denied", "lock_released"]
    );
  } finally {
    await fsp.rm(targetPath, { recursive: true, force: true });
  }
});

test("appendEvent rejects unknown event types", async () => {
  const targetPath = await makeTempRoot();
  try {
    await assert.rejects(
      () => appendEvent({ type: "definitely_not_a_real_event" }, { targetPath }),
      /Unknown handshake event type/
    );
  } finally {
    await fsp.rm(targetPath, { recursive: true, force: true });
  }
});

test("appendEvent rejects empty type", async () => {
  const targetPath = await makeTempRoot();
  try {
    await assert.rejects(
      () => appendEvent({ type: "" }, { targetPath }),
      /event.type is required/
    );
  } finally {
    await fsp.rm(targetPath, { recursive: true, force: true });
  }
});

test("readEvents returns [] when file missing", async () => {
  const targetPath = await makeTempRoot();
  try {
    assert.deepEqual(await readEvents({ targetPath }), []);
  } finally {
    await fsp.rm(targetPath, { recursive: true, force: true });
  }
});

test("readEvents skips corrupt lines", async () => {
  const targetPath = await makeTempRoot();
  try {
    const sentinelDir = path.join(targetPath, ".sentinel");
    await fsp.mkdir(sentinelDir, { recursive: true });
    const eventsPath = path.join(sentinelDir, "events.jsonl");
    const good = JSON.stringify({
      type: "lock_granted",
      path: "a.ts",
      agent: "backend",
      token: "t1",
      ts: "2026-04-18T00:00:00.000Z",
    });
    await fsp.writeFile(
      eventsPath,
      `${good}\n{ this is not json }\n${good}\n`,
      "utf-8"
    );

    const events = await readEvents({ targetPath });
    assert.equal(events.length, 2);
    assert.equal(events[0].type, "lock_granted");
  } finally {
    await fsp.rm(targetPath, { recursive: true, force: true });
  }
});

test("concurrent appendEvent calls all land (serialized under mutex)", async () => {
  const targetPath = await makeTempRoot();
  try {
    const count = 25;
    await Promise.all(
      Array.from({ length: count }, (_, idx) =>
        appendEvent(
          {
            type: "lock_granted",
            path: `f${idx}.ts`,
            agent: "backend",
            token: `t${idx}`,
          },
          { targetPath }
        )
      )
    );
    const events = await readEvents({ targetPath });
    assert.equal(events.length, count);
    const tokens = new Set(events.map((e) => e.token));
    assert.equal(tokens.size, count);
  } finally {
    await fsp.rm(targetPath, { recursive: true, force: true });
  }
});

test("KNOWN_EVENT_TYPES covers the 9 handshake transitions from spec", () => {
  const expected = [
    "lock_granted",
    "lock_renewed",
    "lock_denied",
    "lock_preempted",
    "lock_released",
    "lock_expired",
    "wait_recorded",
    "wait_cleared",
    "deadlock_broken",
  ];
  for (const type of expected) {
    assert.ok(
      KNOWN_EVENT_TYPES.has(type),
      `expected ${type} to be a known event type`
    );
  }
  assert.equal(KNOWN_EVENT_TYPES.size, expected.length);
});
