const SUPPORTED_CODING_AGENT_TABLE = Object.freeze({
  "claude-code": Object.freeze({
    name: "Claude Code",
    promptTarget: "claude",
    configFile: "CLAUDE.md",
    configDir: ".claude/",
  }),
  cursor: Object.freeze({
    name: "Cursor",
    promptTarget: "cursor",
    configFile: ".cursorrules",
    configDir: ".cursor/",
  }),
  copilot: Object.freeze({
    name: "GitHub Copilot",
    promptTarget: "copilot",
    configFile: ".github/copilot-instructions.md",
    configDir: ".github/",
  }),
  windsurf: Object.freeze({
    name: "Windsurf",
    promptTarget: "generic",
    configFile: ".windsurfrules",
    configDir: null,
  }),
  cody: Object.freeze({
    name: "Sourcegraph Cody",
    promptTarget: "generic",
    configFile: ".cody/cody.json",
    configDir: ".cody/",
  }),
  aider: Object.freeze({
    name: "Aider",
    promptTarget: "generic",
    configFile: ".aider.conf.yml",
    configDir: null,
  }),
  continue: Object.freeze({
    name: "Continue",
    promptTarget: "generic",
    configFile: ".continue/config.json",
    configDir: ".continue/",
  }),
  codex: Object.freeze({
    name: "OpenAI Codex",
    promptTarget: "codex",
    configFile: "AGENTS.md",
    configDir: null,
  }),
  bolt: Object.freeze({
    name: "Bolt.new",
    promptTarget: "generic",
    configFile: null,
    configDir: null,
  }),
  generic: Object.freeze({
    name: "Other",
    promptTarget: "generic",
    configFile: null,
    configDir: null,
  }),
});

const SUPPORTED_IDE_TABLE = Object.freeze({
  vscode: Object.freeze({
    name: "VS Code",
    detect: (env) =>
      String(env.TERM_PROGRAM || "").toLowerCase().includes("vscode") &&
      !String(env.CURSOR_TRACE_ID || "").trim(),
  }),
  cursor: Object.freeze({
    name: "Cursor",
    detect: (env) => Boolean(String(env.CURSOR_TRACE_ID || "").trim()),
  }),
  jetbrains: Object.freeze({
    name: "JetBrains",
    detect: (env) => Boolean(String(env.JETBRAINS_IDE || "").trim()),
  }),
  neovim: Object.freeze({
    name: "Neovim",
    detect: (env) => Boolean(String(env.NVIM || "").trim()),
  }),
  zed: Object.freeze({
    name: "Zed",
    detect: (env) => String(env.TERM_PROGRAM || "").trim().toLowerCase() === "zed",
  }),
  sublime: Object.freeze({
    name: "Sublime Text",
    detect: (env) => Boolean(String(env.SUBLIME_TEXT || "").trim()),
  }),
  vim: Object.freeze({
    name: "Vim",
    detect: (env) => Boolean(String(env.VIM || "").trim()),
  }),
  emacs: Object.freeze({
    name: "Emacs",
    detect: (env) => Boolean(String(env.INSIDE_EMACS || "").trim()),
  }),
  terminal: Object.freeze({
    name: "Terminal",
    detect: () => true,
  }),
});

const IDE_DETECTION_ORDER = Object.freeze([
  "cursor",
  "vscode",
  "jetbrains",
  "neovim",
  "zed",
  "sublime",
  "vim",
  "emacs",
  "terminal",
]);

export const DEFAULT_CODING_AGENT_ID = "generic";
export const DEFAULT_IDE_ID = "terminal";

export const SUPPORTED_CODING_AGENTS = SUPPORTED_CODING_AGENT_TABLE;
export const SUPPORTED_IDES = SUPPORTED_IDE_TABLE;

function normalizeKey(value) {
  return String(value || "")
    .trim()
    .toLowerCase();
}

export function listSupportedCodingAgents() {
  return Object.entries(SUPPORTED_CODING_AGENT_TABLE).map(([id, record]) => ({
    id,
    ...record,
  }));
}

export function resolveCodingAgent(agentId = DEFAULT_CODING_AGENT_ID) {
  const normalized = normalizeKey(agentId) || DEFAULT_CODING_AGENT_ID;
  const record = SUPPORTED_CODING_AGENT_TABLE[normalized];
  if (!record) {
    throw new Error(
      `Unsupported coding agent '${agentId}'. Use one of: ${Object.keys(SUPPORTED_CODING_AGENT_TABLE).join(", ")}`
    );
  }
  return {
    id: normalized,
    ...record,
  };
}

export function detectCodingAgentFromEnv(env = process.env) {
  const explicit = normalizeKey(env.SENTINELAYER_CODING_AGENT || env.CODING_AGENT || "");
  if (explicit && Object.prototype.hasOwnProperty.call(SUPPORTED_CODING_AGENT_TABLE, explicit)) {
    return resolveCodingAgent(explicit);
  }
  if (String(env.CURSOR_TRACE_ID || "").trim()) {
    return resolveCodingAgent("cursor");
  }
  return resolveCodingAgent(DEFAULT_CODING_AGENT_ID);
}

export function listSupportedIdes() {
  return Object.entries(SUPPORTED_IDE_TABLE).map(([id, record]) => ({
    id,
    name: record.name,
  }));
}

export function detectIdeFromEnv(env = process.env) {
  for (const id of IDE_DETECTION_ORDER) {
    const entry = SUPPORTED_IDE_TABLE[id];
    if (entry && typeof entry.detect === "function" && entry.detect(env)) {
      return {
        id,
        name: entry.name,
      };
    }
  }
  return {
    id: DEFAULT_IDE_ID,
    name: SUPPORTED_IDE_TABLE[DEFAULT_IDE_ID].name,
  };
}
