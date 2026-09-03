/**
 * ENGRAM — document ingestion with SPAN-LEVEL PROVENANCE.
 *
 * The session adapter's atom is a message, addressed by `sequenceId`. A document
 * has no such atom: it must be chunked, and the moment you chunk without recording
 * each chunk's position you can name a chunk but cannot prove it is the line the
 * caller asked for. "What is on page 3337 line 45" then gets answered by something
 * that SOUNDS right, which is worse than not answering.
 *
 * So every chunk carries where it came from, and `resolveSpan` re-reads the source
 * to prove the quote rather than trusting the stored copy.
 *
 * TWO THINGS THAT ARE NOT OBVIOUS AND ARE LOAD-BEARING:
 *
 * 1. IDENTITY MUST INCLUDE POSITION. `itemId` (store.js) hashes
 *    [kind, author, text, ts] and the store DEDUPES on it. Documents repeat
 *    themselves constantly -- blank lines, `---`, table rows, boilerplate, a
 *    recurring header -- and every repeat after the first would be silently
 *    dropped, its position unrecoverable, precisely when the queried line is a
 *    common one. `itemId` honours an explicit `id`, so chunks set one that
 *    includes the span. Same document re-ingested -> identical ids (idempotent,
 *    which is what makes "build once, serve everyone" real); same text at a
 *    different offset -> a different id, which is correct because it is a
 *    different occurrence.
 *
 * 2. OFFSETS ARE UTF-16 CODE UNITS, NOT BYTES. They index the JS string, so
 *    `text.slice(start, end)` is exact by construction. For any source containing
 *    astral characters these differ from byte offsets, and calling them "byte
 *    offsets" would be a claim this module does not support. `docDigest` is
 *    SHA-256 over the UTF-8 encoding of the whole document -- that one IS
 *    tamper-evidence, unlike the store's FNV-1a `contentHash`, which is a dedup
 *    key and nothing more.
 */

import { createHash } from "node:crypto";

/** Chunk kind. Distinct from `session` so a namespace's atoms are never confused. */
export const DOCUMENT_CHUNK_KIND = "document";

/** SHA-256 over the document's UTF-8 bytes. Tamper-evidence, not a dedup key. */
export function documentDigest(text) {
  return createHash("sha256").update(String(text ?? ""), "utf8").digest("hex");
}

/**
 * Deterministic, position-inclusive chunk id.
 * Same (document, span) -> same id, on every run and every machine.
 */
export function chunkId(digest, start, end) {
  return `doc:${String(digest).slice(0, 16)}:${start}-${end}`;
}

/**
 * Split on line boundaries, accumulating whole lines up to `maxChars`.
 *
 * Line-aligned deliberately: the caller's question is "page N line M", so a chunk
 * that begins mid-line makes the answer harder to prove than it needs to be. A
 * single line longer than `maxChars` is emitted whole rather than split, because
 * truncating it would produce a chunk whose text is not what the source says.
 *
 * @param {string} text                 the whole document, verbatim
 * @param {object} [options]
 * @param {number} [options.maxChars]   soft ceiling per chunk (UTF-16 code units)
 * @param {number} [options.linesPerPage] lines per page for the `page` coordinate
 * @returns {{start:number,end:number,line:number,endLine:number,page:number,text:string}[]}
 */
