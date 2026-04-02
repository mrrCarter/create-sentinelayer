import pc from "picocolors";
import { highlight } from "cli-highlight";

const TABLE_SEPARATOR_PATTERN = /^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)+\|?\s*$/;

function stripAnsi(text) {
  return String(text || "").replace(/\x1B\[[0-9;]*m/g, "");
}

function visibleLength(text) {
  return stripAnsi(text).length;
}

function padCell(text, width) {
  const value = String(text || "");
  const missing = Math.max(0, width - visibleLength(value));
  return `${value}${" ".repeat(missing)}`;
}

function parseTableRow(line) {
  const normalized = String(line || "").trim();
  if (!normalized.includes("|")) {
    return null;
  }

  const trimmed = normalized.startsWith("|") ? normalized.slice(1) : normalized;
  const tailTrimmed = trimmed.endsWith("|") ? trimmed.slice(0, -1) : trimmed;
  const cells = tailTrimmed.split("|").map((cell) => cell.trim());
  if (cells.length < 2) {
    return null;
  }
  return cells;
}

function isTableSeparator(line) {
  return TABLE_SEPARATOR_PATTERN.test(String(line || "").trim());
}

function styleInlineMarkdown(line, plain = false) {
  const input = String(line || "");
  if (plain || !input) {
    return input;
  }

  let output = input;
  output = output.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_, label, href) => {
    return `${pc.underline(label)} ${pc.gray(`(${href})`)}`;
  });
  output = output.replace(/`([^`]+)`/g, (_, value) => pc.bgBlack(pc.white(` ${value} `)));
  output = output.replace(/\*\*([^*]+)\*\*/g, (_, value) => pc.bold(value));
  output = output.replace(/\*([^*]+)\*/g, (_, value) => pc.italic(value));
  return output;
}

function renderTableBlock(lines, startIndex, plain = false) {
  const header = parseTableRow(lines[startIndex]);
  if (!header) {
    return null;
  }

  if (startIndex + 1 >= lines.length || !isTableSeparator(lines[startIndex + 1])) {
    return null;
  }

  const rows = [];
  let cursor = startIndex + 2;
  while (cursor < lines.length) {
    const row = parseTableRow(lines[cursor]);
    if (!row) {
      break;
    }
    rows.push(row);
    cursor += 1;
  }

  if (rows.length === 0) {
    return null;
  }

  const tableRows = [header, ...rows];
  const colCount = Math.max(...tableRows.map((row) => row.length));
  const widths = Array.from({ length: colCount }, (_, col) => {
    return Math.max(...tableRows.map((row) => visibleLength(row[col] || "")));
  });

  const drawBorder = (left, fill, join, right) =>
    `${left}${widths.map((width) => fill.repeat(width + 2)).join(join)}${right}`;

  const drawRow = (row, headerRow = false) => {
    const cells = widths.map((width, col) => {
      const raw = styleInlineMarkdown(row[col] || "", plain);
      const value = headerRow && !plain ? pc.bold(raw) : raw;
      return ` ${padCell(value, width)} `;
    });
    return `│${cells.join("│")}│`;
  };

  const renderedLines = [
    drawBorder("┌", "─", "┬", "┐"),
    drawRow(header, true),
    drawBorder("├", "─", "┼", "┤"),
    ...rows.map((row) => drawRow(row)),
    drawBorder("└", "─", "┴", "┘"),
  ];

  return {
    renderedLines,
    nextIndex: cursor - 1,
  };
}

function renderCodeBlock(lines, language, plain = false) {
  const code = lines.join("\n");
  if (plain || !code.trim()) {
    return code;
  }
  try {
    return highlight(code, {
      language: language || undefined,
      ignoreIllegals: true,
    });
  } catch {
    return code;
  }
}

function styleLine(line, plain = false) {
  const input = String(line || "");
  const trimmed = input.trimStart();

  if (!trimmed) {
    return "";
  }

  const headingMatch = trimmed.match(/^(#{1,6})\s+(.+)$/);
  if (headingMatch) {
    const [, marks, text] = headingMatch;
    const heading = `${marks} ${styleInlineMarkdown(text, plain)}`;
    if (plain) {
      return heading;
    }
    if (marks.length <= 2) {
      return pc.bold(pc.cyan(heading));
    }
    return pc.bold(heading);
  }

  if (trimmed.startsWith(">")) {
    const quote = trimmed.replace(/^>\s?/, "");
    const formatted = `> ${styleInlineMarkdown(quote, plain)}`;
    return plain ? formatted : pc.gray(formatted);
  }

  if (/^\d+\.\s+/.test(trimmed)) {
    const numbered = trimmed.replace(/^(\d+\.)\s+/, (_, idx) => `${idx} ${""}`);
    return plain ? styleInlineMarkdown(numbered, true) : styleInlineMarkdown(numbered, false);
  }

  if (/^[-*+]\s+/.test(trimmed)) {
    const bullet = trimmed.replace(/^[-*+]\s+/, "• ");
    return plain ? styleInlineMarkdown(bullet, true) : styleInlineMarkdown(bullet, false);
  }

  if (/^(-{3,}|\*{3,}|_{3,})$/.test(trimmed)) {
    const hr = "─".repeat(48);
    return plain ? hr : pc.gray(hr);
  }

  return styleInlineMarkdown(input, plain);
}

export function renderTerminalMarkdown(markdown, options = {}) {
  const plain = Boolean(options.plain);
  const lines = String(markdown || "").split(/\r?\n/);
  const rendered = [];
  let inCodeBlock = false;
  let codeLanguage = "";
  let codeLines = [];

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const fenceMatch = String(line).match(/^```([\w-]+)?\s*$/);

    if (fenceMatch) {
      if (!inCodeBlock) {
        inCodeBlock = true;
        codeLanguage = String(fenceMatch[1] || "").trim();
        rendered.push(plain ? line : pc.gray(line));
      } else {
        const highlighted = renderCodeBlock(codeLines, codeLanguage, plain);
        rendered.push(highlighted);
        rendered.push(plain ? line : pc.gray(line));
        inCodeBlock = false;
        codeLanguage = "";
        codeLines = [];
      }
      continue;
    }

    if (inCodeBlock) {
      codeLines.push(line);
      continue;
    }

    const tableBlock = renderTableBlock(lines, index, plain);
    if (tableBlock) {
      rendered.push(...tableBlock.renderedLines);
      index = tableBlock.nextIndex;
      continue;
    }

    rendered.push(styleLine(line, plain));
  }

  if (inCodeBlock) {
    rendered.push(renderCodeBlock(codeLines, codeLanguage, plain));
  }

  return rendered.join("\n");
}
