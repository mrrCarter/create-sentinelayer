/**
 * ENGRAM §2 — governance seams: signed recall receipts + per-call metering.
 *
 * Both are CLEAN INTERFACES with P0 stubs, because the real backing is not
 * reachable in P0 (confirmed by the API scout):
 *   - Receipt signing = AIdenID, which is an EXTERNAL service
 *     (api.aidenid.com); this repo is only a client. §9 receipt shape is
 *     {caller, scope, ts, sig}. P0 emits an UNSIGNED receipt (sig=null) and
 *     marks stub:true — the seam is present so §2.1 drops in a real signer.
 *   - Metering = the server usage ledger is session-welded
 *     (SessionUsageLedgerEntry requires session_id + session_sequence_id).
 *     §2.1 generalizes it to a namespace/tenant ledger keyed on
 *     billing_account_id. P0 records a local stub entry.
 *
 * Never skip the seam — always emit (stub or real) so callers and tests can
 * assert governance fired on every write/recall/summarize.
 */

/**
 * @param {object} [options]
 * @param {{sign: (payload:object)=>Promise<string>|string}} [options.signer]  Real receipt signer (§2.1 AIdenID).
 * @param {{record: (entry:object)=>Promise<void>|void}} [options.meterSink]   Real usage-ledger sink (§2.1).
 * @param {()=>string} [options.now]
 */
export function createGovernance({ signer = null, meterSink = null, now = () => new Date().toISOString() } = {}) {
  return {
    /**
     * Emit a signed recall receipt (§9 {caller, scope, ts, sig}).
     * @returns {Promise<object>}
     */
    async emitRecallReceipt({ caller, scope, namespace, query = "", resultCount = 0 } = {}) {
      const base = {
        caller: caller?.id || null,
        scope,
        namespace: namespace || scope,
        query,
        resultCount,
        ts: now(),
      };
      if (signer && typeof signer.sign === "function") {
        const sig = await signer.sign(base);
        return { ...base, sig, stub: false };
      }
      return { ...base, sig: null, stub: true, seam: "aidenid-external-signer" };
    },

    /**
     * Meter one MaaS call.
     * @returns {Promise<object>}
     */
    async meter({ namespace, caller, action, count = 1, tokens = 0 } = {}) {
      const entry = {
        namespace,
        caller: caller?.id || null,
        action,
        count,
        tokens,
        ts: now(),
      };
      if (meterSink && typeof meterSink.record === "function") {
        await meterSink.record(entry);
        return { ...entry, stub: false };
      }
      return { ...entry, stub: true, seam: "namespace-usage-ledger" };
    },
  };
}
