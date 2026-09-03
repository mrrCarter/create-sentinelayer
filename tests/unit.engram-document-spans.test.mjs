import test from "node:test";
import assert from "node:assert/strict";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  DOCUMENT_CHUNK_KIND,
  chunkId,
  documentDigest,
  ingestDocument,
  resolveSpan,
  splitIntoSpans,
} from "../src/engram/document.js";
import { createStore, itemId } from "../src/engram/store.js";
import { parseNamespace } from "../src/engram/namespace.js";

/**
 * A NEEDLE ANSWER MUST BE REPRODUCIBLE FROM THE SOURCE, AND NO OCCURRENCE MAY BE LOST.
 *
 * The two failures these gates exist for are both SILENT, which is why they are
 * worth testing rather than eyeballing:
 *
 *   1. The store dedupes on itemId = hash(kind, author, text, ts). A document
 *      repeats itself constantly, so identical chunks at different offsets would
 *      collapse into one and the later occurrence's position would be gone --
 *      with `written` reporting success. That is data loss that looks like dedup.
 *
 *   2. A span that cannot be re-derived from the source lets a citation name
 *      coordinates it cannot support. The failure mode is a fluent, wrong quote,
 *      not an error.
 */

const DOC = ["alpha", "---", "beta", "---", "gamma"].join("\n");

test("Unit engram document: the SAME text at different offsets keeps distinct identities", () => {
  // "---" appears twice. Under content-hash dedup alone these are one item.
  const { items } = ingestDocument(DOC, { source: "d.md", ts: "2026-01-01T00:00:00Z", maxChars: 6 });
  const separators = items.filter((i) => i.text.startsWith("---"));
  assert.ok(separators.length >= 2, "fixture must actually contain a repeated chunk");

  const ids = new Set(separators.map((i) => i.id));
  assert.equal(ids.size, separators.length, "each occurrence must have its own id");

  // And the id the STORE will use must differ too -- this is the property that matters,
  // since itemId() is what dedup keys on.
  const storeIds = new Set(separators.map((i) => itemId(i)));
  assert.equal(storeIds.size, separators.length, "store-visible ids must differ per occurrence");
});

test("Unit engram document: repeated chunks SURVIVE a real store round-trip (the actual bug)", async () => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "engram-doc-"));
  try {
    const store = createStore({ storeRoot: root });
    const ns = parseNamespace("document:spans-test");
    const { items } = ingestDocument(DOC, { source: "d.md", ts: "2026-01-01T00:00:00Z", maxChars: 6 });

    const first = await store.appendItems(ns, items);
    assert.equal(first.written, items.length, "every chunk must be written, including repeats");
    assert.equal(first.deduped, 0);

    // CONTROL: idempotency is NOT broken by the fix. Re-ingesting the same document
    // must dedupe entirely -- that is what makes "build once, serve everyone" real.
    const second = await store.appendItems(ns, ingestDocument(DOC, {
      source: "d.md", ts: "2026-01-01T00:00:00Z", maxChars: 6,
    }).items);
    assert.equal(second.written, 0, "re-ingesting the same document must write nothing");
    assert.equal(second.deduped, items.length);
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});

test("Unit engram document: spans TILE the document exactly -- no gap, no overlap", () => {
  const spans = splitIntoSpans(DOC, { maxChars: 6 });
  assert.ok(spans.length > 1, "fixture must actually split");

  let cursor = 0;
  for (const s of spans) {
    assert.equal(s.start, cursor, "each span must begin where the previous ended (no gap/overlap)");
    assert.equal(s.text, DOC.slice(s.start, s.end), "span text must be the source slice");
    cursor = s.end;
  }
  assert.equal(cursor, DOC.length, "spans must cover the document to its end");
  assert.equal(spans.map((s) => s.text).join(""), DOC, "concatenation must reproduce the document");
});

