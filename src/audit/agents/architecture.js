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

function buildHotspots(ingest = {}) {
  const indexed = Array.isArray(ingest.indexedFiles?.files) ? ingest.indexedFiles.files : [];
  return indexed
    .filter((file) => Number(file.loc || 0) >= 300)
    .sort((left, right) => Number(right.loc || 0) - Number(left.loc || 0))
    .slice(0, 20)
    .map((file) => ({
      path: toPosixPath(file.path),
      language: file.language,
      loc: Number(file.loc || 0),
      sizeBytes: Number(file.sizeBytes || 0),
      risk: Number(file.loc || 0) >= 700 ? "high" : "medium",
    }));
}

function deriveArchitectureFindings({ findings = [], hotspots = [] } = {}) {
  const derived = [];
  const base = Array.isArray(findings) ? findings : [];

  for (const finding of base) {
    const message = normalizeString(finding.message).toLowerCase();
    if (/n\+1|loop|query|component|cleanup|stale|coupling|dependency/.test(message)) {
      derived.push(finding);
    }
  }

  for (const hotspot of hotspots) {
    const existing = derived.some((finding) => toPosixPath(finding.file) === hotspot.path);
    if (existing) {
      continue;
    }
    derived.push({
      severity: hotspot.risk === "high" ? "P1" : "P2",
      file: hotspot.path,
      line: 1,
      message: `Large architectural hotspot detected (${hotspot.loc} LOC).`,
      excerpt: `${hotspot.language} module at ${hotspot.path}`,
      ruleId: "SL-ARCH-001",
      suggestedFix: "Split this module into bounded components with explicit interfaces.",
      layer: "architecture",
    });
  }

  return derived.slice(0, 120);
}

function estimateCouplingRisk(ingest = {}) {
  const files = Array.isArray(ingest.indexedFiles?.files) ? ingest.indexedFiles.files : [];
  const byDirectory = new Map();
  for (const file of files) {
    const normalizedPath = toPosixPath(file.path);
    const dir = normalizedPath.includes("/") ? normalizedPath.slice(0, normalizedPath.lastIndexOf("/")) : ".";
    const existing = byDirectory.get(dir) || 0;
    byDirectory.set(dir, existing + 1);
  }
  const denseDirs = [...byDirectory.entries()].filter((entry) => entry[1] >= 20);
  return {
    denseDirectoryCount: denseDirs.length,
    denseDirectories: denseDirs
      .sort((left, right) => right[1] - left[1])
      .slice(0, 12)
      .map((entry) => ({ directory: entry[0], fileCount: entry[1] })),
  };
}

function estimateArchitectureScore(hotspots = [], summary = {}) {
  const penalty =
    hotspots.length * 3 +
    Number(summary.P1 || 0) * 6 +
    Number(summary.P2 || 0) * 3 +
    Number(summary.P3 || 0);
  return Math.max(0, 100 - Math.min(100, penalty));
}

function buildRecommendations({ hotspots = [], summary = {}, couplingRisk } = {}) {
  const recommendations = [];
  if (hotspots.length > 0) {
    recommendations.push(
      "Split high-LOC modules into bounded contexts and enforce explicit interface contracts."
    );
  }
  if (Number(summary.P1 || 0) > 0) {
    recommendations.push("Resolve all P1 architecture findings before onboarding additional feature work.");
  }
  if (couplingRisk.denseDirectoryCount > 0) {
    recommendations.push(
      "Introduce package-level ownership boundaries for dense directories to reduce cross-module coupling."
    );
  }
  if (recommendations.length === 0) {
    recommendations.push("Architecture signals are stable; continue tracking drift with periodic audits.");
  }
  return recommendations;
}

export function runArchitectureSpecialist({
  findings = [],
  ingest = {},
} = {}) {
  const hotspots = buildHotspots(ingest);
  const architectureFindings = deriveArchitectureFindings({
    findings,
    hotspots,
  });
  const summary = summarizeSeverity(architectureFindings);
  const couplingRisk = estimateCouplingRisk(ingest);
  const architectureScore = estimateArchitectureScore(hotspots, summary);
  const confidence = architectureFindings.length > 0 ? Math.max(0.72, 1 - architectureFindings.length * 0.002) : 0.9;

  return {
    schemaVersion: "1.0.0",
    generatedAt: new Date().toISOString(),
    summary: {
      ...summary,
      findingCount: architectureFindings.length,
      architectureScore,
    },
    confidence,
    hotspots,
    couplingRisk,
    recommendations: buildRecommendations({
      hotspots,
      summary,
      couplingRisk,
    }),
    findings: architectureFindings,
  };
}

export function renderArchitectureSpecialistMarkdown(report = {}) {
  const hotspots = (report.hotspots || [])
    .map((item) => `- ${item.path} (${item.loc} LOC, risk=${item.risk})`)
    .join("\n");
  const couplings = (report.couplingRisk?.denseDirectories || [])
    .map((item) => `- ${item.directory}: ${item.fileCount} files`)
    .join("\n");
  const recommendations = (report.recommendations || []).map((item) => `- ${item}`).join("\n");

  return `# ARCHITECTURE_AGENT_REPORT

Generated: ${report.generatedAt}
Architecture score: ${report.summary?.architectureScore ?? 0}/100
Confidence: ${((report.confidence || 0) * 100).toFixed(0)}%

Summary:
- Findings: P0=${report.summary?.P0 ?? 0} P1=${report.summary?.P1 ?? 0} P2=${report.summary?.P2 ?? 0} P3=${report.summary?.P3 ?? 0}
- Blocking: ${report.summary?.blocking ? "yes" : "no"}
- Total findings: ${report.summary?.findingCount ?? 0}

Hotspots:
${hotspots || "- none"}

Coupling density:
${couplings || "- none"}

Recommendations:
${recommendations || "- none"}
`;
}

