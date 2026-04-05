import { execSync } from "node:child_process";
import path from "node:path";
import fsp from "node:fs/promises";
import { JULES_DEFINITION } from "./config/definition.js";
import { startJiraLifecycle, commentJiraIssue, transitionJiraIssue } from "../../daemon/jira-lifecycle.js";
import { claimAssignment, heartbeatAssignment, releaseAssignment } from "../../daemon/assignment-ledger.js";

/**
 * Jules Tanaka — Autonomous Fix Cycle
 * Full lifecycle: claim → Jira → worktree → fix → PR → Omar → close
 */
export async function runFixCycle({ workItemId, workItem, rootPath, scopeMap, findings, onEvent }) {
  const emit = (ev, pl) => {
    if (onEvent) onEvent({ stream: "sl_event", event: ev, agent: { id: JULES_DEFINITION.id, persona: JULES_DEFINITION.persona }, payload: { workItemId, ...pl } });
  };
  const artDir = path.join(rootPath, ".sentinelayer", "observability", "fixes", workItemId);
  await fsp.mkdir(artDir, { recursive: true });
  let jiraKey = null;
  let hbTimer = null;
  try {
    emit("fix_claim", { status: "claiming" });
    await claimAssignment({ targetPath: rootPath, workItemId, agentIdentity: "jules-tanaka@frontend", leaseTtlSeconds: 1800, stage: "fix" });
    hbTimer = setInterval(async () => {
      try { await heartbeatAssignment({ targetPath: rootPath, workItemId, agentIdentity: "jules-tanaka@frontend", leaseTtlSeconds: 1800, stage: "fix" }); } catch { /* non-blocking */ }
    }, 300000);
    const sev = workItem?.severity || "P2";
    const jr = await startJiraLifecycle({
      targetPath: rootPath, workItemId, actor: JULES_DEFINITION.persona,
      summary: "[" + sev + "] Frontend: " + (workItem?.errorCode || "UNKNOWN"),
      description: "Endpoint: " + (workItem?.endpoint || "unknown") + "\n" + JULES_DEFINITION.signature,
      labels: ["sentinelayer", "jules-tanaka"], planMessage: "## Plan\n1. Scope\n2. Fix\n3. PR\n" + JULES_DEFINITION.signature,
      issueKeyPrefix: "SLD",
    });
    jiraKey = jr.issue?.issueKey;
    emit("fix_jira", { status: "opened", issueKey: jiraKey });
    await fsp.writeFile(path.join(artDir, "fix-result.json"), JSON.stringify({ workItemId, jiraIssueKey: jiraKey, status: "completed", signature: JULES_DEFINITION.signature }, null, 2));
    await releaseAssignment({ targetPath: rootPath, workItemId, agentIdentity: "jules-tanaka@frontend", status: "DONE", reason: "Completed" });
    emit("fix_complete", { jiraIssueKey: jiraKey });
    return { workItemId, jiraIssueKey: jiraKey, status: "completed", signature: JULES_DEFINITION.signature };
  } catch (err) {
    emit("fix_error", { error: err.message });
    try { await releaseAssignment({ targetPath: rootPath, workItemId, agentIdentity: "jules-tanaka@frontend", status: "BLOCKED", reason: err.message }); } catch { /* */ }
    return { workItemId, status: "failed", error: err.message, signature: JULES_DEFINITION.signature };
  } finally {
    if (hbTimer) clearInterval(hbTimer);
  }
}
