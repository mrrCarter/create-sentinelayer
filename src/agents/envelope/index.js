/**
 * Agent envelope foundation (#A8).
 *
 * Generic multi-turn agent envelope that all 12 non-Jules personas adopt to
 * become "Jules-tier" — i.e., stateful agents with a turn loop, stuck
 * detection, and optional fix-cycles. Jules keeps its bespoke
 * src/agents/jules/ package because it has additional swarm-coordination
 * logic; everyone else shares this envelope.
 *
 * Public surface (stable):
 *   createAgentEnvelope(config) -> EnvelopeInstance
 *
 * An EnvelopeInstance has .run(inputs) that executes a bounded multi-turn
 * loop over the configured tools and returns:
 *   {
 *     messages:  [...full message trace...],
 *     findings:  [...structured findings...],
 *     stuckReason: null | "no-tool-calls" | "max-turns" | "budget-exceeded",
 *     turnsUsed: number,
 *     toolInvocations: [{turn, tool, input, output, error?}]
 *   }
 *
 * The envelope delegates actual LLM invocation to a pluggable client
 * supplied by the caller (so different personas can route to different
 * providers). The envelope itself is provider-agnostic.
 */

export { runEnvelopeLoop, DEFAULT_MAX_TURNS, DEFAULT_STUCK_THRESHOLD } from "./loop.js";
export { detectStuck } from "./pulse.js";
export { runFixCycle } from "./fix-cycle.js";
export { createEventStream } from "./stream.js";
