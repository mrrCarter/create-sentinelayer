// admission-auth.js — which credential a session command runs on.
//
// An admitted agent must act with ITS admission credential: room-scoped, expiring,
// revocable, and limited to what the owner approved. The human's own token is
// broader (every room they belong to, owner rights where they have them), so
// quietly falling back to it would let an agent step around its grant.
//
// A command that knows its (session, agent) wraps its work in withAgentAdmission:
//
//   - nothing stored for that pair  -> the legacy path, unchanged (human token)
//   - a live credential             -> every session API call made inside the
//                                      callback resolves to that credential, sent
//                                      only to the API that issued it
//   - a tombstone (expired, malformed, bound elsewhere) -> refused before any
//                                      request is made; never treated as absence
//
// The scope is an AsyncLocalStorage context (src/auth/admission-scope.js) that
// resolveActiveAuthSession consults first. It therefore covers every helper a
// command calls, however deep, and every credential lookup, not only the session
// transport's.
// A revoked credential looks live here; the API refuses it (401) and the command
// fails. There is no retry with another credential anywhere on this path.

import path from "node:path";
import process from "node:process";

import { admittedAgentScope } from "../auth/admission-scope.js";
import { readAdmissionCredentialState } from "./admission.js";

export class AdmissionCredentialRefused extends Error {
  constructor(message, { reason, sessionId, agentId } = {}) {
    super(message);
    this.name = "AdmissionCredentialRefused";
    this.code = "ADMISSION_CREDENTIAL_REFUSED";
    this.reason = reason;
    this.sessionId = sessionId;
    this.agentId = agentId;
  }
}

const REFUSAL_HINT = {
  expired: "its admission has expired",
  malformed: "its stored admission credential is unreadable",
  bound_to_another_session_or_agent: "its stored admission credential names a different session or agent",
  no_issuing_authority: "its stored admission credential does not record the API that issued it",
};

/**
 * THE canonical agent id: exactly what every session command acts as. Commands
 * canonicalise through this (normalizeAgentId delegates here), so the identity that
 * authorises and the identity that executes are computed by one function.
 */
