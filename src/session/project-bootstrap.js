import path from "node:path";

import { ensureWorkspaceSession } from "../commands/session.js";
import { createAgentEvent } from "../events/schema.js";
import { spawnDetachedSentiDaemon } from "./daemon-spawn.js";
import { setupSessionGuides } from "./setup-guides.js";
import { appendToStream } from "./stream.js";
import { syncSessionMetadataToApi } from "./sync.js";
import { buildDashboardUrl } from "./templates.js";

export const PROJECT_BOOTSTRAP_AGENT = Object.freeze({
  id: "project-bootstrap",
  persona: "Project Bootstrap",
  shortName: "Bootstrap",
  color: "green",
  avatar: "P",
});

function normalizeString(value) {
  return String(value || "").trim();
}

export function buildProjectSessionWelcomeMessage({ projectName, sessionId } = {}) {
  const name = normalizeString(projectName) || "this project";
  return [
    `🏗️ Project session for "${name}" is live (created by \`create-sentinelayer\`).`,
    "",
    "This is the project's shared coordination room. Agents working on this codebase should:",
    `- Join before starting work: \`sl session join ${sessionId} --agent <your-agent-name>\``,
    `- Post status updates as you work: \`sl session say ${sessionId} "<update>" --agent <your-agent-name>\``,
    "- Audit runs (`sentinel audit`) post per-persona progress here automatically, so swarm agents can see each other's findings without losing context.",
  ].join("\n");
}

/**
 * Create the project's senti session as part of `create-sentinelayer` init:
 * a fresh workspace session rooted at the new project directory, with
 * coordination guides written into AGENTS.md / CLAUDE.md and a welcome
 * message announcing the room to joining agents.
 *
 * Local-first: session creation always succeeds offline; dashboard metadata
 * sync and the welcome-message relay are best-effort and never throw.
 *
 * Pass `skipGuides: true` when the caller writes coding-agent config files
 * after this call (guide upsert would otherwise create AGENTS.md/CLAUDE.md
 * first and make the config scaffold skip itself) — then call
 * `setupSessionGuides` once those files exist.
 */
export async function bootstrapProjectSession({
  projectDir,
  projectName,
  ttlSeconds,
  skipGuides = false,
} = {}) {
  const targetPath = path.resolve(normalizeString(projectDir) || ".");
  const title = normalizeString(projectName) || path.basename(targetPath);

  const ensured = await ensureWorkspaceSession({
    targetPath,
    title,
    resume: false,
    forceNew: true,
    ...(Number.isFinite(Number(ttlSeconds)) && Number(ttlSeconds) > 0
      ? { ttlSeconds: Math.floor(Number(ttlSeconds)) }
      : {}),
  });
  const created = ensured.created;
  const sessionId = created.sessionId;

  // Best-effort dashboard visibility — session creation stays local-first.
  await syncSessionMetadataToApi(sessionId, {
    targetPath,
    sessionId,
    status: created.status,
    createdAt: created.createdAt,
    expiresAt: created.expiresAt,
    title: ensured.title || title,
    template: created.template,
    codebaseContext: created.codebaseContext,
  }).catch(() => {});

  const guides = skipGuides ? null : await setupSessionGuides(sessionId, { targetPath });

  const welcomeEvent = createAgentEvent({
    event: "session_message",
    agent: PROJECT_BOOTSTRAP_AGENT,
    sessionId,
    payload: {
      message: buildProjectSessionWelcomeMessage({ projectName: title, sessionId }),
      channel: "session",
    },
  });
  let welcomePosted = true;
  try {
    await appendToStream(sessionId, welcomeEvent, { targetPath, awaitRemoteSync: true });
  } catch {
    welcomePosted = false;
  }

  // Project rooms are managed by default too: the detached Senti daemon
  // greets joining agents and keeps recaps/checkpoints flowing. Honors
  // SENTINELAYER_SKIP_SENTI_AUTOSTART / SENTINELAYER_SKIP_SENTI_DAEMON
  // and never fails the bootstrap.
  const daemon = await spawnDetachedSentiDaemon({ sessionId, targetPath });

  return {
    sessionId,
    title: ensured.title || title,
    targetPath,
    dashboardUrl: buildDashboardUrl(sessionId),
    guides,
    welcomePosted,
    daemon,
  };
}
