import { execFile } from "node:child_process";
import fsp from "node:fs/promises";
import path, { extname } from "node:path";
import { promisify } from "node:util";

import { parse } from "@babel/parser";

const execFileAsync = promisify(execFile);
const PYTHON_EXECUTABLE_CANDIDATES = ["python3", "python"];
let pythonExecutablePromise = null;
const MAX_FALLBACK_TARGETS = 12;

function normalizeString(value) {
  return String(value || "").trim();
}

function normalizeLanguage(language) {
  return normalizeString(language).toLowerCase();
}

function normalizeName(value) {
  const normalized = normalizeString(value);
  if (!normalized) {
    return "";
  }
  return normalized.slice(0, 256);
}

function normalizeSymbolList(values = []) {
  const unique = new Set();
  for (const value of values) {
    const normalized = normalizeName(value);
    if (!normalized) {
      continue;
    }
    unique.add(normalized);
  }
  return [...unique];
}

function normalizeCallList(values = []) {
  const normalizedCalls = [];
  const seen = new Set();
  for (const value of values) {
    const caller = normalizeName(value?.caller);
    const callee = normalizeName(value?.callee);
    if (!callee) {
      continue;
    }
    const normalizedCaller = caller || "<module>";
    const dedupeKey = `${normalizedCaller}=>${callee}`;
    if (seen.has(dedupeKey)) {
      continue;
    }
    seen.add(dedupeKey);
    normalizedCalls.push({
      caller: normalizedCaller,
      callee,
    });
  }
  return normalizedCalls;
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

function walkAst(node, { enter, leave } = {}, parent = null) {
  if (!node || typeof node !== "object") {
    return;
  }
  if (Array.isArray(node)) {
    for (const child of node) {
      walkAst(child, { enter, leave }, parent);
    }
    return;
  }
  if (typeof enter === "function") {
    enter(node, parent);
  }
  for (const value of Object.values(node)) {
    if (value && typeof value === "object") {
      walkAst(value, { enter, leave }, node);
    }
  }
  if (typeof leave === "function") {
    leave(node, parent);
  }
}

function resolveBabelMemberName(node) {
  if (!node || typeof node !== "object") {
    return "";
  }
  if (node.type === "Identifier") {
    return normalizeName(node.name);
  }
  if (node.type === "StringLiteral") {
    return normalizeName(node.value);
  }
  if (node.type === "NumericLiteral") {
    return normalizeName(String(node.value));
  }
  if (node.type === "ThisExpression") {
    return "this";
  }
  if (node.type === "MemberExpression" || node.type === "OptionalMemberExpression") {
    const objectName = resolveBabelMemberName(node.object);
    const propertyName = resolveMemberPropertyName(node.property, Boolean(node.computed));
    if (objectName && propertyName) {
      return node.computed ? `${objectName}${propertyName}` : `${objectName}.${propertyName}`;
    }
    return propertyName || objectName;
  }
  return "";
}

function resolveMemberPropertyName(node, computed = false) {
  if (!node || typeof node !== "object") {
    return "";
  }
  if (!computed) {
    if (node.type === "Identifier") {
      return normalizeName(node.name);
    }
    return resolveBabelMemberName(node);
  }

  if (node.type === "StringLiteral") {
    return `[${normalizeName(node.value)}]`;
  }
  if (node.type === "NumericLiteral") {
    return `[${normalizeName(String(node.value))}]`;
  }
  if (node.type === "Identifier") {
    return `[${normalizeName(node.name)}]`;
  }

  const nested = resolveBabelMemberName(node);
  return nested ? `[${nested}]` : "[computed]";
}

function resolveClassName(node) {
  if (!node || typeof node !== "object") {
    return "";
  }
  if (node.type === "ClassDeclaration" && node.id && node.id.type === "Identifier") {
    return normalizeName(node.id.name);
  }
  if (node.type === "ClassExpression" && node.id && node.id.type === "Identifier") {
    return normalizeName(node.id.name);
  }
  return "";
}

function resolveFunctionName(node, parent, classStack = []) {
  if (!node || typeof node !== "object") {
    return "";
  }
  if (node.type === "FunctionDeclaration" && node.id && node.id.type === "Identifier") {
    return normalizeName(node.id.name);
  }
  if (
    (node.type === "FunctionExpression" || node.type === "ArrowFunctionExpression") &&
    parent &&
    parent.type === "VariableDeclarator" &&
    parent.id &&
    parent.id.type === "Identifier"
  ) {
    return normalizeName(parent.id.name);
  }
  if (
    (node.type === "FunctionExpression" || node.type === "ArrowFunctionExpression") &&
    parent &&
    parent.type === "AssignmentExpression" &&
    parent.left
  ) {
    return normalizeName(resolveBabelMemberName(parent.left));
  }
  if (
    (node.type === "ClassMethod" ||
      node.type === "ObjectMethod" ||
      node.type === "ClassPrivateMethod") &&
    node.key
  ) {
    const methodName =
      node.key.type === "Identifier"
        ? normalizeName(node.key.name)
        : node.key.type === "StringLiteral"
          ? normalizeName(node.key.value)
          : node.key.type === "PrivateName" && node.key.id && node.key.id.type === "Identifier"
            ? normalizeName(node.key.id.name)
            : "";
    if (!methodName) {
      return "";
    }
    const currentClass = classStack[classStack.length - 1] || "";
    if (currentClass) {
      return `${currentClass}.${methodName}`;
    }
    return methodName;
  }
  if (
    node.type === "ObjectProperty" &&
    node.value &&
    (node.value.type === "FunctionExpression" || node.value.type === "ArrowFunctionExpression")
  ) {
    const keyName =
      node.key && node.key.type === "Identifier"
        ? normalizeName(node.key.name)
        : node.key && node.key.type === "StringLiteral"
          ? normalizeName(node.key.value)
          : "";
    return keyName;
  }
  return "";
}

function parseBabelCallgraph(content = "", absolutePath = "") {
  const ast = parse(String(content || ""), {
    sourceType: "unambiguous",
    errorRecovery: true,
    allowAwaitOutsideFunction: true,
    plugins: buildBabelPlugins(absolutePath),
  });
  if (Array.isArray(ast.errors) && ast.errors.length > 0) {
    throw ast.errors[0];
  }

  const classStack = [];
  const functionStack = [];
  const symbols = new Set(["<module>"]);
  const calls = [];

  walkAst(ast, {
    enter(node, parent) {
      const className = resolveClassName(node);
      if (className) {
        classStack.push(className);
      }

      const functionName = resolveFunctionName(node, parent, classStack);
      if (functionName) {
        symbols.add(functionName);
        functionStack.push(functionName);
      } else if (
        node.type === "FunctionExpression" ||
        node.type === "ArrowFunctionExpression" ||
        node.type === "ClassMethod" ||
        node.type === "ObjectMethod" ||
        node.type === "ClassPrivateMethod"
      ) {
        functionStack.push("<anonymous>");
      }

      if (node.type === "CallExpression" || node.type === "OptionalCallExpression") {
        const callee = resolveBabelMemberName(node.callee);
        if (callee && callee !== "require" && callee !== "import") {
          const callerName = normalizeName(functionStack[functionStack.length - 1]);
          const caller = !callerName || callerName === "<anonymous>" ? "<module>" : callerName;
          calls.push({
            caller,
            callee,
          });
        }
      }

      if (node.type === "ImportExpression" && node.source) {
        const callerName = normalizeName(functionStack[functionStack.length - 1]);
        const caller = !callerName || callerName === "<anonymous>" ? "<module>" : callerName;
        calls.push({
          caller,
          callee: "import",
        });
      }
    },
    leave(node) {
      if (node.type === "ClassDeclaration" || node.type === "ClassExpression") {
        classStack.pop();
      }
      if (
        node.type === "FunctionDeclaration" ||
        node.type === "FunctionExpression" ||
        node.type === "ArrowFunctionExpression" ||
        node.type === "ClassMethod" ||
        node.type === "ObjectMethod" ||
        node.type === "ClassPrivateMethod"
      ) {
        functionStack.pop();
      }
    },
  });

  return {
    symbols: normalizeSymbolList([...symbols]),
    calls: normalizeCallList(calls),
  };
}

function parseRegexCallgraph(content = "", normalizedLanguage = "") {
  const raw = String(content || "");
  const symbols = new Set(["<module>"]);
  const calls = [];

  if (normalizedLanguage.includes("javascript") || normalizedLanguage.includes("typescript")) {
    const functionPattern = /\bfunction\s+([A-Za-z_$][A-Za-z0-9_$]*)\s*\(/g;
    let functionMatch;
    while ((functionMatch = functionPattern.exec(raw))) {
      symbols.add(functionMatch[1]);
    }
    const variableFunctionPattern =
      /\b(?:const|let|var)\s+([A-Za-z_$][A-Za-z0-9_$]*)\s*=\s*(?:async\s*)?(?:function\b|\([^)]*\)\s*=>|[A-Za-z_$][A-Za-z0-9_$]*\s*=>)/g;
    let variableMatch;
    while ((variableMatch = variableFunctionPattern.exec(raw))) {
      symbols.add(variableMatch[1]);
    }
  } else if (normalizedLanguage === "python") {
    const defPattern = /^\s*def\s+([A-Za-z_][A-Za-z0-9_]*)\s*\(/gm;
    let defMatch;
    while ((defMatch = defPattern.exec(raw))) {
      symbols.add(defMatch[1]);
    }
  }

  const callPattern = /\b([A-Za-z_][A-Za-z0-9_\.]*)\s*\(/g;
  let callMatch;
  while ((callMatch = callPattern.exec(raw))) {
    const callee = normalizeName(callMatch[1]);
    if (!callee) {
      continue;
    }
    if (
      [
        "if",
        "for",
        "while",
        "switch",
        "catch",
        "return",
        "function",
        "def",
        "class",
        "new",
      ].includes(callee)
    ) {
      continue;
    }
    calls.push({
      caller: "<module>",
      callee,
    });
  }

  return {
    symbols: normalizeSymbolList([...symbols]),
    calls: normalizeCallList(calls),
  };
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

const PYTHON_CALLGRAPH_SCRIPT = `
import ast
import json
import sys

target_path = sys.argv[1]
with open(target_path, "r", encoding="utf-8") as source_file:
    source_text = source_file.read()

tree = ast.parse(source_text, filename=target_path)
symbols = ["<module>"]
calls = []

class CallgraphVisitor(ast.NodeVisitor):
    def __init__(self):
        self.function_stack = []
        self.class_stack = []

    def _current_caller(self):
        return self.function_stack[-1] if self.function_stack else "<module>"

    def _qualify(self, name):
        if self.class_stack:
            return ".".join(self.class_stack + [name])
        return name

    def visit_ClassDef(self, node):
        self.class_stack.append(node.name)
        self.generic_visit(node)
        self.class_stack.pop()

    def visit_FunctionDef(self, node):
        qualified = self._qualify(node.name)
        symbols.append(qualified)
        self.function_stack.append(qualified)
        self.generic_visit(node)
        self.function_stack.pop()

    def visit_AsyncFunctionDef(self, node):
        qualified = self._qualify(node.name)
        symbols.append(qualified)
        self.function_stack.append(qualified)
        self.generic_visit(node)
        self.function_stack.pop()

    def visit_Call(self, node):
        callee = ""
        if isinstance(node.func, ast.Name):
            callee = node.func.id
        elif isinstance(node.func, ast.Attribute):
            callee = node.func.attr
        if callee:
            calls.append({
                "caller": self._current_caller(),
                "callee": callee,
            })
        self.generic_visit(node)

CallgraphVisitor().visit(tree)
print(json.dumps({"symbols": symbols, "calls": calls}))
`;

async function parsePythonCallgraph(absolutePath = "", content = "", normalizedLanguage = "python") {
  const executable = await resolvePythonExecutable();
  if (!executable) {
    return {
      ...parseRegexCallgraph(content, normalizedLanguage),
      parserMode: "regex_fallback_python",
      parseError: "python_executable_not_found",
    };
  }
  try {
    const { stdout } = await execFileAsync(executable, ["-c", PYTHON_CALLGRAPH_SCRIPT, absolutePath], {
      timeout: 15000,
      maxBuffer: 1024 * 1024,
    });
    const parsed = JSON.parse(String(stdout || "{}"));
    return {
      symbols: normalizeSymbolList(parsed.symbols),
      calls: normalizeCallList(parsed.calls),
      parserMode: "python_ast",
      parseError: "",
    };
  } catch (error) {
    const fallback = parseRegexCallgraph(content, normalizedLanguage);
    return {
      ...fallback,
      parserMode: "regex_fallback_python",
      parseError: normalizeString(error?.message) || "python_ast_callgraph_failed",
    };
  }
}

export async function parseFileCallgraph({
  absolutePath = "",
  content = "",
  language = "",
} = {}) {
  const normalizedLanguage = normalizeLanguage(language);
  if (normalizedLanguage.includes("javascript") || normalizedLanguage.includes("typescript")) {
    try {
      const parsed = parseBabelCallgraph(content, absolutePath);
      return {
        ...parsed,
        parserMode: "babel_ast",
        parseError: "",
      };
    } catch (error) {
      const fallback = parseRegexCallgraph(content, normalizedLanguage);
      return {
        ...fallback,
        parserMode: "regex_fallback",
        parseError: normalizeString(error?.message) || "babel_callgraph_parse_failed",
      };
    }
  }

  if (normalizedLanguage === "python") {
    return parsePythonCallgraph(absolutePath, content, normalizedLanguage);
  }

  const fallback = parseRegexCallgraph(content, normalizedLanguage);
  return {
    ...fallback,
    parserMode: "regex_fallback_generic",
    parseError: "",
  };
}

function createQualifiedSymbolId(pathValue = "", symbolName = "") {
  return `${normalizeString(pathValue)}#${normalizeName(symbolName) || "<module>"}`;
}

function createQualifiedNode(pathValue = "", symbolName = "") {
  return {
    id: createQualifiedSymbolId(pathValue, symbolName),
    path: normalizeString(pathValue),
    symbol: normalizeName(symbolName) || "<module>",
  };
}

export async function buildCallgraphOverlay({
  rootPath = ".",
  indexedFilesByPath,
  scopedPaths = [],
} = {}) {
  const parsedFiles = [];
  const symbolIndex = new Map();
  const rawCalls = [];
  const stats = {
    parsedFileCount: 0,
    fallbackParsedFileCount: 0,
    parseErrorCount: 0,
  };
  const nodes = [];

  for (const pathValue of scopedPaths) {
    const metadata = indexedFilesByPath.get(pathValue);
    if (!metadata) {
      continue;
    }
    const absolutePath = path.join(rootPath, pathValue);
    let content = "";
    try {
      content = await fsp.readFile(absolutePath, "utf-8");
    } catch {
      continue;
    }
    const parsed = await parseFileCallgraph({
      absolutePath,
      content,
      language: metadata.language,
    });
    if (parsed.parserMode === "babel_ast" || parsed.parserMode === "python_ast") {
      stats.parsedFileCount += 1;
    } else {
      stats.fallbackParsedFileCount += 1;
    }
    if (normalizeString(parsed.parseError)) {
      stats.parseErrorCount += 1;
    }

    const symbols = normalizeSymbolList(parsed.symbols);
    const symbolRecords = symbols.map((symbol) => createQualifiedNode(pathValue, symbol));
    for (const symbolRecord of symbolRecords) {
      nodes.push(symbolRecord);
      const existing = symbolIndex.get(symbolRecord.symbol) || [];
      existing.push(symbolRecord);
      symbolIndex.set(symbolRecord.symbol, existing);
    }

    const calls = normalizeCallList(parsed.calls);
    for (const call of calls) {
      rawCalls.push({
        path: pathValue,
        caller: call.caller || "<module>",
        callee: call.callee,
      });
    }

    parsedFiles.push({
      path: pathValue,
      parserMode: parsed.parserMode,
      parseError: normalizeString(parsed.parseError),
      symbolCount: symbols.length,
      callCount: calls.length,
    });
  }

  const edges = [];
  const edgeSet = new Set();
  for (const call of rawCalls) {
    const fromId = createQualifiedSymbolId(call.path, call.caller || "<module>");
    const preferredTargets = (symbolIndex.get(call.callee) || []).filter((entry) => entry.path === call.path);
    const fallbackTargets = symbolIndex.get(call.callee) || [];
    // When no same-file symbol exists, limit fallback fan-out to keep the graph bounded.
    const targets = preferredTargets.length > 0 ? preferredTargets : fallbackTargets.slice(0, MAX_FALLBACK_TARGETS);
    for (const target of targets) {
      const key = `${fromId}->${target.id}`;
      if (edgeSet.has(key)) {
        continue;
      }
      edgeSet.add(key);
      edges.push({
        from: fromId,
        to: target.id,
        callee: call.callee,
      });
    }
  }

  const dedupedNodes = [];
  const nodeSet = new Set();
  for (const node of nodes) {
    if (nodeSet.has(node.id)) {
      continue;
    }
    nodeSet.add(node.id);
    dedupedNodes.push(node);
  }

  return {
    nodes: dedupedNodes.sort((left, right) => left.id.localeCompare(right.id)),
    edges: edges.sort((left, right) => {
      if (left.from !== right.from) {
        return left.from.localeCompare(right.from);
      }
      if (left.to !== right.to) {
        return left.to.localeCompare(right.to);
      }
      return left.callee.localeCompare(right.callee);
    }),
    parsedFiles,
    summary: {
      nodeCount: dedupedNodes.length,
      edgeCount: edges.length,
      parsedFileCount: stats.parsedFileCount,
      fallbackParsedFileCount: stats.fallbackParsedFileCount,
      parseErrorCount: stats.parseErrorCount,
    },
  };
}
