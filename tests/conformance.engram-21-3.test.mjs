// §21.3 SUBSTRATE CONFORMANCE HARNESS — respawn contract §21 (Carter-ratified, room seq 430717/430718).
//
// STATUS BY DESIGN: gates (i)-(iii) are EXPECTED RED on today's main. They are the executable form of the
// R1-R2 convergence gap, not a broken build: this file is deliberately OUTSIDE the `test:unit` glob
// (tests/unit*.test.mjs) and runs only via `npm run test:conformance`. When the spine converges (real
// canonical encoder, content-addressed ids, asOf on answers), the gates flip green and THEN this file is
// renamed into the required glob. A red gate here has a named reason; a green one is a §21.3 property.
//
// Gate (i)  — the spine's OWN encoder reproduces the five published §19.1 canonicalization vectors.
// Gate (ii) — ids are content-addressed: position-independent, collision-resistant framing, re-derivable.
// Gate (iii)— every recall answer carries an asOf/watermark (contract §21.2: freshness is disclosed).
// Gate (0)  — (GREEN today) the vendored fixture matches the PUBLISHED byte hash before parse — the
//             engram #5 pattern: a fixture verified against itself is not an anchor.
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { buildEventObservations } from "../src/session/recall/observation-core.js";
import { buildRecallIndex } from "../src/session/recall/index-build.js";
import { recall } from "../src/session/recall/retrieve.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE_PATH = path.join(here, "fixtures/engram/canonicalization-vectors-v1.json");
// The PUBLISHED hash — authoritative literal from respawn origin/main (contract §21.3(i); same pin as engram #5).
const PUBLISHED_SHA = "16b93737caef01f082c8b100484effe0e8f9c46fa731aeaba00f9879bd4e961c";
const PUBLISHED_BYTES = 5935;
const FIXED_NOW = Date.UTC(2026, 7, 31);

const sha256 = (b) => createHash("sha256").update(b).digest("hex");

// events WITHOUT eventId/sequence identity, so id resolution exercises the CONTENT fallback path —
// the path §21.3(ii) constrains (explicit eventIds would mask the content-addressing question entirely).
function rawMsg(seq, agentId, message) {
  return {
    stream: "sl_event",
    event: "session_message",
    agent: { id: agentId },
    payload: { message },
    ts: new Date(Date.UTC(2026, 7, 1) + seq * 60000).toISOString(),
  };
}

test("gate 0 (anchor, GREEN): vendored fixture matches the PUBLISHED bytes before parse", () => {
  const bytes = readFileSync(FIXTURE_PATH);
  assert.equal(bytes.byteLength, PUBLISHED_BYTES, "byte length drifted from the published fixture");
  assert.equal(sha256(bytes), PUBLISHED_SHA, "vendored fixture no longer matches respawn's published hash — re-vendor deliberately, never patch locally");
  const fixture = JSON.parse(bytes.toString("utf8"));
  assert.equal(fixture.vectors.length, 5);
  assert.deepEqual(fixture.mustDiffer, [["v4a-nfc", "v4b-nfd"]]);
});

test("gate i (§21.3(i)): the spine's own canonical encoder reproduces the five published vectors", async () => {
  let mod;
  try {
    mod = await import("../src/engram/canonical.js");
  } catch {
    assert.fail(
      "RED (expected on today's main): the spine has NO canonical encoder — src/engram/canonical.js does not exist. " +
        "Ids are FNV-1a-32x2 over pipe-joined strings (src/session/recall/text.js:145-149), not sha256 over canonical JSON. " +
        "Gate goes green when a JCS-subset encoder (respawn contract §19.1) lands and matches the fixture."
    );
  }
  const { canonicalize } = mod;
  assert.equal(typeof canonicalize, "function", "src/engram/canonical.js must export canonicalize()");
  const fixture = JSON.parse(readFileSync(FIXTURE_PATH, "utf8"));
  for (const v of fixture.vectors) {
    assert.equal(canonicalize(v.preimage), v.canonical, `${v.name}: canonical bytes diverge from the published vector`);
    assert.equal(sha256(Buffer.from(canonicalize(v.preimage), "utf8")), v.sha256, `${v.name}: digest diverges`);
  }
  assert.throws(() => canonicalize({ generation: 1.5 }), /non-integer|integer/i, "non-integer numbers must REFUSE at encode time — no third behavior");
});

test("gate ii (§21.3(ii)): observation ids are CONTENT-addressed — position-independent, and distinct content yields distinct ids", () => {
  const target = rawMsg(2, "codex", "we should gate merges behind the omar policy");
  // same logical observation materialized at batch index 0 vs batch index 1
  const alone = buildEventObservations([target], { sessionId: "s1" });
  const shifted = buildEventObservations([rawMsg(1, "claude", "an unrelated earlier message"), target], { sessionId: "s1" });
  const idAlone = alone.observations?.[0]?.id ?? alone[0]?.id;
  const idShifted = (shifted.observations ?? shifted).find((o) => /omar policy/.test(o.text ?? ""))?.id;
  assert.ok(idAlone && idShifted, "harness could not materialize observations — call-shape drift, fix the harness");
  assert.equal(
    idShifted,
    idAlone,
    "RED (expected on today's main): the fallback id mixes ARRAY POSITION into the preimage " +
      "(src/session/recall/observation-core.js:128-138 — `index` in the contentHash input), so the same observation " +
      "changes identity with batch position. Content-addressing (respawn §19/engram core-v1) forbids this: " +
      "position is ordering metadata, never identity."
  );
  // negative control — the comparator can fail: different content must never share an id
  const perturbed = buildEventObservations([rawMsg(2, "codex", "we should gate merges behind the omar policy!")], { sessionId: "s1" });
  const idPerturbed = perturbed.observations?.[0]?.id ?? perturbed[0]?.id;
  assert.notEqual(idPerturbed, idAlone, "perturbed content must change the id");
});

test("gate iii (§21.2): a recall answer carries asOf — freshness is DISCLOSED, never implied", () => {
  const events = [
    rawMsg(1, "codex", "we should gate merges behind the omar policy"),
    rawMsg(2, "claude", "opened PR #60 implementing the gate"),
  ];
  const index = buildRecallIndex({ events, sessionId: "s1" });
  const r = recall(index, { query: "gate policy", k: 5, now: FIXED_NOW });
  assert.ok(r && Array.isArray(r.results), "recall must return a results envelope");
  const asOf = r.asOf ?? r.watermark ?? r.latestSeq ?? index?.meta?.asOf;
  assert.ok(
    asOf !== undefined && asOf !== null,
    "RED (expected on today's main): no asOf/watermark anywhere in the recall response " +
      "(src/session/recall/retrieve.js envelope; index-core.js meta carries counts only). Contract §21.2: " +
      "every query surface returns the watermark it reflects, or it does not ship — a result with no asOf " +
      "cannot tell fresh from stale."
  );
});
