# Reference Patterns — Claude Code Architecture

These files are **architectural excerpts** from the Claude Code CLI source.
They are provided as reference patterns for SentiNelayer CLI development.

**DO NOT import or bundle these files.** Read them for design patterns, then write original implementations.

## Files

| File | Pattern | Used By |
|---|---|---|
| claude-code/Tool.ts | Tool interface, ToolDef, buildTool(), ToolUseContext | PR 0.1, 9.2, 10.1 |
| claude-code/tools.ts | Tool registry, getAllBaseTools() | PR 0.1 |
| claude-code/commands.ts | Command registry, lazy loading | PR 0.1 |
| claude-code/cost-tracker.ts | Cost tracking, session costs | PR 3.2 |
| claude-code/spawnMultiAgent.ts | Team spawning, mailbox messaging | PR 10.1, 12.1 |
