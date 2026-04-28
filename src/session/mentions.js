/**
 * Mention parsing for session events.
 *
 * Carter saw `@codex` and `@claude` in messages but nothing routed them —
 * peers had no signal a message was addressed to them. Senti's daemon
 * already handles `help_request` events and the listener already filters
 * by `to / recipient / recipients / targetAgent / targetAgentId` (see
 * `eventMatchesAgent` in `src/session/sync.js`); we just need to populate
 * one of those fields when a human / agent writes `@<name>`.
 *
 * This module is the canonical, **deterministic**, **pure-function**
 * mention parser. It runs at append-time (`appendToStream`) so every
 * event flowing through the local + remote stream picks up `payload.to`
 * for free. The web sidebar + listener can then highlight or notify
 * without changing their own routing logic.
 *
 * Borrowing pattern (per the build spec — borrow, don't import):
 *  - `eventMatchesAgent` style of multi-key recipient (we add to `to`,
 *    which the listener already understands)
 *  - `senti-naming.js` style of normalize-then-set (lowercase + strip
 *    punctuation + cap length)
 */

// `@handle` is one or more identifier characters. We allow letters,
// digits, `._-` so `@codex-1`, `@human-mrrcarter`, `@claude.verifier`
// all work. Word boundary on the front avoids matching `you@example.com`.
const MENTION_RE = /(?:^|[^A-Za-z0-9_.-])@([A-Za-z0-9][A-Za-z0-9._-]{0,63})/g;

// Common false positives we should never surface as mentions: email-y
// remnants and code annotations. We stop matching when the @ is preceded
// by a non-whitespace alnum (handled by the regex), so this is just for
// post-filter sanity.
const RESERVED_HANDLES = new Set(["all", "everyone", "channel", "here"]);

function normalizeString(value) {
  return String(value == null ? "" : value).trim();
}

/**
 * Extract `@handle` mentions from a free-text string.
 *
 * - Returns lowercased handles.
 * - Dedupes preserving first-seen order.
 * - Filters reserved broadcast handles (`@all`, `@everyone`, `@channel`,
 *   `@here`) into a separate `broadcast` array — the daemon decides
 *   whether broadcasts should fan out or be ignored.
 *
 * @param {string} text
 * @returns {{handles: string[], broadcast: string[]}}
 */
export function parseMentions(text) {
  const raw = normalizeString(text);
  if (!raw) return { handles: [], broadcast: [] };

  const handles = [];
  const broadcast = [];
  const seenHandle = new Set();
  const seenBroadcast = new Set();

  for (const match of raw.matchAll(MENTION_RE)) {
    const candidate = String(match[1] || "").trim().toLowerCase();
    if (!candidate) continue;
    if (RESERVED_HANDLES.has(candidate)) {
      if (!seenBroadcast.has(candidate)) {
        seenBroadcast.add(candidate);
        broadcast.push(candidate);
      }
      continue;
    }
    if (seenHandle.has(candidate)) continue;
    seenHandle.add(candidate);
    handles.push(candidate);
  }

  return { handles, broadcast };
}

/**
 * Look at an event and, if its payload carries human-readable text and
 * doesn't already have a `to` field, populate `payload.to` from any
 * `@<name>` mentions found in the text. Idempotent: if `to` is already
 * set (caller-supplied), we leave it alone. The original message text
 * is never mutated.
 *
 * Also surfaces the parse result on `payload.mentions = { handles, broadcast }`
 * so dashboards can render a "this message addressed: @x, @y" badge
 * without re-parsing.
 *
 * @template {object} E
 * @param {E} event
 * @returns {E} new event (shallow-merged) — NOT mutated in place
 */
export function enrichEventWithMentions(event) {
  if (!event || typeof event !== "object" || Array.isArray(event)) return event;
  const payload = event.payload && typeof event.payload === "object" && !Array.isArray(event.payload)
    ? event.payload
    : null;
  if (!payload) return event;

  // Already routed by an explicit caller — don't second-guess.
  const hasExplicitTo =
    Array.isArray(payload.to) ||
    Array.isArray(payload.recipients) ||
    typeof payload.recipient === "string" ||
    typeof payload.targetAgent === "string" ||
    typeof payload.targetAgentId === "string";

  // We pull text from the standard fields the renderer already uses,
  // matching the priority in `Session.tsx:payloadText`.
  const text = normalizeString(payload.message)
    || normalizeString(payload.text)
    || normalizeString(payload.detail)
    || normalizeString(payload.title);
  if (!text) return event;

  const parsed = parseMentions(text);
  if (parsed.handles.length === 0 && parsed.broadcast.length === 0) {
    return event;
  }

  const nextPayload = {
    ...payload,
    mentions: { handles: parsed.handles, broadcast: parsed.broadcast },
  };
  if (!hasExplicitTo && parsed.handles.length > 0) {
    nextPayload.to = parsed.handles;
  }

  return { ...event, payload: nextPayload };
}