test("Unit engram document: a resolved quote is exact, and coordinates are integers", () => {
  const { items } = ingestDocument(DOC, { source: "d.md", ts: "2026-01-01T00:00:00Z", maxChars: 6 });
  for (const item of items) {
    const got = resolveSpan(DOC, item);
    assert.equal(got.ok, true, got.reason);
    assert.equal(got.quote, item.text);
    // SS19.1 canonicalization admits safe integers only; a float coordinate would be
    // rejected at encode time, so the shape has to be right at the source.
    for (const key of ["start", "end", "line", "endLine", "page"]) {
      assert.ok(Number.isInteger(item.span[key]), `${key} must be an integer`);
    }
  }
});

test("Unit engram document: resolveSpan REFUSES a document that is not the one cut from", () => {
  const { items } = ingestDocument(DOC, { source: "d.md", ts: "2026-01-01T00:00:00Z", maxChars: 6 });
  const tampered = DOC.replace("beta", "BETA");
  assert.notEqual(documentDigest(tampered), documentDigest(DOC));

  const got = resolveSpan(tampered, items[0]);
  assert.equal(got.ok, false, "a different document must not silently resolve");
  assert.match(got.reason, /digest/);
});

test("Unit engram document: resolveSpan REFUSES when the stored text diverges from the source", () => {
  const { items } = ingestDocument(DOC, { source: "d.md", ts: "2026-01-01T00:00:00Z", maxChars: 6 });
  // Same digest claim, but the stored copy no longer matches what is at that span.
  const lying = { ...items[0], text: "something else entirely" };
  const got = resolveSpan(DOC, lying);
  assert.equal(got.ok, false, "a stored copy that disagrees with the source must refuse");
  assert.match(got.reason, /does not match the source/);
});

test("Unit engram document: resolveSpan REFUSES a span outside the document", () => {
  const [item] = ingestDocument(DOC, { source: "d.md", ts: "2026-01-01T00:00:00Z" }).items;
  const past = { ...item, span: { ...item.span, end: DOC.length + 50 }, docDigest: undefined };
  assert.equal(resolveSpan(DOC, past).ok, false);

  const noSpan = { ...item, span: undefined };
  assert.equal(resolveSpan(DOC, noSpan).ok, false);
});

test("Unit engram document: line and page coordinates track the source", () => {
  const doc = Array.from({ length: 10 }, (_, i) => `line ${i + 1}`).join("\n");
  const spans = splitIntoSpans(doc, { maxChars: 8, linesPerPage: 4 });

  assert.equal(spans[0].line, 1);
  assert.equal(spans[0].page, 1);
  for (const s of spans) {
    assert.ok(s.line >= 1 && s.endLine >= s.line, "line range must be well-ordered");
    assert.equal(s.page, Math.floor((s.line - 1) / 4) + 1, "page derives from the start line");
  }
  // A line beyond the first page must actually report a later page, or the
  // coordinate is decorative.
  assert.ok(spans.some((s) => s.page > 1), "multi-page fixture must produce a page > 1");
});

test("Unit engram document: ingestion is deterministic and refuses an unattributed source", () => {
  const a = ingestDocument(DOC, { source: "d.md", ts: "2026-01-01T00:00:00Z" });
  const b = ingestDocument(DOC, { source: "d.md", ts: "2026-01-01T00:00:00Z" });
  assert.deepEqual(a.items, b.items, "same input must produce identical items");
  assert.equal(a.items[0].kind, DOCUMENT_CHUNK_KIND);
  assert.equal(chunkId(a.docDigest, 0, 5), `doc:${a.docDigest.slice(0, 16)}:0-5`);

  assert.throws(() => ingestDocument(DOC, { source: "  " }), /source is required/);
});

test("Unit engram document: a line longer than maxChars is kept WHOLE, never truncated", () => {
  const long = "x".repeat(50);
  const doc = `short\n${long}\nshort2`;
  const spans = splitIntoSpans(doc, { maxChars: 10 });
  assert.equal(spans.map((s) => s.text).join(""), doc, "no content may be dropped");
  assert.ok(spans.some((s) => s.text.includes(long)), "the long line must survive intact");
});
