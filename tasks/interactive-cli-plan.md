# Interactive CLI + Admin Dashboard + Daemon Refresh — Execution Plan

Date: 2026-04-07
Status: Execution-ready

## PR Batch Plan

### PR I-1: Multi-repo detection + auto-ingest with live progress
- Detect `.git` directories in parent workspace
- Arrow-key repo selector via `prompts` package (already a dep)
- Auto-trigger ingest if `CODEBASE_INGEST.json` missing or stale
- Live progress output during ingest: "Scanning files...", "Building AST...", "Assigning domains..."
- Deterministic domain assignment from import graph (frontend/backend/data/infra)
- Orchestrator quick-pass to approve/reassign domain mappings
- Show completion summary: files, LOC, frameworks, risk surfaces, domains

### PR I-2: Interactive action menu + command routing
- After ingest: present action menu with arrow keys:
  1. 🔍 Audit (full / security / frontend / backend / etc.)
  2. 📝 Review (full / diff / staged)
  3. 🏗️ Add Feature (opens prompt for description)
  4. 🆕 Create Project (scaffold flow)
  5. ⚙️ More options... (config, cost, telemetry, watch, etc.)
- Audit submenu: all 13 personas + "Full audit (all 13 in parallel)"
- Review submenu: full / diff / staged
- Feature prompt: free-text description → spec generate
- Each choice routes to the existing command handler

### PR I-3: Session tracking — tokens, tools, time, cost per run
- Global session state: startTime, tokenCount, toolCallCount, costUsd
- Accumulate on every tool dispatch and LLM call
- Show live counter in terminal during long operations (like src's SpinnerAnimationRow)
- On completion: print summary line "Run complete: 3.2K tokens, 12 tools, $0.47, 45s"
- Include in dashboard sync payload (PR #179 already wires this)

### PR I-4: Pulse daemon periodic ingest refresh
- Rename: Pulse (our daemon, not Kairos)
- File watcher: detect when file count changes vs last ingest
- If delta detected: re-run ingest + AST + domain assignment (15-30s budget)
- Run on configurable interval (default: check every 60s when CLI is active)
- Emit refresh event to streaming consumers
- Budget-gated: if refresh takes >30s, abort and use stale ingest

### PR I-5: Admin CLI dashboard page (sentinelayer-web)
- New page: `/admin/cli` — CLI-specific telemetry
- Sections:
  - Live downloads / installs (from npm if available, or proxy metric)
  - Most-run commands (frequency chart)
  - Active CLI users (who signed up via sl auth login)
  - Command breakdown per user
  - Error streams with requestIds from CLI runs
  - Run history table with token/cost/duration per run
- New API endpoints if needed (or aggregate from existing /admin/stats)
- Reference link in main /admin nav sidebar

### PR I-6: Jules URL scanner → sentinelayer-api integration
- Wire `sl audit frontend --url <url>` to call `POST /api/v1/scan/url`
- Attach scan results (Lighthouse scores, headers, a11y findings) to the audit report
- Include scan results in spec generation context (if spec is regenerated after audit)
- Store scan results as artifacts alongside JULES_AUDIT.json

## Dependency Order

```
I-1 (multi-repo + auto-ingest) — no deps
I-2 (interactive menu) — depends on I-1
I-3 (session tracking) — no deps, parallel with I-1
I-4 (Pulse refresh) — depends on I-1 (ingest logic)
I-5 (admin page) — no CLI deps, web-only
I-6 (URL scanner) — already partially done in PR #178, needs completion
```

## Parallel execution plan
- I-1 + I-3 can run in parallel (different files)
- I-5 is web repo (completely independent)
- I-2 depends on I-1
- I-4 depends on I-1
- I-6 can start anytime
