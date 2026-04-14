/**
 * Shared Tools — Common tool implementations for all personas.
 *
 * Generic file/search/edit tools live here. Domain-specific tools
 * (FrontendAnalyze, BackendAnalyze, DataAnalyze) stay in persona folders.
 * Each persona's dispatch.js imports SHARED_TOOLS and merges with its own.
 */

import { fileRead } from "./file-read.js";
import { grep } from "./grep.js";
import { glob } from "./glob.js";
import { shell } from "./shell.js";
import { fileEdit } from "./file-edit.js";

/**
 * Tool map for generic tools shared across all personas.
 * Merge with persona-specific tools in each persona's dispatch.js.
 */
export const SHARED_TOOLS = {
  FileRead: fileRead,
  Grep: grep,
  Glob: glob,
  Shell: shell,
  FileEdit: fileEdit,
};

/**
 * Read-only tool names (safe for concurrent execution in swarm sub-agents).
 */
export const SHARED_READ_ONLY_TOOLS = new Set(["FileRead", "Grep", "Glob"]);

// Re-export individual tools for direct import
export { fileRead, FileReadError } from "./file-read.js";
export { grep, GrepError } from "./grep.js";
export { glob, GlobError } from "./glob.js";
export { shell, analyzeCommand, buildScrubbedEnv, ShellError, ShellBlockedError } from "./shell.js";
export { fileEdit, FileEditError } from "./file-edit.js";
export { PathGuardError, resolveGuardedPath } from "./path-guards.js";

// Re-export dispatch infrastructure
export {
  createToolDispatcher,
  createAgentContext,
  ToolDispatchError,
  BudgetExhaustedError,
} from "./dispatch-core.js";
