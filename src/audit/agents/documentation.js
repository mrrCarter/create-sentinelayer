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

function buildDocumentationInventory(ingest = {}) {
  const indexed = Array.isArray(ingest.indexedFiles?.files) ? ingest.indexedFiles.files : [];
  const normalized = indexed.map((file) => ({
    path: toPosixPath(file.path),
    loc: Number(file.loc || 0),
    language: file.language,
  }));
  const docFiles = normalized.filter((file) => /(^|\/)(docs?|guides?|adr|readme)/i.test(file.path));
  const codeFiles = normalized.filter(
    (file) => file.loc > 0 && !/(^|\/)(docs?|guides?|adr|readme)/i.test(file.path)
  );
  const docDensity = codeFiles.length > 0 ? docFiles.length / codeFiles.length : 0;
  const undocumentedHotspots = codeFiles
    .filter((file) => file.loc >= 320)
    .filter((file) => {
      const dir = file.path.includes("/") ? file.path.slice(0, file.path.lastIndexOf("/")) : ".";
      return !docFiles.some((doc) => doc.path.startsWith(dir));
    })
    .sort((left, right) => right.loc - left.loc)
    .slice(0, 20)
    .map((file) => ({
      path: file.path,
      loc: file.loc,
      language: file.language,
      severity: file.loc >= 800 ? "P1" : "P2",
    }));

  return {
    docFileCount: docFiles.length,
    codeFileCount: codeFiles.length,
    docDensity,
    undocumentedHotspots,
  };
}

function buildDocumentationFindings({ findings = [], inventory = {} } = {}) {
  const scoped = Array.isArray(findings) ? findings : [];
  const derived = [];
  for (const finding of scoped) {
    const haystack = `${normalizeString(finding.message)} ${normalizeString(finding.ruleId)} ${normalizeString(
      finding.file
    )}`.toLowerCase();
    if (/doc|documentation|spec|guide|readme|runbook|playbook|adr/.test(haystack)) {
      derived.push(finding);
    }
  }

  for (const hotspot of inventory.undocumentedHotspots || []) {
    const exists = derived.some((finding) => toPosixPath(finding.file) === hotspot.path);
    if (exists) {
      continue;
    }
    derived.push({
      severity: hotspot.severity,
      file: hotspot.path,
      line: 1,
      message: `Large module lacks nearby documentation coverage (${hotspot.loc} LOC).`,
      excerpt: `${hotspot.language || "code"} module at ${hotspot.path}`,
      ruleId: "SL-DOC-001",
      suggestedFix: "Add a runbook/spec section describing responsibilities, dependencies, and failure modes.",
      layer: "documentation",
    });
  }

  return derived.slice(0, 120);
}

function estimateDocumentationScore(inventory = {}, summary = {}) {
  const densityScore = Math.min(70, Math.round(Number(inventory.docDensity || 0) * 100));
  const penalty = Number(summary.P1 || 0) * 8 + Number(summary.P2 || 0) * 4 + Number(summary.P3 || 0);
  return Math.max(0, Math.min(100, densityScore + 30 - penalty));
}

function buildRecommendations(inventory = {}, summary = {}) {
  const recommendations = [];
  if (Number(summary.P1 || 0) > 0) {
    recommendations.push("Close P1 documentation gaps for critical modules before release.");
  }
  if (inventory.undocumentedHotspots?.length > 0) {
    recommendations.push("Create runbooks/spec addenda for high-LOC modules lacking nearby docs.");
  }
  if (Number(inventory.docDensity || 0) < 0.2) {
    recommendations.push("Increase docs-to-code density with ADRs and operator-oriented troubleshooting guides.");
  }
  if (recommendations.length === 0) {
    recommendations.push("Documentation posture is stable; maintain drift checks between code and specs.");
  }
  return recommendations;
}

export function runDocumentationSpecialist({ findings = [], ingest = {} } = {}) {
  const inventory = buildDocumentationInventory(ingest);
  const documentationFindings = buildDocumentationFindings({
    findings,
    inventory,
  });
  const summary = summarizeSeverity(documentationFindings);
  const documentationScore = estimateDocumentationScore(inventory, summary);
  const confidence =
    documentationFindings.length > 0 ? Math.max(0.72, 1 - documentationFindings.length * 0.0025) : 0.9;

  return {
    schemaVersion: "1.0.0",
    generatedAt: new Date().toISOString(),
    summary: {
      ...summary,
      findingCount: documentationFindings.length,
      documentationScore,
    },
    confidence,
    inventory,
    recommendations: buildRecommendations(inventory, summary),
    findings: documentationFindings,
  };
}

export function renderDocumentationSpecialistMarkdown(report = {}) {
  const hotspots = (report.inventory?.undocumentedHotspots || [])
    .map((item) => `- ${item.path} (${item.loc} LOC, severity=${item.severity})`)
    .join("\n");
  const recommendations = (report.recommendations || []).map((item) => `- ${item}`).join("\n");

  return `# DOCUMENTATION_AGENT_REPORT

Generated: ${report.generatedAt}
Documentation score: ${report.summary?.documentationScore ?? 0}/100
Confidence: ${((report.confidence || 0) * 100).toFixed(0)}%

Summary:
- Findings: P0=${report.summary?.P0 ?? 0} P1=${report.summary?.P1 ?? 0} P2=${report.summary?.P2 ?? 0} P3=${report.summary?.P3 ?? 0}
- Blocking: ${report.summary?.blocking ? "yes" : "no"}
- Total findings: ${report.summary?.findingCount ?? 0}

Documentation inventory:
- doc files: ${report.inventory?.docFileCount ?? 0}
- code files: ${report.inventory?.codeFileCount ?? 0}
- doc density: ${((report.inventory?.docDensity || 0) * 100).toFixed(1)}%

Undocumented hotspots:
${hotspots || "- none"}

Recommendations:
${recommendations || "- none"}
`;
}
