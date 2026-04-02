function normalizeString(value) {
  return String(value || "").trim();
}

function toPosixPath(value) {
  return String(value || "").replace(/\\/g, "/");
}

function summarizeSeverity(findings = []) {
  const summary = { P0: 0, P1: 0, P2: 0, P3: 0 };
  for (const finding of findings) {
    const severity = normalizeString(finding.severity).toUpperCase();
    if (Object.prototype.hasOwnProperty.call(summary, severity)) {
      summary[severity] += 1;
    }
  }
  summary.blocking = summary.P0 > 0 || summary.P1 > 0;
  return summary;
}

function isTestPath(filePath) {
  return /(^|\/)(__tests__|tests?|spec)(\/|$)|\.(test|spec)\.[^.]+$/i.test(filePath);
}

function buildCoverageInventory(ingest = {}) {
  const indexedFiles = Array.isArray(ingest.indexedFiles?.files) ? ingest.indexedFiles.files : [];
  const normalized = indexedFiles.map((file) => ({
    ...file,
    path: toPosixPath(file.path),
    loc: Number(file.loc || 0),
  }));

  const testFiles = normalized.filter((file) => isTestPath(file.path));
  const nonTestCodeFiles = normalized.filter((file) => !isTestPath(file.path) && file.loc > 0);
  const ratio = nonTestCodeFiles.length > 0 ? testFiles.length / nonTestCodeFiles.length : 0;
  const likelyGaps = nonTestCodeFiles
    .filter((file) => file.loc >= 260)
    .filter((file) => {
      const basename = file.path.slice(file.path.lastIndexOf("/") + 1).replace(/\.[^.]+$/, "");
      return !testFiles.some((candidate) => candidate.path.includes(basename));
    })
    .sort((left, right) => right.loc - left.loc)
    .slice(0, 20)
    .map((file) => ({
      path: file.path,
      loc: file.loc,
      language: file.language,
      severity: file.loc >= 550 ? "P1" : "P2",
    }));

  return {
    testFileCount: testFiles.length,
    codeFileCount: nonTestCodeFiles.length,
    ratio,
    testFiles: testFiles.slice(0, 30).map((file) => file.path),
    likelyGaps,
  };
}

function deriveTestingFindings({ findings = [], coverageInventory } = {}) {
  const derived = [];
  const scopedFindings = Array.isArray(findings) ? findings : [];
  for (const finding of scopedFindings) {
    const haystack = `${normalizeString(finding.message)} ${normalizeString(finding.ruleId)} ${normalizeString(
      finding.file
    )}`.toLowerCase();
    if (/test|coverage|assert|typecheck|lint|static analysis|flaky|fixture/.test(haystack)) {
      derived.push(finding);
    }
  }

  for (const gap of coverageInventory.likelyGaps || []) {
    const exists = derived.some((finding) => toPosixPath(finding.file) === gap.path);
    if (exists) {
      continue;
    }
    derived.push({
      severity: gap.severity,
      file: gap.path,
      line: 1,
      message: `High-risk module has no obvious colocated test coverage (${gap.loc} LOC).`,
      excerpt: `${gap.language || "code"} module ${gap.path}`,
      ruleId: "SL-TST-001",
      suggestedFix: "Add deterministic unit/integration coverage with failure-path assertions.",
      layer: "testing",
    });
  }

  return derived.slice(0, 120);
}

function estimateTestingScore(coverageInventory = {}, summary = {}) {
  const ratio = Number(coverageInventory.ratio || 0);
  const ratioScore = Math.min(60, Math.round(ratio * 100));
  const penalty = Number(summary.P1 || 0) * 10 + Number(summary.P2 || 0) * 5 + Number(summary.P3 || 0) * 1;
  return Math.max(0, Math.min(100, ratioScore + 40 - penalty));
}

function buildRecommendations({ coverageInventory = {}, summary = {} } = {}) {
  const recommendations = [];
  if (Number(summary.P1 || 0) > 0) {
    recommendations.push("Stabilize high-risk modules with P1 test gaps before feature expansion.");
  }
  if (coverageInventory.likelyGaps.length > 0) {
    recommendations.push("Create targeted tests for top LOC modules lacking colocated test companions.");
  }
  if (coverageInventory.ratio < 0.2) {
    recommendations.push("Increase test-to-code ratio with deterministic smoke and integration suites.");
  }
  if (recommendations.length === 0) {
    recommendations.push("Testing posture is stable; continue enforcing deterministic regression checks.");
  }
  return recommendations;
}

export function runTestingSpecialist({ findings = [], ingest = {} } = {}) {
  const coverageInventory = buildCoverageInventory(ingest);
  const testingFindings = deriveTestingFindings({
    findings,
    coverageInventory,
  });
  const summary = summarizeSeverity(testingFindings);
  const testingScore = estimateTestingScore(coverageInventory, summary);
  const confidence = testingFindings.length > 0 ? Math.max(0.74, 1 - testingFindings.length * 0.002) : 0.9;

  return {
    schemaVersion: "1.0.0",
    generatedAt: new Date().toISOString(),
    summary: {
      ...summary,
      findingCount: testingFindings.length,
      testingScore,
    },
    confidence,
    coverageInventory,
    recommendations: buildRecommendations({
      coverageInventory,
      summary,
    }),
    findings: testingFindings,
  };
}

export function renderTestingSpecialistMarkdown(report = {}) {
  const likelyGaps = (report.coverageInventory?.likelyGaps || [])
    .map((item) => `- ${item.path} (${item.loc} LOC, severity=${item.severity})`)
    .join("\n");
  const recommendations = (report.recommendations || []).map((item) => `- ${item}`).join("\n");

  return `# TESTING_AGENT_REPORT

Generated: ${report.generatedAt}
Testing score: ${report.summary?.testingScore ?? 0}/100
Confidence: ${((report.confidence || 0) * 100).toFixed(0)}%

Summary:
- Findings: P0=${report.summary?.P0 ?? 0} P1=${report.summary?.P1 ?? 0} P2=${report.summary?.P2 ?? 0} P3=${report.summary?.P3 ?? 0}
- Blocking: ${report.summary?.blocking ? "yes" : "no"}
- Total findings: ${report.summary?.findingCount ?? 0}

Coverage inventory:
- test files: ${report.coverageInventory?.testFileCount ?? 0}
- code files: ${report.coverageInventory?.codeFileCount ?? 0}
- ratio: ${((report.coverageInventory?.ratio || 0) * 100).toFixed(1)}%

Likely coverage gaps:
${likelyGaps || "- none"}

Recommendations:
${recommendations || "- none"}
`;
}