export function canonicalAgentId(value) {
  return String(value ?? "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/**
 * Refuse, before any I/O, an agent id whose canonical form is a DIFFERENT identity than
 * its spelling (case folding aside): "a:b" would act as "a-b", a separate identity with
 * its own key and credential. Two spellings are never silently aliased.
 */
export function assertCanonicalAgentId(value, source) {
  const raw = String(value ?? "").trim();
  if (!raw) return;
  const canonical = canonicalAgentId(raw);
  if (canonical !== raw.toLowerCase()) {
    throw new AdmissionCredentialRefused(
      `${source} "${raw}" is not a canonical agent id: commands would act as "${canonical || "(none)"}", ` +
        `a different identity. Use the canonical spelling.`,
      { reason: "non_canonical_agent_id" }
    );
  }
}

// Options whose value decides WHICH identity, and so which credential, a command
// runs as. Given more than once they are ambiguous (Commander keeps the LAST value),
// so they are refused outright rather than guessed at.
const IDENTITY_OPTIONS = ["--agent", "--session", "--id", "--path"];

// Options end at a bare `--`; everything after it is an operand, as Commander reads it.
function optionTokens(args) {
  const tokens = args.map((arg) => String(arg ?? ""));
  const end = tokens.indexOf("--");
  return end < 0 ? tokens : tokens.slice(0, end);
}

function optionValue(args, name) {
  const tokens = optionTokens(args);
  for (let i = 0; i < tokens.length; i += 1) {
    const arg = tokens[i];
    if (arg === name) return String(tokens[i + 1] || "").trim();
    if (arg.startsWith(`${name}=`)) return arg.slice(name.length + 1).trim();
  }
  return "";
}

/** Refuse a `session` command that gives an identity-deciding option more than once. */
export function assertUnambiguousIdentityOptions(args = []) {
  if (String(args[0] || "").trim().toLowerCase() !== "session") return;
  const tokens = optionTokens(args);
  for (const name of IDENTITY_OPTIONS) {
    const count = tokens.filter((t) => t === name || t.startsWith(`${name}=`)).length;
    if (count > 1) {
      throw new AdmissionCredentialRefused(
        `${name} is given ${count} times. It decides which identity and credential this ` +
          `command runs as, so it may be given at most once.`,
        { reason: "ambiguous_identity_option" }
      );
    }
  }
}

// Who `--agent` names, per `session` subcommand ("group sub" for nested groups).
//   actor   -- the named agent performs the operation: it runs on THAT agent's
//              admission (or refuses, if what is stored is a tombstone)
//   target  -- a human acts ON that agent (stop its listener, kill or unregister
//              it): it stays on the human's own credential, so an owner can always
//              recover from a misbehaving or expired agent
//   control -- join: the human's control plane; it scopes its own post-claim steps
// A `session` subcommand missing from this table fails CLOSED when an admission
// is stored for its (session, agent): new commands must be classified.
export const SESSION_AGENT_PRINCIPAL = Object.freeze({
  say: "actor",
  "post-agent": "actor",
  observe: "actor",
  action: "actor",
  react: "actor",
  reply: "actor",
  comment: "actor",
  edit: "actor",
  read: "actor",
  listen: "actor",
  pins: "actor",
  recap: "actor",
  now: "actor",
  lock: "actor",
  unlock: "actor",
  renew: "actor",
  guard: "actor",
  "guard-hook": "actor",
  "guard-install": "actor",
  "codex-notify": "actor",
  daemon: "actor",
  "checkpoint create": "actor",
  "checkpoint generate": "actor",
  "ticket list": "actor",
  "ticket claim": "actor",
  "ticket renew": "actor",
  "ticket release": "actor",
  "ticket submit": "actor",
  "ticket events": "actor",
  "access mode": "control",
  "access request": "control",
  "access list": "control",
  "access status": "control",
  "access approve": "control",
  "access deny": "control",
  "access revoke": "control",
  kill: "target",
  "stop-listener": "target",
  leave: "target",
  "guard-uninstall": "target",
  join: "control",
});
const SESSION_COMMAND_GROUPS = new Set(["access", "checkpoint", "ticket"]);

async function implicitAgent(sessionId, targetPath, env) {
  // The same identity the command itself resolves when --agent is omitted
  // (SENTINELAYER_AGENT_ID, then the sole joined local agent). Imported lazily:
  // the commands module imports this one.
  const { resolveSessionSayIdentity } = await import("../commands/session.js");
  const identity = await resolveSessionSayIdentity({ sessionId, agentId: "", targetPath, env }).catch(() => null);
  const agentId = String(identity?.agentId || "").trim();
  return agentId && agentId !== "cli-user" ? agentId : "";
}

/**
 * The (session, agent) a `session` command must run as, when this machine holds an
 * admission for it -- live OR tombstoned -- else null. Used by BOTH the auth gate
 * and the dispatch choke point in runCli, so the two can never disagree.
 *
 * Only ACTOR commands are scoped (see SESSION_AGENT_PRINCIPAL). The agent is
 * --agent, else SENTINELAYER_AGENT_ID, else the implicit joined identity. A
 * subcommand outside the table is scoped only if it NAMES an agent with --agent,
 * and then it refuses (unclassified); otherwise it is a human command. The
 * session is --session or any positional argument for which an admission is stored:
 * a credential file is keyed by (session, agent), so a positional that is not a
 * session can never match one. An unclassified subcommand with a stored admission
 * throws: it is never silently run on the human token.
 */
export async function resolveAgentAdmissionTarget(args = [], { env = process.env, homeDir } = {}) {
  if (String(args[0] || "").trim().toLowerCase() !== "session") return null;
  assertUnambiguousIdentityOptions(args);
  const tokens = args.map((a) => String(a ?? "").trim());
  const terminator = tokens.indexOf("--");
  const positional = [
    ...(terminator < 0 ? tokens : tokens.slice(0, terminator)).slice(1).filter((a) => a && !a.startsWith("-")),
    ...(terminator < 0 ? [] : tokens.slice(terminator + 1).filter(Boolean)),
  ];
  if (!positional.length) return null;
  // Every `session` subcommand, join included: an identity-changing spelling is refused
  // before any lookup, dispatch or request.
  assertCanonicalAgentId(optionValue(args, "--agent"), "--agent");
  assertCanonicalAgentId(env.SENTINELAYER_AGENT_ID, "SENTINELAYER_AGENT_ID");
  let command = positional[0].toLowerCase();
  let rest = positional.slice(1);
  if (SESSION_COMMAND_GROUPS.has(command) && rest.length) {
    command = `${command} ${rest[0].toLowerCase()}`;
    rest = rest.slice(1);
  }
  const principal = SESSION_AGENT_PRINCIPAL[command];
  if (principal === "target" || principal === "control") return null;
  const flagAgent = optionValue(args, "--agent");
  // A subcommand outside the table that names NO agent is a human command (archive,
  // members, ...): it is not agent-attributed, whatever SENTINELAYER_AGENT_ID says.
  if (!principal && !flagAgent) return null;
  const explicitAgent = flagAgent || String(env.SENTINELAYER_AGENT_ID || "").trim();
  const candidates = [optionValue(args, "--session"), optionValue(args, "--id"), ...rest].filter(Boolean);
  for (const sessionId of candidates) {
    const targetPath = path.resolve(process.cwd(), optionValue(args, "--path") || ".");
    const agentId = explicitAgent || (await implicitAgent(sessionId, targetPath, env));
    if (!agentId) continue;
    const held = await readAdmissionCredentialState(sessionId, agentId, { homeDir }).catch(() => ({ state: "none" }));
    if (held.state === "none") continue;
    if (!principal) {
      throw new AdmissionCredentialRefused(
        `\`sl session ${command}\` is not classified as acting as "${agentId}" or on it, and "${agentId}" ` +
          `holds an admission in session ${sessionId}. Refusing rather than guessing which credential it should use.`,
        { reason: "unclassified_command", sessionId, agentId }
      );
    }
    return { sessionId, agentId };
  }
  return null;
}

/**
 * preAction guard: the identity Commander ACTUALLY resolved for this action must be
 * the one whose admission scope (if any) the dispatch was wrapped in. Computed from
 * Commander's own resolved options -- counting only values given on the command line,
 * not defaults such as read's `--agent cli-user` -- so no argv reading of ours can
 * disagree with execution. A mismatch refuses before the action runs.
 */
export async function assertDispatchMatchesScope(actionCommand, { env = process.env, homeDir } = {}) {
  const names = [];
  for (let cmd = actionCommand; cmd && cmd.parent; cmd = cmd.parent) names.unshift(cmd.name());
  if (String(names[0] || "").toLowerCase() !== "session") return;
  const command = names.slice(1).join(" ").toLowerCase();
  const principal = SESSION_AGENT_PRINCIPAL[command];
  const opts = actionCommand.opts();
  const given = (key) =>
    actionCommand.getOptionValueSource?.(key) === "cli" ? String(opts[key] ?? "").trim() : "";
  let actual = null;
  if (principal === "actor" || (!principal && given("agent"))) {
    const sessionId = given("session") || given("id") || String(actionCommand.processedArgs?.[0] ?? "").trim();
    const targetPath = path.resolve(process.cwd(), String(opts.path || "."));
    const agentId =
      given("agent") ||
      String(env.SENTINELAYER_AGENT_ID || "").trim() ||
      (sessionId ? await implicitAgent(sessionId, targetPath, env) : "");
    if (sessionId && agentId) {
      const held = await readAdmissionCredentialState(sessionId, agentId, { homeDir }).catch(() => ({ state: "none" }));
      if (held.state !== "none") actual = { sessionId, agentId };
    }
  }
  const inForce = currentAdmittedAgent();
  const key = (pair) => (pair ? `${String(pair.sessionId).toLowerCase()}/${String(pair.agentId).toLowerCase()}` : "none");
  if (key(actual) !== key(inForce)) {
    throw new AdmissionCredentialRefused(
      `Refusing: \`sl session ${command}\` resolved to ${key(actual)} but was dispatched under ` +
        `${key(inForce)}. Authorization and execution must name the same identity.`,
      { reason: "scope_mismatch" }
    );
  }
}

/** Run `fn` with the right credential for (sessionId, agentId). See the module header. */
export async function withAgentAdmission(sessionId, agentId, fn, { homeDir, now } = {}) {
  const held = await readAdmissionCredentialState(sessionId, agentId, { homeDir, now });
  if (held.state === "none") return fn({ admitted: false });
  if (held.state !== "live") {
    const why = REFUSAL_HINT[held.reason] || `its stored admission is unusable (${held.reason})`;
    throw new AdmissionCredentialRefused(
      `Agent "${agentId}" cannot act in session ${sessionId}: ${why}. ` +
        `It will not fall back to your own credentials. Request a new admission with ` +
        `\`sl session join ${sessionId} --agent ${agentId} --goal "<what it is here to do>"\`.`,
      { reason: held.reason, sessionId, agentId }
    );
  }
  const credential = Object.freeze({ ...held.credential });
  try {
    return await admittedAgentScope.run(credential, () =>
      fn({ admitted: true, admissionId: credential.admissionId, agentId: credential.agentId })
    );
  } catch (error) {
    if (error instanceof Error && /\bapi_401\b|not_authenticated/.test(error.message)) {
      error.message +=
        ` The API no longer accepts agent "${agentId}"'s admission for this room (revoked, expired,` +
        ` or outside its grant). It did not fall back to your own credentials.`;
    }
    throw error;
  }
}

/** The admission this code is running under, without the token, or null. */
export function currentAdmittedAgent() {
  const credential = admittedAgentScope.getStore();
  if (!credential) return null;
  return {
    admissionId: credential.admissionId,
    sessionId: credential.sessionId,
    agentId: credential.agentId,
    expiresAt: credential.expiresAt,
  };
}
