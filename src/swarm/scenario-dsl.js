import fsp from "node:fs/promises";
import path from "node:path";

const SUPPORTED_ACTIONS = new Set(["goto", "click", "fill", "wait", "screenshot"]);

function normalizeString(value) {
  return String(value || "").trim();
}

function decodeQuoted(value) {
  return String(value || "")
    .replace(/^"/, "")
    .replace(/"$/, "")
    .replace(/\\"/g, '"')
    .replace(/\\n/g, "\n")
    .replace(/\\t/g, "\t");
}

function tokenizeLine(line = "") {
  const tokens = [];
  let cursor = 0;
  while (cursor < line.length) {
    while (cursor < line.length && /\s/.test(line[cursor])) {
      cursor += 1;
    }
    if (cursor >= line.length) {
      break;
    }
    if (line[cursor] === "#") {
      break;
    }

    if (line[cursor] === '"') {
      let token = '"';
      cursor += 1;
      let escaped = false;
      while (cursor < line.length) {
        const char = line[cursor];
        token += char;
        cursor += 1;
        if (escaped) {
          escaped = false;
          continue;
        }
        if (char === "\\") {
          escaped = true;
          continue;
        }
        if (char === '"') {
          break;
        }
      }
      if (!token.endsWith('"')) {
        throw new Error("Unterminated quoted string.");
      }
      tokens.push(decodeQuoted(token));
      continue;
    }

    const start = cursor;
    while (cursor < line.length && !/\s/.test(line[cursor])) {
      cursor += 1;
    }
    tokens.push(line.slice(start, cursor));
  }
  return tokens;
}

function parseAction(tokens = [], lineNumber = 0) {
  const type = normalizeString(tokens[0]).toLowerCase();
  if (!SUPPORTED_ACTIONS.has(type)) {
    throw new Error(
      `Line ${lineNumber}: unsupported action '${type}'. Supported: ${[...SUPPORTED_ACTIONS].join(
        ", "
      )}.`
    );
  }

  if (type === "goto") {
    if (tokens.length < 2) {
      throw new Error(`Line ${lineNumber}: action goto requires <url>.`);
    }
    return {
      type,
      url: normalizeString(tokens[1]),
    };
  }

  if (type === "click") {
    if (tokens.length < 2) {
      throw new Error(`Line ${lineNumber}: action click requires <selector>.`);
    }
    return {
      type,
      selector: normalizeString(tokens[1]),
    };
  }

  if (type === "fill") {
    if (tokens.length < 3) {
      throw new Error(`Line ${lineNumber}: action fill requires <selector> <text>.`);
    }
    return {
      type,
      selector: normalizeString(tokens[1]),
      text: normalizeString(tokens[2]),
    };
  }

  if (type === "wait") {
    if (tokens.length < 2) {
      throw new Error(`Line ${lineNumber}: action wait requires <ms>.`);
    }
    const ms = Number(tokens[1]);
    if (!Number.isFinite(ms) || ms < 0) {
      throw new Error(`Line ${lineNumber}: action wait requires non-negative milliseconds.`);
    }
    return {
      type,
      ms: Math.floor(ms),
    };
  }

  if (type === "screenshot") {
    return {
      type,
      path: normalizeString(tokens[1] || ""),
    };
  }

  throw new Error(`Line ${lineNumber}: unsupported action '${type}'.`);
}

export function parseScenarioDsl(content = "", { source = "" } = {}) {
  const raw = String(content || "");
  const lines = raw.split(/\r?\n/);
  const spec = {
    id: "",
    startUrl: "",
    tags: [],
    actions: [],
    source: normalizeString(source),
  };

  for (let index = 0; index < lines.length; index += 1) {
    const lineNumber = index + 1;
    const line = lines[index];
    const trimmed = normalizeString(line);
    if (!trimmed || trimmed.startsWith("#")) {
      continue;
    }

    let tokens;
    try {
      tokens = tokenizeLine(line);
    } catch (error) {
      throw new Error(`Line ${lineNumber}: ${error.message}`);
    }
    if (tokens.length === 0) {
      continue;
    }
    const command = normalizeString(tokens[0]).toLowerCase();

    if (command === "scenario") {
      if (tokens.length < 2) {
        throw new Error(`Line ${lineNumber}: scenario requires <id>.`);
      }
      spec.id = normalizeString(tokens[1]);
      continue;
    }

    if (command === "start_url") {
      if (tokens.length < 2) {
        throw new Error(`Line ${lineNumber}: start_url requires <url>.`);
      }
      spec.startUrl = normalizeString(tokens[1]);
      continue;
    }

    if (command === "tag") {
      if (tokens.length < 2) {
        throw new Error(`Line ${lineNumber}: tag requires <value>.`);
      }
      spec.tags.push(normalizeString(tokens[1]));
      continue;
    }

    if (command === "action") {
      const action = parseAction(tokens.slice(1), lineNumber);
      spec.actions.push(action);
      continue;
    }

    throw new Error(`Line ${lineNumber}: unknown command '${command}'.`);
  }

  return spec;
}

export function validateScenarioSpec(spec = {}) {
  const errors = [];
  const id = normalizeString(spec.id);
  if (!id) {
    errors.push("scenario id is required.");
  }
  if (!Array.isArray(spec.actions) || spec.actions.length === 0) {
    errors.push("at least one action is required.");
  }
  for (const action of spec.actions || []) {
    if (!SUPPORTED_ACTIONS.has(normalizeString(action.type).toLowerCase())) {
      errors.push(`unsupported action type: ${action.type}`);
    }
  }
  return {
    valid: errors.length === 0,
    errors,
  };
}

export async function parseScenarioFile(filePath = "") {
  const normalizedPath = normalizeString(filePath);
  if (!normalizedPath) {
    throw new Error("scenario file path is required.");
  }
  const resolved = path.resolve(process.cwd(), normalizedPath);
  const content = await fsp.readFile(resolved, "utf-8");
  const spec = parseScenarioDsl(content, { source: resolved });
  return {
    spec,
    filePath: resolved,
  };
}

export function renderScenarioTemplate({
  scenarioId = "nightly_smoke",
  startUrl = "https://example.com",
} = {}) {
  const id = normalizeString(scenarioId) || "nightly_smoke";
  const url = normalizeString(startUrl) || "https://example.com";
  return `# Sentinelayer swarm scenario DSL
scenario "${id}"
start_url "${url}"
tag "smoke"
tag "runtime"

action goto "${url}"
action wait 500
action screenshot "${id}-home.png"
`;
}

export async function writeScenarioTemplate({
  scenarioId,
  targetPath = ".",
  outputFile = "",
  startUrl = "https://example.com",
} = {}) {
  const normalizedTargetPath = path.resolve(String(targetPath || "."));
  const resolvedOutputFile = normalizeString(outputFile)
    ? path.resolve(normalizedTargetPath, outputFile)
    : path.join(normalizedTargetPath, ".sentinelayer", "scenarios", `${scenarioId}.sls`);
  const content = renderScenarioTemplate({
    scenarioId,
    startUrl,
  });
  await fsp.mkdir(path.dirname(resolvedOutputFile), { recursive: true });
  await fsp.writeFile(resolvedOutputFile, `${content.trim()}\n`, "utf-8");
  return {
    filePath: resolvedOutputFile,
    content,
  };
}
