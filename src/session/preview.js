/**
 * Per-session message preview — used by `slc session history` to show
 * the last meaningful line of each past conversation, ChatGPT-style.
 *
 * "Meaningful" filters out heartbeats / agent_join / file-lock churn
 * so the preview doesn't get drowned in machine traffic.
 */

import { readStream } from "./stream.js";

const PREVIEW_EVENTS = new Set([
  "session_message",
  "session_say",
  "agent_response",
  "human_relay",
  "daemon_alert",
  "session_admin_kill",
]);

const HEAD_LIMIT = 40;
const PREVIEW_TAIL_SCAN = 50;

function trim(value, limit = HEAD_LIMIT) {
  const text = String(value == null ? "" : value).trim();
  if (!text) return "";
  if (text.length <= limit) return text;
  return `${text.slice(0, Math.max(0, limit - 1))}…`;
}

/**
 * Pick the most recent user-visible message from an event list. Returns
 * the head of its body and the speaker so the caller can render
 * `<agentId>: <message>`.
 *
 * @param {Array<object>} events
 * @returns {{ts: string|null, agentId: string|null, kind: string|null, message: string|null}}
 */
export function pickLatestPreview(events = []) {
  if (!Array.isArray(events) || events.length === 0) {
    return { ts: null, agentId: null, kind: null, message: null };
  }
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const event = events[i] || {};
    const kind = String(event.event || event.type || "").trim();
    if (!kind || !PREVIEW_EVENTS.has(kind)) continue;
    const payload = event.payload && typeof event.payload === "object" ? event.payload : {};
    const text =
      payload.message ||
      payload.response ||
      payload.alert ||
      payload.reason ||
      payload.text;
    if (!text) continue;
    return {
      ts: event.ts || event.timestamp || null,
      agentId:
        (event.agent && event.agent.id) ||
        event.agentId ||
        payload.agentId ||
        null,
      kind,
      message: trim(text),
    };
  }
  return { ts: null, agentId: null, kind: null, message: null };
}

/**
 * Lift a preview line for a single session by tailing the stream.
 * Failures are non-fatal — missing stream / parse errors yield a null
 * preview rather than throwing, so the history listing stays resilient
 * across mixed-state caches.
 *
 * @param {string} sessionId
 * @param {{targetPath?: string, tail?: number}} [options]
 * @returns {Promise<{ts: string|null, agentId: string|null, kind: string|null, message: string|null}>}
 */
export async function readSessionPreview(
  sessionId,
  { targetPath = process.cwd(), tail = PREVIEW_TAIL_SCAN } = {},
) {
  if (!sessionId) {
    return { ts: null, agentId: null, kind: null, message: null };
  }
  try {
    const events = await readStream(sessionId, { targetPath, tail });
    return pickLatestPreview(events);
  } catch {
    return { ts: null, agentId: null, kind: null, message: null };
  }
}
