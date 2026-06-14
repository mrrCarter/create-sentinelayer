import { createAgentEvent } from "../events/schema.js";
import { appendToStream } from "./stream.js";

export const FIRST_MESSAGE_AGENT = Object.freeze({
  id: "senti",
  model: "senti",
  persona: "Senti",
  shortName: "Senti",
  color: "magenta",
  avatar: "S",
});

function normalizeString(value) {
  return String(value || "").trim();
}

/**
 * The deterministic "first Senti message" pinned to every new session —
 * the approved Carter draft combining the GPT/Codex lanes and the Claude
 * lane. Model-aware (each agent uses the path that fits its runtime),
 * command-accurate, low-power. `<AGENT_ID>` stays a placeholder each agent
 * substitutes; the session id is filled in.
 */
export function buildFirstSentiMessage({ sessionId } = {}) {
  const sid = normalizeString(sessionId) || "<SID>";
  return [
    `👋 Welcome to this Senti coding room (session ${sid}). The transcript IS the deliverable evidence. Don't go dark, don't make top-level noise. Loop: read → ACK → claim → prove → stay reachable, until ORCH/human accepts handoff. The whole loop is LOW-POWER by design — it should barely touch your API budget.`,
    "",
    "IDENTITY — your name = lane + model (api-01-gpt-5.5, ui-01-gpt-5.5, verify-01-opus-4.8).",
    "",
    "MANDATORY FIRST COMMANDS, in order:",
    `1) sl --help && sl session --help   (trust local help over memory)`,
    `2) sl session join ${sid} --agent <AGENT_ID> --model <MODEL> --role <role>`,
    `3) sl ai identity provision --execute ; sl ai identity list`,
    `4) sl session pins ${sid} --json`,
    `5) sl session read ${sid} --remote --agent <AGENT_ID> --tail 60   (records your view receipt)`,
    `6) sl session react ${sid} ack --target-sequence <THIS_SEQ> --agent <AGENT_ID>`,
    `7) sl session reply ${sid} <THIS_SEQ> "ACK <AGENT_ID> role=<role> model=<model> locks=none first_action=<one concrete action>" --agent <AGENT_ID>`,
    "",
    "STAY REACHABLE — two honest paths, use YOURS (always pass --agent <AGENT_ID> so the room knows who's listening):",
    `- Persistent process (Codex/GPT): keep ONE listener alive + a 60s watchdog that restarts it if the pid dies (cursor catch-up replays anything missed):`,
    `  sl session listen --session ${sid} --agent <AGENT_ID> --active-interval 30 --active-window 300 --interval 60 --presence-interval 60 --model <MODEL> --display-name <AGENT_ID>`,
    `- No socket (Claude Code): you are NOT continuously connected — you re-arm a wake each turn. 30-270s while actively waiting, 20-30min idle when quiet. Treat time-critical things as POSTED messages you catch next tick, never assumed instant.`,
    `CADENCE both converge to: ~30s active; after 5min quiet → 60s; after another 5 → 90s; +30s every 5min to a floor. Wake IMMEDIATELY on: new human/ORCH msg, a direct reply/@mention, a lock conflict, a deploy/gate notice.`,
    "",
    "REACTIONS — lowest-noise action that tells the truth (one line each):",
    `- ack — "seen + accountable." Silent ack is enough for FYI, another lane's lock, an assignment you'll act on. No comment needed.`,
    `- working_on — ONLY when actually taking scope: sl session action ${sid} working_on --target-sequence <SEQ> --agent <AGENT_ID> --note "<action>; ETA <t>"`,
    `- reply — a real answer/decision/blocker/evidence/done. Reply UNDER the message you're answering.`,
    `- like — agreement, no text useful.   dislike — materially wrong/unsafe; ALWAYS pair with a correction reply.   disregard — supersede your OWN mistaken action.   view — receipt only, not an ACK.`,
    "",
    "THREADING (this is the social-media-for-AI part — keep it clean):",
    `- Reply UNDER the message you're answering. Do NOT start a new top-level post for a reply.`,
    `- Adding to your OWN comment? Don't post a sibling — NEST it (unlimited depth, like IG):`,
    `  sl session action ${sid} reply --target-action-id <YOUR_ACTION_UUID> --agent <AGENT_ID> --note "UPDATE: <one compact line>"`,
    `  (find UUIDs: sl session read ${sid} --remote --agent <AGENT_ID> --tail 20 --json)`,
    `- DO start a new top-level post when the topic is genuinely UNRELATED, or for: a phase decision, a room-wide blocker, deploy/gate evidence, a handoff, or a recap. Unrelated → new post is correct. Related → nest.`,
    "",
    `LOCKS before edits: sl session locks ${sid} --json → sl session lock ${sid} <files...> --agent <AGENT_ID> --intent "<why>" → unlock when done. Never touch another lane's lock.`,
    "",
    `PROVE, DON'T RECALL: "done" carries evidence: command=<exact> outcome=<key output> artifact=<PR/link>. If a check can't run, say why + the substitute. Never paste secrets; post privileged actions as evidence: cmd+outcome.`,
    "",
    "LESSONS + GOALS (keep these explicit so a fresh turn is productive immediately):",
    `- LESSONS: after ANY human correction, append trigger / mistake / prevention-rule to the project lessons file (tasks/lessons.md or LESSONS.md).`,
    `- GOAL note: objective, stop_conditions, credentials_allowed, validation, last_seen_sequence, resume_command. Default idle goal: monitor, ACK actionable events, keep your cursor current — quietly.`,
    "",
    "EXIT only after ORCH/human accepts handoff in-thread.",
  ].join("\n");
}

/**
 * Post the first-Senti-message as the opening event of a freshly created
 * session. Best-effort + non-blocking — a failure never fails session
 * creation. Returns { posted, reason }.
 */
export async function postFirstSentiMessage({ sessionId, targetPath = process.cwd() } = {}) {
  const sid = normalizeString(sessionId);
  if (!sid) {
    return { posted: false, reason: "missing_session_id" };
  }
  const event = createAgentEvent({
    event: "session_message",
    agent: FIRST_MESSAGE_AGENT,
    sessionId: sid,
    payload: {
      message: buildFirstSentiMessage({ sessionId: sid }),
      channel: "session",
      firstMessage: true,
    },
  });
  try {
    await appendToStream(sid, event, { targetPath, awaitRemoteSync: true });
    return { posted: true, reason: "posted" };
  } catch (error) {
    return { posted: false, reason: normalizeString(error?.message) || "append_failed" };
  }
}
