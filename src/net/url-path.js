// url-path.js — one identifier, one URL path segment.
//
// The CLI puts identifiers into API URL paths: session, admission, ticket, lease, checkpoint, run,
// token, message, reply, scan and AIdenID ids. urlPathSegment encodes each one as exactly one
// segment, and refuses a value that cannot be one: empty, "." or "..", or containing "/", "\", a
// control character or an unpaired surrogate. The URL builders that take ids (the session,
// ticket, admission and lease URL helpers) take the raw id and call it themselves.
//
// tests/unit.url-path-segments.test.mjs holds the census of src/ and says exactly which forms it
// checks. assertCredentialDestination (src/auth/credential-destinations.js) also checks the path
// of every URL it sends a credential to.

// C0 controls, DEL and C1 controls.
const CONTROL_CHARACTER = /[\u0000-\u001f\u007f-\u009f]/;

/** Whether urlPathSegment accepts `value`. Use it to refuse an id before any request work starts. */
export function isUrlPathSegment(value) {
  const text = String(value ?? "");
  return (
    text !== "" &&
    text !== "." &&
    text !== ".." &&
    !/[/\\]/.test(text) &&
    !CONTROL_CHARACTER.test(text) &&
    text.isWellFormed()
  );
}

/**
 * `value` encoded as exactly one URL path segment. Refuses an empty value, "." or "..", and a
 * value containing "/", "\", a control character or an unpaired surrogate. "%" is encoded, so
 * "%2e%2e" is sent as "%252e%252e" and stays one literal segment.
 */
export function urlPathSegment(value, { label = "identifier" } = {}) {
  if (!isUrlPathSegment(value)) {
    throw new Error(
      `${label} must be a single URL path segment: not empty, "." or "..", and without "/", "\\" or control characters.`,
    );
  }
  return encodeURIComponent(String(value ?? ""));
}
