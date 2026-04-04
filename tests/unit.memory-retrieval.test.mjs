import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";

import {
  buildLocalHybridIndex,
  buildSharedMemoryCorpus,
  queryHybridRetriever,
  queryLocalHybridIndex,
} from "../src/memory/retrieval.js";

test("Unit memory retrieval: local hybrid index ranks deterministic + TF-IDF matches", () => {
  const documents = [
    {
      documentId: "doc-auth",
      sourceType: "blackboard",
      severity: "P1",
      updatedAt: "2026-04-04T00:00:00.000Z",
      text: "auth token validation missing on callback endpoint",
    },
    {
      documentId: "doc-ui",
      sourceType: "blackboard",
      severity: "P3",
      updatedAt: "2026-04-01T00:00:00.000Z",
      text: "dashboard color palette and typography notes",
    },
  ];

  const index = buildLocalHybridIndex(documents);
  assert.equal(index.documentCount, 2);
  assert.equal(index.vocabularySize > 0, true);

  const query = queryLocalHybridIndex(index, {
    query: "auth token callback validation",
    limit: 2,
  });
  assert.equal(query.results.length, 2);
  assert.equal(query.results[0].documentId, "doc-auth");
  assert.equal(query.results[0].score > query.results[1].score, true);
});

test("Unit memory retrieval: corpus builder combines ingest, spec, and historical audit docs", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "create-sentinelayer-memory-corpus-"));
  try {
    const targetPath = path.join(tempRoot, "workspace");
    const outputRoot = path.join(targetPath, ".sentinelayer");
    const historyRun = path.join(outputRoot, "audits", "audit-20260403-000000-aaaa1111");
    await mkdir(historyRun, { recursive: true });

    await writeFile(
      path.join(targetPath, "SPEC.md"),
      "# SPEC\n\n## Endpoints\n- POST /api/auth/callback\n",
      "utf-8"
    );

    const historicalReport = {
      generatedAt: "2026-04-03T00:00:00.000Z",
      summary: {
        P0: 0,
        P1: 1,
        P2: 2,
        P3: 0,
        blocking: true,
      },
      ingest: {
        riskSurfaces: ["auth", "api"],
      },
      agentResults: [
        {
          agentId: "security",
          findings: [
            {
              severity: "P1",
              file: "src/auth/service.js",
              line: 10,
              layer: "deterministic",
              message: "Token validation bypass",
            },
          ],
        },
      ],
    };
    await writeFile(
      path.join(historyRun, "AUDIT_REPORT.json"),
      `${JSON.stringify(historicalReport, null, 2)}\n`,
      "utf-8"
    );

    const corpus = await buildSharedMemoryCorpus({
      outputRoot,
      targetPath,
      ingest: {
        summary: {
          filesScanned: 12,
          totalLoc: 344,
        },
        frameworks: ["node"],
        riskSurfaces: [{ surface: "auth" }, { surface: "observability" }],
      },
      excludeRunId: "audit-20990101-000000-ignore",
    });

    assert.equal(corpus.documents.length > 0, true);
    assert.equal(corpus.hasSpecDocument, true);
    assert.equal(corpus.historyRunDocumentCount > 0, true);
    assert.equal((corpus.sourceCounts.ingest || 0) > 0, true);
    assert.equal((corpus.sourceCounts["audit-history"] || 0) > 0, true);
    assert.equal((corpus.sourceCounts.spec || 0) > 0, true);
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("Unit memory retrieval: API delegation fails closed to local retriever", async () => {
  const documents = [
    {
      documentId: "doc-auth",
      sourceType: "blackboard",
      severity: "P2",
      updatedAt: "2026-04-04T00:00:00.000Z",
      text: "auth callback validation missing test coverage",
    },
  ];

  const fallback = await queryHybridRetriever({
    query: "auth callback validation",
    documents,
    provider: "auto",
    apiEndpoint: "https://memory-api.invalid/retrieve",
    fetchImpl: async () => {
      throw new Error("network unavailable");
    },
  });
  assert.equal(fallback.providerUsed, "local");
  assert.equal(fallback.apiFallback, true);
  assert.match(String(fallback.apiError || ""), /network unavailable/i);
  assert.equal(fallback.results.length > 0, true);

  const apiMode = await queryHybridRetriever({
    query: "auth callback validation",
    documents,
    provider: "api",
    apiEndpoint: "https://memory-api.example/retrieve",
    fetchImpl: async () => ({
      ok: true,
      json: async () => ({
        results: [
          {
            documentId: "remote-doc",
            sourceType: "api",
            severity: "P1",
            score: 0.99,
            snippet: "remote retrieval result",
          },
        ],
      }),
    }),
  });
  assert.equal(apiMode.providerUsed, "api");
  assert.equal(apiMode.apiFallback, false);
  assert.equal(apiMode.results[0].documentId, "remote-doc");
});
