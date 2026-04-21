/**
 * Notification dispatch for investor-DD reports (#investor-dd-19).
 *
 * After a run completes, dispatch the report to:
 *   - operator's email (via sentinelayer-api Resend integration)
 *   - the user's dashboard card on sentinelayer.com
 *
 * The dispatcher is pluggable: it speaks to two injected clients so
 * production can swap in real Resend/API clients and tests use stubs.
 * All failures are non-fatal — a notification failure must never
 * invalidate the report itself.
 */

/**
 * @typedef {object} EmailClient
 * @property {(msg: {to: string, subject: string, markdown: string,
 *   attachments?: Array<{filename: string, content: string, mime?: string}>}) => Promise<{id: string}>} sendMarkdown
 */

/**
 * @typedef {object} DashboardClient
 * @property {(card: {runId: string, artifactDir: string, summary: object,
 *   findings: Array<object>}) => Promise<{cardId: string}>} upload
 */

/**
 * Notify the operator about a completed run.
 *
 * @param {object} params
 * @param {object} params.run                - Output of runInvestorDd().
 * @param {string} [params.notifyEmail]      - Operator email.
 * @param {EmailClient} [params.emailClient]
 * @param {DashboardClient} [params.dashboardClient]
 * @param {boolean} [params.emailEnabled=true]
 * @param {boolean} [params.dashboardEnabled=true]
 * @param {Function} [params.onEvent]
 * @returns {Promise<{email: object|null, dashboard: object|null}>}
 */
export async function notifyRunCompleted({
  run,
  notifyEmail,
  emailClient,
  dashboardClient,
  emailEnabled = true,
  dashboardEnabled = true,
  onEvent = () => {},
} = {}) {
  if (!run || !run.runId) throw new TypeError("notifyRunCompleted requires run.runId");

  let emailResult = null;
  if (emailEnabled && notifyEmail && emailClient && typeof emailClient.sendMarkdown === "function") {
    onEvent({ type: "notification_email_start", runId: run.runId, to: notifyEmail });
    try {
      const subject = `[Investor-DD] ${run.runId} — ${run.summary?.totalFindings ?? "?"} findings`;
      const markdown = buildEmailMarkdown(run);
      emailResult = await emailClient.sendMarkdown({
        to: notifyEmail,
        subject,
        markdown,
      });
      onEvent({ type: "notification_email_sent", runId: run.runId, messageId: emailResult.id });
    } catch (err) {
      emailResult = { error: err instanceof Error ? err.message : String(err) };
      onEvent({ type: "notification_email_error", runId: run.runId, error: emailResult.error });
    }
  } else if (emailEnabled && notifyEmail) {
    onEvent({ type: "notification_email_skipped", runId: run.runId, reason: "no client" });
  }

  let dashboardResult = null;
  if (dashboardEnabled && dashboardClient && typeof dashboardClient.upload === "function") {
    onEvent({ type: "notification_dashboard_start", runId: run.runId });
    try {
      dashboardResult = await dashboardClient.upload({
        runId: run.runId,
        artifactDir: run.artifactDir,
        summary: run.summary,
        findings: run.findings || [],
      });
      onEvent({
        type: "notification_dashboard_sent",
        runId: run.runId,
        cardId: dashboardResult.cardId,
      });
    } catch (err) {
      dashboardResult = { error: err instanceof Error ? err.message : String(err) };
      onEvent({
        type: "notification_dashboard_error",
        runId: run.runId,
        error: dashboardResult.error,
      });
    }
  } else if (dashboardEnabled) {
    onEvent({ type: "notification_dashboard_skipped", runId: run.runId, reason: "no client" });
  }

  return { email: emailResult, dashboard: dashboardResult };
}

function buildEmailMarkdown(run) {
  const lines = [];
  lines.push(`# Investor-DD Report — ${run.runId}`);
  lines.push("");
  if (run.summary) {
    lines.push(`- Status: **${run.summary.terminationReason || "ok"}**`);
    lines.push(`- Findings: ${run.summary.totalFindings ?? 0}`);
    lines.push(
      `- Duration: ${
        typeof run.summary.durationSeconds === "number"
          ? run.summary.durationSeconds.toFixed(1)
          : "?"
      }s`,
    );
  }
  lines.push("");
  lines.push(`Artifacts: \`${run.artifactDir}\``);
  lines.push("");
  lines.push("The full markdown report is attached (also available on the dashboard).");
  return lines.join("\n");
}
