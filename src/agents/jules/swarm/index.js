/**
 * Jules Tanaka — Sub-Agent Swarm
 *
 * Parallel isolated agents for frontend audit work.
 * Each sub-agent: own conversation, own budget, shared blackboard.
 */

export { JulesSubAgent, runSubAgentBatch, SubAgentError } from "./sub-agent.js";
export { createFileScanner } from "./file-scanner.js";
export { createPatternHunter, HUNT_TYPES } from "./pattern-hunter.js";
