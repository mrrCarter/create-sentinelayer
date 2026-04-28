/**
 * Senti — auto-name + welcome anonymous participants.
 *
 * When an agent joins without a clear name + model, Senti steps in:
 *
 *  1. `assignFriendlyName({ model, existingAgents })` — generates a
 *     stable, human-readable id like "guest-3", "claude-2",
 *     "codex-anon-1" derived from the model family + the next free
 *     ordinal in the session. Sequential beats hex-suffix for the
 *     ChatGPT-style "everyone has a face" UX Carter asked for.
 *
 *  2. `buildSentiWelcome({ agentId, model, role })` — produces the
 *     payload for an `agent_identified` event Senti emits in the
 *     stream so the new participant + everyone watching sees the
 *     auto-assignment + how to override it.
 *
 *  3. `isAnonymousAgent({ agentId, model })` — single-source check
 *     for "this registration didn't carry real identity" used by
 *     callers to decide whether to invoke (1) and (2). Generic
 *     prefixes (`agent-…`, `cli-user`) and unknown models qualify.
 *
 * This module never touches the network or the disk; it's pure naming
 * logic that the agent-registry wires into the registration path.
 */

const ANONYMOUS_AGENT_PREFIXES = Object.freeze(["agent-", "cli-user", "guest-"]);
const ANONYMOUS_MODELS = Object.freeze(["", "unknown", "cli", "anonymous"]);

/**
 * Strict: should the agent-registry auto-rename this registration?
 *
 * The hook's contract is "if a name is already there, leave it alone; if
 * not, give them one." So we ONLY auto-rename when the caller gave us
 * nothing OR the literal default placeholder `cli-user`. Any other
 * caller-supplied id — even ones that *look* generic like `agent-alpha`,
 * `guest-team`, or `codex-task-holder-1` — was an intentional choice and
 * round-trips verbatim.
 *
 * Why so strict:
 *  - e2e test #91 (CLI session commands flow) does `session join
 *    --name agent-alpha` and asserts the id round-trips. The previous
 *    rule (`agent-` prefix => rename) clobbered it.
 *  - PR 348/351 kill tests register `codex-task-holder-1` with model=""
 *    and need verbatim round-trip.
 *  - `isAnonymousAgent` is intentionally separate and stays permissive
 *    (model can flag) for downstream callers that decide whether to
 *    *welcome* a participant; the registry hook is stricter.
 *
 * @param {{originalCallerAgentId: string}} params
 * @returns {boolean}
 */
export function shouldAutoRenameInRegistry({ originalCallerAgentId = "" } = {}) {
  const id = normalize(originalCallerAgentId).toLowerCase();
  if (!id) return true;
  return id === "cli-user";
}

/**
 * @typedef {object} AgentLike
 * @property {string} agentId
 * @property {string} [model]
 */

function normalize(value) {
  return String(value == null ? "" : value).trim();
}

function familyFromModel(modelName) {
  const lower = normalize(modelName).toLowerCase();
  if (!lower || lower === "unknown" || lower === "anonymous") return "guest";
  if (lower.includes("claude") || lower.includes("sonnet") || lower.includes("opus")) {
    return "claude";
  }
  if (lower.includes("codex") || lower.includes("gpt-")) return "codex";
  if (lower.includes("gemini")) return "gemini";
  if (lower.includes("senti") || lower.includes("sentinel")) return "senti";
  if (lower === "cli") return "guest";
  // Otherwise use the first sanitized token so distinct providers stay
  // distinct even when we don't recognize them.
  const token = lower.split(/[\s:/_-]+/).find(Boolean) || "guest";
  return token.replace(/[^a-z0-9]/g, "") || "guest";
}

/**
 * Given the existing agent roster + the model the new participant
 * declared (which may be empty/unknown), pick the next free ordinal
 * within that family and return `<family>-<ordinal>`. Stable across
 * runs because we pass the existing agents in.
 *
 * @param {{model?: string, existingAgents?: Array<AgentLike>}} params
 * @returns {string}
 */
