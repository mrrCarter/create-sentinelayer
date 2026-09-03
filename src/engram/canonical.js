// canonical.js — the spine's canonical JSON encoder (ENGRAM identity substrate).
//
// Implements the JCS-subset of respawn contract §19.1 (docs/contracts/checkpoint-proof-identity.md,
// respawn repo): RFC 8785 canonical JSON restricted to INTEGER-ONLY numbers. This is the encoder
// whose output bytes are the preimage for content-addressed observation ids (sha256 over canonical
// JSON). Conformance: tests/fixtures/engram/canonicalization-vectors-v1.json (published hash
// 16b93737…, five vectors incl. the NFC/NFD never-normalize pair) — exercised by
// tests/unit.engram-canonical.test.mjs (required glob) and conformance gate (i) (§21.3).
//
// Rules (each REFUSES rather than guessing — no third behavior, §19.1):
//   • Object keys sorted by UTF-16 code units (RFC 8785 §3.2.3). No whitespace.
//   • Strings serialized per JSON.stringify (JCS-compatible escaping), NEVER unicode-normalized:
//     NFC and NFD spellings are DIFFERENT bytes and must yield different digests (vector 4).
//   • Numbers: safe integers only. -0 encodes as 0. Non-integers, NaN, ±Infinity, unsafe
//     magnitudes, and BigInt REFUSE at encode time.
//   • Values: null, boolean, string, integer, array, PLAIN object only. Dates, Maps, class
//     instances, functions, symbols, and undefined REFUSE — an identity encoder must never
//     silently coerce. Circular structures REFUSE.
//   • Object entries whose value is undefined REFUSE (not skipped): an absent optional is
//     expressed by OMITTING the key (vector 3), and silently dropping undefined would let two
//     different in-memory shapes share one identity.

const REFUSE = (msg) => {
  throw new TypeError(`canonicalize: ${msg}`);
};

function isPlainObject(v) {
  if (v === null || typeof v !== "object") return false;
  const proto = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null;
}

function encode(value, seen, path) {
  switch (typeof value) {
    case "boolean":
      return value ? "true" : "false";
    case "number": {
      if (!Number.isFinite(value)) REFUSE(`non-finite number at ${path} — integer-only (§19.1)`);
      if (!Number.isInteger(value)) REFUSE(`non-integer number ${value} at ${path} — integer-only (§19.1)`);
      if (!Number.isSafeInteger(value)) REFUSE(`integer magnitude beyond 2^53-1 at ${path} — unrepresentable exactly`);
      return String(value === 0 ? 0 : value); // -0 → "0" (RFC 8785)
    }
    case "string":
      return JSON.stringify(value); // JCS-compatible escaping; NO normalization
    case "bigint":
      REFUSE(`BigInt at ${path} — integer-only means JSON numbers (§19.1)`);
      break;
    case "undefined":
      REFUSE(`undefined at ${path} — absent optionals OMIT the key`);
      break;
    case "function":
    case "symbol":
      REFUSE(`${typeof value} at ${path} — not a JSON value`);
      break;
  }
  if (value === null) return "null";
  if (seen.has(value)) REFUSE(`circular reference at ${path}`);
  if (Array.isArray(value)) {
    seen.add(value);
    const parts = value.map((item, i) => encode(item, seen, `${path}[${i}]`));
    seen.delete(value);
    return `[${parts.join(",")}]`;
  }
  if (!isPlainObject(value)) REFUSE(`non-plain object (${value.constructor?.name ?? "unknown"}) at ${path} — refuse, never coerce`);
  seen.add(value);
  const keys = Object.keys(value).sort(); // default sort = UTF-16 code unit order (RFC 8785 §3.2.3)
  const parts = keys.map((k) => `${JSON.stringify(k)}:${encode(value[k], seen, `${path}.${k}`)}`);
  seen.delete(value);
  return `{${parts.join(",")}}`;
}

/** Canonicalize a value to its §19.1 canonical JSON string (UTF-8 of this string is the digest preimage). */
export function canonicalize(value) {
  return encode(value, new Set(), "$");
}
