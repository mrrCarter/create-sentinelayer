// Cross-language conformance: the CLI must produce the SAME bytes as the API's
// Python canonical_preimage(), or no admission claim signature ever verifies.
// The vectors are generated from the Python implementation, never hand-written.

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";

import { CanonicalPreimageError, canonicalPreimage } from "../src/session/admission-preimage.js";

const vectors = JSON.parse(
  readFileSync(new URL("./fixtures/admission/canonical-preimage-vectors-v1.json", import.meta.url), "utf8")
).vectors;

test("vectors are present (a missing fixture must not pass as zero cases)", () => {
  assert.ok(vectors.length >= 5, `expected >=5 vectors, got ${vectors.length}`);
});

for (const vector of vectors) {
  test(`byte-identical to the Python canonicaliser: ${vector.name}`, () => {
    const bytes = canonicalPreimage(vector.payload, { domain: vector.domain, fields: vector.fields });
    assert.equal(bytes.toString("hex"), vector.preimageHex);
    assert.equal(createHash("sha256").update(bytes).digest("hex"), vector.sha256);
  });
}

test("field order is a set: permutations produce identical bytes", () => {
  const payload = { a: "1", b: "2", c: "3" };
  const one = canonicalPreimage(payload, { domain: "d.v1", fields: ["a", "b", "c"] });
  const two = canonicalPreimage(payload, { domain: "d.v1", fields: ["c", "a", "b"] });
  assert.deepEqual(one, two);
});

test("the domain separates otherwise identical preimages", () => {
  const payload = { a: "1" };
  const claim = canonicalPreimage(payload, { domain: "sentinelayer.admission.claim.v1", fields: ["a"] });
  const grant = canonicalPreimage(payload, { domain: "sentinelayer.admission-grant.v1", fields: ["a"] });
  assert.notDeepEqual(claim, grant);
});

test("refusals: missing field, empty fields, no domain, non-ASCII key, float", () => {
  assert.throws(() => canonicalPreimage({ a: "1" }, { domain: "d", fields: ["a", "b"] }), CanonicalPreimageError);
  assert.throws(() => canonicalPreimage({ a: "1" }, { domain: "d", fields: [] }), CanonicalPreimageError);
  assert.throws(() => canonicalPreimage({ a: "1" }, { domain: " ", fields: ["a"] }), CanonicalPreimageError);
  assert.throws(() => canonicalPreimage({ a: { "é": 1 } }, { domain: "d", fields: ["a"] }), CanonicalPreimageError);
  assert.throws(() => canonicalPreimage({ a: 1.5 }, { domain: "d", fields: ["a"] }), CanonicalPreimageError);
});
