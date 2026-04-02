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

function buildRuntimeHotspots(ingest = {}) {
  const indexed = Array.isArray(ingest.indexedFiles?.files) ? ingest.indexedFiles.files : [];
  return indexed
    .filter((file) => Number(file.loc || 0) >= 280)
    .sort((left, right) => Number(right.loc || 0) - Number(left.loc || 0))
    .slice(0, 20)
    .map((file) => ({
      path: toPosixPath(file.path),
      loc: Number(file.loc || 0),
      language: file.language,
      severity: Number(file.loc || 0) >= 900 ? "P1" : "P2",
    }));
}

function buildPerformanceFindings({ findings = [], runtimeHotspots = [] } = {}) {
  const scoped = Array.isArray(findings) ? findings : [];
  const derived = [];
  for (const finding of scoped) {
    const haystack = `${normalizeString(finding.message)} ${normalizeString(finding.ruleId)} ${normalizeString(
      finding.file
    )}`.toLowerCase();
    if (/latency|loop|n\+1|query|performance|cache|hot path|throughput|timeout/.test(haystack)) {
      derived.push(finding);
    }
  }

  for (const hotspot of runtimeHotspots) {
    const exists = derived.some((finding) => toPosixPath(finding.file) === hotspot.path);
    if (exists) {
      continue;
    }
    derived.push({
      severity: hotspot.severity,
      file: hotspot.path,
      line: 1,
      message: `Runtime hotspot candidate detected (${hotspot.loc} LOC).`,
      excerpt: `${hotspot.language || "code"} module at ${hotspot.path}`,
      ruleId: "SL-PERF-001",
      suggestedFix: "Profile this path and split heavy loops/queries into bounded units with caching.",
      layer: "performance",
    });
  }

  return derived.slice(0, 120);
}

function estimatePerformanceScore(runtimeHotspots = [], summary = {}) {
  const penalty =
    runtimeHotspots.length * 2 +
    Number(summary.P1 || 0) * 8 +
    Number(summary.P2 || 0) * 4 +
    Number(summary.P3 || 0);
  return Math.max(0, 100 - Math.min(100, penalty));
}

function buildRecommendations({ runtimeHotspots = [], summary = {} } = {}) {
  const recommendations = [];
  if (Number(summary.P1 || 0) > 0) {
    recommendations.push("Resolve P1 performance findings and add regression benchmarks before merge.");
  }
  if (runtimeHotspots.length > 0) {
    recommendations.push("Profile top hotspot modules and document expected p95/p99 behavior for each.");
  }
  if (Number(summary.P2 || 0) >= 4) {
    recommendations.push("Introduce staged load checks for high-change paths to prevent latency drift.");
  }
  if (recommendations.length === 0) {
    recommendations.push("Performance posture is stable; continue periodic profiling on critical paths.");
  }
  return recommendations;
}

export function runPerformanceSpecialist({ findings = [], ingest = {} } = {}) {
  const runtimeHotspots = buildRuntimeHotspots(ingest);
  const performanceFindings = buildPerformanceFindings({
    findings,
    runtimeHotspots,
  });
  const summary = summarizeSeverity(performanceFindings);
  const performanceScore = estimatePerformanceScore(runtimeHotspots, summary);
  const confidence =
    performanceFindings.length > 0 ? Math.max(0.74, 1 - performanceFindings.length * 0.0025) : 0.9;

  return {
    schemaVersion: "1.0.0",
    generatedAt: new Date().toISOString(),
    summary: {
      ...summary,
      findingCount: performanceFindings.length,
      performanceScore,
    },
    confidence,
    runtimeHotspots,
    recommendations: buildRecommendations({
      runtimeHotspots,
      summary,
    }),
    findings: performanceFindings,
  };
}

export function renderPerformanceSpecialistMarkdown(report = {}) {
  const hotspots = (report.runtimeHotspots || [])
    .map((item) => `- ${item.path} (${item.loc} LOC, severity=${item.severity})`)
    .join("\n");
  const recommendations = (report.recommendations || []).map((item) => `- ${item}`).join("\n");

  return `# PERFORMANCE_AGENT_REPORT

Generated: ${report.generatedAt}
Performance score: ${report.summary?.performanceScore ?? 0}/100
Confidence: ${((report.confidence || 0) * 100).toFixed(0)}%

Summary:
- Findings: P0=${report.summary?.P0 ?? 0} P1=${report.summary?.P1 ?? 0} P2=${report.summary?.P2 ?? 0} P3=${report.summary?.P3 ?? 0}
- Blocking: ${report.summary?.blocking ? "yes" : "no"}
- Total findings: ${report.summary?.findingCount ?? 0}

Runtime hotspots:
${hotspots || "- none"}

Recommendations:
${recommendations || "- none"}
`;
}
