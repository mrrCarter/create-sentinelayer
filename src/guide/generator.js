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

// Labeled bullets the builder emits per phase (e.g. "- Objective: ...").
// We capture these as structured fields so ticket bodies carry real content
// instead of dropping every non-numbered line.
const PHASE_FIELD_LABELS = new Map([
  ["objective", "objective"],
  ["dependencies", "dependencies"],
  ["files", "files"],
  ["commands", "commands"],
  ["tests", "tests"],
  ["rollback", "rollback"],
  ["evidence", "evidence"],
]);

// "Phase 0 (P0) — Repo Bootstrap" -> "P0"; "Phase 2 ..." -> "P2".
function parsePhaseHeadingId(title) {
  const paren = String(title || "").match(/\(\s*([A-Za-z]+\d+)\s*\)/);
  if (paren) {
    return paren[1].toUpperCase();
  }
  const phaseNum = String(title || "").match(/^Phase\s+(\d+)\b/i);
  return phaseNum ? `P${phaseNum[1]}` : "";
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
      const title = headingMatch[1].trim();
      current = {
        title,
        phaseId: parsePhaseHeadingId(title),
        tasks: [],
        fields: {},
      };
      continue;
    }

    if (!current) {
      continue;
    }

    const taskMatch = line.match(/^\d+\.\s+(.+)$/);
    if (taskMatch) {
      current.tasks.push(taskMatch[1].trim());
      continue;
    }

    const bulletMatch = line.match(/^[-*]\s+(.+)$/);
    if (bulletMatch) {
      const body = bulletMatch[1].trim();
      const labelMatch = body.match(/^([A-Za-z][A-Za-z ]*?):\s*(.*)$/);
      if (labelMatch) {
        const key = labelMatch[1].trim().toLowerCase();
        if (PHASE_FIELD_LABELS.has(key)) {
          current.fields[PHASE_FIELD_LABELS.get(key)] = labelMatch[2].trim();
          continue;
        }
      }
      // An unlabeled bullet is real work -> treat it as a task.
      current.tasks.push(body);
    }
  }

  if (current) {
    phases.push(current);
  }

  return phases;
}

// Expand a dependency token into phase ids: "P0-P4" -> [P0..P4], "P0" -> [P0].
function expandPhaseRange(token) {
  const raw = String(token || "").trim();
  if (!raw) {
    return [];
  }
  const range = raw.match(/^([A-Za-z]+)(\d+)\s*[-–—]\s*([A-Za-z]+)?(\d+)$/);
  if (range) {
    const prefix = range[1].toUpperCase();
    const start = Number(range[2]);
    const end = Number(range[4]);
    if (Number.isFinite(start) && Number.isFinite(end) && end >= start && end - start <= 50) {
      const out = [];
      for (let value = start; value <= end; value += 1) {
        out.push(`${prefix}${value}`);
      }
      return out;
    }
  }
  const single = raw.match(/^([A-Za-z]+\d+)$/);
  return single ? [single[1].toUpperCase()] : [];
}

