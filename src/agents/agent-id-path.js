import path from "node:path";

// An agent id names exactly one entry directly under the directory that holds per-agent files:
// <run>/agents/<id>.json for an audit run, <session>/agents/<id>.json for a session.
//
// The rule is the canonical agent id (canonicalAgentId in src/session/admission-auth.js:
// lowercase letters, digits, '.', '_' and '-', never starting or ending with '-'), held to a
// spelling that is also one portable file name:
// - 1-64 characters, the bound admission already puts on the same ids;
// - starts with a letter or digit, so it is never '.' or '..';
// - does not end with '.': Windows drops it, so "abc." and "abc" would name the same file;
// - is not a Windows device name (refused on every platform).
// Every id in use fits: built-in audit agents and personas (security, code-quality,
// ai-governance), ids from --agent (canonicalised before they get here), generated ids
// (claude-a1b2, claude-3) and daemon ids (senti, scope-engine, audit-orchestrator).
const AGENT_ID_PATTERN = /^[a-z0-9](?:[a-z0-9._-]{0,62}[a-z0-9_])?$/;
// CON, PRN, AUX, NUL, COM1-9 and LPT1-9, with or without an extension.
const RESERVED_DEVICE_NAME = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/;
// Either separator, on every platform.
const SEPARATOR = /[\\/]/;

export const AGENT_ID_RULE =
  "agent id must be 1-64 characters: lowercase letters, digits, '.', '_' or '-', starting with a letter or digit and ending with a letter, digit or '_'.";
export const AGENT_ID_RESERVED_RULE = "agent id must not be a reserved device name.";
export const AGENT_ID_ENTRY_RULE = "agent id must name one entry directly under its directory.";

/** The rule `value` breaks, or "" when it is an agent id that can name a file. */
export function agentIdProblem(value) {
  const id = typeof value === "string" ? value : "";
  if (!AGENT_ID_PATTERN.test(id)) return AGENT_ID_RULE;
  if (RESERVED_DEVICE_NAME.test(id)) return AGENT_ID_RESERVED_RULE;
  return "";
}

/**
 * `<dir>/<agentId><suffix>`, refused unless the result is exactly one entry directly under
 * `dir` and the id follows the agent id rule. The one-entry check runs first, on the id as
 * given (no separator, and the resolved path is a direct child of `dir` with that exact name),
 * so it holds by itself whatever the rule admits.
 */
export function resolveAgentIdPath(dir, agentId, suffix = "") {
  const root = path.resolve(String(dir || "."));
  const id = typeof agentId === "string" ? agentId : String(agentId ?? "");
  if (!id) {
    throw new Error("agentId is required.");
  }
  const entry = `${id}${suffix}`;
  const target = path.resolve(root, entry);
  if (SEPARATOR.test(entry) || path.dirname(target) !== root || path.basename(target) !== entry) {
    throw new Error(AGENT_ID_ENTRY_RULE);
  }
  const problem = agentIdProblem(id);
  if (problem) {
    throw new Error(problem);
  }
  return target;
}
