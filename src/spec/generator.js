import path from "node:path";

import { getCoordinationEtiquetteItems } from "../session/coordination-guidance.js";
import { getDefaultTemplate, getTemplateById } from "./templates.js";

const VALID_PROJECT_TYPES = new Set(["greenfield", "add_feature", "bugfix"]);

const PROJECT_TYPE_LABELS = Object.freeze({
  greenfield: "Greenfield",
  add_feature: "Add feature",
  bugfix: "Bugfix",
});

function normalizeList(values, fallback = []) {
  if (!Array.isArray(values)) {
    return fallback;
  }
  const normalized = values
    .map((value) => String(value || "").trim())
    .filter(Boolean);
  return normalized.length > 0 ? normalized : fallback;
}

export function resolveSpecTemplate(templateId) {
  if (!templateId) {
    return getDefaultTemplate();
  }
  const template = getTemplateById(templateId);
  if (!template) {
    throw new Error(`Unknown spec template '${templateId}'. Use 'spec list-templates' to view valid ids.`);
  }
  return template;
}

export function inferProjectName({ projectPath, ingest }) {
  const fromPackage = String(ingest?.packageMetadata?.name || "").trim();
  if (fromPackage) {
    return fromPackage;
  }
  return path.basename(path.resolve(projectPath || ingest?.rootPath || process.cwd()));
}

function renderSectionList(items) {
  return items.map((item, index) => `${index + 1}. ${item}`).join("\n");
}

function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

function normalizeProjectType(value) {
  const normalized = String(value || "")
    .trim()
    .toLowerCase();
  return VALID_PROJECT_TYPES.has(normalized) ? normalized : "";
}

function inferProjectTypeFromDescription(description) {
  const normalized = String(description || "")
    .trim()
    .toLowerCase();
  if (!normalized) {
    return "";
  }

  if (/\b(bug|fix|hotfix|regression|incident|vulnerability|patch)\b/.test(normalized)) {
    return "bugfix";
  }
  if (/\b(add|feature|extend|enhance|integrat|upgrade|existing|refactor)\b/.test(normalized)) {
    return "add_feature";
  }
  return "";
}

export function inferProjectTypeFromIngest(ingest = {}) {
  const filesScanned = Number(ingest?.summary?.filesScanned || 0);
  const hasEntryPoints = Array.isArray(ingest?.entryPoints) && ingest.entryPoints.length > 0;
  const hasFrameworks = Array.isArray(ingest?.frameworks) && ingest.frameworks.length > 0;
  const hasManifests = Array.isArray(ingest?.manifests?.detected) && ingest.manifests.detected.length > 0;
  const indexedFiles = Array.isArray(ingest?.indexedFiles?.files) ? ingest.indexedFiles.files.length : 0;

  if (filesScanned <= 1 && !hasEntryPoints && !hasFrameworks && !hasManifests) {
    return "greenfield";
  }
  if (filesScanned <= 12 && indexedFiles <= 12 && !hasEntryPoints && !hasFrameworks && !hasManifests) {
    return "greenfield";
  }
  return "add_feature";
}

export function resolveProjectType({ projectType, ingest, description } = {}) {
  const explicit = normalizeProjectType(projectType);
  if (explicit) {
    return explicit;
  }

  const fromDescription = inferProjectTypeFromDescription(description);
  if (fromDescription) {
    return fromDescription;
  }
  return inferProjectTypeFromIngest(ingest);
}

export function inferProjectTypeFromSpecMarkdown(markdown) {
  const source = String(markdown || "");
  const directMatch =
    source.match(/- Project type:\s*`?(greenfield|add_feature|bugfix)`?/i) ||
    source.match(/^Project type:\s*`?(greenfield|add_feature|bugfix)`?/im);
  if (!directMatch) {
    return "";
  }
  return normalizeProjectType(directMatch[1]);
}

function deriveTechStackLine(ingest) {
  const languageSummary = Array.isArray(ingest?.languages)
    ? ingest.languages
        .slice(0, 6)
        .map((item) => `${item.language} (${item.loc} LOC)`)
        .join(", ")
    : "none";

  const frameworkSummary = Array.isArray(ingest?.frameworks) && ingest.frameworks.length
    ? ingest.frameworks.join(", ")
    : "none";

  return {
    languages: languageSummary,
    frameworks: frameworkSummary,
  };
}

