import { frontendAnalyze } from "./frontend-analyze.js";

const SEVERITIES = new Set(["P0", "P1", "P2", "P3"]);

function toPosix(value) {
  return String(value || "").replace(/\\/g, "/");
}

function normalizeSeverity(value, fallback = "P2") {
  const normalized = String(value || "").trim().toUpperCase();
  return SEVERITIES.has(normalized) ? normalized : fallback;
}

function normalizeFiles(files) {
  if (!Array.isArray(files)) return [];
  return files.map((file) => toPosix(file).trim()).filter(Boolean);
}

function isInScope(file, scopeFiles) {
  const normalized = toPosix(file);
  if (!normalized || scopeFiles.length === 0) return true;
  return scopeFiles.some((candidate) =>
    candidate === normalized ||
    candidate.endsWith(`/${normalized}`) ||
    normalized.endsWith(`/${candidate}`)
  );
}

function createFinding({
  kind,
  severity,
  file = "",
  line = 0,
  evidence = "",
  rootCause = "",
  recommendedFix = "",
  confidence = 0.7,
} = {}) {
  return {
    persona: "frontend",
    tool: "frontend-analyze",
    kind: String(kind || "frontend.finding"),
    severity: normalizeSeverity(severity),
    file: toPosix(file),
    line: Number.isFinite(Number(line)) ? Math.max(0, Math.floor(Number(line))) : 0,
    evidence: String(evidence || "").trim().slice(0, 400),
    rootCause: String(rootCause || "").trim(),
    recommendedFix: String(recommendedFix || "").trim(),
    confidence: Math.max(0, Math.min(1, Number(confidence) || 0)),
  };
}

function dedupeFindings(findings) {
  const seen = new Set();
  const deduped = [];
  for (const finding of findings) {
    const key = [
      finding.kind,
      finding.file,
      finding.line,
      finding.evidence,
    ].join("|");
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(finding);
  }
  return deduped;
}

function analyze(operation, rootPath) {
  try {
    return frontendAnalyze({ operation, path: rootPath });
  } catch {
    return null;
  }
}

/**
 * Deterministic Investor-DD adapter for Jules/frontend.
 *
 * `frontendAnalyze` is intentionally repo-scoped, so the Investor-DD runner
 * invokes this as a single `scope: "repo"` tool per frontend persona run.
 */
