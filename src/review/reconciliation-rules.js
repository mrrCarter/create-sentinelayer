/**
 * Reconciliation ruleset (#investor-dd-29).
 *
 * Cross-references source-level findings emitted by the persona runner
 * with live-web observations captured by the live-validator (devTestBot
 * via AIdenID). Each rule matches a (finding-pattern, live-observation-
 * pattern) pair and assigns a verdict.
 *
 * Verdicts:
 *   CONFIRMED       — source claim validated by live behavior (or code
 *                     claim paired with consistent live observation).
 *   FALSE_POSITIVE  — source flagged an issue, live behavior proves it
 *                     is not actually broken in production.
 *   CONTRADICTORY   — source claim and live observation actively
 *                     disagree (rare; warrants human review).
 *   UNVERIFIABLE    — no live observation covered this finding, or no
 *                     rule matched the pair; reported as-is.
 *
 * Each rule is a pure function pair:
 *   matchFinding(finding)       → bool    (source side)
 *   matchObservation(observation, finding) → bool  (live side, may use
 *                                 the finding context to match to a
 *                                 specific interaction)
 *
 * Rules are intentionally declarative and small: the ruleset grows as
 * new finding classes appear. The engine (PR-28) walks rules in order
 * and picks the first verdict.
 */

/**
 * @typedef {object} Finding
 * @property {string} [kind]       - e.g., "sast.eval", "authz.missing-guard".
 * @property {string} [severity]
 * @property {string} [file]
 * @property {number} [line]
 * @property {string} [personaId]
 * @property {string} [evidence]
 * @property {string} [recommendedFix]
 */

/**
 * @typedef {object} LiveObservation
 * @property {string} interactionId        - UUID for the clicked button/form/nav.
 * @property {string} [elementLabel]
 * @property {string} [sourceFile]         - File that declared the element (if static extract worked).
 * @property {number} [statusCodeObserved]
 * @property {string[]} [consoleErrors]
 * @property {Array<object>} [networkErrors]
 * @property {boolean} [navigated]
 * @property {string} [observedBehavior]   - Free-form summary from the recorder.
 * @property {object} [payload]            - Request/response summary when relevant.
 */

/**
 * @typedef {object} ReconciliationVerdict
 * @property {"CONFIRMED" | "FALSE_POSITIVE" | "CONTRADICTORY" | "UNVERIFIABLE"} verdict
 * @property {string} ruleId
 * @property {number} confidence           - 0.0-1.0
 * @property {string} [reason]
 */

