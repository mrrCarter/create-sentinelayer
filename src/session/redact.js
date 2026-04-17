// Central payload-redaction utility for Senti session streams.
//
// Invariant: every event that lands on disk (stream.ndjson) or on the wire
// (API sync, human-message sync) passes through redactEventPayload before
// serialization. The sink call in stream.appendToStream is the enforcement
// point — if it writes raw, a secret leaks into the audit trail forever.
//
// Keep the SECRET_LIKE_PATTERN below in sync with src/session/sync.js.

const SECRET_LIKE_PATTERN =
  /(gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|sk-[A-Za-z0-9]{20,}|AKIA[0-9A-Z]{16}|-----BEGIN [A-Z ]+PRIVATE KEY-----|SENTINELAYER_TOKEN|AIDENID_API_KEY|NPM_TOKEN|xox[baprs]-[A-Za-z0-9-]+|AIza[0-9A-Za-z_-]{35}|eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{6,})/;

const REDACTION_MARKER = "[REDACTED]";
const MAX_STRING_LENGTH = 16_384;

function redactString(value) {
  if (typeof value !== "string") {
    return value;
  }
  const truncated =
    value.length > MAX_STRING_LENGTH ? `${value.slice(0, MAX_STRING_LENGTH)}…[truncated]` : value;
  if (!SECRET_LIKE_PATTERN.test(truncated)) {
    return truncated;
  }
  return truncated.replace(new RegExp(SECRET_LIKE_PATTERN.source, "gi"), REDACTION_MARKER);
}

function redactValue(value, depth = 0) {
  if (depth > 8) {
    return REDACTION_MARKER;
  }
  if (typeof value === "string") {
    return redactString(value);
  }
  if (Array.isArray(value)) {
    return value.map((entry) => redactValue(entry, depth + 1));
  }
  if (value && typeof value === "object") {
    const out = {};
    for (const [key, inner] of Object.entries(value)) {
      if (/^(authorization|cookie|set-cookie|x-api-key|api[_-]?key|secret|password|token)$/i.test(key)) {
        out[key] = REDACTION_MARKER;
        continue;
      }
      out[key] = redactValue(inner, depth + 1);
    }
    return out;
  }
  return value;
}

export function redactEventPayload(event) {
  if (!event || typeof event !== "object" || Array.isArray(event)) {
    return event;
  }
  const clone = { ...event };
  if (clone.payload !== undefined) {
    clone.payload = redactValue(clone.payload);
  }
  if (clone.message !== undefined) {
    clone.message = redactValue(clone.message);
  }
  if (clone.body !== undefined) {
    clone.body = redactValue(clone.body);
  }
  return clone;
}

export function containsSecret(value) {
  if (typeof value === "string") {
    return SECRET_LIKE_PATTERN.test(value);
  }
  if (Array.isArray(value)) {
    return value.some((entry) => containsSecret(entry));
  }
  if (value && typeof value === "object") {
    return Object.values(value).some((entry) => containsSecret(entry));
  }
  return false;
}

export const __secretPatternForTests = SECRET_LIKE_PATTERN;
