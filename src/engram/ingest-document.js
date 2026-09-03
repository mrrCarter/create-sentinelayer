/**
 * ENGRAM — the document ingest path: the thing that makes the other three real.
 *
 * Before this, the pieces existed and none of them ran together:
 *   document.js     could cut a document into span-carrying chunks -- nothing called it
 *   build-state.js  could refuse a half-built namespace -- but nothing ever called
 *                   `begin()`, so BUILDING was UNREACHABLE and the gate #808 wired
 *                   could never actually fire
 *
 * A gate that is invoked but guards a state nothing can enter is a subtler version of
 * a gate nobody invokes: it runs, it passes, and it has never once said no.
 *
 * ORDER IS THE WHOLE DESIGN, and it is chosen for the failure case rather than the
 * happy one:
 *
 *   1. begin()      BEFORE the first chunk is written
 *   2. write chunks
 *   3. complete()   only after every chunk landed, with the count checked
 *
 * If the process dies at step 2 -- or the store throws, or the disk fills -- nothing
 * runs step 3, so the namespace stays BUILDING and refuses queries FOREVER rather than
 * silently serving a partial index. Recovery is to re-ingest, which is safe because
 * chunk ids are content+position addressed: the chunks already written dedupe, the
 * missing ones land, and the build completes.
 *
 * The alternative order -- write first, then mark building -- would leave a window
 * where a partial index answers as though whole, which is the exact failure the
 * lifecycle exists to prevent.
 */

import { ingestDocument } from "./document.js";
import { parseNamespace } from "./namespace.js";

/**
 * Ingest a document into a namespace, under the build lifecycle.
 *
 * @param {object} options
 * @param {string} options.scope        namespace, e.g. "document:handbook"
 * @param {string} options.text         the document, verbatim
 * @param {string} options.source       origin (filename, url, title) -- required
 * @param {object} options.deps         { store, buildState }
 * @param {object} [options.caller]
 * @param {string} [options.ts]
 * @param {number} [options.maxChars]
 * @param {number} [options.linesPerPage]
 * @returns {Promise<{ok:true, namespace:string, docDigest:string, chunks:number,
 *                    written:number, deduped:number, state:string}>}
 */
export async function ingestDocumentIntoNamespace({
  scope,
  text,
  source,
  deps: { store, buildState } = {},
  caller,
  ts,
  maxChars,
  linesPerPage,
} = {}) {
  if (!store) throw new TypeError("a store is required");
  if (!buildState) {
    // Refuse rather than ingest without the lifecycle. Writing chunks with no
    // build state would produce a namespace that is queryable while incomplete --
    // the precise condition build-state.js exists to make impossible.
    throw new TypeError("a buildState is required: ingesting without the lifecycle would leave a partial index queryable");
  }

  const namespace = parseNamespace(scope);
  const cut = ingestDocument(text, {
    source,
    ...(caller?.id ? { author: caller.id } : {}),
    ...(ts === undefined ? {} : { ts }),
    ...(maxChars === undefined ? {} : { maxChars }),
    ...(linesPerPage === undefined ? {} : { linesPerPage }),
  });

  // STEP 1 -- claim the namespace as BUILDING before a single chunk exists on disk.
  await buildState.begin(namespace, {
    docDigest: cut.docDigest,
    expectedChunks: cut.items.length,
  });

  // STEP 2 -- write. If this throws, step 3 never runs and the namespace stays
  // BUILDING, which is the correct outcome: an interrupted ingest must not answer.
  const result = await store.appendItems(namespace, cut.items);

  // STEP 3 -- complete, with the count. `complete` itself refuses if fewer chunks
  // landed than were promised, so a short write cannot be stamped ready.
  //
  // The count is written + deduped, i.e. chunks PRESENT, not chunks newly added.
  // Counting only new writes would make re-ingesting an already-complete document
  // fail to complete (every chunk dedupes, so written === 0), which would strand a
  // perfectly good namespace in BUILDING -- turning idempotent recovery into a way
  // to break a working index.
  const state = await buildState.complete(namespace, {
    writtenChunks: result.written + result.deduped,
  });

  return {
    ok: true,
    namespace: namespace.raw,
    docDigest: cut.docDigest,
    chunks: cut.items.length,
    written: result.written,
    deduped: result.deduped,
    state: state.state,
  };
}