const RULES = Object.freeze([
  // CONTRADICTORY rules MUST come before CONFIRMED/FALSE_POSITIVE rules
  // for the same finding kind — they capture the ambiguity that the
  // simpler rules would otherwise collapse in the wrong direction.
  {
    id: "R11",
    description:
      "Source says broken, live shows 2xx, but observed text claims failure — human review",
    matchFinding: (f) =>
      f.kind === "frontend.broken-handler" ||
      /broken (click|button|onclick|handler)/i.test(String(f.evidence || "")),
    matchObservation: (obs) =>
      obs &&
      (obs.statusCodeObserved || 0) >= 200 &&
      (obs.statusCodeObserved || 0) < 400 &&
      /(error|failed|denied)/i.test(String(obs.observedBehavior || "")),
    verdict: "CONTRADICTORY",
    confidence: 0.7,
    reason: "Live 2xx response but observed text suggests failure — human review",
  },

  {
    id: "R01",
    description:
      "UI click finding marked as broken in source, live click succeeded + no console error + expected network call ≥ 200",
    matchFinding: (f) =>
      f.kind === "frontend.broken-handler" ||
      /broken (click|button|onclick|handler)/i.test(String(f.evidence || "")),
    matchObservation: (obs) =>
      obs &&
      (obs.statusCodeObserved || 0) >= 200 &&
      (obs.statusCodeObserved || 0) < 400 &&
      (obs.consoleErrors || []).length === 0,
    verdict: "FALSE_POSITIVE",
    confidence: 0.9,
    reason: "Live interaction succeeded with no console error",
  },

  {
    id: "R02",
    description:
      "UI click finding and live click actually threw a console error matching the claimed stack",
    matchFinding: (f) =>
      f.kind === "frontend.broken-handler" ||
      /broken (click|button|onclick|handler)/i.test(String(f.evidence || "")),
    matchObservation: (obs, finding) => {
      if (!obs || !(obs.consoleErrors || []).length) return false;
      const evidence = String(finding?.evidence || "").toLowerCase();
      if (!evidence) return false;
      // Bidirectional substring: either finding evidence contains the
      // live console msg, or the live msg contains a chunk of the
      // evidence. Either direction proves the live failure matches the
      // static claim.
      return (obs.consoleErrors || []).some((e) => {
        const msg = String(e.msg || e).toLowerCase();
        if (!msg) return false;
        if (evidence.includes(msg)) return true;
        if (msg.includes(evidence.slice(0, 40))) return true;
        // Token overlap fallback: if 3+ contiguous tokens appear in both
        // strings, call it a match.
        const evidenceTokens = evidence.split(/\s+/).filter((t) => t.length >= 4);
        for (let i = 0; i + 3 <= evidenceTokens.length; i += 1) {
          const window = evidenceTokens.slice(i, i + 3).join(" ");
          if (msg.includes(window)) return true;
        }
        return false;
      });
    },
    verdict: "CONFIRMED",
    confidence: 0.85,
    reason: "Live console error matches source evidence",
  },

  {
    id: "R03",
    description: "Source flagged auth bypass; live unauth request returned 200 with sensitive data",
    matchFinding: (f) =>
      f.kind === "authz.missing-guard" ||
      /auth (bypass|missing)/i.test(String(f.evidence || "")),
    matchObservation: (obs) =>
      obs &&
      obs.statusCodeObserved === 200 &&
      /token|secret|user\s*id|email|ssn|credit/i.test(String(obs.observedBehavior || "")),
    verdict: "CONFIRMED",
    confidence: 0.95,
    reason: "Unauthenticated 200 with sensitive data surfaced",
  },

  {
    id: "R04",
    description: "Source flagged auth bypass; live unauth request returned 401/403",
    matchFinding: (f) =>
      f.kind === "authz.missing-guard" ||
      /auth (bypass|missing)/i.test(String(f.evidence || "")),
    matchObservation: (obs) =>
      obs && (obs.statusCodeObserved === 401 || obs.statusCodeObserved === 403),
    verdict: "FALSE_POSITIVE",
    confidence: 0.9,
    reason: "Unauthenticated request was properly rejected",
  },

  {
    id: "R05",
    description: "Source flagged XSS vector; live payload injected and executed",
    matchFinding: (f) => /xss/i.test(String(f.kind || f.evidence || "")),
    matchObservation: (obs) =>
      obs &&
      (obs.observedBehavior || "").toLowerCase().includes("payload executed"),
    verdict: "CONFIRMED",
    confidence: 0.95,
    reason: "Live probe confirmed XSS payload executed",
  },

  {
    id: "R06",
    description: "Source flagged unbounded fetch; live request returned > 10MB or > 10k rows",
    matchFinding: (f) =>
      /unbounded[\s.-](fetch|query|list)/i.test(String(f.kind || f.evidence || "")),
    matchObservation: (obs) => {
      if (!obs || !obs.payload) return false;
      const bytes = obs.payload.bytes || 0;
      const rows = obs.payload.rows || 0;
      return bytes > 10 * 1024 * 1024 || rows > 10_000;
    },
    verdict: "CONFIRMED",
    confidence: 0.9,
    reason: "Payload size/row count exceeded thresholds",
  },

  {
    id: "R07",
    description: "Source flagged missing idempotency; double-submit created N > 1 rows",
    matchFinding: (f) =>
      /idempoten|double(-|\s)?submit/i.test(String(f.kind || f.evidence || "")),
    matchObservation: (obs) =>
      obs &&
      typeof obs.payload?.rowsCreatedOnDoubleSubmit === "number" &&
      obs.payload.rowsCreatedOnDoubleSubmit > 1,
    verdict: "CONFIRMED",
    confidence: 0.95,
    reason: "Double-submit resulted in multiple created rows",
  },

  {
    id: "R08",
    description: "Source flagged CORS too permissive; live response sent permissive Access-Control-Allow-Origin",
    matchFinding: (f) => /cors/i.test(String(f.kind || f.evidence || "")),
    matchObservation: (obs) => {
      const header = obs?.payload?.headers?.["access-control-allow-origin"];
      return header === "*" || header === "null";
    },
    verdict: "CONFIRMED",
    confidence: 0.9,
    reason: "CORS header permissive in live response",
  },

  {
    id: "R09",
    description:
      "Source flagged element not rendered; live DOM snapshot shows the element and it is interactive",
    matchFinding: (f) =>
      /not rendered|missing element/i.test(String(f.kind || f.evidence || "")),
    matchObservation: (obs) => obs && obs.elementLabel && !obs.navigated === false,
    verdict: "FALSE_POSITIVE",
    confidence: 0.8,
    reason: "Element present and interactive in live run",
  },

  {
    id: "R10",
    description:
      "Source flagged rate-limit bypass; live 10x-burst returned ≥ 1 non-429 success",
    matchFinding: (f) => /rate[\s-]?limit/i.test(String(f.kind || f.evidence || "")),
    matchObservation: (obs) => {
      const burst = obs?.payload?.burstResults || [];
      return burst.length >= 10 && burst.some((s) => s >= 200 && s < 400);
    },
    verdict: "CONFIRMED",
    confidence: 0.9,
    reason: "Rate-limit was bypassed under burst",
  },

]);

