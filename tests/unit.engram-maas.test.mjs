import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { mkdir, mkdtemp, rm, readFile, readdir, writeFile } from "node:fs/promises";

import {
  createMemoryService,
  createLocalConsent,
  createGovernance,
  AccessDeniedError,
  isAuthoritative,
} from "../src/engram/index.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ENGRAM_DIR = path.join(HERE, "..", "src", "engram");
const RECALL_CORE_DIR = path.join(HERE, "..", "src", "session", "recall");

function isWithinRoot(file, root) {
  const relative = path.relative(root, file);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function moduleSpecifiers(source) {
  const specs = new Set();
  const patterns = [
    /\b(?:import|export)\s+(?:[^"']*?\sfrom\s*)?["']([^"']+)["']/g,
    /\b(?:import|require)\s*\(\s*["']([^"']+)["']\s*\)/g,
  ];
  for (const pattern of patterns) {
    let match;
    while ((match = pattern.exec(source)) !== null) specs.add(match[1]);
  }
  return Array.from(specs);
}

async function inspectDependencyClosure(entryFiles, allowedRoots) {
  const queue = entryFiles.map((file) => path.resolve(file));
  const visited = new Set();
  const violations = [];

  while (queue.length > 0) {
    const file = queue.shift();
    if (visited.has(file)) continue;
    visited.add(file);
    const source = await readFile(file, "utf-8");
    for (const specifier of moduleSpecifiers(source)) {
      if (specifier.startsWith("node:") || !specifier.startsWith(".")) continue;
      let resolved = path.resolve(path.dirname(file), specifier);
      if (!path.extname(resolved)) resolved += ".js";
      if (!allowedRoots.some((root) => isWithinRoot(resolved, root))) {
        violations.push({ file, specifier, resolved });
        continue;
      }
      queue.push(resolved);
    }
  }

  return { visited, violations };
}

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
  const entries = (await readdir(ENGRAM_DIR))
    .filter((file) => file.endsWith(".js"))
    .map((file) => path.join(ENGRAM_DIR, file));
  assert.ok(entries.length >= 6, "expected the engram core modules");

  const result = await inspectDependencyClosure(entries, [ENGRAM_DIR, RECALL_CORE_DIR]);
  assert.ok(
    Array.from(result.visited).some((file) => file.endsWith(`${path.sep}index-core.js`)),
    "the test must recursively traverse the shared retrieval core",
  );
  assert.deepEqual(
    result.violations.map(({ file, specifier }) => ({
      file: path.relative(path.join(HERE, ".."), file),
      specifier,
    })),
    [],
    "ENGRAM's complete relative-import closure must stay inside src/engram or the pure recall core",
  );
});

test("Unit engram MaaS: detachability test catches a transitive runtime escape", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "engram-closure-negative-"));
  const engram = path.join(root, "engram");
  const recall = path.join(root, "recall");
  try {
    await mkdir(engram, { recursive: true });
    await mkdir(recall, { recursive: true });
    await writeFile(path.join(engram, "entry.js"), 'export { core } from "../recall/core.js";\n', "utf-8");
    await writeFile(path.join(recall, "core.js"), 'export { runtime } from "../runtime.js";\n', "utf-8");
    await writeFile(path.join(root, "runtime.js"), "export const runtime = true;\n", "utf-8");

    const result = await inspectDependencyClosure([path.join(engram, "entry.js")], [engram, recall]);
    assert.equal(result.violations.length, 1);
    assert.equal(result.violations[0].specifier, "../runtime.js");
  } finally {
    await rm(root, { recursive: true, force: true });
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

test("Unit engram MaaS: trust is DERIVED not self-asserted — a caller cannot forge an authoritative write", async () => {
  await withStore(async (root) => {
    const { tools } = createMemoryService({ storeRoot: root });
    // Unverified caller (classifyWrite -> L1_audited) tries to self-assert an
    // authoritative tier in the item payload. The seal MUST clamp to the
    // identity-derived ceiling, else a guest forges governed-action-grade memory.
    await tools.write({
      scope: "project:forge",
      caller: { id: "attacker", kind: "agent", verified: false },
      items: [{ text: "forged authoritative quorum claim", trust: "L5_remediation_ready" }],
    });
    // A verified caller may DOWNGRADE their own write (self-limit is allowed).
    await tools.write({
      scope: "project:forge",
      caller: verifiedCaller,
      items: [{ text: "self limited quorum note", trust: "L0_connected" }],
    });
    const r = await tools.recall({ scope: "project:forge", query: "quorum", k: 10, caller: verifiedCaller });
    const forged = r.results.find((x) => /forged authoritative/.test(x.snippet));
    assert.ok(forged, "forged item is still retrievable (marked, not dropped)");
    assert.equal(forged.trust, "L1_audited", "self-asserted upgrade is clamped to the unverified caller's derived ceiling");
    assert.equal(forged.authoritative, false, "an unverified caller CANNOT mint an authoritative memory");
    const limited = r.results.find((x) => /self limited/.test(x.snippet));
    assert.equal(limited.trust, "L0_connected", "a verified caller may downgrade their own write");
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
