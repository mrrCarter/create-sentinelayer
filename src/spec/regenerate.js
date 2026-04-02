import pc from "picocolors";

function normalizeHeadingKey(rawHeading) {
  return String(rawHeading || "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

function normalizeSectionBody(lines) {
  return lines
    .map((line) => String(line || ""))
    .join("\n")
    .replace(/\s+$/gm, "")
    .trim();
}

export function inferTemplateFromSpec(markdown) {
  const match = String(markdown || "").match(/^Template:\s*([a-z0-9-]+)/im);
  return match ? String(match[1] || "").trim() : "";
}

export function parseSpecSections(markdown) {
  const lines = String(markdown || "").split(/\r?\n/);
  const preambleLines = [];
  const sections = [];
  let activeSection = null;

  for (const line of lines) {
    const heading = line.match(/^##\s+(.+)$/);
    if (heading) {
      if (activeSection) {
        sections.push(activeSection);
      }
      activeSection = {
        headingLine: line,
        headingText: String(heading[1] || "").trim(),
        headingKey: normalizeHeadingKey(heading[1]),
        lines: [line],
      };
      continue;
    }

    if (!activeSection) {
      preambleLines.push(line);
      continue;
    }
    activeSection.lines.push(line);
  }

  if (activeSection) {
    sections.push(activeSection);
  }

  return {
    preamble: preambleLines.join("\n").trimEnd(),
    sections: sections.map((section) => ({
      headingLine: section.headingLine,
      headingText: section.headingText,
      headingKey: section.headingKey,
      lines: section.lines,
      body: normalizeSectionBody(section.lines.slice(1)),
      manualTagged: section.lines.some((line) =>
        /sentinelayer:manual|\[manual\]/i.test(String(line || ""))
      ),
    })),
  };
}

export function mergeSpecRegeneration({
  existingMarkdown,
  regeneratedMarkdown,
  preserveManual = true,
} = {}) {
  const existing = parseSpecSections(existingMarkdown);
  const regenerated = parseSpecSections(regeneratedMarkdown);

  const existingByHeading = new Map();
  for (const section of existing.sections) {
    if (!existingByHeading.has(section.headingKey)) {
      existingByHeading.set(section.headingKey, section);
    }
  }

  const usedExisting = new Set();
  const mergedSections = [];
  const summary = {
    preservedManualSections: [],
    replacedGeneratedSections: [],
    addedGeneratedSections: [],
    preservedManualOnlySections: [],
    preservedManualPreamble: false,
  };

  for (const generatedSection of regenerated.sections) {
    const existingSection = existingByHeading.get(generatedSection.headingKey);
    if (!existingSection) {
      mergedSections.push(generatedSection.lines.join("\n").trimEnd());
      summary.addedGeneratedSections.push(generatedSection.headingText);
      continue;
    }

    usedExisting.add(existingSection.headingKey);
    const contentDiffers = existingSection.body !== generatedSection.body;
    const preserveCurrent = preserveManual && (existingSection.manualTagged || contentDiffers);

    if (preserveCurrent) {
      mergedSections.push(existingSection.lines.join("\n").trimEnd());
      summary.preservedManualSections.push(existingSection.headingText);
      continue;
    }

    mergedSections.push(generatedSection.lines.join("\n").trimEnd());
    summary.replacedGeneratedSections.push(generatedSection.headingText);
  }

  if (preserveManual) {
    for (const existingSection of existing.sections) {
      if (usedExisting.has(existingSection.headingKey)) {
        continue;
      }
      mergedSections.push(existingSection.lines.join("\n").trimEnd());
      summary.preservedManualOnlySections.push(existingSection.headingText);
    }
  }

  const preambleDiffers = existing.preamble.trim() !== regenerated.preamble.trim();
  const mergedPreamble =
    preserveManual && preambleDiffers ? existing.preamble.trimEnd() : regenerated.preamble.trimEnd();
  if (preserveManual && preambleDiffers && existing.preamble.trim()) {
    summary.preservedManualPreamble = true;
  }

  const mergedMarkdown = `${[mergedPreamble, mergedSections.join("\n\n")]
    .filter((segment) => String(segment || "").trim().length > 0)
    .join("\n\n")
    .trimEnd()}\n`;

  return {
    mergedMarkdown,
    changed: String(existingMarkdown || "").trimEnd() !== mergedMarkdown.trimEnd(),
    summary,
  };
}

function buildLcsTable(a, b) {
  const table = Array.from({ length: a.length + 1 }, () => new Array(b.length + 1).fill(0));
  for (let i = a.length - 1; i >= 0; i -= 1) {
    for (let j = b.length - 1; j >= 0; j -= 1) {
      if (a[i] === b[j]) {
        table[i][j] = table[i + 1][j + 1] + 1;
      } else {
        table[i][j] = Math.max(table[i + 1][j], table[i][j + 1]);
      }
    }
  }
  return table;
}

export function buildLineDiff(beforeMarkdown, afterMarkdown) {
  const beforeLines = String(beforeMarkdown || "").split(/\r?\n/);
  const afterLines = String(afterMarkdown || "").split(/\r?\n/);
  const lcs = buildLcsTable(beforeLines, afterLines);
  const operations = [];
  let i = 0;
  let j = 0;

  while (i < beforeLines.length && j < afterLines.length) {
    if (beforeLines[i] === afterLines[j]) {
      operations.push({ type: "context", line: beforeLines[i] });
      i += 1;
      j += 1;
      continue;
    }
    if (lcs[i + 1][j] >= lcs[i][j + 1]) {
      operations.push({ type: "remove", line: beforeLines[i] });
      i += 1;
    } else {
      operations.push({ type: "add", line: afterLines[j] });
      j += 1;
    }
  }

  while (i < beforeLines.length) {
    operations.push({ type: "remove", line: beforeLines[i] });
    i += 1;
  }
  while (j < afterLines.length) {
    operations.push({ type: "add", line: afterLines[j] });
    j += 1;
  }

  let added = 0;
  let removed = 0;
  for (const op of operations) {
    if (op.type === "add") {
      added += 1;
    } else if (op.type === "remove") {
      removed += 1;
    }
  }

  return {
    operations,
    added,
    removed,
    changed: added > 0 || removed > 0,
  };
}

export function renderLineDiff(diff, options = {}) {
  const plain = Boolean(options.plain);
  const maxLines = Number(options.maxLines || 0);
  const hasLimit = Number.isFinite(maxLines) && maxLines > 0;
  const rows = [];

  for (const op of diff.operations) {
    if (op.type === "add") {
      rows.push(plain ? `+ ${op.line}` : pc.green(`+ ${op.line}`));
    } else if (op.type === "remove") {
      rows.push(plain ? `- ${op.line}` : pc.red(`- ${op.line}`));
    } else {
      rows.push(`  ${op.line}`);
    }
  }

  if (!hasLimit || rows.length <= maxLines) {
    return rows.join("\n");
  }

  const headCount = Math.max(1, Math.floor(maxLines / 2));
  const tailCount = Math.max(1, maxLines - headCount - 1);
  const omitted = rows.length - headCount - tailCount;
  return [...rows.slice(0, headCount), `... (${omitted} lines omitted) ...`, ...rows.slice(-tailCount)].join(
    "\n"
  );
}
