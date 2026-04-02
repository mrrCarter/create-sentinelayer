function normalizeString(value) {
  return String(value || "").trim();
}

function severityWeight(severity) {
  const normalized = normalizeString(severity).toUpperCase();
  if (normalized === "P0") {
    return 40;
  }
  if (normalized === "P1") {
    return 25;
  }
  if (normalized === "P2") {
    return 10;
  }
  return 3;
}

function classifySecurityCategory(finding = {}) {
  const haystack = `${normalizeString(finding.message)} ${normalizeString(finding.ruleId)} ${normalizeString(
    finding.file
  )} ${normalizeString(finding.excerpt)}`.toLowerCase();
  if (/token|secret|credential|private key|api key|jwt|bearer/.test(haystack)) {
    return {
      id: "secret_exposure",
      title: "Secret Exposure",
      owasp: "A02:2021-Cryptographic Failures",
      cwe: "CWE-798",
    };
  }
  if (/sql|injection|eval|innerhtml|xss|cors|tls/.test(haystack)) {
    return {
      id: "injection_surface",
      title: "Injection / Unsafe Execution Surface",
      owasp: "A03:2021-Injection",
      cwe: "CWE-89",
    };
  }
  if (/workflow|release|dependency|lockfile|supply/.test(haystack)) {
    return {
      id: "supply_chain",
      title: "Supply Chain / CI Exposure",
      owasp: "A06:2021-Vulnerable and Outdated Components",
      cwe: "CWE-1104",
    };
  }
  if (/auth|session|ttl|rotation|revoke/.test(haystack)) {
    return {
      id: "auth_control",
      title: "Authentication & Session Control",
      owasp: "A07:2021-Identification and Authentication Failures",
      cwe: "CWE-287",
    };
  }
  return {
    id: "misc_security",
    title: "General Security Hardening",
    owasp: "A04:2021-Insecure Design",
    cwe: "CWE-693",
  };
}

function summarizeSeverity(findings = []) {
  const summary = {
    P0: 0,
    P1: 0,
    P2: 0,
    P3: 0,
  };
  for (const finding of findings) {
    const severity = normalizeString(finding.severity).toUpperCase();
    if (Object.prototype.hasOwnProperty.call(summary, severity)) {
      summary[severity] += 1;
    }
  }
  summary.blocking = summary.P0 > 0 || summary.P1 > 0;
  return summary;
}

function buildExploitScenario(finding, index) {
  const category = classifySecurityCategory(finding);
  return {
    scenarioId: `SEC-SCENARIO-${String(index + 1).padStart(3, "0")}`,
    findingRef: finding.ruleId || finding.findingId || "unknown",
    title: `${category.title} exploit path`,
    severity: finding.severity,
    file: finding.file,
    line: finding.line,
    scenario: `An attacker can leverage ${category.title.toLowerCase()} indicators in ${finding.file}:${finding.line} to bypass controls or exfiltrate sensitive data.`,
    impact: "Credential compromise, privilege escalation, or unauthorized data access.",
    recommendedControl: finding.suggestedFix || "Apply least-privilege controls and rotate affected credentials.",
    owasp: category.owasp,
    cwe: category.cwe,
  };
}

function buildCategorySummary(findings = []) {
  const buckets = new Map();
  for (const finding of findings) {
    const category = classifySecurityCategory(finding);
    const existing = buckets.get(category.id) || {
      ...category,
      count: 0,
      findings: [],
    };
    existing.count += 1;
    existing.findings.push({
      severity: finding.severity,
      file: finding.file,
      line: finding.line,
      message: finding.message,
      ruleId: finding.ruleId,
    });
    buckets.set(category.id, existing);
  }

  return [...buckets.values()]
    .map((category) => ({
      ...category,
      findings: category.findings.slice(0, 25),
    }))
    .sort((left, right) => right.count - left.count);
}

function computeRiskScore(findings = []) {
  let score = 0;
  for (const finding of findings) {
    score += severityWeight(finding.severity);
  }
  return Math.min(100, score);
}

function buildRecommendedActions(findings = []) {
  if (findings.length === 0) {
    return [
      "No high-confidence security findings surfaced in this run; continue monitoring with periodic deep scans.",
    ];
  }

  return [
    "Rotate any credentials or tokens potentially exposed in source history.",
    "Enforce strict release-gate dependencies so publish paths cannot bypass quality/security checks.",
    "Pin GitHub Actions and critical dependencies to immutable versions/SHAs where feasible.",
    "Strengthen auth/session controls (TTL, revocation visibility, keyring fallback hardening).",
    "Add targeted security tests for each P0/P1 finding before merge.",
  ];
}

export function runSecuritySpecialist({
  findings = [],
  maxFindings = 120,
} = {}) {
  const scopedFindings = (Array.isArray(findings) ? findings : []).slice(0, maxFindings);
  const severity = summarizeSeverity(scopedFindings);
  const categories = buildCategorySummary(scopedFindings);
  const exploitScenarios = scopedFindings
    .filter((finding) => ["P0", "P1", "P2"].includes(normalizeString(finding.severity).toUpperCase()))
    .slice(0, 12)
    .map((finding, index) => buildExploitScenario(finding, index));
  const riskScore = computeRiskScore(scopedFindings);
  const confidence = scopedFindings.length > 0 ? Math.max(0.78, 1 - scopedFindings.length * 0.0025) : 0.92;

  return {
    schemaVersion: "1.0.0",
    generatedAt: new Date().toISOString(),
    summary: {
      ...severity,
      findingCount: scopedFindings.length,
      riskScore,
    },
    confidence,
    categories,
    exploitScenarios,
    recommendedActions: buildRecommendedActions(scopedFindings),
    findings: scopedFindings,
  };
}

export function renderSecuritySpecialistMarkdown(report = {}) {
  const categories = (report.categories || [])
    .map((item) => `- ${item.title}: ${item.count} findings (${item.owasp}, ${item.cwe})`)
    .join("\n");
  const scenarios = (report.exploitScenarios || [])
    .map(
      (item, index) =>
        `${index + 1}. [${item.severity}] ${item.file}:${item.line} ${item.title}\n` +
        `   scenario: ${item.scenario}\n` +
        `   impact: ${item.impact}\n` +
        `   control: ${item.recommendedControl}`
    )
    .join("\n");
  const actions = (report.recommendedActions || []).map((item) => `- ${item}`).join("\n");

  return `# SECURITY_AGENT_REPORT

Generated: ${report.generatedAt}
Risk score: ${report.summary?.riskScore ?? 0}/100
Confidence: ${((report.confidence || 0) * 100).toFixed(0)}%

Summary:
- Findings: P0=${report.summary?.P0 ?? 0} P1=${report.summary?.P1 ?? 0} P2=${report.summary?.P2 ?? 0} P3=${report.summary?.P3 ?? 0}
- Blocking: ${report.summary?.blocking ? "yes" : "no"}
- Total findings: ${report.summary?.findingCount ?? 0}

Category breakdown:
${categories || "- none"}

Exploit scenarios:
${scenarios || "- none"}

Recommended actions:
${actions || "- none"}
`;
}

