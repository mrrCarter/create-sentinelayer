/**
 * ENGRAM §1 — token accounting for the "hydration cost decouples from
 * session length" claim (stack doc §1).
 *
 * Compares the cost of the STATUS QUO (replay the full material transcript)
 * against the ENGRAM path (retrieve top-K memories + provenance). Uses the
 * Anthropic tokenizer when available (agents here are Claude/codex), with a
 * deterministic chars/4 fallback so tests never depend on the native module.
 */

let cachedCounter;

async function getCounter() {
  if (cachedCounter !== undefined) return cachedCounter;
  try {
    const mod = await import("@anthropic-ai/tokenizer");
    cachedCounter = typeof mod.countTokens === "function" ? mod.countTokens : null;
  } catch {
    cachedCounter = null;
  }
  return cachedCounter;
}

/**
 * Count tokens in a string. Falls back to a chars/4 estimate.
 * @param {string} text
 * @returns {Promise<{tokens: number, method: string}>}
 */
export async function countTextTokens(text) {
  const value = String(text ?? "");
  const counter = await getCounter();
  if (counter) {
    try {
      return { tokens: counter(value), method: "anthropic-tokenizer" };
    } catch {
      // fall through to estimate
    }
  }
  return { tokens: Math.ceil(value.length / 4), method: "chars/4-estimate" };
}

/** Render a full-replay transcript line for an observation. */
function transcriptLine(obs) {
  const ts = obs.ts || "";
  const agent = obs.agentId || "unknown";
  const kind = obs.kind || "event";
  return `${ts} ${agent} ${kind}: ${obs.text}`.trim();
}

/** Render a compact recall-pack line (snippet + provenance) for a result. */
function packLine(result) {
  const seq = result.sequenceId ? `#${result.sequenceId} ` : "";
  return `${seq}${result.agentId} ${result.kind}: ${result.snippet} [why: ${result.provenance}]`.trim();
}

/**
 * Compute the token cut of recall-vs-replay for a session.
 *
 * @param {object} params
 * @param {object[]} params.observations  All material observations (full replay).
 * @param {object[]} params.results       The recall results (the pack).
 * @returns {Promise<{fullReplayTokens:number, recallPackTokens:number,
 *   reductionRatio:number, reductionPct:number, method:string,
 *   replayEvents:number, packEvents:number}>}
 */
export async function computeTokenCut({ observations = [], results = [] }) {
  const fullText = observations.map(transcriptLine).join("\n");
  const packText = results.map(packLine).join("\n");
  const full = await countTextTokens(fullText);
  const pack = await countTextTokens(packText);
  const ratio = pack.tokens > 0 ? full.tokens / pack.tokens : 0;
  return {
    fullReplayTokens: full.tokens,
    recallPackTokens: pack.tokens,
    reductionRatio: Number(ratio.toFixed(2)),
    reductionPct: full.tokens > 0 ? Number((100 * (1 - pack.tokens / full.tokens)).toFixed(1)) : 0,
    method: full.method,
    replayEvents: observations.length,
    packEvents: results.length,
  };
}
