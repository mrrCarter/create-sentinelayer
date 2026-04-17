import fsp from "node:fs/promises";
import path from "node:path";
import process from "node:process";

import { buildAgentsSessionGuideContent } from "../legacy-cli.js";
import { getSession } from "./store.js";

const SECTION_START_MARKER = "<!-- SENTINELAYER_SESSION_COORDINATION:START -->";
const SECTION_END_MARKER = "<!-- SENTINELAYER_SESSION_COORDINATION:END -->";
const SECTION_HEADING = "## Multi-Agent Session Coordination (SentinelLayer)";
const SESSION_GUIDE_RELATIVE_PATH = path.join(".sentinelayer", "AGENTS_SESSION_GUIDE.md");

function normalizeString(value) {
  return String(value || "").trim();
}

function normalizeLineEndings(value = "") {
  return String(value || "").replace(/\r\n/g, "\n");
}

function normalizeHeadingText(value) {
  return normalizeString(value).toLowerCase();
}

function buildSessionCoordinationSection() {
  return `${SECTION_START_MARKER}
${SECTION_HEADING}

### Before You Start
- Check for active sessions: \`sl session list\`
- Join if one exists: \`sl session join <id> --name <your-name>\`
- Read recent context: \`sl session read <id> --tail 20\`

### While Working
- Emit status every 5 min: \`sl session say <id> "status: <what you're doing>"\`
- Lock files before editing: \`sl session say <id> "lock: <file> - <intent>"\`
- Unlock when done: \`sl session say <id> "unlock: <file> - done"\`
- Post findings: \`sl session say <id> "finding: [P2] <title> in <file>:<line>"\`

### On Problems
- Unexpected file change? Ask: \`sl session say <id> "help: unexpected change in <file>"\`
- Need another agent's work? Request: \`sl session say <id> "handoff: @<agent> <description>"\`
- Found issues for others? Assign: \`sl session say <id> "assign: @<agent> <task>"\`

### What Not To Do
- Do not break your autonomous loop on unexpected file changes; ask in session first.
- Do not edit files locked by another agent; wait or coordinate.
- Do not push without checking session activity on files you touched.
- Do not ignore daemon alerts; post a status update if flagged as stuck.

### Budget Awareness
- Share usage: \`sl session say <id> "budget: 40K/50K tokens used"\`
- Signal low budget and handoff: \`sl session say <id> "budget-low: 90% used, handing off <task>"\`
${SECTION_END_MARKER}
`;
}

function splitLines(value) {
  return normalizeLineEndings(value).split("\n");
}

