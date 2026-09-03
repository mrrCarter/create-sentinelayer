import test from "node:test";
import assert from "node:assert/strict";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { createMemoryService } from "../src/engram/index.js";
import { ingestDocumentIntoNamespace } from "../src/engram/ingest-document.js";
import { BUILD_STATES, EngramNotReadyError } from "../src/engram/build-state.js";
import { parseNamespace } from "../src/engram/namespace.js";

/**
 * AN INTERRUPTED INGEST MUST NEVER LEAVE A NAMESPACE THAT ANSWERS.
 *
 * #808 wired the readiness gate into the query path, but nothing in production ever
 * called `begin()` -- so BUILDING was UNREACHABLE and the gate, though invoked on
 * every recall, had never once been able to say no. A gate guarding a state nothing
 * can enter is a subtler dead control than one nobody calls: it runs and it passes.
 *
 * These gates are therefore mostly about the FAILURE path, because the happy path was
 * never the risk. The control is that a completed ingest really does answer -- without
 * it, a module that always left BUILDING would satisfy every refusal test here.
 */

const CALLER = { id: "ingester" };
const DOC = ["alpha", "---", "beta", "---", "gamma"].join("\n");

async function svc() {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "engram-ingest-"));
  return { root, ...createMemoryService({ storeRoot: root }) };
}

test("Unit engram ingest: CONTROL -- a completed ingest is READY and answers", async () => {
  const { root, ingestDocument, tools, buildState } = await svc();
  try {
    const scope = "document:happy";
    const out = await ingestDocument({ scope, text: DOC, source: "d.md", ts: "2026-01-01T00:00:00Z", maxChars: 6, caller: CALLER });
    assert.equal(out.ok, true);
    assert.equal(out.state, BUILD_STATES.READY);
    assert.ok(out.chunks > 1, "fixture must actually chunk");
    assert.equal(out.written, out.chunks);

    assert.equal((await buildState.read(parseNamespace(scope))).state, BUILD_STATES.READY);
    const got = await tools.recall({ scope, query: "beta", k: 5, caller: CALLER });
    assert.ok(got, "a completed ingest must be queryable");
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});

test("Unit engram ingest: a FAILED write leaves the namespace BUILDING and refusing", async () => {
  // The whole point. The store throws mid-ingest; step 3 never runs; the namespace
  // must refuse queries rather than serve whatever chunks landed.
  const { root, buildState, tools } = await svc();
  try {
    const scope = "document:interrupted";
    const exploding = {
      appendItems: async () => {
        throw new Error("disk full");
      },
    };

    await assert.rejects(
      () => ingestDocumentIntoNamespace({
        scope, text: DOC, source: "d.md", ts: "2026-01-01T00:00:00Z", maxChars: 6,
        deps: { store: exploding, buildState },
      }),
      /disk full/,
    );

    const state = await buildState.read(parseNamespace(scope));
    assert.equal(state.state, BUILD_STATES.BUILDING, "an interrupted ingest must stay BUILDING");
    await assert.rejects(
      () => tools.recall({ scope, query: "alpha", k: 5, caller: CALLER }),
      EngramNotReadyError,
      "and the query path must refuse it",
    );
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});

test("Unit engram ingest: begin() runs BEFORE the first chunk is written", async () => {
  // Order is the design. If the write happened first there would be a window where a
  // partial index answers as though whole -- so assert the state AT write time.
  const { root, buildState } = await svc();
  try {
    const scope = "document:ordering";
    let stateAtWrite = null;
    const observing = {
      appendItems: async () => {
        stateAtWrite = (await buildState.read(parseNamespace(scope))).state;
        return { written: 0, deduped: 0 };
      },
    };
    await assert.rejects(
      () => ingestDocumentIntoNamespace({
        scope, text: DOC, source: "d.md", ts: "2026-01-01T00:00:00Z", maxChars: 6,
        deps: { store: observing, buildState },
      }),
      /expected .* chunks, wrote 0/,
      "a store that writes nothing must not be completable",
    );
    assert.equal(stateAtWrite, BUILD_STATES.BUILDING, "the namespace must already be BUILDING when the write runs");
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});

test("Unit engram ingest: RE-INGEST is idempotent and still completes", async () => {
  // Recovery path. Every chunk dedupes on the second run, so counting only NEW writes
  // would strand a perfectly good namespace in BUILDING -- turning idempotent recovery
  // into a way to break a working index.
  const { root, ingestDocument, buildState } = await svc();
  try {
    const scope = "document:reingest";
    const args = { scope, text: DOC, source: "d.md", ts: "2026-01-01T00:00:00Z", maxChars: 6, caller: CALLER };
    const first = await ingestDocument(args);
    const second = await ingestDocument(args);

    assert.equal(second.written, 0, "nothing new to write");
    assert.equal(second.deduped, first.chunks, "every chunk dedupes");
    assert.equal(second.state, BUILD_STATES.READY, "a re-ingest must still end READY");
    assert.equal((await buildState.read(parseNamespace(scope))).state, BUILD_STATES.READY);
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});

test("Unit engram ingest: an interrupted ingest RECOVERS by re-running", async () => {
  // Ties the two halves together: refuse while broken, then repair without manual
  // intervention. If this failed, "stays BUILDING forever" would be a dead end.
  const { root, buildState, tools, store } = await svc();
  try {
    const scope = "document:recovers";
    let fail = true;
    const flaky = {
      appendItems: async (ns, items) => {
        if (fail) { fail = false; throw new Error("transient"); }
        return store.appendItems(ns, items);
      },
    };
    const args = { scope, text: DOC, source: "d.md", ts: "2026-01-01T00:00:00Z", maxChars: 6, deps: { store: flaky, buildState } };

    await assert.rejects(() => ingestDocumentIntoNamespace(args), /transient/);
    assert.equal((await buildState.read(parseNamespace(scope))).state, BUILD_STATES.BUILDING);

    const retry = await ingestDocumentIntoNamespace(args);
    assert.equal(retry.state, BUILD_STATES.READY, "re-running must repair the namespace");
    assert.ok(await tools.recall({ scope, query: "gamma", k: 5, caller: CALLER }));
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});

test("Unit engram ingest: ingesting WITHOUT a buildState is refused", async () => {
  // Otherwise the lifecycle is optional, and an optional lifecycle is no lifecycle:
  // the chunks would land and the namespace would be queryable while incomplete.
  await assert.rejects(
    () => ingestDocumentIntoNamespace({
      scope: "document:no-lifecycle", text: DOC, source: "d.md",
      deps: { store: { appendItems: async () => ({ written: 1, deduped: 0 }) } },
    }),
    /buildState is required/,
  );
});
