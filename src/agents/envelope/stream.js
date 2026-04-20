/**
 * Streaming event adapter (#A8 envelope).
 *
 * Wraps the envelope loop's onTurn callback so personas can publish
 * turn-level events to any sink (Telegram forum topic, SSE channel,
 * console spinner). The adapter normalizes event shape so sink
 * implementations don't need to know envelope internals.
 */

/**
 * @param {object} [options]
 * @param {Function} [options.sink] - (event) => void
 */
export function createEventStream({ sink } = {}) {
  const emit = typeof sink === "function" ? sink : () => {};
  const events = [];

  return {
    /** Call this as the envelope loop's onTurn callback. */
    onTurn: ({ turn, plan }) => {
      const event = {
        type: "turn",
        turn,
        planSummary: {
          stopReason: plan?.stopReason ?? null,
          toolCallCount: Array.isArray(plan?.toolCalls) ? plan.toolCalls.length : 0,
          findingCount: Array.isArray(plan?.findings) ? plan.findings.length : 0,
        },
      };
      events.push(event);
      try {
        emit(event);
      } catch {
        // sinks are advisory; never let them break the loop
      }
    },
    /** Get the buffered event history. */
    history: () => events.slice(),
  };
}
