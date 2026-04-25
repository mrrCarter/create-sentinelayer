/**
 * Live session-event source — composes `fs.watch` (instant local notify
 * when the NDJSON file changes) and SSE (`/api/v1/sessions/<id>/stream`,
 * server-pushed updates) into a single async iterator.
 *
 * The two lanes give us the WebRTC-like behavior the user asked about
 * without the WebRTC operational tax: same-machine peers see each
 * other's writes through `fs.watch` immediately; remote peers receive
 * via SSE the moment the API persists. A single stream emits both, with
 * dedup by event id so the same event seen on both lanes only surfaces
 * once.
 *
 * Tests inject `_watch`, `_sse`, and `_readEvents` so the iterator can
 * be exercised hermetically; production uses `node:fs` watch + native
 * fetch streaming.
 */

import fs from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";

import { resolveSessionPaths } from "./paths.js";
import { readStream } from "./stream.js";

const DEFAULT_RECONNECT_BACKOFF_MS = 2_000;
const MAX_RECONNECT_BACKOFF_MS = 30_000;

function eventKey(event) {
  if (!event || typeof event !== "object") return null;
  if (event.id) return `id:${event.id}`;
  if (event.eventId) return `id:${event.eventId}`;
  const ts = event.ts || event.timestamp;
  const kind = event.event || event.type;
  if (ts && kind) return `${ts}::${kind}`;
  return null;
}

/**
 * Watch a session's NDJSON file with `fs.watch`. Whenever the file
 * changes (append-only writes happen on every event), re-read the tail
 * and emit any events the consumer hasn't seen yet. Falls back to a
 * 500 ms poll on platforms where `fs.watch` is unreliable (some
 * Windows + network mounts) — controlled by `_watch` for tests.
 *
 * Async generator yields `{ source: "fs", event }`.
 */
export async function* watchLocalStream({
  sessionId,
  targetPath,
  signal,
  initialTail = 50,
  _watch = fs.watch,
  _readEvents = readStream,
} = {}) {
  if (!sessionId) return;
  const paths = resolveSessionPaths(sessionId, { targetPath });
  let lastTs = null;

  // Replay the tail first so any caller getting the iterator catches
  // up with the in-flight context before live events start arriving.
  const initial = await _readEvents(sessionId, { targetPath, tail: initialTail });
  for (const event of initial) {
    const candidate = event.ts || event.timestamp;
    if (candidate) lastTs = candidate;
    yield { source: "fs", event };
  }

  let pendingResolve = null;
  let pendingPromise = null;
  const queue = [];

  function notify() {
    if (pendingResolve) {
      const r = pendingResolve;
      pendingResolve = null;
      pendingPromise = null;
      r();
    }
  }

  let watcher = null;
  try {
    watcher = _watch(paths.streamPath, { persistent: false }, () => notify());
  } catch {
    // If watch can't attach (file missing yet, locked filesystem), we
    // fall back to a 500ms poll so the iterator still makes progress.
    watcher = {
      close() {},
    };
    (async () => {
      while (!signal?.aborted) {
        await sleep(500);
        notify();
      }
    })();
  }

  const aborted = () => Boolean(signal?.aborted);
  if (signal) signal.addEventListener("abort", () => notify(), { once: true });

  try {
    while (!aborted()) {
      // Wait for any change notification.
      pendingPromise = new Promise((resolve) => {
        pendingResolve = resolve;
      });
      await pendingPromise;
      if (aborted()) break;

      const events = await _readEvents(sessionId, { targetPath, tail: 0, since: lastTs });
      for (const event of events) {
        const candidate = event.ts || event.timestamp;
        if (lastTs && candidate && candidate <= lastTs) continue;
        if (candidate) lastTs = candidate;
        queue.push({ source: "fs", event });
      }
      while (queue.length > 0) {
        yield queue.shift();
      }
    }
  } finally {
    try {
      watcher.close();
    } catch {
      /* swallow */
    }
  }
}

/**
 * Subscribe to the API's SSE stream for a session. Emits each parsed
 * data: line as `{ source: "sse", event }`. Auto-reconnects on
 * connection drop with exponential backoff capped at 30s.
 *
 * `_sseFetch` defaults to `fetch` but tests can stub it.
 */
