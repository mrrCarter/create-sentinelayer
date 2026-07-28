import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { mkdtemp, rm, readFile, readdir } from "node:fs/promises";

import {
  createMemoryService,
  createLocalConsent,
  createGovernance,
  AccessDeniedError,
  isAuthoritative,
} from "../src/engram/index.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ENGRAM_DIR = path.join(HERE, "..", "src", "engram");

async function withStore(fn) {
  const root = await mkdtemp(path.join(os.tmpdir(), "engram-maas-"));
  try {
    return await fn(root);
  } finally {
    await rm(root, { recursive: true, force: true }).catch(() => {});
  }
}

const verifiedCaller = { id: "codex", kind: "agent", verified: true };

test("Unit engram MaaS: HARD detachability — src/engram imports NO session runtime", async () => {
  // The detachable MaaS core may import ONLY node builtins, sibling engram
  // modules, and the §1 engine core (../session/recall/). Any other
  // ../session/* (runtime), ../mcp, ../auth, etc. breaks sellable-alone.
  const files = (await readdir(ENGRAM_DIR)).filter((f) => f.endsWith(".js"));
  assert.ok(files.length >= 6, "expected the engram core modules");
  const importRe = /(?:import|export)[^"']*?from\s*["']([^"']+)["']/g;
  const allowed = /^(node:|\.\/|\.\.\/session\/recall\/)/;
  for (const file of files) {
    const src = await readFile(path.join(ENGRAM_DIR, file), "utf-8");
    let m;
    while ((m = importRe.exec(src)) !== null) {
      const spec = m[1];
      assert.ok(
        allowed.test(spec),
        `src/engram/${file} imports '${spec}' — only node:, ./, or ../session/recall/ are allowed (detachability)`,
      );
    }
  }
});

test("Unit engram MaaS: 3 tools, idempotent write, provenance, namespace isolation", async () => {
  await withStore(async (root) => {
    const { tools } = createMemoryService({ storeRoot: root });
    const w1 = await tools.write({ scope: "project:web", caller: verifiedCaller, items: [
      { text: "gate merges behind the omar policy", topics: ["gate-policy"] },
      { text: "opened PR #60 implementing the gate", topics: ["gate-policy"] },
    ] });
    assert.equal(w1.written, 2);
    // Idempotent: identical content re-written -> content-hash dedup, no-op.
    const w2 = await tools.write({ scope: "project:web", caller: verifiedCaller, items: [
      { text: "gate merges behind the omar policy", topics: ["gate-policy"] },
    ] });
    assert.equal(w2.written, 0);
    assert.equal(w2.deduped, 1);

    const r = await tools.recall({ scope: "project:web", query: "omar gate policy", k: 5, caller: verifiedCaller });
    assert.ok(r.results.length > 0);
    for (const hit of r.results) assert.ok(hit.provenance && hit.provenance.length > 0, "every hit carries provenance");

    // Namespace = tenancy boundary: another namespace sees nothing.
    const other = await tools.recall({ scope: "project:other", query: "omar gate policy", k: 5, caller: verifiedCaller });
    assert.equal(other.results.length, 0);
  });
});

test("Unit engram MaaS: consent is fail-closed (403) for guests / no identity", async () => {
  await withStore(async (root) => {
    const { tools } = createMemoryService({ storeRoot: root });
    await tools.write({ scope: "ns:x", caller: verifiedCaller, items: [{ text: "hello world note" }] });
    await assert.rejects(
      () => tools.recall({ scope: "ns:x", query: "hello", caller: { id: "g1", kind: "guest" } }),
      (e) => e instanceof AccessDeniedError && e.status === 403,
    );
    await assert.rejects(
      () => tools.write({ scope: "ns:x", caller: {}, items: [{ text: "y" }] }),
      (e) => e instanceof AccessDeniedError && e.status === 403,
    );
  });
});