function findLegacySectionRange(lines = []) {
  const targetHeading = normalizeHeadingText(SECTION_HEADING.replace(/^##\s*/, ""));
  const startIndex = lines.findIndex(
    (line) => normalizeHeadingText(line.replace(/^#+\s*/, "")) === targetHeading
  );
  if (startIndex < 0) {
    return null;
  }
  let endIndexExclusive = lines.length;
  for (let index = startIndex + 1; index < lines.length; index += 1) {
    if (/^##\s+/.test(lines[index])) {
      endIndexExclusive = index;
      break;
    }
  }
  return {
    startIndex,
    endIndexExclusive,
  };
}

function upsertCoordinationSection(existingText = "", sectionText = buildSessionCoordinationSection()) {
  const normalizedExisting = normalizeLineEndings(existingText);
  const normalizedSection = normalizeLineEndings(sectionText).trimEnd();
  if (!normalizeString(normalizedExisting)) {
    return {
      content: `${normalizedSection}\n`,
      changed: true,
    };
  }

  const markerPattern = new RegExp(
    `${SECTION_START_MARKER.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}[\\s\\S]*?${SECTION_END_MARKER.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`,
    "m"
  );
  if (markerPattern.test(normalizedExisting)) {
    const replaced = normalizedExisting.replace(markerPattern, normalizedSection);
    const finalText = `${replaced.trimEnd()}\n`;
    return {
      content: finalText,
      changed: finalText !== `${normalizedExisting.trimEnd()}\n`,
    };
  }

  const lines = splitLines(normalizedExisting);
  const legacyRange = findLegacySectionRange(lines);
  if (legacyRange) {
    const before = lines.slice(0, legacyRange.startIndex).join("\n").trimEnd();
    const after = lines.slice(legacyRange.endIndexExclusive).join("\n").trimStart();
    const stitched = [before, normalizedSection, after].filter(Boolean).join("\n\n");
    const finalText = `${stitched.trimEnd()}\n`;
    return {
      content: finalText,
      changed: finalText !== `${normalizedExisting.trimEnd()}\n`,
    };
  }

  const appended = `${normalizedExisting.trimEnd()}\n\n${normalizedSection}\n`;
  return {
    content: appended,
    changed: appended !== `${normalizedExisting.trimEnd()}\n`,
  };
}

async function readOptionalFile(filePath) {
  try {
    return await fsp.readFile(filePath, "utf-8");
  } catch (error) {
    if (error && typeof error === "object" && error.code === "ENOENT") {
      return null;
    }
    throw error;
  }
}

async function writeTextFile(filePath, content) {
  await fsp.mkdir(path.dirname(filePath), { recursive: true });
  await fsp.writeFile(filePath, normalizeLineEndings(content), "utf-8");
}

function buildDefaultGuideDoc(fileName, sectionText) {
  const title = fileName === "CLAUDE.md" ? "CLAUDE" : "AGENTS";
  return `# ${title}

${sectionText.trimEnd()}
`;
}

async function upsertInstructionGuide(filePath, sectionText, { createIfMissing = true } = {}) {
  const existing = await readOptionalFile(filePath);
  if (existing === null) {
    if (!createIfMissing) {
      return {
        path: filePath,
        existed: false,
        changed: false,
        content: "",
      };
    }
    const createdContent = buildDefaultGuideDoc(path.basename(filePath), sectionText);
    await writeTextFile(filePath, createdContent);
    return {
      path: filePath,
      existed: false,
      changed: true,
      content: createdContent,
    };
  }
  const upserted = upsertCoordinationSection(existing, sectionText);
  if (upserted.changed) {
    await writeTextFile(filePath, upserted.content);
  }
  return {
    path: filePath,
    existed: true,
    changed: upserted.changed,
    content: upserted.content,
  };
}

function countCoordinationSections(content = "") {
  const text = normalizeLineEndings(content);
  const markerCount = (text.match(new RegExp(SECTION_START_MARKER, "g")) || []).length;
  if (markerCount > 0) {
    return markerCount;
  }
  return (text.match(new RegExp(SECTION_HEADING.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "g")) || [])
    .length;
}

async function resolveSessionContext(sessionId, { targetPath = process.cwd() } = {}) {
  const normalizedSessionId = normalizeString(sessionId);
  if (!normalizedSessionId) {
    throw new Error("session id is required.");
  }
  const normalizedTargetPath = path.resolve(String(targetPath || "."));
  const session = await getSession(normalizedSessionId, {
    targetPath: normalizedTargetPath,
  });
  if (!session) {
    throw new Error(`Session '${normalizedSessionId}' was not found.`);
  }
  return {
    sessionId: normalizedSessionId,
    targetPath: normalizedTargetPath,
  };
}

function summarizeInstructionGuide(result = {}) {
  return {
    path: result.path,
    existed: result.existed,
    changed: result.changed,
    sectionCount: countCoordinationSections(result.content),
  };
}

function resolveInstructionGuidePaths(targetPath) {
  return {
    agentsPath: path.join(targetPath, "AGENTS.md"),
    claudePath: path.join(targetPath, "CLAUDE.md"),
    guidePath: path.join(targetPath, SESSION_GUIDE_RELATIVE_PATH),
  };
}

export async function setupSessionGuides(
  sessionId,
  {
    targetPath = process.cwd(),
  } = {}
) {
  const context = await resolveSessionContext(sessionId, {
    targetPath,
  });

  const sectionText = buildSessionCoordinationSection();
  const { agentsPath, claudePath, guidePath } = resolveInstructionGuidePaths(context.targetPath);

  const [agentsResult, claudeResult] = await Promise.all([
    upsertInstructionGuide(agentsPath, sectionText),
    upsertInstructionGuide(claudePath, sectionText),
  ]);

  const guideContent = `${normalizeLineEndings(buildAgentsSessionGuideContent()).trimEnd()}\n`;
  const existingGuide = await readOptionalFile(guidePath);
  const normalizedExistingGuide = existingGuide === null ? null : `${normalizeLineEndings(existingGuide).trimEnd()}\n`;
  const guideChanged = normalizedExistingGuide !== guideContent;
  if (guideChanged) {
    await writeTextFile(guidePath, guideContent);
  }

  return {
    sessionId: context.sessionId,
    targetPath: context.targetPath,
    sectionHeading: SECTION_HEADING,
    agents: summarizeInstructionGuide(agentsResult),
    claude: summarizeInstructionGuide(claudeResult),
    sessionGuide: {
      path: guidePath,
      existed: existingGuide !== null,
      changed: guideChanged,
    },
  };
}

export async function injectSessionGuides(
  sessionId,
  {
    targetPath = process.cwd(),
  } = {}
) {
  const context = await resolveSessionContext(sessionId, {
    targetPath,
  });
  const sectionText = buildSessionCoordinationSection();
  const { agentsPath, claudePath } = resolveInstructionGuidePaths(context.targetPath);
  const [agentsResult, claudeResult] = await Promise.all([
    upsertInstructionGuide(agentsPath, sectionText, {
      createIfMissing: false,
    }),
    upsertInstructionGuide(claudePath, sectionText, {
      createIfMissing: false,
    }),
  ]);

  return {
    sessionId: context.sessionId,
    targetPath: context.targetPath,
    sectionHeading: SECTION_HEADING,
    agents: summarizeInstructionGuide(agentsResult),
    claude: summarizeInstructionGuide(claudeResult),
  };
}

export {
  SECTION_END_MARKER,
  SECTION_HEADING,
  SECTION_START_MARKER,
  SESSION_GUIDE_RELATIVE_PATH,
  buildSessionCoordinationSection,
  countCoordinationSections,
  upsertCoordinationSection,
};
