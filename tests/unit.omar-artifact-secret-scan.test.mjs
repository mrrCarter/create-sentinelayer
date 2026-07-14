import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFile, mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scannerPath = fileURLToPath(
  new URL("../.github/scripts/scan-omar-artifacts.js", import.meta.url),
);

function runScanner({
  artifactDir,
  reportPath,
  manifestPath,
  expectedManifestPath,
  maxBytes,
  maxTotalBytes,
  maxFiles,
}) {
  const args = [scannerPath, "--path", artifactDir, "--report", reportPath];
  if (manifestPath !== undefined) {
    args.push("--manifest", manifestPath);
  }
  if (expectedManifestPath !== undefined) {
    args.push("--expected-manifest", expectedManifestPath);
  }
  if (maxBytes !== undefined) {
    args.push("--max-bytes", String(maxBytes));
  }
  if (maxTotalBytes !== undefined) {
    args.push("--max-total-bytes", String(maxTotalBytes));
  }
  if (maxFiles !== undefined) {
    args.push("--max-files", String(maxFiles));
  }
  return spawnSync(
    process.execPath,
    args,
    { encoding: "utf8" },
  );
}

test("Omar artifact scanner rejects files above its inspection limit", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "omar-artifact-size-"));
  try {
    const artifactDir = path.join(tempRoot, "artifacts");
    const reportPath = path.join(tempRoot, "secret-scan.json");
    await mkdir(artifactDir, { recursive: true });
    await writeFile(path.join(artifactDir, "oversized.txt"), "x".repeat(65), "utf8");

    const result = runScanner({ artifactDir, reportPath, maxBytes: 64 });

    assert.equal(result.status, 2, result.stderr || result.stdout);
    const findings = JSON.parse(await readFile(reportPath, "utf8"));
    assert.deepEqual(findings, [
      {
        file: "oversized.txt",
        line: null,
        type: "oversized_file",
        size_bytes: 65,
        max_bytes: 64,
      },
    ]);
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("Omar artifact scanner still reports secret-shaped content", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "omar-artifact-secret-"));
  try {
    const artifactDir = path.join(tempRoot, "artifacts");
    const reportPath = path.join(tempRoot, "secret-scan.json");
    await mkdir(artifactDir, { recursive: true });
    await writeFile(
      path.join(artifactDir, "summary.json"),
      '{"api_key":"0123456789abcdef0123456789abcdef"}\n',
      "utf8",
    );

    const result = runScanner({ artifactDir, reportPath, maxBytes: 1024 });

    assert.equal(result.status, 2, result.stderr || result.stdout);
    const reportText = await readFile(reportPath, "utf8");
    const findings = JSON.parse(reportText);
    assert.equal(findings.some((finding) => finding.type === "key_value"), true);
    assert.doesNotMatch(reportText, /0123456789abcdef0123456789abcdef/);
    assert.equal(findings.every((finding) => !Object.hasOwn(finding, "match")), true);
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("Omar artifact scanner rejects bare provider credentials and private keys", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "omar-artifact-provider-secret-"));
  const secrets = [
    `sk-proj-${"A".repeat(32)}`,
    `sk_live_${"B".repeat(32)}`,
    `github_pat_${"C".repeat(30)}`,
    `ghp_${"D".repeat(36)}`,
    `AIza${"E".repeat(35)}`,
    `xoxb-${"F".repeat(30)}`,
    `AKIA${"G".repeat(16)}`,
    `xai-${"H".repeat(32)}`,
    `gsk_${"I".repeat(32)}`,
    `npm_${"J".repeat(36)}`,
    `eyJ${"K".repeat(12)}.${"L".repeat(12)}.${"M".repeat(12)}`,
    "-----BEGIN OPENSSH PRIVATE KEY-----",
  ];
  try {
    const artifactDir = path.join(tempRoot, "artifacts");
    const reportPath = path.join(tempRoot, "secret-scan.json");
    await mkdir(artifactDir, { recursive: true });
    await writeFile(path.join(artifactDir, "bare-secrets.txt"), `${secrets.join("\n")}\n`, "utf8");

    const result = runScanner({ artifactDir, reportPath });

    assert.equal(result.status, 2, result.stderr || result.stdout);
    const reportText = await readFile(reportPath, "utf8");
    const findings = JSON.parse(reportText);
    assert.deepEqual(
      new Set(findings.map((finding) => finding.type)),
      new Set([
        "openai_or_anthropic_key",
        "shift4_key",
        "github_token",
        "google_api_key",
        "slack_token",
        "aws_access_key_id",
        "provider_api_key",
        "npm_token",
        "jwt",
        "private_key",
      ]),
    );
    for (const secret of secrets) {
      assert.equal(reportText.includes(secret), false);
    }
    assert.equal(findings.every((finding) => /^sha256:[0-9a-f]{16}$/.test(finding.fingerprint)), true);
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("Omar artifact scanner rejects common auth headers, passwords, cookies, and database URLs", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "omar-artifact-auth-secret-"));
  const secrets = [
    "Authorization: Basic ZGVtbzpwYXNzd29yZA==",
    "Authorization: Bearer short-valid-token",
    "password=hunter2",
    "Cookie: session_id=abcdef123456",
    "postgresql://demo:db-password@example.com/catalog",
  ];
  try {
    const artifactDir = path.join(tempRoot, "artifacts");
    const reportPath = path.join(tempRoot, "secret-scan.json");
    await mkdir(artifactDir, { recursive: true });
    await writeFile(path.join(artifactDir, "auth.txt"), `${secrets.join("\n")}\n`, "utf8");

    const result = runScanner({ artifactDir, reportPath });

    assert.equal(result.status, 2, result.stderr || result.stdout);
    const reportText = await readFile(reportPath, "utf8");
    const findings = JSON.parse(reportText);
    assert.deepEqual(
      new Set(findings.map((finding) => finding.type)),
      new Set([
        "authorization_header",
        "password_or_credential",
        "cookie_header",
        "database_url",
      ]),
    );
    for (const secret of secrets) {
      assert.equal(reportText.includes(secret), false);
    }
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("Omar artifact scanner bounds secret findings and fails closed at the cap", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "omar-artifact-finding-limit-"));
  try {
    const artifactDir = path.join(tempRoot, "artifacts");
    const reportPath = path.join(tempRoot, "secret-scan.json");
    await mkdir(artifactDir, { recursive: true });
    const repeatedSecret = `sk-proj-${"Q".repeat(32)}`;
    await writeFile(
      path.join(artifactDir, "many-secrets.txt"),
      `${Array.from({ length: 1_100 }, () => repeatedSecret).join("\n")}\n`,
      "utf8",
    );

    const result = runScanner({ artifactDir, reportPath });

    assert.equal(result.status, 2, result.stderr || result.stdout);
    const reportText = await readFile(reportPath, "utf8");
    const findings = JSON.parse(reportText);
    assert.equal(findings.length, 1_001);
    assert.equal(findings.at(-1).type, "finding_count_limit");
    assert.equal(findings.at(-1).max_findings, 1_000);
    assert.equal(reportText.includes(repeatedSecret), false);
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("Omar artifact scanner blocks secret-bearing filenames without disclosing the path", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "omar-artifact-secret-path-"));
  const secretName = `sk-proj-${"Z".repeat(32)}.txt`;
  try {
    const artifactDir = path.join(tempRoot, "artifacts");
    const reportPath = path.join(tempRoot, "secret-scan.json");
    await mkdir(artifactDir, { recursive: true });
    await writeFile(path.join(artifactDir, secretName), "safe content\n", "utf8");

    const result = runScanner({ artifactDir, reportPath });

    assert.equal(result.status, 2, result.stderr || result.stdout);
    const reportText = await readFile(reportPath, "utf8");
    const findings = JSON.parse(reportText);
    assert.equal(findings.some((finding) => finding.type === "path_openai_or_anthropic_key"), true);
    assert.equal(reportText.includes(secretName), false);
    assert.equal(findings.some((finding) => /^<redacted-path:sha256:/.test(finding.file)), true);
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("Omar artifact scanner enforces aggregate byte and file-count bounds", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "omar-artifact-aggregate-"));
  try {
    const artifactDir = path.join(tempRoot, "artifacts");
    const sizeReport = path.join(tempRoot, "size-report.json");
    const countReport = path.join(tempRoot, "count-report.json");
    await mkdir(artifactDir, { recursive: true });
    await writeFile(path.join(artifactDir, "a.txt"), "a".repeat(40), "utf8");
    await writeFile(path.join(artifactDir, "b.txt"), "b".repeat(40), "utf8");

    const sizeResult = runScanner({
      artifactDir,
      reportPath: sizeReport,
      maxTotalBytes: 64,
    });
    assert.equal(sizeResult.status, 2, sizeResult.stderr || sizeResult.stdout);
    assert.equal(JSON.parse(await readFile(sizeReport, "utf8"))[0].type, "aggregate_size_limit");

    const countResult = runScanner({
      artifactDir,
      reportPath: countReport,
      maxFiles: 1,
    });
    assert.equal(countResult.status, 2, countResult.stderr || countResult.stdout);
    assert.equal(JSON.parse(await readFile(countReport, "utf8"))[0].type, "file_count_limit");

    await rm(path.join(artifactDir, "a.txt"));
    await rm(path.join(artifactDir, "b.txt"));
    await mkdir(path.join(artifactDir, "empty-a"));
    await mkdir(path.join(artifactDir, "empty-b"));
    const emptyDirectoryResult = runScanner({
      artifactDir,
      reportPath: countReport,
      maxFiles: 1,
    });
    assert.equal(
      emptyDirectoryResult.status,
      2,
      emptyDirectoryResult.stderr || emptyDirectoryResult.stdout,
    );
    assert.equal(JSON.parse(await readFile(countReport, "utf8"))[0].type, "file_count_limit");
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("Omar artifact scanner seals and verifies the exact scanned file set", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "omar-artifact-manifest-"));
  try {
    const sourceDir = path.join(tempRoot, "source");
    const extractedDir = path.join(tempRoot, "extracted");
    const manifestPath = path.join(tempRoot, "artifact-manifest.json");
    await mkdir(path.join(sourceDir, "nested"), { recursive: true });
    await mkdir(path.join(extractedDir, "nested"), { recursive: true });
    await writeFile(path.join(sourceDir, "summary.json"), "{}\n", "utf8");
    await writeFile(path.join(sourceDir, "nested", "finding.txt"), "safe\n", "utf8");
    await writeFile(path.join(extractedDir, "summary.json"), "{}\n", "utf8");
    await writeFile(path.join(extractedDir, "nested", "finding.txt"), "safe\n", "utf8");

    const sealResult = runScanner({
      artifactDir: sourceDir,
      reportPath: path.join(tempRoot, "seal-report.json"),
      manifestPath,
    });
    assert.equal(sealResult.status, 0, sealResult.stderr || sealResult.stdout);
    const manifestText = await readFile(manifestPath, "utf8");
    const manifest = JSON.parse(manifestText);
    assert.equal(manifest.file_count, 2);
    assert.equal(manifest.total_bytes, 8);
    assert.match(manifest.root_sha256, /^[0-9a-f]{64}$/);
    assert.equal(manifestText.includes(sourceDir), false);

    const verifyResult = runScanner({
      artifactDir: extractedDir,
      reportPath: path.join(tempRoot, "verify-report.json"),
      expectedManifestPath: manifestPath,
    });
    assert.equal(verifyResult.status, 0, verifyResult.stderr || verifyResult.stdout);

    const embeddedManifestPath = path.join(extractedDir, "validation", "artifact-manifest.json");
    await mkdir(path.dirname(embeddedManifestPath), { recursive: true });
    await writeFile(embeddedManifestPath, manifestText, "utf8");
    const embeddedVerifyResult = runScanner({
      artifactDir: extractedDir,
      reportPath: path.join(tempRoot, "embedded-verify-report.json"),
      expectedManifestPath: embeddedManifestPath,
    });
    assert.equal(
      embeddedVerifyResult.status,
      0,
      embeddedVerifyResult.stderr || embeddedVerifyResult.stdout,
    );

    await writeFile(path.join(extractedDir, "nested", "finding.txt"), "swap\n", "utf8");
    const mismatchReport = path.join(tempRoot, "mismatch-report.json");
    const mismatchResult = runScanner({
      artifactDir: extractedDir,
      reportPath: mismatchReport,
      expectedManifestPath: embeddedManifestPath,
    });
    assert.equal(mismatchResult.status, 2, mismatchResult.stderr || mismatchResult.stdout);
    assert.equal(
      JSON.parse(await readFile(mismatchReport, "utf8")).some(
        (finding) => finding.type === "artifact_manifest_mismatch",
      ),
      true,
    );
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("Omar artifact scanner scans beyond the retired 512 KiB boundary", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "omar-artifact-stream-"));
  try {
    const artifactDir = path.join(tempRoot, "artifacts");
    const reportPath = path.join(tempRoot, "secret-scan.json");
    await mkdir(artifactDir, { recursive: true });
    await writeFile(
      path.join(artifactDir, "large-findings.jsonl"),
      `${"safe finding\n".repeat(45_000)}api_key=0123456789abcdef0123456789abcdef\n`,
      "utf8",
    );

    const result = runScanner({ artifactDir, reportPath });

    assert.equal(result.status, 2, result.stderr || result.stdout);
    const findings = JSON.parse(await readFile(reportPath, "utf8"));
    assert.equal(findings.some((finding) => finding.type === "key_value"), true);
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("Omar artifact scanner rejects invalid byte limits", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "omar-artifact-limit-"));
  try {
    const artifactDir = path.join(tempRoot, "artifacts");
    const reportPath = path.join(tempRoot, "secret-scan.json");
    await mkdir(artifactDir, { recursive: true });

    const result = runScanner({ artifactDir, reportPath, maxBytes: 0 });

    assert.equal(result.status, 1, result.stderr || result.stdout);
    assert.match(result.stderr, /--max-bytes must be a positive safe integer/);
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("Omar artifact scanner refuses symlinks instead of leaving its evidence root", async (t) => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "omar-artifact-symlink-"));
  try {
    const artifactDir = path.join(tempRoot, "artifacts");
    const reportPath = path.join(tempRoot, "secret-scan.json");
    const outsidePath = path.join(tempRoot, "outside.txt");
    await mkdir(artifactDir, { recursive: true });
    await writeFile(outsidePath, "safe outside content\n", "utf8");
    try {
      await symlink(outsidePath, path.join(artifactDir, "linked.txt"), "file");
    } catch (error) {
      if (process.platform === "win32" && error?.code === "EPERM") {
        t.skip("Windows symlink creation requires Developer Mode or elevated privilege.");
        return;
      }
      throw error;
    }

    const result = runScanner({ artifactDir, reportPath });

    assert.equal(result.status, 1, result.stderr || result.stdout);
    assert.match(result.stderr, /Artifact scan refuses symbolic links/);
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("Omar artifact scanner refuses unsupported filesystem entries", async (t) => {
  if (process.platform === "win32") {
    t.skip("Named-pipe fixture uses the Unix mkfifo utility.");
    return;
  }
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "omar-artifact-fifo-"));
  try {
    const artifactDir = path.join(tempRoot, "artifacts");
    const reportPath = path.join(tempRoot, "secret-scan.json");
    const fifoPath = path.join(artifactDir, "unsupported.fifo");
    await mkdir(artifactDir, { recursive: true });
    const fixture = spawnSync("mkfifo", [fifoPath], { encoding: "utf8" });
    if (fixture.error?.code === "ENOENT") {
      t.skip("mkfifo is unavailable on this host.");
      return;
    }
    assert.equal(fixture.status, 0, fixture.stderr || fixture.stdout);

    const result = runScanner({ artifactDir, reportPath });

    assert.equal(result.status, 1, result.stderr || result.stdout);
    assert.match(result.stderr, /Artifact scan refuses non-regular filesystem entries/);
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});