test("Unit engram MaaS: trust seal — unverified not authoritative; sealed/revoked hidden from unauthorized scope", async () => {
  await withStore(async (root) => {
    const { tools } = createMemoryService({ storeRoot: root });
    await tools.write({ scope: "project:t", caller: { id: "u", kind: "agent", verified: false }, items: [{ text: "provisional zephyr claim" }] });
    await tools.write({ scope: "project:t", caller: verifiedCaller, items: [{ text: "certified zephyr truth" }] });
    await tools.write({ scope: "project:t", caller: verifiedCaller, items: [{ text: "sealed zephyr secret", sealed: true }] });
    await tools.write({ scope: "project:t", caller: verifiedCaller, items: [{ text: "revoked zephyr note", revoked: true }] });

    // Default: caller not authorized for sealed -> sealed + revoked never surface.
    const r = await tools.recall({ scope: "project:t", query: "zephyr", k: 10, caller: verifiedCaller });
    const texts = r.results.map((x) => x.snippet).join(" | ");
    assert.ok(!/sealed zephyr secret/.test(texts), "sealed hidden from unauthorized scope");
    assert.ok(!/revoked zephyr note/.test(texts), "revoked never surfaced");
    const unverified = r.results.find((x) => /provisional/.test(x.snippet));
    assert.equal(unverified.authoritative, false, "unverified write is retrievable but NOT authoritative");
    const verified = r.results.find((x) => /certified/.test(x.snippet));
    assert.equal(verified.authoritative, true, "verified write is authoritative");
    assert.equal(isAuthoritative(verified.trust), true);

    // With an authorized-for-sealed caller, the sealed memory surfaces.
    const svc2 = createMemoryService({ storeRoot: root, isAuthorizedForSealed: () => true });
    const r2 = await svc2.tools.recall({ scope: "project:t", query: "zephyr", k: 10, caller: verifiedCaller });
    assert.ok(r2.results.some((x) => /sealed zephyr secret/.test(x.snippet)), "sealed surfaces to authorized scope");
    assert.ok(!r2.results.some((x) => /revoked zephyr note/.test(x.snippet)), "revoked still never surfaces");
  });
});

test("Unit engram MaaS: summarize — deterministic SELECT, renderer only GENERATES", async () => {
  await withStore(async (root) => {
    // Selection must be identical with and without a renderer (no model in selection).
    const base = createMemoryService({ storeRoot: root });
    await base.tools.write({ scope: "ns:s", caller: verifiedCaller, items: [
      { text: "alpha decision about pricing", topics: ["pricing"] },
      { text: "beta note on pricing tiers", topics: ["pricing"] },
      { text: "unrelated gamma chatter", topics: ["misc"] },
    ] });
    const noRenderer = await base.tools.summarize({ scope: "ns:s", focus: "pricing", k: 5, caller: verifiedCaller });
    assert.equal(noRenderer.generated, false, "no renderer -> deterministic digest, not model-generated");

    let seenSubset = null;
    const withRenderer = createMemoryService({
      storeRoot: root,
      renderer: { render: ({ memories }) => { seenSubset = memories.map((m) => m.observationId); return "GEMMA_PROSE"; } },
    });
    const rendered = await withRenderer.tools.summarize({ scope: "ns:s", focus: "pricing", k: 5, caller: verifiedCaller });
    assert.equal(rendered.generated, true);
    assert.equal(rendered.summary, "GEMMA_PROSE");
    // Deterministic selection: same subset regardless of renderer presence.
    assert.deepEqual(
      rendered.groundedIn.map((g) => g.observationId),
      noRenderer.groundedIn.map((g) => g.observationId),
    );
    assert.deepEqual(seenSubset, rendered.groundedIn.map((g) => g.observationId));
  });
});

test("Unit engram MaaS: governance seams fire on every call (stub-flagged in P0)", async () => {
  await withStore(async (root) => {
    const recorded = [];
    const governance = createGovernance({ meterSink: { record: (e) => recorded.push(e.action) } });
    const { tools } = createMemoryService({ storeRoot: root, governance });
    await tools.write({ scope: "ns:g", caller: verifiedCaller, items: [{ text: "metered memory item" }] });
    const r = await tools.recall({ scope: "ns:g", query: "metered", caller: verifiedCaller });
    await tools.summarize({ scope: "ns:g", focus: "metered", caller: verifiedCaller });
    assert.deepEqual(recorded, ["write", "recall", "summarize"], "meter fires per call");
    // Receipt seam present; P0 stub is unsigned + flagged.
    assert.equal(r.receipt.sig, null);
    assert.equal(r.receipt.stub, true);
    assert.equal(r.receipt.caller, "codex");
  });
});
