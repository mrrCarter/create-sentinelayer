import { execFile } from "node:child_process";
import { extname } from "node:path";
import { promisify } from "node:util";

import { parse } from "@babel/parser";

const execFileAsync = promisify(execFile);
const PYTHON_EXECUTABLE_CANDIDATES = ["python3", "python"];
let pythonExecutablePromise = null;

function normalizeString(value) {
  return String(value || "").trim();
}

function normalizeLanguage(language) {
  return normalizeString(language).toLowerCase();
}

function normalizeSpecifierList(values = []) {
  const unique = new Set();
  for (const value of values) {
    const normalized = normalizeString(value);
    if (!normalized) {
      continue;
    }
    unique.add(normalized);
  }
  return [...unique];
}

function parseRegexSpecifiers(content = "", normalizedLanguage = "") {
  const raw = String(content || "");
  const specifiers = new Set();
  if (normalizedLanguage.includes("javascript") || normalizedLanguage.includes("typescript")) {
    const pattern =
      /(?:import\s+[^'"]*from\s*|export\s+[^'"]*from\s*|import\s*\(\s*|require\s*\()\s*['"]([^'"]+)['"]/g;
    let match;
    while ((match = pattern.exec(raw))) {
      if (match[1]) {
        specifiers.add(match[1]);
      }
    }
  }
  if (normalizedLanguage === "python") {
    const fromPattern = /^\s*from\s+([a-zA-Z0-9_\.]+)\s+import\s+/gm;
    let fromMatch;
    while ((fromMatch = fromPattern.exec(raw))) {
      if (fromMatch[1]) {
        specifiers.add(fromMatch[1]);
      }
    }
    const importPattern = /^\s*import\s+([a-zA-Z0-9_\.]+)/gm;
    let importMatch;
    while ((importMatch = importPattern.exec(raw))) {
      if (importMatch[1]) {
        specifiers.add(importMatch[1]);
      }
    }
  }
  return [...specifiers];
}

function collectBabelSpecifiers(astRoot) {
  const specifiers = new Set();
  const queue = [astRoot];
  while (queue.length > 0) {
    const node = queue.shift();
    if (!node || typeof node !== "object") {
      continue;
    }
    if (Array.isArray(node)) {
      for (const value of node) {
        queue.push(value);
      }
      continue;
    }

    if (
      (node.type === "ImportDeclaration" ||
        node.type === "ExportAllDeclaration" ||
        node.type === "ExportNamedDeclaration") &&
      node.source &&
      typeof node.source.value === "string"
    ) {
      specifiers.add(node.source.value);
    }

    if (
      node.type === "CallExpression" &&
      node.callee &&
      node.callee.type === "Identifier" &&
      node.callee.name === "require"
    ) {
      const firstArg = Array.isArray(node.arguments) ? node.arguments[0] : null;
      if (firstArg && firstArg.type === "StringLiteral" && typeof firstArg.value === "string") {
        specifiers.add(firstArg.value);
      }
    }

    if (node.type === "CallExpression" && node.callee && node.callee.type === "Import") {
      const firstArg = Array.isArray(node.arguments) ? node.arguments[0] : null;
      if (firstArg && firstArg.type === "StringLiteral" && typeof firstArg.value === "string") {
        specifiers.add(firstArg.value);
      }
    }

    if (node.type === "ImportExpression" && node.source) {
      if (node.source.type === "StringLiteral" && typeof node.source.value === "string") {
        specifiers.add(node.source.value);
      }
    }

    for (const value of Object.values(node)) {
      if (value && typeof value === "object") {
        queue.push(value);
      }
    }
  }
  return [...specifiers];
}

function buildBabelPlugins(absolutePath = "") {
  const extension = extname(normalizeString(absolutePath)).toLowerCase();
  const plugins = ["importAttributes", "dynamicImport"];
  if (extension === ".ts" || extension === ".tsx" || extension === ".mts" || extension === ".cts") {
    plugins.push("typescript");
  }
  if (extension === ".jsx" || extension === ".tsx") {
    plugins.push("jsx");
  }
  return plugins;
}

function parseWithBabelAst(content = "", absolutePath = "") {
  const ast = parse(String(content || ""), {
    sourceType: "unambiguous",
    errorRecovery: true,
    allowAwaitOutsideFunction: true,
    plugins: buildBabelPlugins(absolutePath),
  });
  if (Array.isArray(ast.errors) && ast.errors.length > 0) {
    throw ast.errors[0];
  }
  return collectBabelSpecifiers(ast);
}

async function resolvePythonExecutable() {
  if (!pythonExecutablePromise) {
    pythonExecutablePromise = (async () => {
      for (const executable of PYTHON_EXECUTABLE_CANDIDATES) {
        try {
          await execFileAsync(executable, ["--version"], { timeout: 5000 });
          return executable;
        } catch {
          continue;
        }
      }
      return "";
    })();
  }
  return pythonExecutablePromise;
}

const PYTHON_AST_SCRIPT = `
import ast
import json
import sys

target_path = sys.argv[1]
with open(target_path, "r", encoding="utf-8") as source_file:
    source_text = source_file.read()

parsed = ast.parse(source_text, filename=target_path)
specifiers = []
for node in ast.walk(parsed):
    if isinstance(node, ast.Import):
        for alias in node.names:
            if alias.name:
                specifiers.append(alias.name)
    elif isinstance(node, ast.ImportFrom):
        if node.module:
            specifiers.append(node.module)

print(json.dumps({"specifiers": specifiers}))
`;

async function parsePythonAstSpecifiers(absolutePath = "") {
  const executable = await resolvePythonExecutable();
  if (!executable) {
    return {
      specifiers: [],
      parseError: "python_executable_not_found",
    };
  }
  try {
    const { stdout } = await execFileAsync(executable, ["-c", PYTHON_AST_SCRIPT, absolutePath], {
      timeout: 10000,
      maxBuffer: 1024 * 1024,
    });
    const parsed = JSON.parse(String(stdout || "{}"));
    const specifiers = Array.isArray(parsed.specifiers) ? parsed.specifiers : [];
    return {
      specifiers: normalizeSpecifierList(specifiers),
      parseError: "",
    };
  } catch (error) {
    return {
      specifiers: [],
      parseError: normalizeString(error?.message) || "python_ast_parse_failed",
    };
  }
}

export async function parseAstModuleSpecifiers({
  absolutePath = "",
  content = "",
  language = "",
} = {}) {
  const normalizedLanguage = normalizeLanguage(language);
  if (normalizedLanguage.includes("javascript") || normalizedLanguage.includes("typescript")) {
    try {
      const specifiers = parseWithBabelAst(content, absolutePath);
      return {
        specifiers: normalizeSpecifierList(specifiers),
        parserMode: "babel_ast",
        parseError: "",
      };
    } catch (error) {
      return {
        specifiers: normalizeSpecifierList(parseRegexSpecifiers(content, normalizedLanguage)),
        parserMode: "regex_fallback",
        parseError: normalizeString(error?.message) || "babel_parse_failed",
      };
    }
  }

  if (normalizedLanguage === "python") {
    const parsed = await parsePythonAstSpecifiers(absolutePath);
    if (parsed.parseError) {
      return {
        specifiers: normalizeSpecifierList(parseRegexSpecifiers(content, normalizedLanguage)),
        parserMode: "regex_fallback_python",
        parseError: parsed.parseError,
      };
    }
    return {
      specifiers: parsed.specifiers,
      parserMode: "python_ast",
      parseError: "",
    };
  }

  return {
    specifiers: normalizeSpecifierList(parseRegexSpecifiers(content, normalizedLanguage)),
    parserMode: "regex_fallback_generic",
    parseError: "",
  };
}
