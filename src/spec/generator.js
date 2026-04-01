import path from "node:path";

import { getDefaultTemplate, getTemplateById } from "./templates.js";

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

function derivePhasePlan(template, ingest) {
  const riskSurfaces = Array.isArray(ingest?.riskSurfaces) ? ingest.riskSurfaces : [];
  const topRiskSurfaces = riskSurfaces.slice(0, 6).map((item) => item.surface);
  const phase3Items = topRiskSurfaces.length > 0
    ? topRiskSurfaces.map((surface) => `Address ${surface} controls and tests.`)
    : ["Address prioritized risk surfaces and add regression tests."];

  return [
    {
      title: "Phase 1 - Foundation",
      items: [
        "Define architecture boundaries and interfaces.",
        `Establish ${template.name.toLowerCase()} baseline scaffolding and dev workflow.`,
        "Add deterministic CI checks before feature expansion.",
      ],
    },
    {
      title: "Phase 2 - Core Delivery",
      items: [
        "Implement highest-value user flow end-to-end.",
        "Add telemetry and error handling for critical paths.",
        "Document rollout and rollback paths for the first release slice.",
      ],
    },
    {
      title: "Phase 3 - Hardening",
      items: phase3Items,
    },
  ];
}

export function generateSpecMarkdown({
  template,
  description,
  ingest,
  projectPath,
  generatedAt = new Date().toISOString(),
} = {}) {
  const resolvedTemplate = template || getDefaultTemplate();
  const projectName = inferProjectName({ projectPath, ingest });
  const goal = String(description || "").trim() || `Build and harden ${projectName}.`;

  const techStack = deriveTechStackLine(ingest);
  const entryPoints = normalizeList(ingest?.entryPoints, ["none detected"]);
  const riskSurfaces = normalizeList(
    Array.isArray(ingest?.riskSurfaces) ? ingest.riskSurfaces.map((item) => item.surface) : [],
    ["code_quality"]
  );
  const architectureFocus = normalizeList(resolvedTemplate.architectureFocus, ["Define module boundaries."]);
  const securityChecklist = normalizeList(resolvedTemplate.securityChecklist, ["Apply secure defaults."]);

  const phases = derivePhasePlan(resolvedTemplate, ingest);

  const phaseMarkdown = phases
    .map(
      (phase) =>
        `### ${phase.title}\n${phase.items.map((item, index) => `${index + 1}. ${item}`).join("\n")}`
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

## Architecture Focus
${renderSectionList(architectureFocus)}

## Security Checklist
${renderSectionList(securityChecklist)}

## Acceptance Criteria
1. Primary user flow is implemented and validated by automated checks.
2. CI gates are deterministic and reproducible.
3. Security and reliability controls for critical surfaces are documented and tested.
4. Deployment/rollback guidance is included for the delivered scope.

## Phase Plan
${phaseMarkdown}
`;
}
