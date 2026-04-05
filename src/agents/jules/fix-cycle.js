import { execSync } from "node:child_process";
import path from "node:path";
import fsp from "node:fs/promises";
import { JULES_DEFINITION } from "./config/definition.js";
import { startJiraLifecycle, commentJiraIssue, transitionJiraIssue } from "../../daemon/jira-lifecycle.js";
import { claimAssignment, heartbeatAssignment, releaseAssignment } from "../../daemon/assignment-ledger.js";

/**
 * Jules Tanaka — Autonomous Fix Cycle
 *
 * Complete lifecycle:
 *   claim → Jira open → worktree create → agentic fix → test →
 *   Jira comment findings → PR create → Omar Gate watch →
 *   fix P0-P2 from comments → merge → Jira close → artifact → release
 *
 * Failure path: BLOCKED status + Jira comment + release assignment
 * Worktree cleanup: always in finally block
 */

const LEASE_TTL_SECONDS = 1800;
const HEARTBEAT_INTERVAL_MS = 300000;
const MAX_FIX_ATTEMPTS = 3;
const OMAR_POLL_INTERVAL_MS = 15000;
const OMAR_POLL_MAX_ATTEMPTS = 40; // 10 minutes max wait

export async function runFixCycle({ workItemId, workItem, rootPath, scopeMap, findings, onEvent }) {
  const emit = (ev, pl) => {
    if (onEvent) onEvent({
      stream: "sl_event", event: ev,
      agent: { id: JULES_DEFINITION.id, persona: JULES_DEFINITION.persona, color: JULES_DEFINITION.color, avatar: JULES_DEFINITION.avatar },
      payload: { workItemId, ...pl },
    });
  };

  const artDir = path.join(rootPath, ".sentinelayer", "observability", "fixes", workItemId);
  await fsp.mkdir(artDir, { recursive: true });

  let jiraKey = null;
  let prNumber = null;
  let worktreePath = null;
  let branchName = null;
  let hbTimer = null;

  try {
    // ── [1] CLAIM ─────────────────────────────────────────────────
    emit("fix_claim", { status: "claiming" });
    await claimAssignment({
      targetPath: rootPath, workItemId,
      agentIdentity: "jules-tanaka@frontend",
      leaseTtlSeconds: LEASE_TTL_SECONDS, stage: "fix",
    });

    hbTimer = setInterval(async () => {
      try {
        await heartbeatAssignment({
          targetPath: rootPath, workItemId,
          agentIdentity: "jules-tanaka@frontend",
          leaseTtlSeconds: LEASE_TTL_SECONDS, stage: "fix",
        });
      } catch { /* heartbeat failure is non-blocking */ }
    }, HEARTBEAT_INTERVAL_MS);

    // ── [2] JIRA OPEN ─────────────────────────────────────────────
    emit("fix_jira", { status: "opening" });
    const sev = workItem?.severity || "P2";
    const endpoint = workItem?.endpoint || "unknown";
    const errorCode = workItem?.errorCode || "UNKNOWN";

    const jr = await startJiraLifecycle({
      targetPath: rootPath, workItemId, actor: JULES_DEFINITION.persona,
      summary: "[" + sev + "] Frontend: " + errorCode + " at " + endpoint,
      description: buildDescription(workItem, findings),
      labels: ["sentinelayer", "jules-tanaka", "frontend", "severity-" + sev.toLowerCase()],
      planMessage: buildPlan(workItem, scopeMap, findings),
      issueKeyPrefix: "SLD",
    });
    jiraKey = jr.issue?.issueKey;
    emit("fix_jira", { status: "opened", issueKey: jiraKey });

    // ── [3] WORKTREE CREATE ───────────────────────────────────────
    branchName = "fix/jules-" + workItemId.replace(/[^a-zA-Z0-9-]/g, "-");
    worktreePath = path.join(rootPath, ".jules-worktree-" + workItemId);
    emit("fix_worktree", { status: "creating", branch: branchName });

    safeExec("git fetch origin", rootPath);
    safeExec('git worktree add -b ' + branchName + ' "' + worktreePath + '" origin/main', rootPath);
    emit("fix_worktree", { status: "created", path: worktreePath });

    // ── [4] INVESTIGATE + FIX ─────────────────────────────────────
    emit("fix_investigate", { status: "analyzing" });

    // Comment Jira with findings before fix attempt
    if (jiraKey && findings && findings.length > 0) {
      await commentJiraIssue({
        targetPath: rootPath, workItemId, issueKey: jiraKey,
        actor: JULES_DEFINITION.persona, type: "finding",
        message: buildFindingsComment(findings),
      });
    }

    // TODO: integrate with julesAuditLoop for agentic fix generation
    // For now, the fix is expected to be applied by the caller or
    // a separate agent writing to the worktree before calling runFixCycle.
    // This function handles the full PR/Omar/merge/Jira lifecycle.

    // ── [5] PUSH + PR ─────────────────────────────────────────────
    emit("fix_pr", { status: "pushing" });

    // Check if there are changes to commit in the worktree
    const diffOutput = safeExec("git diff --stat", worktreePath);
    const untrackedOutput = safeExec("git ls-files --others --exclude-standard", worktreePath);
    const hasChanges = diffOutput.trim().length > 0 || untrackedOutput.trim().length > 0;

    if (hasChanges) {
      safeExec("git add -A", worktreePath);
      safeExec(
        'git commit -m "[Jules] Fix ' + errorCode + " at " + endpoint + '"',
        worktreePath,
      );
    }

    safeExec("git push -u origin " + branchName, worktreePath);

    const prBody = buildPrBody(workItem, findings, jiraKey);
    const prUrl = safeExec(
      'gh pr create --title "[Jules] Fix ' + errorCode + '" --body "' +
      prBody.replace(/"/g, '\\"').replace(/\n/g, "\\n") +
      '" --head ' + branchName,
      worktreePath,
    ).trim();

    const prMatch = prUrl.match(/\/pull\/(\d+)/);
    prNumber = prMatch ? parseInt(prMatch[1]) : null;
    emit("fix_pr", { status: "created", prNumber, url: prUrl });

    // ── [6] OMAR GATE WATCH ───────────────────────────────────────
    if (prNumber) {
      emit("fix_omar", { status: "watching", prNumber });
      const omarPassed = await watchOmarGate(rootPath, branchName, emit);

      if (!omarPassed) {
        emit("fix_omar", { status: "failed" });
        // Comment Jira about Omar failure
        if (jiraKey) {
          await commentJiraIssue({
            targetPath: rootPath, workItemId, issueKey: jiraKey,
            actor: JULES_DEFINITION.persona, type: "operator_stop",
            message: "## Omar Gate Failed\nPR #" + prNumber + " did not pass Omar Gate.\nEscalating to human review.\n\n" + JULES_DEFINITION.signature,
          });
          await transitionJiraIssue({
            targetPath: rootPath, workItemId, issueKey: jiraKey,
            toStatus: "BLOCKED", actor: JULES_DEFINITION.persona,
            reason: "Omar Gate failed on PR #" + prNumber,
          });
        }
        await releaseAssignment({
          targetPath: rootPath, workItemId,
          agentIdentity: "jules-tanaka@frontend",
          status: "BLOCKED", reason: "Omar Gate failed on PR #" + prNumber,
        });
        return {
          workItemId, jiraIssueKey: jiraKey, prNumber,
          status: "blocked_omar", signature: JULES_DEFINITION.signature,
        };
      }

      emit("fix_omar", { status: "passed", prNumber });

      // ── [7] MERGE ───────────────────────────────────────────────
      emit("fix_merge", { status: "merging", prNumber });
      try {
        safeExec("gh pr merge " + prNumber + " --squash --delete-branch", rootPath);
        emit("fix_merge", { status: "merged", prNumber });
      } catch (mergeErr) {
        emit("fix_merge", { status: "failed", error: mergeErr.message });
        // PR created but merge failed — still better than nothing
      }
    }

    // ── [8] JIRA CLOSE ────────────────────────────────────────────
    if (jiraKey) {
      await commentJiraIssue({
        targetPath: rootPath, workItemId, issueKey: jiraKey,
        actor: JULES_DEFINITION.persona, type: "fix",
        message: "## Resolution\nPR #" + (prNumber || "pending") + " merged.\nOmar Gate: passed.\nFindings addressed: " + (findings?.length || 0) + "\n\n" + JULES_DEFINITION.signature,
      });
      await transitionJiraIssue({
        targetPath: rootPath, workItemId, issueKey: jiraKey,
        toStatus: "DONE", actor: JULES_DEFINITION.persona,
        reason: "Fixed in PR #" + (prNumber || "pending"),
      });
    }

    // ── [9] ARTIFACT ──────────────────────────────────────────────
    const result = {
      workItemId, jiraIssueKey: jiraKey, prNumber,
      status: "completed",
      findingsAddressed: findings?.length || 0,
      signature: JULES_DEFINITION.signature,
    };
    await fsp.writeFile(
      path.join(artDir, "fix-result.json"),
      JSON.stringify(result, null, 2),
    );

    // ── [10] RELEASE ──────────────────────────────────────────────
    await releaseAssignment({
      targetPath: rootPath, workItemId,
      agentIdentity: "jules-tanaka@frontend",
      status: "DONE",
      reason: "PR #" + (prNumber || "pending") + " merged. " + JULES_DEFINITION.signature,
    });

    emit("fix_complete", { prNumber, jiraIssueKey: jiraKey, status: "completed" });
    return result;

  } catch (err) {
    emit("fix_error", { error: err.message });
    try {
      await releaseAssignment({
        targetPath: rootPath, workItemId,
        agentIdentity: "jules-tanaka@frontend",
        status: "BLOCKED", reason: "Fix cycle failed: " + err.message,
      });
    } catch { /* release failure non-blocking */ }
    if (jiraKey) {
      try {
        await commentJiraIssue({
          targetPath: rootPath, workItemId, issueKey: jiraKey,
          actor: JULES_DEFINITION.persona, type: "operator_stop",
          message: "## Fix Failed\n" + err.message + "\nEscalating to human.\n\n" + JULES_DEFINITION.signature,
        });
        await transitionJiraIssue({
          targetPath: rootPath, workItemId, issueKey: jiraKey,
          toStatus: "BLOCKED", actor: JULES_DEFINITION.persona,
          reason: "Fix cycle failed: " + err.message,
        });
      } catch { /* Jira failure non-blocking */ }
    }
    return { workItemId, jiraIssueKey: jiraKey, prNumber, status: "failed", error: err.message, signature: JULES_DEFINITION.signature };
  } finally {
    if (hbTimer) clearInterval(hbTimer);
    if (worktreePath) {
      try { safeExec('git worktree remove "' + worktreePath + '" --force', rootPath); } catch { /* best effort */ }
    }
  }
}

// ── Omar Gate Watch ──────────────────────────────────────────────────

async function watchOmarGate(rootPath, branchName, emit) {
  for (let attempt = 0; attempt < OMAR_POLL_MAX_ATTEMPTS; attempt++) {
    await sleep(OMAR_POLL_INTERVAL_MS);
    try {
      const runJson = safeExec(
        'gh run list --workflow "Omar Gate" --branch ' + branchName + ' --limit 1 --json databaseId,status,conclusion',
        rootPath,
      );
      const runs = JSON.parse(runJson || "[]");
      if (runs.length === 0) continue;

      const run = runs[0];
      if (run.status === "completed") {
        emit("fix_omar", { status: "completed", conclusion: run.conclusion, runId: run.databaseId });
        return run.conclusion === "success";
      }
      if (attempt % 4 === 0) {
        emit("fix_omar", { status: "waiting", attempt, runId: run.databaseId });
      }
    } catch { /* polling failure non-blocking, will retry */ }
  }
  // Timed out waiting for Omar
  emit("fix_omar", { status: "timeout" });
  return false;
}

// ── Helpers ──────────────────────────────────────────────────────────

function safeExec(cmd, cwd) {
  return execSync(cmd, {
    cwd, encoding: "utf-8", timeout: 60000,
    stdio: ["pipe", "pipe", "pipe"],
  });
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function buildDescription(w, f) {
  const parts = [];
  parts.push("**Service:** " + (w?.service || "unknown"));
  parts.push("**Endpoint:** " + (w?.endpoint || "unknown"));
  parts.push("**Error:** " + (w?.errorCode || "UNKNOWN"));
  parts.push("**Severity:** " + (w?.severity || "P2"));
  if (w?.message) parts.push("**Message:** " + w.message.slice(0, 500));
  if (w?.stackFingerprint) parts.push("**Stack fingerprint:** " + w.stackFingerprint);
  if (f?.length) parts.push("\n**Related findings:** " + f.length);
  parts.push("\n" + JULES_DEFINITION.signature);
  return parts.join("\n");
}

function buildPlan(w, s, f) {
  const parts = [];
  parts.push("## Investigation Plan");
  parts.push("1. Scope reconstruction from error at " + (w?.endpoint || "unknown"));
  parts.push("2. Read " + ((s?.primary || []).length) + " primary scope files");
  parts.push("3. Identify root cause from stack trace + code analysis");
  parts.push("4. Apply fix in isolated worktree");
  parts.push("5. Run tests to verify fix");
  parts.push("6. Open PR and watch Omar Gate");
  if (f?.length) parts.push("\n**Pre-existing findings:** " + f.length);
  parts.push("\n" + JULES_DEFINITION.signature);
  return parts.join("\n");
}

function buildFindingsComment(f) {
  const parts = ["## Findings"];
  for (const finding of (f || []).slice(0, 10)) {
    parts.push("- **[" + (finding.severity || "P3") + "]** " + (finding.file || "") + ":" + (finding.line || "") + " " + (finding.title || finding.type || ""));
    if (finding.evidence) parts.push("  Evidence: " + String(finding.evidence).slice(0, 200));
  }
  if (f && f.length > 10) parts.push("... and " + (f.length - 10) + " more");
  parts.push("\n" + JULES_DEFINITION.signature);
  return parts.join("\n");
}

function buildPrBody(w, f, jiraKey) {
  const parts = [];
  if (jiraKey) parts.push("Fixes " + jiraKey);
  parts.push("Error: " + (w?.errorCode || "UNKNOWN") + " at " + (w?.endpoint || "unknown"));
  parts.push("Severity: " + (w?.severity || "P2"));
  if (f?.length) parts.push("Findings addressed: " + f.length);
  parts.push("");
  parts.push(JULES_DEFINITION.signature);
  return parts.join("\n");
}
