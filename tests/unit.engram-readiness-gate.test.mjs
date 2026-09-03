import test from "node:test";
import assert from "node:assert/strict";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { createMemoryService } from "../src/engram/index.js";
import { createBuildState, EngramNotReadyError } from "../src/engram/build-state.js";
import { parseNamespace } from "../src/engram/namespace.js";
import { ingestDocument } from "../src/engram/document.js";

/**
 * THE READINESS GATE, ACTUALLY INVOKED.
 *
 * `build-state.js` shipped as a correct module that NOTHING CALLED. A gate nobody
 * invokes is a comment, so this file exists to assert the wiring rather than the
 * logic: that `memory.recall` and `memory.summarize` genuinely refuse a namespace
 * whose build is in flight, and that they still work for the namespaces that have no
 * build state at all.
 *
 * THE TWO WAYS THIS WIRING COULD BE WRONG, both gated below:
 *   too tight  -> requiring `ready` would refuse every SESSION namespace, which is
 *                 adapter-backed, live, and has no state file. That breaks recall in
 *                 the product while looking like a safety improvement.
 *   too loose  -> gating only `recall` and not `summarize` leaves a second door open,
 *                 which is exactly how the viewer-role rule was enforced on one path
 *                 and not the other.
 */

const CALLER = { id: "tester" };

async function service() {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "engram-gate-"));
  return { root, ...createMemoryService({ storeRoot: root }) };
}

test("Unit engram readiness gate: CONTROL -- a namespace with NO build state still answers", async () => {
  // The session case. If this fails, the gate is too tight and has broken live recall.
  const { root, tools } = await service();
  try {
    const scope = "document:no-state";
    await tools.write({ scope, items: [{ text: "alpha beta", kind: "note" }], caller: CALLER });
    const got = await tools.recall({ scope, query: "alpha", k: 5, caller: CALLER });
    assert.ok(got, "an unbuilt namespace must remain queryable");
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});

test("Unit engram readiness gate: a build IN FLIGHT refuses memory.recall", async () => {
  const { root, tools } = await service();
  try {
    const scope = "document:in-flight";
    const ns = parseNamespace(scope);
    const bs = createBuildState({ storeRoot: root });

    const { items, docDigest } = ingestDocument("alpha\nbeta\n", {
      source: "d.md", ts: "2026-01-01T00:00:00Z", maxChars: 6,
    });
    await bs.begin(ns, { docDigest, expectedChunks: items.length });
    // Partial ingest: some chunks land, the build never completes.
    await tools.write({ scope, items: [items[0]], caller: CALLER });

    await assert.rejects(
      () => tools.recall({ scope, query: "alpha", k: 5, caller: CALLER }),
      EngramNotReadyError,
      "a half-built index must refuse rather than answer from the chunks it happens to have",
    );
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});

test("Unit engram readiness gate: a build IN FLIGHT also refuses memory.summarize", async () => {
  // The second-door test. recall and summarize share retrieveInternal; if someone
  // later gives summarize its own retrieval path, this fails and says why.
  const { root, tools } = await service();
  try {
    const scope = "document:in-flight-2";
    const bs = createBuildState({ storeRoot: root });
    await bs.begin(parseNamespace(scope), { expectedChunks: 3 });

    await assert.rejects(
      () => tools.summarize({ scope, focus: "alpha", caller: CALLER }),
      EngramNotReadyError,
      "summarize must not be a way around the readiness gate",
    );
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});

test("Unit engram readiness gate: a COMPLETED build answers again", async () => {
  // Proves the refusal is about readiness and not a permanent break -- without this,
  // a gate that refused forever would pass the tests above.
  const { root, tools } = await service();
  try {
    const scope = "document:completed";
    const ns = parseNamespace(scope);
    const bs = createBuildState({ storeRoot: root });

    const { items, docDigest } = ingestDocument("alpha\nbeta\n", {
      source: "d.md", ts: "2026-01-01T00:00:00Z", maxChars: 6,
    });
    await bs.begin(ns, { docDigest, expectedChunks: items.length });
    const { written } = await tools.write({ scope, items, caller: CALLER });
    await assert.rejects(() => tools.recall({ scope, query: "alpha", k: 5, caller: CALLER }), EngramNotReadyError);

    await bs.complete(ns, { writtenChunks: written });
    const got = await tools.recall({ scope, query: "alpha", k: 5, caller: CALLER });
    assert.ok(got, "a completed build must answer");
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});

test("Unit engram readiness gate: the gate is wired by DEFAULT, not opt-in", async () => {
  // createMemoryService must construct the buildState itself. If a future refactor
  // makes it a flag the caller has to remember, this fails -- an uninjected gate is
  // a comment, which is the whole reason this test file exists.
  const { root, tools } = await service();
  try {
    const scope = "document:default-wiring";
    await createBuildState({ storeRoot: root }).begin(parseNamespace(scope), { expectedChunks: 1 });
    await assert.rejects(
      () => tools.recall({ scope, query: "x", k: 1, caller: CALLER }),
      EngramNotReadyError,
      "createMemoryService must wire the readiness gate without being asked",
    );
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});
