/**
 * Reproducibility chain (#investor-dd-17).
 *
 * For each finding emitted by the investor-DD run, attach a `replay`
 * block that captures:
 *
 *   - replayCommand   — a single-line bash command that re-runs the
 *                        exact evidence-gathering step (tool dispatch
 *                        against the same file), so an auditor or the
 *                        caller can verify without re-running the
 *                        full investor-DD flow.
 *   - filesAtTime     — SHA-256 of every file involved in the finding
 *                        at finding time, so if the repo has changed
 *                        since, the mismatch is detectable.
 *   - runId / timestamp for cross-reference.
 *
 * The module is a pure decorator: it does not mutate findings, it
 * returns new ones enriched with reproducibility metadata.
 */

import crypto from "node:crypto";
import fsp from "node:fs/promises";
import path from "node:path";

/**
 * Compute SHA-256 of a file on disk. Returns null if unreadable so
 * the chain never blocks the report on transient fs failures.
 *
 * @param {string} absPath
 * @returns {Promise<string | null>}
 */
export async function sha256File(absPath) {
  try {
    const data = await fsp.readFile(absPath);
    return crypto.createHash("sha256").update(data).digest("hex");
  } catch {
    return null;
  }
}

/**
 * Build a single finding's replay block.
 *
 * @param {object} params
 * @param {object} params.finding       - Must have .personaId, .tool, .file.
 * @param {string} params.rootPath      - Repo root (used to resolve finding.file).
 * @param {string} params.runId
 * @param {string} [params.cliName="sl"]  - Display name in replayCommand.
 * @returns {Promise<{replayCommand: string, filesAtTime: Record<string, string|null>, runId: string, timestamp: string}>}
 */
export async function buildReplayBlock({
  finding,
  rootPath,
  runId,
  cliName = "sl",
} = {}) {
  if (!finding) throw new TypeError("buildReplayBlock requires finding");
  if (!rootPath) throw new TypeError("buildReplayBlock requires rootPath");
  if (!runId) throw new TypeError("buildReplayBlock requires runId");

  const file = finding.file || "";
  const tool = finding.tool || finding.kind || "";
  const personaId = finding.personaId || "";

  const replayCommand = [
    cliName,
    "/review",
    "show",
    "--run",
    runId,
    "--persona",
    personaId,
    "--tool",
    tool,
    "--file",
    file,
  ]
    .filter(Boolean)
    .join(" ");

  const filesAtTime = {};
  if (file) {
    const abs = path.isAbsolute(file) ? file : path.join(rootPath, file);
    filesAtTime[file] = await sha256File(abs);
  }

  return {
    replayCommand,
    filesAtTime,
    runId,
    timestamp: new Date().toISOString(),
  };
}

/**
 * Decorate an array of findings with reproducibility chains. Runs in
 * parallel but bounded concurrency so we don't thrash disk on huge
 * finding sets.
 *
 * @param {object} params
 * @param {Array<object>} params.findings
 * @param {string} params.rootPath
 * @param {string} params.runId
 * @param {string} [params.cliName]
 * @param {number} [params.concurrency=8]
 * @returns {Promise<Array<object>>}  Findings with `.reproducibility` attached.
 */
export async function attachReproducibilityChain({
  findings = [],
  rootPath,
  runId,
  cliName = "sl",
  concurrency = 8,
} = {}) {
  if (!Array.isArray(findings)) throw new TypeError("findings must be an array");
  if (!rootPath) throw new TypeError("rootPath required");
  if (!runId) throw new TypeError("runId required");

  const result = [];
  let cursor = 0;
  async function worker() {
    while (cursor < findings.length) {
      const idx = cursor;
      cursor += 1;
      const finding = findings[idx];
      const replay = await buildReplayBlock({ finding, rootPath, runId, cliName });
      result[idx] = { ...finding, reproducibility: replay };
    }
  }
  const workers = [];
  for (let i = 0; i < Math.max(1, Math.min(concurrency, findings.length)); i += 1) {
    workers.push(worker());
  }
  await Promise.all(workers);
  return result;
}