/**
 * Evaluate a single (finding, observation) pair against the ruleset.
 * Returns the first matching verdict, or UNVERIFIABLE if no rule fires.
 *
 * @param {Finding} finding
 * @param {LiveObservation | null} observation
 * @returns {ReconciliationVerdict}
 */
export function reconcileFindingWithObservation(finding, observation) {
  if (!finding) {
    return {
      verdict: "UNVERIFIABLE",
      ruleId: "R-PREFLIGHT",
      confidence: 0.0,
      reason: "No finding supplied",
    };
  }
  for (const rule of RULES) {
    try {
      if (!rule.matchFinding(finding)) continue;
      if (!rule.matchObservation(observation, finding)) continue;
      return {
        verdict: rule.verdict,
        ruleId: rule.id,
        confidence: rule.confidence,
        reason: rule.reason,
      };
    } catch {
      // defensive: if a rule throws, continue walking — a misconfigured
      // rule must never block the whole reconciliation pass.
      continue;
    }
  }
  return {
    verdict: "UNVERIFIABLE",
    ruleId: "R-NO-MATCH",
    confidence: 0.0,
    reason: observation
      ? "No ruleset match for this (finding, observation) pair"
      : "No live observation covered this finding",
  };
}

/**
 * Apply reconciliation to a batch of findings + observations. Observations
 * are keyed by `finding.file`+`finding.line`+`observation.sourceFile` via
 * the pair function; simplest form is to pair each finding with 0 or 1
 * observation from a lookup the caller provides.
 *
 * @param {Array<Finding>} findings
 * @param {(finding: Finding) => LiveObservation | null} pair
 * @returns {Array<Finding & { reconciliation: ReconciliationVerdict }>}
 */
export function reconcileFindings(findings, pair) {
  if (!Array.isArray(findings)) return [];
  const pairFn = typeof pair === "function" ? pair : () => null;
  return findings.map((f) => ({
    ...f,
    reconciliation: reconcileFindingWithObservation(f, pairFn(f)),
  }));
}

/**
 * Policy helper: decide whether a finding should ship in the final
 * report. FALSE_POSITIVE is suppressed unless the caller forces HITL
 * review; CONTRADICTORY ships with a banner; CONFIRMED and UNVERIFIABLE
 * ship as-is.
 *
 * @param {Finding & { reconciliation: ReconciliationVerdict }} finding
 * @param {object} [options]
 * @param {boolean} [options.keepFalsePositivesForHitl=false]
 * @returns {"include" | "include-with-banner" | "suppress"}
 */
export function applyReportPolicy(finding, { keepFalsePositivesForHitl = false } = {}) {
  const verdict = finding?.reconciliation?.verdict;
  if (verdict === "FALSE_POSITIVE") {
    return keepFalsePositivesForHitl ? "include-with-banner" : "suppress";
  }
  if (verdict === "CONTRADICTORY") return "include-with-banner";
  return "include";
}

export const RECONCILIATION_RULESET_VERSION = "1.0.0";
export const RECONCILIATION_RULES = RULES;
