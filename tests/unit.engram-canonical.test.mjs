// unit.engram-canonical.test.mjs — required-glob proof for src/engram/canonical.js (§19.1 encoder).
// Anchor discipline (engram #5): the fixture is verified against its PUBLISHED hash before any
// vector is trusted — a fixture verified against itself is not an anchor.
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { canonicalize } from "../src/engram/canonical.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE_PATH = path.join(here, "fixtures/engram/canonicalization-vectors-v1.json");
const PUBLISHED_SHA = "16b93737caef01f082c8b100484effe0e8f9c46fa731aeaba00f9879bd4e961c";
const PUBLISHED_BYTES = 5935;
const sha256 = (b) => createHash("sha256").update(b).digest("hex");

function fixture() {
  const bytes = readFileSync(FIXTURE_PATH);
  assert.equal(bytes.byteLength, PUBLISHED_BYTES, "fixture byte length drifted from published");
  assert.equal(sha256(bytes), PUBLISHED_SHA, "fixture no longer matches the published hash — re-vendor deliberately");
  return JSON.parse(bytes.toString("utf8"));
}

test("reproduces all five published §19.1 vectors — canonical bytes AND digests", () => {
  const f = fixture();
  assert.equal(f.vectors.length, 5);
  for (const v of f.vectors) {
    const out = canonicalize(v.preimage);
    assert.equal(out, v.canonical, `${v.name}: canonical string diverges`);
    assert.equal(sha256(Buffer.from(out, "utf8")), v.sha256, `${v.name}: digest diverges`);
  }
});

test("never-normalize: the NFC/NFD pair yields DIFFERENT canonical bytes (mustDiffer)", () => {
  const f = fixture();
  for (const [a, b] of f.mustDiffer) {
    const va = f.vectors.find((v) => v.name === a);
    const vb = f.vectors.find((v) => v.name === b);
    assert.notEqual(canonicalize(va.preimage), canonicalize(vb.preimage), `${a} vs ${b} must differ`);
  }
});

test("determinism: same value canonicalizes identically across calls and key-insertion orders", () => {
  const a = { z: 1, a: [true, null, "x"], m: { k2: 2, k1: 1 } };
  const b = { m: { k1: 1, k2: 2 }, a: [true, null, "x"], z: 1 };
  assert.equal(canonicalize(a), canonicalize(b));
  assert.equal(canonicalize(a), canonicalize(a));
  assert.equal(canonicalize(a), '{"a":[true,null,"x"],"m":{"k1":1,"k2":2},"z":1}');
});

test("key sort is UTF-16 code-unit order (RFC 8785), not locale order", () => {
  // "É" (U+00C9) sorts AFTER "Z" (U+005A) by code units; a locale sort would interleave.
  assert.equal(canonicalize({ "É": 1, Z: 2, a: 3 }), '{"Z":2,"a":3,"É":1}');
});

test("-0 encodes as 0 and shares identity with +0 (RFC 8785)", () => {
  assert.equal(canonicalize({ g: -0 }), '{"g":0}');
  assert.equal(canonicalize({ g: -0 }), canonicalize({ g: 0 }));
});

test("REFUSES every non-§19.1 value — no third behavior", () => {
  const cases = [
    [{ g: 1.5 }, /non-integer/i, "float"],
    [{ g: NaN }, /non-finite/i, "NaN"],
    [{ g: Infinity }, /non-finite/i, "Infinity"],
    [{ g: 2 ** 53 }, /2\^53/, "unsafe integer"],
    [{ g: 10n }, /BigInt/i, "BigInt"],
    [{ g: undefined }, /undefined/i, "undefined value (absent = OMIT the key)"],
    [{ g: () => {} }, /function/i, "function"],
    [{ g: new Date(0) }, /non-plain object/i, "Date instance"],
    [{ g: new Map() }, /non-plain object/i, "Map instance"],
  ];
  for (const [input, re, label] of cases) {
    assert.throws(() => canonicalize(input), re, `must refuse: ${label}`);
  }
  const cyc = { a: 1 };
  cyc.self = cyc;
  assert.throws(() => canonicalize(cyc), /circular/i, "must refuse: circular");
});

test("null-prototype objects are plain; string escaping IS JSON.stringify's (JCS-compatible), asserted as a property", () => {
  const np = Object.create(null);
  // newline, quote, backslash, tab, DEL - composed via fromCharCode so no source-literal escaping is involved.
  np.b = "line" + String.fromCharCode(10, 34, 92, 9, 127) + "end";
  np.a = 1;
  // Property, not a hand-typed literal: the encoder's string escaping must equal JSON.stringify's.
  assert.equal(canonicalize(np), `{"a":1,"b":${JSON.stringify(np.b)}}`);
});