// Parse a declared "Dependencies" field into a list of phase ids.
function parseDeclaredDependencies(value) {
  const raw = String(value || "").trim();
  if (!raw || /^none\b/i.test(raw)) {
    return [];
  }
  const ids = [];
  for (const part of raw.split(/[,;]/)) {
    for (const id of expandPhaseRange(part)) {
      if (!ids.includes(id)) {
        ids.push(id);
      }
    }
  }
  return ids;
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

// Real, phase-specific acceptance criteria derived from the captured fields
// (Tests/Evidence/Objective) and any tasks, instead of an empty placeholder.
function derivePhaseAcceptance(specMarkdown, phase) {
  const globalCriteria = parseNumberedLines(sectionBody(specMarkdown, "Acceptance Criteria"));
  if (globalCriteria.length > 0) {
    return globalCriteria.slice(0, 5);
  }
  const fields = phase.fields || {};
  const out = [];
  if (fields.tests) {
    out.push(`Tests pass: ${fields.tests}`);
  }
  if (fields.evidence) {
    out.push(`Evidence captured: ${fields.evidence}`);
  }
  if (fields.objective) {
    out.push(`Objective met: ${fields.objective}`);
  }
  for (const task of (phase.tasks || []).slice(0, 3)) {
    out.push(`Completed: ${task}`);
  }
  if (out.length === 0) {
    out.push("Phase outcomes are verified by deterministic checks.");
  }
  return out.slice(0, 5);
}

// Structured detail lines (objective/files/tests/...) for the ticket body.
function renderPhaseDetailLines(phase) {
  const fields = phase.fields || {};
  const order = ["objective", "files", "commands", "tests", "rollback", "evidence"];
  const labels = {
    objective: "Objective",
    files: "Files",
    commands: "Commands",
    tests: "Tests",
    rollback: "Rollback",
    evidence: "Evidence",
  };
  return order
    .filter((key) => String(fields[key] || "").trim().length > 0)
    .map((key) => `${labels[key]}: ${fields[key]}`);
}

function renderPhaseMarkdown(phase) {
  const detailLines = renderPhaseDetailLines(phase);
  const detailBlock =
    detailLines.length > 0 ? `\n${detailLines.map((line) => `- ${line}`).join("\n")}` : "";
  const taskLines =
    phase.tasks.length > 0
      ? phase.tasks.map((task, index) => `${index + 1}. ${task}`).join("\n")
      : "1. Deliver the phase objective above with deterministic checks.";
  const acceptanceLines =
    phase.acceptanceCriteria.length > 0
      ? phase.acceptanceCriteria.map((item, index) => `${index + 1}. ${item}`).join("\n")
      : "1. Phase outcomes are verified by deterministic checks.";
  const dependencyLine =
    phase.dependencies.length > 0 ? phase.dependencies.join(", ") : "none (entry phase)";

  return `### ${phase.title}
- Estimated effort: ${phase.effort.label}
- Dependencies: ${dependencyLine}${detailBlock}

#### Implementation Tasks
${taskLines}

#### Acceptance Criteria
${acceptanceLines}
`;
}

function buildTicket(phase, index) {
  const issueNumber = index + 1;
  const phaseId = String(phase.phaseId || "").trim();
  const labels = ["sentinelayer", "build-guide", `phase-${issueNumber}`];
  if (phaseId) {
    labels.push(phaseId.toLowerCase());
  }
  const dependencyLine =
    phase.dependencies.length > 0 ? phase.dependencies.join(", ") : "none (entry phase)";
  const acceptanceBlock = phase.acceptanceCriteria
    .map((item, criterionIndex) => `${criterionIndex + 1}. ${item}`)
    .join("\n");
  const taskBlock = phase.tasks.map((task, taskIndex) => `${taskIndex + 1}. ${task}`).join("\n");
  const detailLines = renderPhaseDetailLines(phase);
  const detailBlock = detailLines.length > 0 ? ["Details:", ...detailLines, ""] : [];

  return {
    id: `phase-${issueNumber}`,
    phase_id: phaseId,
    title: phase.title,
    estimate_hours: {
      min: phase.effort.minHours,
      max: phase.effort.maxHours,
    },
    dependencies: phase.dependencies,
    dependency_ids: phase.dependencyIds || [],
    labels,
    description: [
      `Dependencies: ${dependencyLine}`,
      `Estimated effort: ${phase.effort.label}`,
      "",
      ...detailBlock,
      "Implementation tasks:",
      taskBlock || "1. Deliver the phase objective above with deterministic checks.",
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

  // Map declared phase ids (P0, P1, ...) to titles so a "Dependencies: P0-P1"
  // line resolves to a real prerequisite graph instead of naive sequencing.
  const idToTitle = new Map(
    phases.filter((phase) => phase.phaseId).map((phase) => [phase.phaseId, phase.title])
  );

  const resolvedPhases = phases.map((phase, index) => {
    const declaredIds = parseDeclaredDependencies(phase.fields?.dependencies);
    const knownIds = declaredIds.filter(
      (id) => idToTitle.has(id) && idToTitle.get(id) !== phase.title
    );
    let dependencies;
    if (knownIds.length > 0) {
      // Honor the spec's declared dependency graph.
      dependencies = knownIds.map((id) => idToTitle.get(id));
    } else if (declaredIds.length === 0 && index > 0) {
      // Nothing declared -> fall back to the previous phase only.
      dependencies = [phases[index - 1].title];
    } else {
      // Declared "none", or deps that don't resolve -> entry phase.
      dependencies = [];
    }
    const effort = estimateEffortHours({
      phaseTitle: phase.title,
      taskCount: phase.tasks.length,
      riskSurfaceCount,
    });
    const acceptanceCriteria = derivePhaseAcceptance(source, phase);

    return {
      title: phase.title,
      phaseId: phase.phaseId,
      tasks: phase.tasks,
      fields: phase.fields,
      dependencies,
      dependencyIds: knownIds,
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