export function splitIntoSpans(text, { maxChars = 1200, linesPerPage = 50 } = {}) {
  const source = String(text ?? "");
  if (!source) return [];
  if (!Number.isInteger(maxChars) || maxChars < 1) {
    throw new TypeError("maxChars must be a positive integer");
  }
  if (!Number.isInteger(linesPerPage) || linesPerPage < 1) {
    throw new TypeError("linesPerPage must be a positive integer");
  }

  const spans = [];
  let chunkStart = 0;
  let cursor = 0;
  let line = 1;
  let chunkStartLine = 1;

  const flush = (end, endLine) => {
    if (end <= chunkStart) return;
    spans.push({
      start: chunkStart,
      end,
      line: chunkStartLine,
      endLine,
      page: Math.floor((chunkStartLine - 1) / linesPerPage) + 1,
      text: source.slice(chunkStart, end),
    });
  };

  while (cursor < source.length) {
    const nl = source.indexOf("\n", cursor);
    const lineEnd = nl === -1 ? source.length : nl + 1;
    // Would adding this line overflow a non-empty chunk? Close the chunk first.
    if (lineEnd - chunkStart > maxChars && cursor > chunkStart) {
      flush(cursor, line - 1);
      chunkStart = cursor;
      chunkStartLine = line;
    }
    cursor = lineEnd;
    if (nl !== -1) line += 1;
  }
  flush(cursor, lastCoveredLine(line, source));
  return spans;
}

/** The last line number covered when the document does not end in a newline. */
function lastCoveredLine(line, source) {
  return source.endsWith("\n") ? Math.max(1, line - 1) : line;
}

/**
 * Ingest a document as span-carrying store items.
 *
 * The span rides INSIDE the item (not alongside it) so it is covered by whatever
 * digests the item, and the id encodes the span so the store's content-hash dedup
 * cannot collapse two occurrences of the same text.
 *
 * @param {string} text
 * @param {object} options
 * @param {string} options.source   human-readable origin (filename, url, title)
 * @param {string} [options.author]
 * @param {string} [options.ts]     ISO timestamp; defaults to now
 * @returns {{docDigest:string, source:string, chars:number, items:object[]}}
 */
export function ingestDocument(text, { source, author = "document", ts, maxChars, linesPerPage } = {}) {
  const body = String(text ?? "");
  const origin = String(source ?? "").trim();
  if (!origin) throw new TypeError("source is required: an unattributed span cannot be verified");

  const docDigest = documentDigest(body);
  const stamp = ts || new Date().toISOString();
  const spans = splitIntoSpans(body, {
    ...(maxChars === undefined ? {} : { maxChars }),
    ...(linesPerPage === undefined ? {} : { linesPerPage }),
  });

  const items = spans.map((span) => ({
    id: chunkId(docDigest, span.start, span.end),
    kind: DOCUMENT_CHUNK_KIND,
    author,
    ts: stamp,
    text: span.text,
    span: {
      start: span.start,
      end: span.end,
      line: span.line,
      endLine: span.endLine,
      page: span.page,
    },
    docDigest,
    source: origin,
  }));

  return { docDigest, source: origin, chars: body.length, items };
}

/**
 * Re-derive a chunk's text FROM THE SOURCE and prove it matches what was stored.
 *
 * This is the whole point of the module: a needle answer is only trustworthy if
 * the quote can be reproduced from the original at the coordinates it claims. A
 * mismatch means the stored copy and the source have diverged, and the honest
 * response is to refuse rather than serve the stored text as though verified.
 *
 * @returns {{ok:true, quote:string, start:number, end:number, line:number, page:number}
 *          | {ok:false, reason:string}}
 */
export function resolveSpan(documentText, item) {
  const source = String(documentText ?? "");
  const span = item?.span;
  if (!span || !Number.isInteger(span.start) || !Number.isInteger(span.end)) {
    return { ok: false, reason: "item carries no integer span" };
  }
  if (span.start < 0 || span.end > source.length || span.end < span.start) {
    return { ok: false, reason: "span does not lie within the document" };
  }
  if (item.docDigest && documentDigest(source) !== item.docDigest) {
    return { ok: false, reason: "document digest does not match the one the span was cut from" };
  }
  const quote = source.slice(span.start, span.end);
  if (typeof item.text === "string" && quote !== item.text) {
    return { ok: false, reason: "stored text does not match the source at that span" };
  }
  return { ok: true, quote, start: span.start, end: span.end, line: span.line, page: span.page };
}
