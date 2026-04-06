/**
 * Jules Tanaka — Tool Wrappers
 *
 * Lightweight tool execution layer for the Jules frontend audit persona.
 * Each tool: executes, enforces budget BEFORE execution, emits telemetry,
 * and persists large results to disk.
 *
 * These are built directly for Jules — no generic framework dependency.
 * When the formal tool system (Batch O) lands, these become thin adapters.
 */

export { fileRead, FileReadError } from "./file-read.js";
export { grep, GrepError } from "./grep.js";
export { glob, GlobError } from "./glob.js";
export { shell, analyzeCommand, ShellError, ShellBlockedError } from "./shell.js";
export { fileEdit, FileEditError } from "./file-edit.js";
export { frontendAnalyze, FrontendAnalyzeError } from "./frontend-analyze.js";
export { runtimeAudit, RuntimeAuditError } from "./runtime-audit.js";
export { authAudit, AuthAuditError } from "./auth-audit.js";

export {
  dispatchTool,
  registerTool,
  isReadOnlyTool,
  listTools,
  createAgentContext,
  ToolDispatchError,
  BudgetExhaustedError,
} from "./dispatch.js";
