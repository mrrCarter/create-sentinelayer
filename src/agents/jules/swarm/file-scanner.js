import { JulesSubAgent } from "./sub-agent.js";

const FILE_SCANNER_PROMPT = `You are a FileScanner sub-agent working for Jules Tanaka (SentinelLayer Frontend Specialist).

Your job: Read each file in your scope and extract a structured summary.

For each file, extract:
- componentName: the primary exported component/function name
- useStateCount: number of useState calls
- useEffectCount: number of useEffect calls
- imports: list of imported modules (just the module names)
- exports: list of exported names
- loc: approximate line count
- riskSignals: array of any of these detected patterns:
  - "dangerouslySetInnerHTML" if found
  - "eval" if found
  - "window_access_in_render" if window/document/localStorage used outside useEffect
  - "missing_cleanup" if useEffect has subscription/timer without return
  - "god_component" if useState count >= 16
  - "large_file" if LOC > 500

Use the FileRead tool to read each file. Use Grep if you need to search for patterns.

Return your findings as a JSON array in a \`\`\`json code block:
[
  {
    "file": "path/to/file.tsx",
    "componentName": "Dashboard",
    "useStateCount": 3,
    "useEffectCount": 2,
    "imports": ["react", "zustand", "./Header"],
    "exports": ["Dashboard"],
    "loc": 150,
    "riskSignals": [],
    "discoveredDependencies": ["./utils/formatDate", "../hooks/useAuth"]
  }
]

The discoveredDependencies field is critical: list any imports that point to files NOT in your assigned scope. These will be used to expand the audit coverage.

Be thorough but concise. Do not explain findings — just extract data.`;

/**
 * Create a FileScanner sub-agent for a batch of files.
 *
 * @param {object} config
 * @param {string} config.id - Unique ID (e.g., "scanner-dashboard")
 * @param {string[]} config.files - Files to scan
 * @param {object} config.budget - Budget slice
 * @param {object} config.blackboard - Shared blackboard
 * @param {object} [config.provider] - LLM provider overrides
 * @param {AbortController} [config.parentAbort]
 * @param {function} [config.onEvent]
 */
export function createFileScanner(config) {
  return new JulesSubAgent({
    id: config.id || `scanner-${Date.now()}`,
    role: "FileScanner",
    systemPrompt: FILE_SCANNER_PROMPT,
    allowedTools: ["FileRead", "Grep", "Glob"],
    scope: { files: config.files },
    budget: config.budget || {
      maxCostUsd: 0.5,
      maxOutputTokens: 3000,
      maxRuntimeMs: 60000,
      maxToolCalls: config.files.length * 2 + 5,
    },
    blackboard: config.blackboard,
    maxTurns: Math.min(config.files.length + 3, 15),
    provider: config.provider,
    parentAbort: config.parentAbort,
    onEvent: config.onEvent,
  });
}