function toTitleCaseFromSnake(value) {
  return String(value || "")
    .split("_")
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function estimatePhaseEffort({ projectType, taskCount, riskSurfaceCount, phaseIndex }) {
  const phaseWeight = phaseIndex + 1;
  const projectTypeBoost = projectType === "bugfix" ? 1 : 0;
  const baseline = 4 + taskCount * 2 + Math.min(riskSurfaceCount, 5) + phaseWeight + projectTypeBoost;
  const minHours = Math.max(4, baseline - 2);
  const maxHours = baseline + 2;
  return `${minHours}-${maxHours} hours`;
}

function derivePhaseAcceptanceCriteria(items, phaseTitle) {
  const base = items.slice(0, 3).map((item) => {
    const normalized = String(item || "").trim().replace(/\.$/, "");
    return `Verified ${normalized.toLowerCase()}.`;
  });
  if (base.length > 0) {
    return base;
  }
  return [`Verified outcomes for ${phaseTitle}.`];
}

function buildPhase({
  phaseNumber,
  titleSuffix,
  items,
  projectType,
  riskSurfaceCount,
  previousPhaseTitle = "",
}) {
  const title = `Phase ${phaseNumber} - ${titleSuffix}`;
  return {
    title,
    items,
    dependencies: previousPhaseTitle ? [previousPhaseTitle] : [],
    effort: estimatePhaseEffort({
      projectType,
      taskCount: items.length,
      riskSurfaceCount,
      phaseIndex: phaseNumber - 1,
    }),
    acceptanceCriteria: derivePhaseAcceptanceCriteria(items, title),
  };
}

function deriveBasePhases({ template, projectType, topRiskSurfaces }) {
  const templateName = String(template?.name || "template").toLowerCase();
  const topSurface = topRiskSurfaces[0] || "critical risk surfaces";

  if (projectType === "bugfix") {
    return [
      {
        titleSuffix: "Root Cause Analysis",
        items: [
          "Reproduce the defect with deterministic steps and collect impacted traces.",
          "Pinpoint fault boundaries and confirm why existing controls missed detection.",
          `Document ${topSurface} impact and blast radius before any code changes.`,
        ],
      },
      {
        titleSuffix: "Fix Implementation",
        items: [
          "Implement the smallest safe code change that resolves the confirmed root cause.",
          "Add guardrails and failure-mode handling for adjacent paths touched by the fix.",
          "Validate data/schema/backward compatibility impacts before rollout.",
        ],
      },
      {
        titleSuffix: "Regression Prevention",
        items: [
          "Add deterministic regression tests for the exact failure path and close variants.",
          "Update runbooks, alerts, and release checks to prevent recurrence.",
          "Capture post-fix verification evidence and rollback triggers.",
        ],
      },
    ];
  }

  if (projectType === "add_feature") {
    return [
      {
        titleSuffix: "Impact Analysis",
        items: [
          "Map existing module boundaries, API contracts, and state transitions touched by the feature.",
          `Define compatibility constraints with current ${templateName} behavior and deployment flow.`,
          `Prioritize risk surfaces for the feature path: ${topRiskSurfaces.slice(0, 3).join(", ") || "code_quality"}.`,
        ],
      },
      {
        titleSuffix: "Implementation",
        items: [
          "Implement feature logic end-to-end with explicit interface contracts.",
          "Add telemetry and structured error handling for newly introduced branches.",
          "Keep migrations/config changes deterministic and reversible.",
        ],
      },
      {
        titleSuffix: "Integration Testing",
        items: [
          "Run integration coverage across touched endpoints, data flows, and job boundaries.",
          "Validate backward compatibility and release safety with deterministic gates.",
          "Document rollout, rollback, and operational acceptance checks.",
        ],
      },
    ];
  }

  return [
    {
      titleSuffix: "Foundation",
      items: [
        "Define architecture boundaries and interfaces.",
        `Establish ${templateName} baseline scaffolding and dev workflow.`,
        "Add deterministic CI checks before feature expansion.",
      ],
    },
    {
      titleSuffix: "Core Delivery",
      items: [
        "Implement highest-value user flow end-to-end.",
        "Add telemetry and error handling for critical paths.",
        "Document rollout and rollback paths for the first release slice.",
      ],
    },
    {
      titleSuffix: "Integration & Hardening",
      items: [
        `Address prioritized risk surfaces: ${topRiskSurfaces.slice(0, 4).join(", ") || "code_quality"}.`,
        "Expand automated test coverage for critical paths and integration seams.",
        "Finalize deployment guardrails and incident rollback readiness.",
      ],
    },
  ];
}

function deriveDynamicPhaseCount({ template, ingest, description, riskSurfaces }) {
  const wordCount = String(description || "")
    .trim()
    .split(/\s+/)
    .filter(Boolean).length;
  const filesScanned = Number(ingest?.summary?.filesScanned || 0);
  const totalLoc = Number(ingest?.summary?.totalLoc || 0);
  const riskCount = Array.isArray(riskSurfaces) ? riskSurfaces.length : 0;

  const riskBoost = riskCount >= 12 ? 4 : riskCount >= 8 ? 2 : riskCount >= 4 ? 1 : 0;
  const complexityBoost =
    (wordCount >= 200 ? 2 : wordCount >= 70 ? 1 : 0) +
    (filesScanned >= 1000 ? 2 : filesScanned >= 250 ? 1 : 0) +
    (totalLoc >= 50_000 ? 2 : totalLoc >= 10_000 ? 1 : 0);
  const templateBoost = ["saas-app", "mobile-app"].includes(String(template?.id || "")) ? 1 : 0;

  // No upper cap — enterprise projects can have 10-20+ phases based on complexity.
  // Floor at 3 (minimum viable: foundation + core + hardening).
  return Math.max(3, 3 + riskBoost + complexityBoost + templateBoost);
}

function buildSupplementalPhaseItems({ projectType, surfaces }) {
  const normalizedSurfaces = surfaces.map((item) => toTitleCaseFromSnake(item));
  const headline = normalizedSurfaces.join(" + ") || "Targeted hardening";

  if (projectType === "bugfix") {
    return [
      `Harden ${headline} controls with additional negative-path tests.`,
      "Validate observability and alert coverage for recurrence signals.",
      "Confirm mitigation evidence and operator runbook updates.",
    ];
  }

  if (projectType === "add_feature") {
    return [
      `Complete feature readiness for ${headline} boundaries.`,
      "Run cross-module integration checks and update interface contracts.",
      "Validate deployment sequencing and fallback controls for this slice.",
    ];
  }

  return [
    `Deliver additional capability for ${headline} surfaces.`,
    "Expand reliability and security controls for the new scope.",
    "Confirm deterministic acceptance checks and release readiness.",
  ];
}

function derivePhasePlan(template, ingest, { projectType, description }) {
  const riskSurfaces = Array.isArray(ingest?.riskSurfaces) ? ingest.riskSurfaces : [];
  const topRiskSurfaces = riskSurfaces.slice(0, 8).map((item) => item.surface);
  const baseBlueprint = deriveBasePhases({ template, projectType, topRiskSurfaces });
  const desiredPhaseCount = deriveDynamicPhaseCount({
    template,
    ingest,
    description,
    riskSurfaces: topRiskSurfaces,
  });
  const additionalPhaseCount = Math.max(0, desiredPhaseCount - baseBlueprint.length);

  const phases = [];
  for (let index = 0; index < baseBlueprint.length; index += 1) {
    const phase = baseBlueprint[index];
    phases.push(
      buildPhase({
        phaseNumber: index + 1,
        titleSuffix: phase.titleSuffix,
        items: phase.items,
        projectType,
        riskSurfaceCount: topRiskSurfaces.length,
        previousPhaseTitle: phases[index - 1]?.title || "",
      })
    );
  }

  for (let index = 0; index < additionalPhaseCount; index += 1) {
    const start = index * 2;
    const groupedSurfaces = topRiskSurfaces.slice(start, start + 2);
    const fallbackSurface =
      groupedSurfaces.length > 0 ? groupedSurfaces[0] : topRiskSurfaces[index] || "code_quality";
    const titleSuffix = `${toTitleCaseFromSnake(fallbackSurface)} Optimization`;
    const items = buildSupplementalPhaseItems({
      projectType,
      surfaces: groupedSurfaces.length > 0 ? groupedSurfaces : [fallbackSurface],
    });

    phases.push(
      buildPhase({
        phaseNumber: phases.length + 1,
        titleSuffix,
        items,
        projectType,
        riskSurfaceCount: topRiskSurfaces.length,
        previousPhaseTitle: phases[phases.length - 1]?.title || "",
      })
    );
  }

  // AIdenID awareness: if auth/login patterns detected, append E2E testing phase
  if (shouldSuggestAidenId(ingest, description)) {
    phases.push(
      buildPhase({
        phaseNumber: phases.length + 1,
        titleSuffix: "AIdenID E2E Verification",
        items: [
          "Confirm AIdenID credentials via `sl auth status` (auto-provisioned at login), then provision ephemeral test identity via `sl ai provision-email --execute`.",
          "Run automated signup flow with provisioned email and verify account creation.",
          "Extract OTP from inbound email via AIdenID extraction pipeline (`sl ai identity wait-for-otp`).",
          "Complete login flow with extracted OTP and verify authenticated session.",
          "Audit authenticated pages for cookie security (httpOnly, Secure, SameSite) via `sl audit frontend --url`.",
          "Revoke test identity after verification (`sl ai identity revoke`).",
        ],
        projectType,
        riskSurfaceCount: topRiskSurfaces.length,
        previousPhaseTitle: phases[phases.length - 1]?.title || "",
      })
    );
  }

  return phases;
}

/**
 * Detect if the project warrants AIdenID E2E testing suggestions.
 * Returns true if auth/login/signup patterns are found in the ingest or description.
 */
function shouldSuggestAidenId(ingest, description) {
  const descLower = String(description || "").toLowerCase();
  const authKeywords = ["login", "signup", "sign up", "register", "authentication", "auth flow", "otp", "verification", "password reset", "invite", "onboarding"];
  const descHasAuth = authKeywords.some((kw) => descLower.includes(kw));

  // Check if ingest detected auth-related risk surfaces or frameworks
  const surfaces = (ingest?.riskSurfaces || []).map((s) => String(s.surface || "").toLowerCase());
  const surfaceHasAuth = surfaces.includes("security_overlay") || surfaces.includes("frontend_runtime");

  // Check if package.json has auth-related dependencies
  const scripts = Object.keys(ingest?.packageMetadata?.scripts || {});
  const depsHint = scripts.some((s) => /auth|login|session/i.test(s));

  return descHasAuth || (surfaceHasAuth && descLower.length > 50) || depsHint;
}

function deriveGlobalAcceptanceCriteria(projectType) {
  if (projectType === "bugfix") {
    return [
      "Root cause and blast radius are documented with deterministic evidence.",
      "Fix path and adjacent risks are covered by automated regression checks.",
      "Operational guardrails (alerts/runbooks/rollback) are updated and verified.",
      "Release safety checks pass with zero blocking findings.",
    ];
  }

  if (projectType === "add_feature") {
    return [
      "Feature behavior is validated end-to-end and does not regress existing flows.",
      "Compatibility, migration, and rollout safety checks are documented and tested.",
      "Security/reliability controls cover all new or changed critical paths.",
      "CI gates remain deterministic with reproducible artifacts.",
    ];
  }

  return [
    "Primary user flow is implemented and validated by automated checks.",
    "CI gates are deterministic and reproducible.",
    "Security and reliability controls for critical surfaces are documented and tested.",
    "Deployment/rollback guidance is included for the delivered scope.",
  ];
}

function countAgentInstructions(agentsMarkdown) {
  const markdown = String(agentsMarkdown || "");
  if (!markdown) {
    return 0;
  }

  const lines = markdown.split(/\r?\n/);
  let inAgentsSection = false;
  let sectionCount = 0;
  let globalCount = 0;
  for (const rawLine of lines) {
    const line = String(rawLine || "");
    const trimmed = line.trim();
    if (!trimmed) {
      continue;
    }

    if (/^#{1,6}\s+.*\bagents?\b/i.test(trimmed)) {
      inAgentsSection = true;
      continue;
    }
    if (inAgentsSection && /^#{1,6}\s+/.test(trimmed)) {
      inAgentsSection = false;
    }

    if (!/^\s*[-*]\s+/.test(line)) {
      continue;
    }

    if (/\b(agent|coder|reviewer|tester|observer|persona|daemon)\b/i.test(trimmed)) {
      globalCount += 1;
      if (inAgentsSection) {
        sectionCount += 1;
      }
    }
  }

  if (sectionCount >= 2) {
    return sectionCount;
  }
  return globalCount;
}

function hasCollaborationSignals(description) {
  const normalized = String(description || "").toLowerCase();
  if (!normalized) {
    return false;
  }
  return /\b(team|pair|paired|multi-agent|multi agent|swarm|collaborat)\b/.test(normalized);
}

function shouldIncludeCoordinationPhase({
  description = "",
  agentsMarkdown = "",
  sessionActive = false,
  sessionToolsAvailable = true,
} = {}) {
  if (sessionToolsAvailable === true) {
    return true;
  }
  if (sessionActive === true) {
    return true;
  }
  if (hasCollaborationSignals(description)) {
    return true;
  }
  return countAgentInstructions(agentsMarkdown) >= 2;
}

function buildCoordinationPhase(phaseNumber, previousPhaseTitle = "") {
  return {
    title: `Phase ${phaseNumber}: Multi-Agent Coordination Protocol`,
    items: getCoordinationEtiquetteItems(),
    dependencies: previousPhaseTitle ? [previousPhaseTitle] : [],
    effort: "4-8 hours",
    acceptanceCriteria: [
      "Session participation path is explicit for all collaborating agents.",
      "Unexpected file-change handling favors in-session coordination over stop-and-wait behavior.",
      "Status and finding updates are emitted with actionable file-level context.",
    ],
  };
}

export function generateSpecMarkdown({
  template,
  description,
  ingest,
  projectPath,
  projectType,
  agentsMarkdown = "",
  sessionActive = false,
  sessionToolsAvailable = true,
  generatedAt = new Date().toISOString(),
} = {}) {
  const resolvedTemplate = template || getDefaultTemplate();
  const projectName = inferProjectName({ projectPath, ingest });
  const goal = String(description || "").trim() || `Build and harden ${projectName}.`;
  const resolvedProjectType = resolveProjectType({
    projectType,
    ingest,
    description,
  });

  const techStack = deriveTechStackLine(ingest);
  const entryPoints = normalizeList(ingest?.entryPoints, ["none detected"]);
  const riskSurfaces = normalizeList(
    Array.isArray(ingest?.riskSurfaces) ? ingest.riskSurfaces.map((item) => item.surface) : [],
    ["code_quality"]
  );
  const architectureFocus = normalizeList(resolvedTemplate.architectureFocus, ["Define module boundaries."]);
  const securityChecklist = normalizeList(resolvedTemplate.securityChecklist, ["Apply secure defaults."]);
  const globalAcceptanceCriteria = deriveGlobalAcceptanceCriteria(resolvedProjectType);

  const phases = derivePhasePlan(resolvedTemplate, ingest, {
    projectType: resolvedProjectType,
    description,
  });

  if (
    shouldIncludeCoordinationPhase({
      description,
      agentsMarkdown,
      sessionActive,
      sessionToolsAvailable,
    })
  ) {
    phases.push(buildCoordinationPhase(phases.length + 1, phases[phases.length - 1]?.title || ""));
  }

  const phaseMarkdown = phases
    .map(
      (phase) =>
        [
          `### ${phase.title}`,
          `- Estimated effort: ${phase.effort}`,
          `- Dependencies: ${
            phase.dependencies.length > 0 ? phase.dependencies.join(", ") : "none (entry phase)"
          }`,
          `- Acceptance criteria: ${phase.acceptanceCriteria.join(" | ")}`,
          phase.items.map((item, index) => `${index + 1}. ${item}`).join("\n"),
        ].join("\n")
    )
    .join("\n\n");

  return `# SPEC - ${projectName}

Generated: ${generatedAt}
Template: ${resolvedTemplate.id}
Workspace: ${ingest?.rootPath || path.resolve(projectPath || process.cwd())}

## Goal
${goal}

## Ingest Snapshot
- Files scanned: ${ingest?.summary?.filesScanned || 0}
- Total LOC: ${ingest?.summary?.totalLoc || 0}
- Languages: ${techStack.languages}
- Frameworks: ${techStack.frameworks}
- Entry points: ${entryPoints.join(", ")}
- Risk surfaces: ${riskSurfaces.join(", ")}
- Project type: \`${resolvedProjectType}\` (${PROJECT_TYPE_LABELS[resolvedProjectType] || "Greenfield"})

## Architecture Focus
${renderSectionList(architectureFocus)}

## Security Checklist
${renderSectionList(securityChecklist)}

## Acceptance Criteria
${renderSectionList(globalAcceptanceCriteria)}

## Phase Plan
${phaseMarkdown}
`;
}
