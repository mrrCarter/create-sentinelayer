// Unit tests for the top-level investor-DD orchestrator (#investor-dd-5).

import test from "node:test";
import assert from "node:assert/strict";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { runInvestorDd } from "../src/review/investor-dd-orchestrator.js";

async function makeTempRepo() {
  return fsp.mkdtemp(path.join(os.tmpdir(), "senti-invdd-orch-"));
}

async function writeFile(root, relativePath, content) {
  const fullPath = path.join(root, relativePath);
  await fsp.mkdir(path.dirname(fullPath), { recursive: true });
  await fsp.writeFile(fullPath, content, "utf-8");
}

async function readJson(filePath) {
  const text = await fsp.readFile(filePath, "utf-8");
  return JSON.parse(text);
}

test("runInvestorDd: produces full artifact bundle", async () => {
  const root = await makeTempRepo();
  try {
    await writeFile(root, "src/app.js", "const run = (x) => eval(x);\n");
    await writeFile(root, "README.md", "# test repo\n");
    await writeFile(root, "package.json", '{"name":"t","version":"1.0.0"}');

    const events = [];
    const result = await runInvestorDd({
      rootPath: root,
      outputDir: root,
      onEvent: (e) => events.push(e),
      personas: ["security", "documentation", "supply-chain"],
    });

    assert.ok(result.runId.startsWith("investor-dd-"));
    assert.ok(result.artifactDir.includes("investor-dd"));

    const files = await fsp.readdir(result.artifactDir);
    assert.ok(files.includes("plan.json"));
    assert.ok(files.includes("stream.ndjson"));
    assert.ok(files.includes("summary.json"));
    assert.ok(files.includes("report.md"));
    assert.ok(files.includes("manifest.json"));
    assert.ok(files.includes("findings.json"));

    const plan = await readJson(path.join(result.artifactDir, "plan.json"));
    assert.equal(plan.rootPath, root);
    assert.deepEqual(plan.personas, ["security", "documentation", "supply-chain"]);
    assert.ok(Array.isArray(plan.routing.security));

    const summary = await readJson(path.join(result.artifactDir, "summary.json"));
    assert.equal(summary.runId, result.runId);
    assert.ok(summary.durationSeconds >= 0);

    const manifest = await readJson(path.join(result.artifactDir, "manifest.json"));
    for (const [file, entry] of Object.entries(manifest)) {
      assert.ok(/^[0-9a-f]{64}$/.test(entry.sha256), `bad sha for ${file}`);
      assert.ok(entry.bytes > 0);
    }

    assert.ok(events.some((e) => e.type === "investor_dd_start"));
    assert.ok(events.some((e) => e.type === "investor_dd_complete"));
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});

test("runInvestorDd: dryRun skips persona execution + still emits plan", async () => {
  const root = await makeTempRepo();
  try {
    await writeFile(root, "src/app.js", "const x = eval('x');\n");
    const events = [];
    const result = await runInvestorDd({
      rootPath: root,
      outputDir: root,
      dryRun: true,
      onEvent: (e) => events.push(e),
      personas: ["security"],
    });

    const summary = await readJson(path.join(result.artifactDir, "summary.json"));
    assert.equal(summary.dryRun, true);
    assert.equal(summary.totalFindings, 0);
    assert.ok(events.some((e) => e.type === "investor_dd_dry_run"));
    const files = await fsp.readdir(result.artifactDir);
    assert.ok(files.includes("plan.json"));
    assert.equal(files.includes("findings.json"), false);
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});

test("runInvestorDd: walker excludes node_modules + binary extensions", async () => {
  const root = await makeTempRepo();
  try {
    await writeFile(root, "src/a.js", "// ok\n");
    await writeFile(root, "node_modules/foo/index.js", "// should not be walked\n");
    await writeFile(root, "docs/diagram.png", "PNG");
    await writeFile(root, "README.md", "# t\n");

    const result = await runInvestorDd({
      rootPath: root,
      outputDir: root,
      dryRun: true,
      personas: ["documentation"],
    });
    const plan = await readJson(path.join(result.artifactDir, "plan.json"));
    const all = Object.values(plan.routing).flat();
    assert.ok(!all.some((f) => f.includes("node_modules/")));
    assert.ok(!all.some((f) => f.endsWith(".png")));
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});

test("runInvestorDd: stream.ndjson is line-delimited JSON", async () => {
  const root = await makeTempRepo();
  try {
    await writeFile(root, "src/a.js", "// ok\n");
    const result = await runInvestorDd({
      rootPath: root,
      outputDir: root,
      dryRun: true,
      personas: ["security"],
    });
    const stream = await fsp.readFile(path.join(result.artifactDir, "stream.ndjson"), "utf-8");
    const lines = stream.trim().split(/\n/);
    for (const line of lines) {
      const parsed = JSON.parse(line);
      assert.equal(typeof parsed.type, "string");
      assert.equal(parsed.runId, result.runId);
      assert.ok(parsed.at);
    }
    assert.ok(lines.length >= 2);
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});

test("runInvestorDd: rejects missing rootPath", async () => {
  await assert.rejects(() => runInvestorDd({}), /rootPath/);
});

test("runInvestorDd: writes compliance.json when not dryRun", async () => {
  const root = await makeTempRepo();
  try {
    await writeFile(root, "LICENSE", "MIT\n");
    await writeFile(root, "package.json", '{"name":"t","license":"MIT"}');
    await writeFile(root, "src/app.js", "// ok\n");

    const result = await runInvestorDd({
      rootPath: root,
      outputDir: root,
      personas: ["security"],
      compliancePacks: ["license"],
    });
    const compliance = await readJson(path.join(result.artifactDir, "compliance.json"));
    assert.ok(compliance.packs.license);
    assert.ok(result.summary.compliance);
    assert.ok(typeof result.summary.compliance.totalGaps === "number");
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});

test("runInvestorDd: runs live validator + reconciliation when clients supplied", async () => {
  const root = await makeTempRepo();
  try {
    await writeFile(
      root,
      "src/components/App.tsx",
      `<button data-testid="submit">Submit</button>\n`,
    );

    const devTestBot = {
      interact: async () => ({
        interactionId: "i1",
        statusCodeObserved: 200,
        consoleErrors: [],
      }),
    };
    const aidenid = {
      provisionEphemeralIdentity: async () => ({ identityId: "aid-1", email: "x@y" }),
      release: async () => {},
    };

    const result = await runInvestorDd({
      rootPath: root,
      outputDir: root,
      personas: ["security"],
      liveValidator: { devTestBot, aidenid, maxInteractions: 5 },
    });

    const liveObs = await readJson(path.join(result.artifactDir, "live-observations.json"));
    assert.ok(Array.isArray(liveObs.observations));
    assert.equal(result.summary.reconciliation, true);
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});

test("runInvestorDd: writes report.html alongside report.md", async () => {
  const root = await makeTempRepo();
  try {
    await writeFile(root, "src/app.js", "const run = (x) => eval(x);\n");
    const result = await runInvestorDd({
      rootPath: root,
      outputDir: root,
      personas: ["security"],
    });
    const files = await fsp.readdir(result.artifactDir);
    assert.ok(files.includes("report.html"));
    assert.ok(files.includes("report.md"));
    const html = await fsp.readFile(path.join(result.artifactDir, "report.html"), "utf-8");
    assert.ok(html.startsWith("<!doctype html>"));
    assert.ok(html.includes(result.runId));
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});

test("runInvestorDd: findings carry reproducibility metadata", async () => {
  const root = await makeTempRepo();
  try {
    await writeFile(root, "src/app.js", "const run = (x) => eval(x);\n");
    const result = await runInvestorDd({
      rootPath: root,
      outputDir: root,
      personas: ["security"],
    });
    const findings = await readJson(path.join(result.artifactDir, "findings.json"));
    assert.ok(findings.length > 0, "expected eval finding");
    for (const f of findings) {
      assert.ok(f.reproducibility, `finding missing reproducibility: ${f.kind}`);
      assert.ok(f.reproducibility.replayCommand);
      assert.ok(f.reproducibility.runId);
      assert.ok(f.reproducibility.filesAtTime);
    }
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});

test("runInvestorDd: calls notification clients when supplied", async () => {
  const root = await makeTempRepo();
  try {
    await writeFile(root, "src/app.js", "// ok\n");
    let emailSent = null;
    let dashboardSent = null;

    const result = await runInvestorDd({
      rootPath: root,
      outputDir: root,
      personas: ["security"],
      notification: {
        notifyEmail: "ops@example.com",
        emailClient: {
          sendMarkdown: async (msg) => {
            emailSent = msg;
            return { id: "mid-1" };
          },
        },
        dashboardClient: {
          upload: async (card) => {
            dashboardSent = card;
            return { cardId: "c-1" };
          },
        },
      },
    });

    assert.ok(emailSent);
    assert.equal(emailSent.to, "ops@example.com");
    assert.ok(dashboardSent);
    assert.equal(dashboardSent.runId, result.runId);
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});
