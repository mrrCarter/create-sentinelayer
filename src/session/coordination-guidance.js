export const COORDINATION_GUIDANCE_TITLE = "Multi-Agent Coordination Protocol";

export const COORDINATION_ETIQUETTE_ITEMS = Object.freeze([
  "Find the recent Senti session for this codebase: run `sl session list --path .` and `sl session list --remote --path .`; join the right room with `sl session join <id> --name <your-name> --role coder`.",
  "Before implementation, post a short plan and file claims with `sl session say <id> \"plan: <scope>; files: <paths>\"`.",
  "Claim shared files before editing with `lock: <file> - <intent>` and release them with `unlock: <file> - done`.",
  "Poll coordination every 5 minutes: run `sl session sync <id> --json`, then `sl session read <id> --tail 20 --json`, and answer any non-self message.",
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
