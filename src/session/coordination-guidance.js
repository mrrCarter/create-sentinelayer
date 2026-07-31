export const COORDINATION_GUIDANCE_TITLE = "Multi-Agent Coordination Protocol";

export const COORDINATION_ETIQUETTE_ITEMS = Object.freeze([
  "Find the recent Senti session for this codebase: run `sl session list --path .` and `sl session list --remote --path .`; join the right room with `sl session join <id> --name <your-name> --role coder`.",
  "When you have an agent grant, post agent updates with `sl session post-agent <id> \"status: <update>\" --agent <your-agent-id>` so they render as the agent, not the human relay.",
  "Before implementation, post a short semantic plan only when peers need it; keep routine ownership and progress in message actions.",
  "Claim shared files through authoritative leases before editing: `sl session lock <id> <file> --agent <your-name> --intent \"<scope>\"`; inspect with `sl session locks <id>` and release with `sl session unlock <id> <file> --agent <your-name>`. Lease lifecycle never belongs in chat, and guarded terminal/editor writes report holder, intent, and expiry directly when blocked.",
  "Run one background/secondary listener for replies with `sl session listen --session <id> --agent <your-name> --transport poll --interval 60 --active-interval 60 --emit ndjson --no-presence`; polling applies bounded jitter, exponential transient backoff, and `Retry-After` as a hard floor. `session listen` refuses duplicate local listeners for the same session/agent by default; use `--force` only to stop and replace an existing local owner and `--allow-duplicate` only when you intentionally need parallel wake hooks. `session listen` is only a delivery cursor, not a grounding command; join or recap before acting. For your primary interactive listener, omit `--no-presence` so it renews an ephemeral TTL outside the transcript. Unsupported or degraded presence remains unknown and never falls back to durable heartbeat events. If background polling is unavailable, fall back to `sl session sync <id> --json` then `sl session read <id> --tail 20 --json` every 5 minutes.",
  "For long-lived rooms, make sure exactly one visible participant owns the Senti daemon: `sl session daemon --session <id> --recap-interval 300 --checkpoint-interval 60`. Routine room health is a derived status projection, not a transcript event; run `sl session recap now <id> --remote --agent <your-name> --json` for local grounding and use an explicit checkpoint only for a durable semantic handoff.",
  "Use message actions for low-noise coordination before posting a new top-level message: `sl session react <id> ack --target-sequence <n>` only when an explicit ACK is useful, `sl session action <id> working_on --target-sequence <n>` for ownership, and `sl session reply <id> <sequence> \"<message>\"` / `sl session comment <id> <sequence> \"<message>\"` for threaded responses. `sl session read <id> --remote --agent <your-name>` advances one monotonic per-agent read cursor for the displayed window; it never appends per-message view events; reserve `sl session view <id> <sequence>` for repair/backfill of that same cursor. Run `sl session actions` for the full list.",
  "Search before asking peers to restate context: `sl session search <id> \"<topic>\" --limit 10`.",
  "Run `sl review --diff` after each finished file or PR-ready diff and post the result summary back to the session.",
  "Post findings through `sl session say <id> \"finding: [P2] <title> in <file>:<line>\"` with enough context for a peer to act.",
  "Ask for help in-session instead of stopping on unexpected file changes, blocked context, or ambiguous ownership.",
  "Offer non-conflicting follow-up work to peers when you finish your claimed scope or discover separable tasks.",
  "Run `sl --help` when you hit an unfamiliar workflow before guessing at command syntax.",
  "Leave the session when done with `sl session leave <id>` after posting the final status and verification evidence.",
]);

export function getCoordinationEtiquetteItems() {
  return [...COORDINATION_ETIQUETTE_ITEMS];
}

// Short, punchy success reminders surfaced periodically by `session listen` so
// agents are continually nudged to coordinate well (Carter: "keep reminding
// agents how to be successful... always ack and say if you're working on
// something"). Kept tight on purpose — this fires on a timer, so it must stay
// low-noise.
export const SESSION_LIVE_SUCCESS_TIPS = Object.freeze([
  "Ack messages you've read: `sl session react <id> ack --target-sequence <n>` — don't go silent.",
  "Say what you're doing: claim work with `sl session action <id> working_on --target-sequence <n>`.",
  'Reply in-thread with `sl session reply <id> <seq> "..."`; start a new top-level post only when needed.',
  "Post findings and blockers in-session, and ask for help instead of stalling.",
  "Prefer low-noise actions over new top-level messages; run `sl session actions` for the full list.",
]);

export function getSessionLiveSuccessTips() {
  return [...SESSION_LIVE_SUCCESS_TIPS];
}

export function renderCoordinationNumberedList({
  items = COORDINATION_ETIQUETTE_ITEMS,
  indent = "",
} = {}) {
  return items.map((item, index) => `${indent}${index + 1}. ${item}`).join("\n");
}

export function renderCoordinationBulletList({
  items = COORDINATION_ETIQUETTE_ITEMS,
  indent = "",
} = {}) {
  return items.map((item) => `${indent}- ${item}`).join("\n");
}

export function renderCoordinationMarkdownSection({
  headingLevel = 2,
  title = COORDINATION_GUIDANCE_TITLE,
} = {}) {
  const level = Math.max(1, Math.min(6, Number.parseInt(String(headingLevel || 2), 10) || 2));
  return `${"#".repeat(level)} ${title}
${renderCoordinationNumberedList()}`;
}

export function renderCoordinationTicketBlock() {
  return [
    "Coordination rules:",
    renderCoordinationNumberedList(),
  ].join("\n");
}
