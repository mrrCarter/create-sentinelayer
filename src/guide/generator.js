import {
  getCoordinationEtiquetteItems,
  renderCoordinationMarkdownSection,
  renderCoordinationTicketBlock,
} from "../session/coordination-guidance.js";

export const SUPPORTED_GUIDE_EXPORT_FORMATS = Object.freeze([
  "jira",
  "linear",
  "github-issues",
]);

function normalizeExportFormat(format) {
  const normalized = String(format || "").trim().toLowerCase();
  if (!SUPPORTED_GUIDE_EXPORT_FORMATS.includes(normalized)) {
    throw new Error(
      `Unsupported guide export format '${format}'. Use one of: ${SUPPORTED_GUIDE_EXPORT_FORMATS.join(", ")}`
    );
  }
  return normalized;
}

function sectionBody(specMarkdown, headingTitle) {
  const source = String(specMarkdown || "");
  if (!source.trim()) {
    return "";
  }

  const escapedTitle = headingTitle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = new RegExp(`##\\s+${escapedTitle}\\s*\\n([\\s\\S]*?)(?=\\n##\\s+|$)`, "i");
  const match = source.match(pattern);
  return match ? String(match[1] || "").trim() : "";
}

function parseNumberedLines(block) {
  return String(block || "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => /^\d+\.\s+/.test(line))
    .map((line) => line.replace(/^\d+\.\s+/, "").trim())
    .filter(Boolean);
}

function parsePhasePlan(specMarkdown) {
  const phaseBlock = sectionBody(specMarkdown, "Phase Plan");
  if (!phaseBlock) {
    return [];
  }

  const lines = phaseBlock.split(/\r?\n/);
  const phases = [];
  let current = null;

  for (const rawLine of lines) {
    const line = rawLine.trim();
    const headingMatch = line.match(/^###\s+(.+)$/);
    if (headingMatch) {
      if (current) {
        phases.push(current);
      }
      current = {
        title: headingMatch[1].trim(),
        tasks: [],
      };
      continue;
    }

    const taskMatch = line.match(/^\d+\.\s+(.+)$/);
    if (taskMatch && current) {
      current.tasks.push(taskMatch[1].trim());
    }
  }

  if (current) {
    phases.push(current);
  }

  return phases;
}

function parseProjectName(specMarkdown) {
  const match = String(specMarkdown || "").match(/^#\s*SPEC\s*-\s*(.+)$/im);
  return match ? match[1].trim() : "Project";
}

function parseGoal(specMarkdown) {
  const block = sectionBody(specMarkdown, "Goal");
  return block || "Deliver the scoped feature set with deterministic, secure, and testable execution.";
}

function parseRiskSurfaceCount(specMarkdown) {
  const match = String(specMarkdown || "").match(/^- Risk surfaces:\s*(.+)$/im);
  if (!match) {
    return 0;
  }
  const list = String(match[1] || "")
    .split(",")
    .map((item) => item.trim())
    .filter((item) => item && item.toLowerCase() !== "none");
  return list.length;
}

function estimateEffortHours({ phaseTitle, taskCount, riskSurfaceCount }) {
  const title = String(phaseTitle || "").toLowerCase();
  const hardeningBoost = title.includes("harden") || title.includes("security") ? 2 : 0;
  const base = 4 + taskCount * 3 + Math.min(riskSurfaceCount, 5) + hardeningBoost;
  const min = Math.max(4, base - 2);
  const max = base + 2;
  return {
    minHours: min,
    maxHours: max,
    label: `${min}-${max} hours`,
  };
}

function normalizeAcceptanceCriteria(specMarkdown, phaseTasks) {
  const globalCriteria = parseNumberedLines(sectionBody(specMarkdown, "Acceptance Criteria"));
  if (globalCriteria.length > 0) {
    return globalCriteria.slice(0, 3);
  }
  return phaseTasks.slice(0, 3).map((task) => `Validated completion: ${task}`);
}

function renderPhaseMarkdown(phase) {
  const taskLines =
    phase.tasks.length > 0
      ? phase.tasks.map((task, index) => `${index + 1}. ${task}`).join("\n")
      : "1. Define implementation tasks for this phase.";
  const acceptanceLines =
    phase.acceptanceCriteria.length > 0
      ? phase.acceptanceCriteria.map((item, index) => `${index + 1}. ${item}`).join("\n")
      : "1. Phase outcomes are verified by deterministic checks.";
  const dependencyLine =
    phase.dependencies.length > 0 ? phase.dependencies.join(", ") : "none (entry phase)";

  return `### ${phase.title}
- Estimated effort: ${phase.effort.label}
- Dependencies: ${dependencyLine}

#### Implementation Tasks
${taskLines}

#### Acceptance Criteria
${acceptanceLines}
`;
}

function buildTicket(phase, index) {
  const issueNumber = index + 1;
  const labels = ["sentinelayer", "build-guide", `phase-${issueNumber}`];
  const dependencyLine =
    phase.dependencies.length > 0 ? phase.dependencies.join(", ") : "none (entry phase)";
  const acceptanceBlock = phase.acceptanceCriteria
    .map((item, criterionIndex) => `${criterionIndex + 1}. ${item}`)
    .join("\n");
  const taskBlock = phase.tasks.map((task, taskIndex) => `${taskIndex + 1}. ${task}`).join("\n");

  return {
    id: `phase-${issueNumber}`,
    title: phase.title,
    estimate_hours: {
      min: phase.effort.minHours,
      max: phase.effort.maxHours,
    },
    dependencies: phase.dependencies,
    labels,
    description: [
      `Dependencies: ${dependencyLine}`,
      `Estimated effort: ${phase.effort.label}`,
      "",
      "Implementation tasks:",
      taskBlock || "1. Define implementation tasks for this phase.",
      "",
      "Acceptance criteria:",
      acceptanceBlock || "1. Phase outcomes are verified by deterministic checks.",
      "",
      renderCoordinationTicketBlock(),
    ].join("\n"),
  };
}

export function defaultGuideExportFileName(format) {
  const normalized = normalizeExportFormat(format);
  if (normalized === "github-issues") {
    return "BUILD_GUIDE_GITHUB_ISSUES.md";
  }
  if (normalized === "jira") {
    return "BUILD_GUIDE_JIRA.json";
  }
  return "BUILD_GUIDE_LINEAR.json";
}

export function generateBuildGuide({
  specMarkdown,
  projectPath,
  specPath,
  generatedAt = new Date().toISOString(),
} = {}) {
  const source = String(specMarkdown || "").trim();
  if (!source) {
    throw new Error("Spec content is empty. Generate or provide a spec before creating a build guide.");
  }

  const phases = parsePhasePlan(source);
  if (phases.length === 0) {
    throw new Error("Spec does not include a parseable `## Phase Plan` section.");
  }

  const projectName = parseProjectName(source);
  const goal = parseGoal(source);
  const riskSurfaceCount = parseRiskSurfaceCount(source);

  const resolvedPhases = phases.map((phase, index) => {
    const dependencies = index > 0 ? [phases[index - 1].title] : [];
    const effort = estimateEffortHours({
      phaseTitle: phase.title,
      taskCount: phase.tasks.length,
      riskSurfaceCount,
    });
    const acceptanceCriteria = normalizeAcceptanceCriteria(source, phase.tasks);

    return {
      title: phase.title,
      tasks: phase.tasks,
      dependencies,
      effort,
      acceptanceCriteria,
    };
  });

  const phaseMarkdown = resolvedPhases.map((phase) => renderPhaseMarkdown(phase)).join("\n");
  const tickets = resolvedPhases.map((phase, index) => buildTicket(phase, index));

  const markdown = `# BUILD GUIDE - ${projectName}

Generated: ${generatedAt}
Workspace: ${projectPath || "(not provided)"}
Spec source: ${specPath || "(not provided)"}

## Delivery Goal
${goal}

## Phase Execution Plan
${phaseMarkdown}

${renderCoordinationMarkdownSection()}

## Suggested PR Sequence
${resolvedPhases
  .map((phase, index) => `${index + 1}. ${phase.title} (${phase.effort.label})`)
  .join("\n")}
`;

  return {
    projectName,
    goal,
    phases: resolvedPhases,
    tickets,
    coordinationRules: getCoordinationEtiquetteItems(),
    markdown,
  };
}

export function renderGuideExport({ format, guide }) {
  const normalized = normalizeExportFormat(format);
  const payload = {
    project: guide.projectName,
    generated_at: new Date().toISOString(),
    issues: guide.tickets,
    coordination_rules: Array.isArray(guide.coordinationRules) ? guide.coordinationRules : [],
  };

  if (normalized === "jira") {
    return JSON.stringify(
      {
        format: "jira",
        coordination_rules: payload.coordination_rules,
        issues: payload.issues.map((issue) => ({
          summary: issue.title,
          description: issue.description,
          labels: issue.labels,
          dependencies: issue.dependencies,
          estimate_hours: issue.estimate_hours,
        })),
      },
      null,
      2
    );
  }

  if (normalized === "linear") {
    return JSON.stringify(
      {
        format: "linear",
        coordination_rules: payload.coordination_rules,
        issues: payload.issues.map((issue, index) => ({
          title: issue.title,
          description: issue.description,
          labels: issue.labels,
          priority: index === 0 ? 2 : 3,
          estimate_hours: issue.estimate_hours,
          dependencies: issue.dependencies,
        })),
      },
      null,
      2
    );
  }

  const markdownBlocks = payload.issues
    .map((issue, index) => {
      const dependencyLine =
        issue.dependencies.length > 0 ? issue.dependencies.join(", ") : "none (entry phase)";
      return `## Issue ${index + 1}: ${issue.title}
Labels: ${issue.labels.join(", ")}
Dependencies: ${dependencyLine}
Estimate: ${issue.estimate_hours.min}-${issue.estimate_hours.max} hours

${issue.description}
`;
    })
    .join("\n");

  return `# GitHub Issues Export - ${payload.project}

Generated: ${payload.generated_at}

${markdownBlocks}`.trimEnd();
}

