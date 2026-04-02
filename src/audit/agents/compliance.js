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

function classifyControl(finding = {}) {
  const haystack = `${normalizeString(finding.message)} ${normalizeString(finding.ruleId)} ${normalizeString(
    finding.file
  )}`.toLowerCase();
  if (/secret|token|credential|key|jwt/.test(haystack)) {
    return { framework: "SOC2-CC6", control: "Secrets Management", severity: "P1" };
  }
  if (/auth|session|revoke|ttl|role|permission/.test(haystack)) {
    return { framework: "SOC2-CC6", control: "Access Controls", severity: "P2" };
  }
  if (/telemetry|log|trace|audit/.test(haystack)) {
    return { framework: "SOC2-CC7", control: "Auditability", severity: "P2" };
  }
  if (/data|pii|encryption|tls|privacy|retention/.test(haystack)) {
    return { framework: "SOC2-CC8", control: "Data Protection", severity: "P1" };
  }
  if (/workflow|deploy|release|supply|dependency/.test(haystack)) {
    return { framework: "SOC2-CC9", control: "Change Management", severity: "P2" };
  }
  return { framework: "SOC2-CC3", control: "Governance", severity: "P3" };
}

function buildComplianceFindings({ findings = [], ingest = {} } = {}) {
  const derived = [];
  const scoped = Array.isArray(findings) ? findings : [];
  for (const finding of scoped) {
    const control = classifyControl(finding);
    if (control.severity === "P3" && normalizeString(finding.severity).toUpperCase() === "P3") {
      continue;
    }
    derived.push({
      ...finding,
      severity: normalizeString(finding.severity) ? finding.severity : control.severity,
      complianceFramework: control.framework,
      complianceControl: control.control,
      layer: "compliance",
    });
  }

  const riskSurfaces = Array.isArray(ingest.riskSurfaces) ? ingest.riskSurfaces : [];
  for (const surface of riskSurfaces.slice(0, 20)) {
    const normalizedSurface = normalizeString(surface.surface);
    if (!normalizedSurface) {
      continue;
    }
    const representativePath = toPosixPath(surface.filePath || surface.path || ".");
    const exists = derived.some((finding) => toPosixPath(finding.file) === representativePath);
    if (exists) {
      continue;
    }
    const control =
      normalizedSurface === "secrets"
        ? { framework: "SOC2-CC6", control: "Secrets Management", severity: "P1" }
        : { framework: "SOC2-CC7", control: "Auditability", severity: "P2" };
    derived.push({
      severity: control.severity,
      file: representativePath,
      line: 1,
      message: `Compliance risk surface detected for ${normalizedSurface}.`,
      excerpt: `${normalizedSurface} surface observed in ingest`,
      ruleId: "SL-COMP-001",
      suggestedFix: "Document control ownership and enforce deterministic remediation evidence.",
      complianceFramework: control.framework,
      complianceControl: control.control,
      layer: "compliance",
    });
  }

  return derived.slice(0, 120);
}

function summarizeControls(findings = []) {
  const controlMap = new Map();
  for (const finding of findings) {
    const framework = normalizeString(finding.complianceFramework || "SOC2-CC3");
    const control = normalizeString(finding.complianceControl || "Governance");
    const key = `${framework}::${control}`;
    const existing = controlMap.get(key) || { framework, control, count: 0 };
    existing.count += 1;
    controlMap.set(key, existing);
  }
  return [...controlMap.values()].sort((left, right) => right.count - left.count);
}

function estimateComplianceScore(summary = {}, controlSummary = []) {
  const penalty =
    Number(summary.P1 || 0) * 8 +
    Number(summary.P2 || 0) * 4 +
    Number(summary.P3 || 0) +
    controlSummary.length;
  return Math.max(0, 100 - Math.min(100, penalty));
}

function buildRecommendations(summary = {}, controlSummary = []) {
  const recommendations = [];
  if (Number(summary.P1 || 0) > 0) {
    recommendations.push("Close P1 compliance findings before release and attach evidence in run artifacts.");
  }
  if (controlSummary.some((item) => item.framework === "SOC2-CC6")) {
    recommendations.push("Strengthen credential/access controls and verify rotation/revocation procedures.");
  }
  if (controlSummary.some((item) => item.framework === "SOC2-CC7")) {
    recommendations.push("Improve audit telemetry coverage for remediation and production change traces.");
  }
  if (recommendations.length === 0) {
    recommendations.push("Compliance posture is stable; keep continuous evidence capture in each audit run.");
  }
  return recommendations;
}

export function runComplianceSpecialist({ findings = [], ingest = {} } = {}) {
  const complianceFindings = buildComplianceFindings({
    findings,
    ingest,
  });
  const summary = summarizeSeverity(complianceFindings);
  const controlSummary = summarizeControls(complianceFindings);
  const complianceScore = estimateComplianceScore(summary, controlSummary);
  const confidence = complianceFindings.length > 0 ? Math.max(0.76, 1 - complianceFindings.length * 0.002) : 0.9;

  return {
    schemaVersion: "1.0.0",
    generatedAt: new Date().toISOString(),
    summary: {
      ...summary,
      findingCount: complianceFindings.length,
      complianceScore,
    },
    confidence,
    controlSummary,
    recommendations: buildRecommendations(summary, controlSummary),
    findings: complianceFindings,
  };
}

export function renderComplianceSpecialistMarkdown(report = {}) {
  const controls = (report.controlSummary || [])
    .map((item) => `- ${item.framework} :: ${item.control} (${item.count} findings)`)
    .join("\n");
  const recommendations = (report.recommendations || []).map((item) => `- ${item}`).join("\n");

  return `# COMPLIANCE_AGENT_REPORT

Generated: ${report.generatedAt}
Compliance score: ${report.summary?.complianceScore ?? 0}/100
Confidence: ${((report.confidence || 0) * 100).toFixed(0)}%

Summary:
- Findings: P0=${report.summary?.P0 ?? 0} P1=${report.summary?.P1 ?? 0} P2=${report.summary?.P2 ?? 0} P3=${report.summary?.P3 ?? 0}
- Blocking: ${report.summary?.blocking ? "yes" : "no"}
- Total findings: ${report.summary?.findingCount ?? 0}

Control mapping:
${controls || "- none"}

Recommendations:
${recommendations || "- none"}
`;
}
