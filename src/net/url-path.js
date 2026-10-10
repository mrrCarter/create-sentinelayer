// url-path.js — one identifier, one URL path segment.
//
// The CLI puts identifiers into API URL paths: session, admission, ticket, lease, checkpoint, run,
// token, message, reply, scan and AIdenID ids. urlPathSegment encodes each one as exactly one
// segment, and refuses a value that cannot be one: empty, "." or "..", or containing "/", "\" or
// a control character.
//
// Every identifier in a URL path in src/ goes through urlPathSegment
// (tests/unit.url-path-segments.test.mjs fails on one that does not), and
// assertCredentialDestination (src/auth/credential-destinations.js) also checks the path of every
// URL it sends a credential to.

// C0 controls, DEL and C1 controls.
const CONTROL_CHARACTER = /[\u0000-\u001f\u007f-\u009f]/;

/**
 * `value` encoded as exactly one URL path segment. Refuses an empty value, "." or "..", and a
 * value containing "/", "\" or a control character. "%" is encoded, so "%2e%2e" is sent as
 * "%252e%252e" and stays one literal segment.
 */
export function urlPathSegment(value, { label = "identifier" } = {}) {
  const text = String(value ?? "");
  if (!text || text === "." || text === ".." || /[/\\]/.test(text) || CONTROL_CHARACTER.test(text)) {
    throw new Error(
      `${label} must be a single URL path segment: not empty, "." or "..", and without "/", "\\" or control characters.`,
    );
  }
  return encodeURIComponent(text);
}
