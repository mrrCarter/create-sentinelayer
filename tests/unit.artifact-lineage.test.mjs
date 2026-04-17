import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";

import {
  verifyArtifactChain,
  writeCloseoutArtifact,
} from "../src/daemon/artifact-lineage.js";
import { createSession } from "../src/session/store.js";
import { appendToStream } from "../src/session/stream.js";

async function seedWorkspace(rootPath) {
  await mkdir(path.join(rootPath, "src"), { recursive: true });
  await writeFile(
    path.join(rootPath, "package.json"),
    JSON.stringify(
      {
        name: "artifact-lineage-fixture",
        version: "1.0.0",
      },
      null,
      2
    ),
    "utf-8"
  );
  await writeFile(path.join(rootPath, "src", "index.js"), "export const ready = true;\n", "utf-8");
}

test("Unit artifact lineage: closeout chain verifies for untouched artifacts", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "create-sentinelayer-artifact-closeout-"));
  try {
    await seedWorkspace(tempRoot);
    const session = await createSession({ targetPath: tempRoot, ttlSeconds: 60 });
    await appendToStream(
      session.sessionId,
      {
        event: "session_message",
        agentId: "codex-a1",
        payload: { message: "seed stream digest" },
        ts: "2026-04-17T00:00:00.000Z",
      },
      { targetPath: tempRoot }
    );

    const workItemId = "work-item-analytics";
    const date = "2026-04-17";
    const artifactDir = path.join(
      tempRoot,
      ".sentinelayer",
      "observability",
      date,
      workItemId
    );
    await mkdir(artifactDir, { recursive: true });
    await writeFile(
      path.join(artifactDir, "intake_event.json"),
      `${JSON.stringify({ workItemId, severity: "P1" }, null, 2)}\n`,
      "utf-8"
    );
    await writeFile(
      path.join(artifactDir, "validation_report.json"),
      `${JSON.stringify({ passed: true }, null, 2)}\n`,
      "utf-8"
    );

    const closeout = await writeCloseoutArtifact({
      workItemId,
      sessionId: session.sessionId,
      date,
      targetPath: tempRoot,
      nowIso: "2026-04-17T00:10:00.000Z",
      cosignAttestationRef: "sigstore://entry/abc123",
      sbomRef: "sbom://spdx/sentinelayer-cli",
      evidenceLinks: ["https://example.com/evidence/lineage"],
      chainVerified: true,
    });
    assert.equal(closeout.artifactCount, 2);
    assert.ok(closeout.closeoutPath.endsWith(path.join(workItemId, "closeout.json")));
    assert.match(closeout.anchorSha256, /^[a-f0-9]{64}$/);

    const verification = await verifyArtifactChain({
      workItemId,
      date,
      targetPath: tempRoot,
    });
    assert.equal(verification.valid, true);
    assert.equal(verification.mismatches.length, 0);
    assert.equal(verification.artifactCount, 2);
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("Unit artifact lineage: verifyArtifactChain detects artifact tampering", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "create-sentinelayer-artifact-tamper-"));
  try {
    await seedWorkspace(tempRoot);
    const session = await createSession({ targetPath: tempRoot, ttlSeconds: 60 });
    await appendToStream(
      session.sessionId,
      {
        event: "session_message",
        agentId: "codex-a1",
        payload: { message: "seed stream digest for tamper case" },
        ts: "2026-04-17T00:20:00.000Z",
      },
      { targetPath: tempRoot }
    );

    const workItemId = "work-item-tamper";
    const date = "2026-04-17";
    const artifactDir = path.join(
      tempRoot,
      ".sentinelayer",
      "observability",
      date,
      workItemId
    );
    await mkdir(artifactDir, { recursive: true });
    const intakePath = path.join(artifactDir, "intake_event.json");
    await writeFile(
      intakePath,
      `${JSON.stringify({ workItemId, endpoint: "/v1/runtime/runs" }, null, 2)}\n`,
      "utf-8"
    );

    await writeCloseoutArtifact({
      workItemId,
      sessionId: session.sessionId,
      date,
      targetPath: tempRoot,
      nowIso: "2026-04-17T00:30:00.000Z",
    });
    await writeFile(
      intakePath,
      `${JSON.stringify({ workItemId, endpoint: "/v1/runtime/runs", tampered: true }, null, 2)}\n`,
      "utf-8"
    );

    const verification = await verifyArtifactChain({
      workItemId,
      date,
      targetPath: tempRoot,
    });
    assert.equal(verification.valid, false);
    assert.equal(
      verification.mismatches.some((mismatch) => mismatch.type === "artifact_sha_mismatch"),
      true
    );
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});
