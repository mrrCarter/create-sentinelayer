// snapshot-diff — flag stale / oversized / obsolete snapshots (#A15).
//
// We walk *.snap files (Jest) and *.raw.snap / *.ambr (Ariadne) and flag:
//   1. Snapshots that haven't been touched in > STALE_DAYS days — stale
//      values are a legitimate concern.
//   2. Snapshots larger than LARGE_SIZE_BYTES — huge blobs are an anti-
//      pattern (unreviewable diffs, hide regressions).
//   3. Python doctest / pytest-snapshot *.ambr files that reference a
//      stored block. Same staleness / size rules.
//
// We don't try to diff against the producing code — that's the job of the
// test runner. We only flag maintenance smells.

import path from "node:path";

import { createFinding, toPosix, walkRepoFiles } from "./base.js";

const SNAPSHOT_EXTENSIONS = new Set([
  ".snap",
  ".ambr",
]);
const STALE_DAYS = 90;
const LARGE_SIZE_BYTES = 64 * 1024; // 64 KiB

export async function runSnapshotDiff({ rootPath, files = null, staleDays = STALE_DAYS } = {}) {
  const resolvedRoot = path.resolve(String(rootPath || "."));
  const now = Date.now();
  const staleThreshold = now - staleDays * 24 * 60 * 60 * 1000;
  const iterator =
    Array.isArray(files) && files.length > 0
      ? iterateExplicitFiles(resolvedRoot, files)
      : walkRepoFiles({ rootPath: resolvedRoot, extensions: SNAPSHOT_EXTENSIONS });

  const findings = [];
  for await (const { relativePath, stat } of iterator) {
    const mtime = stat ? Number(stat.mtimeMs || 0) : 0;
    const size = stat ? Number(stat.size || 0) : 0;
    const rel = toPosix(relativePath);

    if (mtime && mtime < staleThreshold) {
      const days = Math.floor((now - mtime) / (24 * 60 * 60 * 1000));
      findings.push(
        createFinding({
          tool: "snapshot-diff",
          kind: "testing.snapshot-stale",
          severity: "P3",
          file: rel,
          line: 0,
          evidence: `Last modified ${days} days ago (threshold ${staleDays})`,
          rootCause:
            "Snapshot has been unchanged for longer than the staleness threshold — a stale snapshot can hide regressions silently.",
          recommendedFix:
            "Re-run the test suite with `--updateSnapshot` (or equivalent) after verifying the current output is actually correct. Delete if the underlying code has been removed.",
          confidence: 0.5,
        })
      );
    }

    if (size > LARGE_SIZE_BYTES) {
      findings.push(
        createFinding({
          tool: "snapshot-diff",
          kind: "testing.snapshot-oversized",
          severity: "P2",
          file: rel,
          line: 0,
          evidence: `Snapshot is ${Math.round(size / 1024)} KiB (threshold ${Math.round(LARGE_SIZE_BYTES / 1024)} KiB)`,
          rootCause:
            "Oversized snapshots are unreviewable in PRs and hide meaningful regressions inside unrelated noise.",
          recommendedFix:
            "Split the snapshot into smaller focused tests, switch to a structural assertion, or mask non-essential fields (timestamps, IDs) before snapshotting.",
          confidence: 0.7,
        })
      );
    }
  }
  return findings;
}

async function* iterateExplicitFiles(resolvedRoot, files) {
  const fsp = await import("node:fs/promises");
  for (const file of files) {
    const trimmed = String(file || "").trim();
    if (!trimmed) {
      continue;
    }
    const fullPath = path.isAbsolute(trimmed)
      ? trimmed
      : path.join(resolvedRoot, trimmed);
    const relativePath = path
      .relative(resolvedRoot, fullPath)
      .replace(/\\/g, "/");
    let stat = null;
    try {
      stat = await fsp.stat(fullPath);
    } catch {
      stat = null;
    }
    yield { fullPath, relativePath, stat };
  }
}

export { LARGE_SIZE_BYTES, STALE_DAYS };
