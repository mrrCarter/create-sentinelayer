// Claude Code host wake adapter (Wake-Up & Notification Bus, L1).
//
// One of the per-host adapters the future `sentid` daemon (L2) drives through a
// single uniform interface:  { hostName, installWakeHook(opts), wake(target) }.
// The daemon calls `adapter.wake(...)` without caring which CLI is behind it.
//
// Ground-truth this encodes (verified against Claude Code hook docs, 2026-05):
//   * An external process CANNOT poke an idle/stopped Claude Code session in
//     place. `asyncRewake` background hooks and `Stop`-hook `decision:"block"`
//     are real, but they only act WITHIN an already-running session.
//   * The only DETERMINISTIC external wake is for the daemon to own the agent
//     lifecycle and (re)spawn `claude --resume <id> "<event>"` per message.
// So `wake()` is implemented as a daemon-owned resume, while the hook builders
// expose the in-session primitives for callers that keep a session parked.
//
// Borrowed by copy (no imports) from the reference agent-CLI wake patterns:
// the deferred-hook-result absorption shape and the channel-notification policy
// gate idea — adapted, not vendored.

import { execFile } from "node:child_process";

export const hostName = "claude";

const DEFAULT_CLAUDE_BIN = "claude";
const DEFAULT_RESUME_TIMEOUT_MS = 120_000;
const DEFAULT_ASYNC_HOOK_TIMEOUT_S = 600;
// Claude Code overrides a Stop hook after it blocks this many times in a row
// without progress; our release helper mirrors that cap so a parked session
// can never wedge itself.
const STOP_BLOCK_CAP = 8;
const MAX_MESSAGE_CHARS = 16_000;

function requireNonEmptyString(value, label) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new TypeError(`claude wake: ${label} must be a non-empty string`);
  }
  return value;
}

function normalizeMessage(message) {
  const text = requireNonEmptyString(message, "message");
  // Cap length so a runaway event payload can't blow the argv / context.
  return text.length > MAX_MESSAGE_CHARS ? text.slice(0, MAX_MESSAGE_CHARS) : text;
}

/**
 * Build the `claude` argv for a daemon-owned resume wake. Returns a plain
 * argument array so callers invoke it via execFile (no shell), which is what
 * keeps an untrusted event message from being interpreted as a command.
 *
 * @param {{ sessionId: string, message: string, print?: boolean, extraArgs?: string[] }} opts
 * @returns {string[]}
 */
export function buildResumeArgs({ sessionId, message, print = true, extraArgs = [] } = {}) {
  requireNonEmptyString(sessionId, "sessionId");
  const text = normalizeMessage(message);
  if (!Array.isArray(extraArgs) || extraArgs.some((a) => typeof a !== "string")) {
    throw new TypeError("claude wake: extraArgs must be an array of strings");
  }
  const args = ["--resume", sessionId, ...extraArgs];
  // `-p` runs headless/non-interactive, which is what a daemon-driven wake wants.
  if (print) args.push("-p");
  args.push(text);
  return args;
}

/**
 * Build an `asyncRewake` background command-hook fragment. An agent installs
 * this so a long-running background task can wake it: the task exits with code
 * 2 and Claude surfaces its stderr (or stdout) as a system reminder. Implies
 * `async: true`.
 *
 * @param {{ command: string, timeoutSeconds?: number }} opts
 */
export function buildAsyncRewakeHook({ command, timeoutSeconds = DEFAULT_ASYNC_HOOK_TIMEOUT_S } = {}) {
  requireNonEmptyString(command, "command");
  if (!Number.isInteger(timeoutSeconds) || timeoutSeconds <= 0) {
    throw new TypeError("claude wake: timeoutSeconds must be a positive integer");
  }
  return { type: "command", command, asyncRewake: true, timeout: timeoutSeconds };
}

/**
 * Build the JSON a `Stop` hook returns to keep a parked session alive: Claude
 * cannot finish the turn and is fed `reason` as the next-turn context.
 *
 * @param {{ reason: string }} opts
 */
export function buildStopBlockDecision({ reason } = {}) {
  return { decision: "block", reason: requireNonEmptyString(reason, "reason") };
}

/**
 * A Stop hook must release (allow the session to stop) once Claude reports it
 * has already been blocked `stop_hook_active` times, or it would wedge at the
 * built-in cap. Returns true when the hook should let the session stop.
 *
 * @param {{ stop_hook_active?: boolean, stopHookActive?: boolean, blockCount?: number }} hookInput
 */
export function shouldReleaseStopBlock(hookInput = {}) {
  if (hookInput.stop_hook_active === true || hookInput.stopHookActive === true) return true;
  if (Number.isInteger(hookInput.blockCount) && hookInput.blockCount >= STOP_BLOCK_CAP) return true;
  return false;
}

/**
 * Shared-interface method: produce the settings fragment that installs the
 * wake hook. Returns the fragment (caller decides where to merge it) rather
 * than mutating a user's settings file, so installation stays non-destructive.
 *
 * @param {{ command: string, timeoutSeconds?: number, event?: string }} opts
 */
export function installWakeHook({ command, timeoutSeconds, event = "Stop" } = {}) {
  const hook = buildAsyncRewakeHook({ command, timeoutSeconds });
  return { hooks: { [event]: [{ hooks: [hook] }] } };
}

/**
 * Shared-interface method the L2 daemon calls. Deterministic external wake =
 * daemon-owned resume: spawn `claude --resume <id> <message>` via execFile
 * (argv array, no shell). Resolves to a structured result; never throws for a
 * non-zero exit — the daemon inspects `ok` and decides whether to retry.
 *
 * @param {{ sessionId: string, message: string, print?: boolean, extraArgs?: string[] }} target
 * @param {{ execFileImpl?: Function, claudeBin?: string, timeoutMs?: number, env?: object }} [deps]
 * @returns {Promise<{ ok: boolean, hostName: string, sessionId: string, code: number|null, reason: string|null }>}
 */
export function wake(target = {}, deps = {}) {
  const {
    execFileImpl = execFile,
    claudeBin = DEFAULT_CLAUDE_BIN,
    timeoutMs = DEFAULT_RESUME_TIMEOUT_MS,
    env = process.env,
  } = deps;

  // Build args first so validation errors reject the promise deterministically.
  let args;
  try {
    args = buildResumeArgs(target);
  } catch (error) {
    return Promise.reject(error);
  }
  const sessionId = target.sessionId;

  return new Promise((resolve) => {
    execFileImpl(
      claudeBin,
      args,
      { timeout: timeoutMs, env, windowsHide: true },
      (error, _stdout, stderr) => {
        if (!error) {
          resolve({ ok: true, hostName, sessionId, code: 0, reason: null });
          return;
        }
        const code = typeof error.code === "number" ? error.code : null;
        const reason = error.killed
          ? "resume_timeout"
          : (typeof stderr === "string" && stderr.trim()) || error.message || "resume_failed";
        resolve({ ok: false, hostName, sessionId, code, reason });
      }
    );
  });
}

export const claudeWakeAdapter = {
  hostName,
  installWakeHook,
  wake,
  buildResumeArgs,
  buildAsyncRewakeHook,
  buildStopBlockDecision,
  shouldReleaseStopBlock,
};

export default claudeWakeAdapter;