export async function runFrontendInvestorDdAnalyze({ rootPath, files = [] } = {}) {
  const scopeFiles = normalizeFiles(files);
  const findings = [];

  const securitySinks = analyze("find_security_sinks", rootPath);
  for (const sink of securitySinks?.sinks || []) {
    if (!isInScope(sink.file, scopeFiles)) continue;
    findings.push(createFinding({
      kind: `frontend.security.${String(sink.type || "sink").replace(/\W+/g, "_")}`,
      severity: sink.severity || "P2",
      file: sink.file,
      line: sink.line || 0,
      evidence: `${sink.type || "frontend security sink"} detected`,
      rootCause: "Frontend markup or script execution sink can create XSS or client-side code execution risk.",
      recommendedFix: "Remove the sink or sanitize/escape untrusted content with a reviewed allowlist sanitizer.",
      confidence: sink.severity === "P0" ? 0.85 : 0.75,
    }));
  }

  const envExposure = analyze("find_env_exposure", rootPath);
  for (const exposure of envExposure?.findings || []) {
    if (!isInScope(exposure.file, scopeFiles)) continue;
    findings.push(createFinding({
      kind: "frontend.env_exposure",
      severity: exposure.severity || (exposure.sensitive ? "P1" : "P3"),
      file: exposure.file,
      line: exposure.line || 0,
      evidence: `${exposure.variable || "public env variable"} referenced in frontend source`,
      rootCause: "Public frontend environment prefixes are shipped to the browser; sensitive names can leak credentials or encourage unsafe configuration.",
      recommendedFix: "Keep secrets server-side and expose only explicitly public, non-sensitive configuration to client bundles.",
      confidence: exposure.sensitive ? 0.8 : 0.45,
    }));
  }

  const missingCleanup = analyze("find_missing_cleanup", rootPath);
  for (const cleanup of missingCleanup?.findings || []) {
    if (!isInScope(cleanup.file, scopeFiles)) continue;
    findings.push(createFinding({
      kind: "frontend.effect_missing_cleanup",
      severity: cleanup.severity || "P2",
      file: cleanup.file,
      evidence: cleanup.pattern || "Effect with timer/subscription has no cleanup return",
      rootCause: "Effects that subscribe or schedule timers without cleanup leak work across remounts and route changes.",
      recommendedFix: "Return a cleanup function that unsubscribes, removes listeners, or clears timers.",
      confidence: 0.7,
    }));
  }

  const staleClosures = analyze("find_stale_closures", rootPath);
  for (const closure of staleClosures?.findings || []) {
    if (!isInScope(closure.file, scopeFiles)) continue;
    findings.push(createFinding({
      kind: "frontend.stale_closure",
      severity: closure.severity || "P2",
      file: closure.file,
      line: closure.line || 0,
      evidence: closure.pattern || "useEffect with empty dependency array may capture stale values",
      rootCause: "Effects with empty dependencies can retain initial state/props while the UI continues to change.",
      recommendedFix: "Declare dependencies, use stable refs intentionally, or move logic out of the effect.",
      confidence: 0.55,
    }));
  }

  const stateHooks = analyze("count_state_hooks", rootPath);
  for (const component of stateHooks?.refactorCandidates || []) {
    if (!isInScope(component.file, scopeFiles)) continue;
    findings.push(createFinding({
      kind: "frontend.state_god_component",
      severity: component.risk === "god_component" ? "P2" : "P3",
      file: component.file,
      evidence: `${component.useStateCount} useState calls (${component.risk})`,
      rootCause: "High local state count usually indicates a component with too many responsibilities and fragile render behavior.",
      recommendedFix: "Split the component or consolidate related state transitions with a reducer/domain hook.",
      confidence: component.risk === "god_component" ? 0.7 : 0.45,
    }));
  }

  const accessibility = analyze("check_accessibility", rootPath);
  for (const check of accessibility?.findings || []) {
    const severity = normalizeSeverity(check.severity, "P3");
    if (String(check.severity || "").toLowerCase() === "pass") continue;
    if (Number(check.matchCount || 0) <= 0 && !String(check.check || "").includes("skip navigation")) continue;
    findings.push(createFinding({
      kind: "frontend.accessibility_check",
      severity,
      evidence: `${check.check || "accessibility heuristic"}; matches=${check.matchCount || 0}`,
      rootCause: "Accessibility regressions block keyboard and assistive-technology users from completing core flows.",
      recommendedFix: "Verify semantic labels, keyboard reachability, focus order, skip navigation, and automated axe coverage.",
      confidence: 0.45,
    }));
  }

  const mobile = analyze("check_mobile_responsive", rootPath);
  for (const check of mobile?.findings || []) {
    const rawSeverity = String(check.severity || "");
    if (rawSeverity === "pass" || rawSeverity === "info") continue;
    findings.push(createFinding({
      kind: "frontend.mobile_responsive",
      severity: check.severity || "P2",
      evidence: `${check.check || "responsive heuristic"}; present=${check.present}; count=${check.count || 0}`,
      rootCause: "Missing viewport or responsive styling evidence can make primary flows fail on mobile.",
      recommendedFix: "Add viewport metadata and validate mobile/tablet breakpoints for the core user journey.",
      confidence: 0.55,
    }));
  }

  const errorBoundaries = analyze("check_error_boundaries", rootPath);
  if (errorBoundaries && errorBoundaries.severity !== "pass") {
    findings.push(createFinding({
      kind: "frontend.error_boundary_gap",
      severity: errorBoundaries.severity || "P2",
      evidence: `errorBoundaryFiles=${errorBoundaries.errorBoundaryFiles || 0}; routeCount=${errorBoundaries.routeCount || 0}; coverage=${errorBoundaries.coverage || "n/a"}`,
      rootCause: "Route-level runtime exceptions can blank the UI without a recoverable boundary.",
      recommendedFix: "Add framework-native error boundaries for routed surfaces and test the failure state.",
      confidence: 0.65,
    }));
  }

  const images = analyze("check_image_optimization", rootPath);
  if (images && images.severity !== "pass") {
    findings.push(createFinding({
      kind: "frontend.image_optimization",
      severity: images.severity || "P2",
      evidence: `rawImgTags=${images.rawImgTags || 0}; nextImageUsage=${images.nextImageUsage || 0}; missingDimensions=${images.missingDimensions || 0}`,
      rootCause: "Unoptimized or dimensionless images can hurt LCP and cause layout shifts.",
      recommendedFix: "Use framework image components or explicit dimensions/lazy loading for non-critical images.",
      confidence: 0.55,
    }));
  } else if (images && Number(images.missingDimensions || 0) > 0) {
    findings.push(createFinding({
      kind: "frontend.image_dimensions_missing",
      severity: "P2",
      evidence: `missingDimensions=${images.missingDimensions}`,
      rootCause: "Images without stable dimensions can cause cumulative layout shift.",
      recommendedFix: "Set width/height or reserve aspect-ratio boxes for rendered images.",
      confidence: 0.65,
    }));
  }

  const fonts = analyze("check_font_loading", rootPath);
  if (fonts && fonts.severity !== "pass") {
    findings.push(createFinding({
      kind: "frontend.font_loading",
      severity: fonts.severity || "P2",
      evidence: `fontDisplayUsage=${fonts.fontDisplayUsage || 0}; googleFontsUsage=${fonts.googleFontsUsage || 0}`,
      rootCause: "Remote fonts without font-display controls can block text rendering or shift layout.",
      recommendedFix: "Use font-display swap/optional, preload critical fonts, or self-host critical font assets.",
      confidence: 0.55,
    }));
  }

  const css = analyze("check_css_health", rootPath);
  if (css && css.severity !== "pass") {
    findings.push(createFinding({
      kind: "frontend.css_health",
      severity: css.severity || "P2",
      evidence: `importantCount=${css.importantCount || 0}; tailwindConfigured=${Boolean(css.tailwindConfigured)}`,
      rootCause: "Large numbers of !important declarations make UI state and responsive overrides brittle.",
      recommendedFix: "Refactor repeated overrides into component variants or ordered utility/style layers.",
      confidence: 0.45,
    }));
  }

  const testCoverage = analyze("find_test_coverage", rootPath);
  if (testCoverage && Number(testCoverage.componentCount || 0) > 0 && Number(testCoverage.untestedCount || 0) > 0) {
    findings.push(createFinding({
      kind: "frontend.test_coverage_gap",
      severity: Number(testCoverage.testCount || 0) === 0 ? "P2" : "P3",
      evidence: `components=${testCoverage.componentCount}; tests=${testCoverage.testCount}; untested=${testCoverage.untestedCount}; ratio=${testCoverage.coverageRatio || "n/a"}`,
      rootCause: "Interactive components without nearby tests are likely to regress without being caught pre-merge.",
      recommendedFix: "Add component/unit tests for primary states and at least one integration smoke for the core route.",
      confidence: 0.55,
    }));
  }

  return dedupeFindings(findings);
}

export const FRONTEND_TOOLS = Object.freeze({
  "frontend-analyze": {
    id: "frontend-analyze",
    scope: "repo",
    description:
      "Run Jules Tanaka's deterministic frontend analyzer once for the routed frontend surface and convert UI/UX, accessibility, runtime, and web-vital heuristics into Investor-DD findings.",
    schema: {
      type: "object",
      properties: {
        rootPath: { type: "string" },
        files: { type: "array", items: { type: "string" } },
      },
    },
    handler: runFrontendInvestorDdAnalyze,
  },
});

export const FRONTEND_TOOL_IDS = Object.freeze(Object.keys(FRONTEND_TOOLS));
