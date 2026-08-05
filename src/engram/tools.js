/**
 * ENGRAM §2 — Memory-as-a-Service: the 3 MCP tools, EXACTLY.
 *
 *   memory.write({ scope, items })      — idempotent (content-hash dedup),
 *                                         trust-sealed, late-binding.
 *   memory.recall({ scope, query, k })  — REUSES the §1 engine verbatim
 *                                         (dense int8 exact-scan + BM25 + RRF
 *                                         + bounded diffusion + ACT-R) ->
 *                                         ranked memories + provenance path.
 *   memory.summarize({ scope, focus })  — retrieve-then-generate: recall
 *                                         DETERMINISTICALLY selects the subset;
 *                                         the injected renderer (Gemma) only
 *                                         GENERATES prose. Never a model in
 *                                         selection.
 *
 * This layer is a namespace + governance wrapper. It imports ONLY the §1
 * engine core + the sibling engram seams — no session/mcp/auth runtime — so
 * the product is detachable/sellable on its own.
 */

import { buildRecallIndex } from "../session/recall/index-core.js";
import { recall as recallEngine } from "../session/recall/retrieve.js";
import { createEmbedder } from "../session/recall/embedder.js";
import { normalizeString } from "../session/recall/text.js";

import { parseNamespace, authorize } from "./namespace.js";
import { sealItem, visibleUnderScope, isAuthoritative, classifyObservation } from "./trust.js";

function normalizeItem(raw) {
  if (typeof raw === "string") return { text: raw };
  if (!raw || typeof raw !== "object") return { text: "" };
  return { ...raw, text: normalizeString(raw.text || raw.message || raw.content) };
}

/** Deterministic, non-model summary used when no renderer is injected. */
function deterministicDigest(focus, memories) {
  const lines = memories.map((m, i) => {
    const seq = m.sequenceId ? `#${m.sequenceId} ` : "";
    return `${i + 1}. ${seq}${m.snippet || ""} [why: ${m.provenance}]`;
  });
  return [`Focus: ${focus}`, `Grounded in ${memories.length} recalled memories:`, ...lines].join("\n");
}

/**
 * Build the 3 MaaS tools over an injected store + governance + consent.
 * @param {object} deps
 * @param {object} deps.store         createStore(...)
 * @param {object} deps.consent       { allows(caller, namespace, scope) }
 * @param {object} deps.governance    createGovernance(...)
 * @param {object} [deps.embedder]
 * @param {{render: (ctx:object)=>Promise<string>|string}} [deps.renderer]  Gemma prose generator.
 * @param {(caller:object, namespace:object)=>boolean} [deps.isAuthorizedForSealed]
 * @param {()=>number} [deps.now]
 */
export function createMemoryTools({
  store,
  consent,
  governance,
  embedder = createEmbedder(),
  renderer = null,
  isAuthorizedForSealed = () => false,
  now = () => Date.now(),
} = {}) {
  async function write({ scope, items = [], caller } = {}) {
    const namespace = parseNamespace(scope);
    authorize(caller, namespace, "write", { consent }); // fail-closed 403
    const sealed = (Array.isArray(items) ? items : []).map((it) => {
      const item = normalizeItem(it);
      if (!item.author && !item.agentId) item.author = caller?.id;
      return sealItem(item, { caller });
    });
    const result = await store.appendItems(namespace, sealed);
    const meter = await governance.meter({ namespace: namespace.raw, caller, action: "write", count: result.written });
    return { ok: true, namespace: namespace.raw, written: result.written, deduped: result.deduped, meter };
  }

  // Shared retrieval core: authorize (fail-closed) + read + trust-filter +
  // §1 engine recall + receipt. Metered by the CALLER tool exactly once, so
  // summarize (which retrieves internally) is billed as one summarize, not
  // recall+summarize.
  async function retrieveInternal({ scope, query, k, role, caller }) {
    const namespace = parseNamespace(scope);
    authorize(caller, namespace, "read", { consent }); // fail-closed 403
    const authorizedForSealed = Boolean(isAuthorizedForSealed(caller, namespace));

    const all = await store.readObservations(namespace);
    const visible = [];
    for (const obs of all) {
      if (!obs.trust) obs.trust = classifyObservation(obs);
      if (visibleUnderScope(obs, { authorized: authorizedForSealed })) visible.push(obs);
    }

    const index = buildRecallIndex({ observations: visible, embedder, sessionId: namespace.raw });
    const engineResult = recallEngine(index, { query: normalizeString(query), k, role, now: now() });
    const results = engineResult.results.map((r) => {
      const obs = index.byId.get(r.observationId);
      const trust = obs?.trust || null;
      return { ...r, trust, authoritative: isAuthoritative(trust) };
    });
    const receipt = await governance.emitRecallReceipt({
      caller,
      scope: namespace.raw,
      namespace: namespace.raw,
      query: normalizeString(query),
      resultCount: results.length,
    });
    return { namespace, engineResult, results, receipt };
  }

  async function recall({ scope, query, k = 12, role = "", caller } = {}) {
    const { namespace, engineResult, results, receipt } = await retrieveInternal({ scope, query, k, role, caller });
    const meter = await governance.meter({ namespace: namespace.raw, caller, action: "recall", count: results.length });
    return {
      ok: true,
      namespace: namespace.raw,
      query: engineResult.query,
      k: engineResult.k,
      poolSize: engineResult.poolSize,
      results,
      receipt,
      meter,
    };
  }

  async function summarize({ scope, focus, k = 12, caller } = {}) {
    // Deterministic SELECT via the shared retrieval; renderer only GENERATES.
    const { namespace, results, receipt } = await retrieveInternal({ scope, query: focus, k, role: "", caller });
    const summary =
      renderer && typeof renderer.render === "function"
        ? await renderer.render({ focus, memories: results })
        : deterministicDigest(normalizeString(focus), results);
    const meter = await governance.meter({ namespace: namespace.raw, caller, action: "summarize", count: results.length });
    return {
      ok: true,
      namespace: namespace.raw,
      focus: normalizeString(focus),
      summary,
      generated: Boolean(renderer && typeof renderer.render === "function"),
      groundedIn: results.map((s) => ({ observationId: s.observationId, provenance: s.provenance })),
      receipt,
      meter,
    };
  }

  return { write, recall, summarize };
}
