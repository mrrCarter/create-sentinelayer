/**
 * ENGRAM §2 — the ONE shared namespace store.
 *
 * This is the single substrate the 3 tools, the 8-Needle SLA, and the
 * token-cut measurement all read (relay ruling #5: no second store). A
 * namespace's observations are the UNION of:
 *   - a read-only SOURCE ADAPTER for its kind, if one is registered
 *     (e.g. kind `session` -> the SL session adapter that maps session
 *     events to observations). Adapters are INJECTED, so this module imports
 *     NO session runtime and stays detachable.
 *   - a generic append-log the tools write to (`memory.write`), one NDJSON
 *     file per namespace, with content-hash dedup (ENGRAM §3 — idempotent).
 *
 * Detachability: imports ONLY the §1 engine core (observations + text) and
 * node builtins. No SentinelLayer session/mcp/auth imports.
 */

import fsp from "node:fs/promises";
import path from "node:path";

import { buildObservationsFromItems } from "./observations.js";
import { contentHash, normalizeString } from "../session/recall/text.js";

/**
 * Where a namespace's files live. EXPORTED so siblings (e.g. build-state.js) resolve
 * the same directory rather than re-deriving the convention -- a second copy of this
 * sanitization would drift and silently point at a different namespace.
 */
export function namespaceDir(root, namespace) {
  const safe = namespace.raw.replace(/[^A-Za-z0-9._-]/g, "_");
  return path.join(root, ".sentinelayer", "engram", safe);
}

/** Stable, content-addressed item id (idempotent write — §3 dedup for free). */
export function itemId(item = {}) {
  const explicit = normalizeString(item.id) || normalizeString(item.idempotencyToken);
  if (explicit) return explicit;
  const basis = [item.kind, item.author || item.agentId, item.text, item.ts]
    .map((value) => normalizeString(value))
    .join("|");
  return `h:${contentHash(basis)}`;
}

async function readItemsFile(file) {
  try {
    const raw = await fsp.readFile(file, "utf-8");
    const items = [];
    for (const line of raw.split(/\r?\n/)) {
      if (!line.trim()) continue;
      try {
        items.push(JSON.parse(line));
      } catch {
        // ignore malformed lines
      }
    }
    return items;
  } catch (error) {
    if (error && error.code === "ENOENT") return [];
    throw error;
  }
}

/**
 * Create the namespace store.
 * @param {object} options
 * @param {string} options.storeRoot          Root dir for the append-log store.
 * @param {Record<string, (id:string)=>Promise<object[]>>} [options.adapters]
 *        Map of namespace-kind -> async source adapter returning observations.
 * @returns {{
 *   appendItems: (namespace:object, items:object[]) => Promise<{written:number, deduped:number, namespace:string}>,
 *   readObservations: (namespace:object) => Promise<object[]>,
 * }}
 */
export function createStore({ storeRoot, adapters = {} } = {}) {
  const root = path.resolve(String(storeRoot || "."));

  return {
    async appendItems(namespace, items = []) {
      const dir = namespaceDir(root, namespace);
      const file = path.join(dir, "items.ndjson");
      const existing = await readItemsFile(file);
      const seen = new Set(existing.map((it) => itemId(it)));
      const lines = [];
      let written = 0;
      let deduped = 0;
      for (const item of Array.isArray(items) ? items : []) {
        const id = itemId(item);
        if (seen.has(id)) {
          deduped += 1;
          continue;
        }
        seen.add(id);
        lines.push(JSON.stringify({ ...item, id }));
        written += 1;
      }
      if (lines.length > 0) {
        await fsp.mkdir(dir, { recursive: true });
        await fsp.appendFile(file, `${lines.join("\n")}\n`, "utf-8");
      }
      return { written, deduped, namespace: namespace.raw };
    },

    async readObservations(namespace) {
      const adapter = adapters[namespace.kind];
      const adapterObservations = adapter
        ? await Promise.resolve(adapter(namespace.id)).catch(() => [])
        : [];
      const file = path.join(namespaceDir(root, namespace), "items.ndjson");
      const items = await readItemsFile(file);
      const itemObservations = buildObservationsFromItems(items, { namespace: namespace.raw }).observations;

      // Union, dedup by id (first wins — adapter source is authoritative for its ids).
      const byId = new Map();
      for (const obs of [...(Array.isArray(adapterObservations) ? adapterObservations : []), ...itemObservations]) {
        if (obs && !byId.has(obs.id)) byId.set(obs.id, obs);
      }
      return Array.from(byId.values());
    },
  };
}