export async function* watchRemoteStream({
  apiBaseUrl,
  sessionId,
  token,
  signal,
  _sseFetch = fetch,
  reconnectBackoffMs = DEFAULT_RECONNECT_BACKOFF_MS,
} = {}) {
  if (!apiBaseUrl || !sessionId || !token) return;
  const endpoint = `${apiBaseUrl.replace(/\/+$/, "")}/api/v1/sessions/${encodeURIComponent(
    sessionId,
  )}/stream`;
  let backoff = reconnectBackoffMs;

  while (!signal?.aborted) {
    let response;
    try {
      response = await _sseFetch(endpoint, {
        method: "GET",
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: "text/event-stream",
        },
        signal,
      });
    } catch (err) {
      if (signal?.aborted) return;
      yield { source: "sse", error: String(err?.message || err) };
      await sleep(backoff);
      backoff = Math.min(backoff * 2, MAX_RECONNECT_BACKOFF_MS);
      continue;
    }

    if (!response || !response.ok || !response.body) {
      yield { source: "sse", error: `HTTP ${response?.status || "?"}` };
      await sleep(backoff);
      backoff = Math.min(backoff * 2, MAX_RECONNECT_BACKOFF_MS);
      continue;
    }

    backoff = reconnectBackoffMs;
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    try {
      while (!signal?.aborted) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const frames = buffer.split(/\n\n/);
        buffer = frames.pop() || "";
        for (const frame of frames) {
          for (const line of frame.split(/\r?\n/)) {
            if (!line.startsWith("data:")) continue;
            const payload = line.slice(5).trim();
            if (!payload || payload === "[done]") continue;
            try {
              const event = JSON.parse(payload);
              yield { source: "sse", event };
            } catch {
              yield { source: "sse", raw: payload };
            }
          }
        }
      }
    } finally {
      try {
        await reader.cancel();
      } catch {
        /* swallow */
      }
    }

    if (signal?.aborted) return;
    await sleep(backoff);
  }
}

/**
 * Compose `fs.watch` and SSE into one event stream. Each emitted event
 * carries its `source` so consumers can tell which lane saw it first;
 * we dedup by event id so the same event arriving on both lanes only
 * surfaces once.
 *
 * @param {object} params
 * @param {string} params.sessionId
 * @param {string} [params.targetPath]
 * @param {string} [params.apiBaseUrl]
 * @param {string} [params.token]
 * @param {AbortSignal} [params.signal]
 * @returns {AsyncIterable<{source: "fs"|"sse", event?: object, raw?: string, error?: string}>}
 */
export async function* mergeLiveSources({
  sessionId,
  targetPath,
  apiBaseUrl,
  token,
  signal,
  _localIterator,
  _remoteIterator,
} = {}) {
  if (!sessionId) return;

  const localIterable = _localIterator
    ? _localIterator
    : watchLocalStream({ sessionId, targetPath, signal });
  const remoteIterable =
    _remoteIterator || (apiBaseUrl && token)
      ? _remoteIterator
        ? _remoteIterator
        : watchRemoteStream({ apiBaseUrl, sessionId, token, signal })
      : null;

  const seen = new Set();
  const queue = [];
  let pending = null;

  const wakeUp = () => {
    if (pending) {
      const r = pending;
      pending = null;
      r();
    }
  };

  async function pump(iterable) {
    if (!iterable) return;
    try {
      for await (const item of iterable) {
        queue.push(item);
        wakeUp();
        if (signal?.aborted) break;
      }
    } catch (err) {
      queue.push({ source: "merge", error: String(err?.message || err) });
      wakeUp();
    }
  }

  pump(localIterable);
  if (remoteIterable) pump(remoteIterable);

  // Make sure abort wakes the iterator promptly so the consumer doesn't
  // hang waiting on a `pending` promise that nothing is going to
  // resolve once the upstream sources finish.
  if (signal) signal.addEventListener("abort", () => wakeUp(), { once: true });

  while (!signal?.aborted) {
    if (queue.length === 0) {
      await new Promise((resolve) => {
        pending = resolve;
      });
      if (signal?.aborted) break;
      continue;
    }
    const item = queue.shift();
    if (item.event) {
      const key = eventKey(item.event);
      if (key) {
        if (seen.has(key)) continue;
        seen.add(key);
        if (seen.size > 5000) {
          // bound memory — older keys roll out
          const trimmed = Array.from(seen).slice(-2500);
          seen.clear();
          for (const k of trimmed) seen.add(k);
        }
      }
    }
    yield item;
  }
}