export function assignFriendlyName({ model = "", existingAgents = [] } = {}) {
  const family = familyFromModel(model);
  const taken = new Set(
    (Array.isArray(existingAgents) ? existingAgents : [])
      .map((agent) => normalize(agent && agent.agentId).toLowerCase())
      .filter(Boolean),
  );
  for (let n = 1; n <= 9999; n += 1) {
    const candidate = `${family}-${n}`;
    if (!taken.has(candidate)) return candidate;
  }
  // Pathological fallback — should never hit in practice, but a
  // 4-digit ceiling without an escape would be a footgun.
  return `${family}-${Date.now().toString(36)}`;
}

/**
 * Decide whether the registration looks anonymous and therefore needs
 * Senti to step in with a friendly name. We treat any of:
 *
 *  - empty / fallback agentId (`agent-…`, `cli-user`, `guest-…`)
 *  - empty / unknown / cli model
 *
 * as a signal. Either alone is enough — the cli-user default agent
 * still wants Senti's welcome the first time.
 *
 * @param {AgentLike} agent
 * @returns {boolean}
 */
export function isAnonymousAgent(agent = {}) {
  const id = normalize(agent.agentId).toLowerCase();
  const model = normalize(agent.model).toLowerCase();
  const idAnonymous =
    !id ||
    ANONYMOUS_AGENT_PREFIXES.some((prefix) => id.startsWith(prefix));
  const modelAnonymous = ANONYMOUS_MODELS.includes(model);
  return idAnonymous || modelAnonymous;
}

/**
 * Derive a deterministic session title from a workspace path + clock.
 *
 * Carter's complaint: every CLI invocation minted an unnamed session, so the
 * web sidebar filled with hundreds of "<null>" rows that all looked like the
 * same chat re-created. The fix: when the caller doesn't pass `--title`, give
 * the session a stable label based on the codebase basename + today's date in
 * UTC, e.g. `create-sentinelayer-2026-04-28`.
 *
 * - Basename only (we never leak the absolute path).
 * - Sanitized to `[a-z0-9-]` so the title is URL-safe + dashboard-friendly.
 * - Date is UTC ISO short form (YYYY-MM-DD) for reproducibility regardless of
 *   the host timezone.
 * - Falls back to `session-<date>` if the path has no usable basename.
 *
 * @param {string} targetPath
 * @param {{now?: Date}} [options]
 * @returns {string}
 */
export function deriveSessionTitle(targetPath, { now = new Date() } = {}) {
  const raw = String(targetPath || "").trim();
  // Use forward slashes consistently — Windows paths come through with
  // backslashes from path.resolve. We don't import the `path` module here
  // to keep this function pure + cheap to test.
  const last = raw.split(/[/\\]+/).filter(Boolean).pop() || "";
  const slug = last
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
  const stamp = (now instanceof Date && !Number.isNaN(now.getTime()) ? now : new Date())
    .toISOString()
    .slice(0, 10);
  return slug ? `${slug}-${stamp}` : `session-${stamp}`;
}

/**
 * Build the payload Senti emits as `agent_identified` when it has
 * stepped in to name a participant. Consumers (CLI / web) render it
 * verbatim; the `instructions` line tells the user how to override.
 *
 * @param {{
 *   agentId: string,
 *   model?: string,
 *   role?: string,
 *   sessionId?: string,
 *   wasAnonymous: boolean,
 *   originalAgentId?: string,
 * }} params
 * @returns {{
 *   alert: "agent_identified",
 *   agentId: string,
 *   model: string,
 *   role: string,
 *   wasAnonymous: boolean,
 *   originalAgentId: string,
 *   message: string,
 *   instructions: string,
 * }}
 */
export function buildSentiWelcome({
  agentId,
  model = "unknown",
  role = "observer",
  wasAnonymous = false,
  originalAgentId = "",
} = {}) {
  const cleanModel = normalize(model) || "unknown";
  const cleanRole = normalize(role) || "observer";
  const cleanId = normalize(agentId);
  const message = wasAnonymous
    ? `Welcome ${cleanId}. I auto-named you because you joined without a name; introduce yourself anytime.`
    : `Welcome ${cleanId}. You're in as ${cleanRole}.`;
  const instructions = `Update with: sl session rename <sessionId> ${cleanId} --to <new-id> [--model <model>]`;
  return {
    alert: "agent_identified",
    agentId: cleanId,
    model: cleanModel,
    role: cleanRole,
    wasAnonymous: Boolean(wasAnonymous),
    originalAgentId: normalize(originalAgentId),
    message,
    instructions,
  };
}
