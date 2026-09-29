// admission-preimage.js — the bytes an agent signs to claim an admission.
//
// This MUST reproduce sentinelayer-api src/services/canonical_preimage.py byte for
// byte, or every claim signature fails to verify. The API SPEC ("Agent Passport
// Contract", preimage construction) is normative:
//
//   ASCII(domain) || 0x00 || JCS( select(payload, fields) with every string NFC )
//
// It deliberately COMPOSES rather than re-implements. JSON encoding is the one JCS
// encoder this CLI already has (src/engram/canonical.js); the NFC step is applied
// here, BEFORE encoding, because that is where the API format puts it. The engram
// encoder must stay non-normalising (content addressing needs NFC != NFD), so the
// normalisation belongs to this format, not to the shared encoder.
//
// Rules copied from the Python, each a refusal rather than a coercion:
//   - the domain is required and ASCII
//   - fields is a non-empty SET: the caller's order is ignored
//   - a named field absent from the payload is an error, never an omission
//   - object keys are ASCII, so UTF-16 and code-point key order agree
//   - no floats: integers must be safe integers (enforced by the encoder)
//
// Conformance: tests/fixtures/admission/canonical-preimage-vectors-v1.json is
// generated FROM the Python implementation; tests/unit.admission-preimage.test.mjs
// asserts these bytes match every vector exactly.

import { canonicalize } from "../engram/canonical.js";

const ASCII = /^[\x00-\x7f]*$/;

export class CanonicalPreimageError extends TypeError {}

function nfcDeep(value, path) {
  if (typeof value === "string") return value.normalize("NFC");
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map((item, i) => nfcDeep(item, `${path}[${i}]`));
  const out = {};
  for (const [key, item] of Object.entries(value)) {
    if (!ASCII.test(key)) {
      throw new CanonicalPreimageError(`object keys must be ASCII at ${path}: ${JSON.stringify(key)}`);
    }
    out[key] = nfcDeep(item, `${path}.${key}`);
  }
  return out;
}

/** The exact bytes to sign or verify, as a Buffer. */
export function canonicalPreimage(payload, { domain, fields }) {
  const normalizedDomain = String(domain ?? "").normalize("NFC").trim();
  if (!normalizedDomain) throw new CanonicalPreimageError("domain is required");
  if (!ASCII.test(normalizedDomain)) throw new CanonicalPreimageError("domain must be ASCII");
  if (!Array.isArray(fields) || fields.length === 0) {
    throw new CanonicalPreimageError(
      "fields is required: an empty selection would sign nothing while appearing to sign a document"
    );
  }
  if (payload === null || typeof payload !== "object" || Array.isArray(payload)) {
    throw new CanonicalPreimageError("payload must be an object");
  }
  const selected = {};
  const missing = [];
  for (const name of fields) {
    if (typeof name !== "string" || !ASCII.test(name)) {
      throw new CanonicalPreimageError(`field names must be ASCII strings: ${JSON.stringify(name)}`);
    }
    if (!Object.prototype.hasOwnProperty.call(payload, name)) {
      missing.push(name);
      continue;
    }
    selected[name] = payload[name];
  }
  if (missing.length) {
    throw new CanonicalPreimageError(
      `fields absent from payload cannot be covered: ${missing.sort().join(", ")}`
    );
  }
  let body;
  try {
    body = canonicalize(nfcDeep(selected, "$"));
  } catch (error) {
    throw new CanonicalPreimageError(error.message);
  }
  return Buffer.concat([
    Buffer.from(normalizedDomain, "ascii"),
    Buffer.from([0x00]),
    Buffer.from(body, "utf8"),
  ]);
}
