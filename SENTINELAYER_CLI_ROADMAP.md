# SentiNelayer CLI — Enterprise-Grade PR Roadmap

> **Goal:** Transform the SentiNelayer CLI (`npx create-sentinelayer`) from a scaffold/bootstrap tool into an enterprise-grade, local-first CLI for spec generation, AI prompt crafting, security review orchestration, and optional direct AI invocation — inspired by the best patterns in the Claude Code CLI source.

---

## Current State (Audited 2026-03-31 via `gh` CLI against live repos)

### `create-sentinelayer` CLI (`mrrCarter/create-sentinelayer`, v0.1.0)
**Status:** Functional — already has more capability than a simple scaffold tool.

| Command | What it does today | Maturity |
|---|---|---|
| `npx create-sentinelayer <app>` | Interactive interview → browser auth → Sentinelayer API generates spec/prompt/guide → writes `docs/spec.md`, `docs/build-guide.md`, `prompts/execution-prompt.md`, `.github/workflows/omar-gate.yml`, `tasks/todo.md`, `AGENT_HANDOFF_PROMPT.md` → injects `SENTINELAYER_TOKEN` into repo secrets via `gh` | ✅ Production |
| `create-sentinelayer /omargate deep --path .` | **Local Omar Gate**: regex credential scan (AWS keys, private keys, API keys, hardcoded secrets), P1/P2 severity grading, writes report to `.sentinelayer/reports/` | ⚡ MVP (deterministic rules only, no AI layers, no sandbox) |
| `create-sentinelayer /audit --path .` | **Local audit**: readiness checks (workflow present? spec present? todo present?) + credential scan, overall PASS/FAIL, report to `.sentinelayer/reports/` | ⚡ MVP (3 hardcoded checks, no pluggable checklist) |
| `create-sentinelayer /persona orchestrator --mode <builder\|reviewer\|hardener>` | Generates persona instruction file with mode-specific directives + repo ingest summary | ⚡ MVP (static templates, no API call, no AI calibration) |
| `create-sentinelayer /apply --plan tasks/todo.md` | Parses checklist from todo.md, emits execution-order preview report | ⚡ MVP (parse + preview only, no execution) |
| `--non-interactive`, `--interview-file`, env var JSON | Headless/CI mode with full input contract via `SENTINELAYER_CLI_INTERVIEW_JSON` | ✅ Production |
| `npm run sentinel:*` scripts | Injects 6 convenience scripts into target project's `package.json` | ✅ Production |

**Architecture:** Single-file ESM (`bin/create-sentinelayer.js`, ~1200 lines). No Commander.js, no subcommand framework, no plugin system. Dependencies: `open`, `picocolors`, `prompts`.

### `sentinelayer-v1-action` — Omar Gate GitHub Action (`mrrCarter/sentinelayer-v1-action@v1`, v1.5.2)
**Status:** Production, 186+ tests across API and action repos.

| Capability | Implementation |
|---|---|
| **Bridge architecture** | Thin Python bridge: loads config from GHA inputs/env → triggers scan via Sentinelayer API (`POST /api/v1/github-app/trigger`) → polls for completion → emits outputs + GITHUB_STEP_SUMMARY |
| **Spec discovery** | Walks workspace, finds `spec.md`, `requirements.md`, `swe_excellence_framework.md` etc., computes composite SHA-256 spec hash |
| **Spec binding** | `spec_binding_mode: explicit|auto_discovered|none` — cryptographically binds scans to spec version |
| **Playwright gate** | Optional E2E test runner: `npm ci` → `npx playwright install` → runs baseline/audit command → pass/fail gate |
| **SBOM gate** | CycloneDX generation for Node + Python: JSON/XML, baseline vs audit modes |
| **Severity gating** | `severity_gate: P0|P1|P2|none` — blocks merge if findings exceed threshold |
| **Scan modes** | `baseline`, `deep` (default), `audit`/`full-depth` — maps to `/omar baseline`, `/omar deep-scan`, `/omar full-depth` |

### `sentinelayer-api` — Backend API (`mrrCarter/sentinelayer-api`)
**Status:** Production on ECS, Alembic at migration 034.

| Service | What it does |
|---|---|
| **BuilderService** | Multi-provider artifact generation (OpenAI → Anthropic → Google fallback chain), repo context ingest, spec validation + scoring. Mixins: persistence, prompts, repo context, templates |
| **InvestigationPackService** | 13 domain-specialist persona dispatch with per-persona contracts (confidence floors, escalation targets, evidence requirements) |
| **OmarCoreService** | Finding materialization with 13 risk surfaces: `security_overlay`, `ai_pipeline`, `release_engineering`, `supply_chain`, `infrastructure`, `observability`, `reliability_sre`, `testing_correctness`, `data_layer`, `frontend_runtime`, `backend_runtime`, `docs_knowledge`, `code_quality` |
| **PersonaPromptRegistry** | 13 named personas with dedicated system prompts: Nina Patel (Security), Maya Volkov (Backend), Jules Tanaka (Frontend), Linh Tran (Data), Omar Singh (Release Eng), Kat Hughes (Infrastructure), Noah Ben-David (Reliability), Sofia Alvarez (Observability), Priya Raman (Testing), Nora Kline (Supply Chain), Ethan Park (Code Quality), Samir Okafor (Docs), Amina Chen (AI Pipeline) |
| **PersonaCalibrationService** | Runtime calibration of persona confidence thresholds and escalation routing |
| **Billing** | Stripe-integrated billing with usage ledger, wallet, subscriptions (v1.2) |

### `AIdenID` — Ephemeral Identity Control Plane (`mrrCarter/AIdenID`)
**Status:** Production ECS deploy in progress (Cloudflare 522 cutover active), PR #82 pending.

| Capability | Implementation |
|---|---|
| **Identity lifecycle** | FastAPI + PostgreSQL + Redis: create → activate → use → expire/squash with tombstones |
| **Bulk creation** | `/v1/identities/bulk` — up to 10K identities per request with idempotency keys |
| **OTP extraction** | `extraction.py`: rules-v1 regex → LLM fallback with circuit breaker. Structured `ExtractionResult` (otp, primaryActionUrl, confidence) |
| **Email routing** | Cloudflare Worker (`workers/email-router/src/index.ts`): resolve recipient → archive raw → queue → extract |
| **Child identities** | Parent→child lineage with delegated policies, TTL inheritance, event budgets |
| **Temporary sites** | Lifecycle-linked ephemeral callback domains, auto-teardown on squash |
| **Demo scripts** | 17 PowerShell + 5 bash scripts covering create/list/squash/wait-for-extraction/8K-benchmark. **No formal CLI yet.** |
| **SDK** | `packages/sdk/src/index.ts`: `exchangeToken()`, `me()`, `createCheckoutSession()` — thin TypeScript client |

### Key Gaps (What the Roadmap Must Address)

1. **CLI is a monolith** — 1200-line single file, no subcommand framework, no plugin system, no tool registry
2. **Local Omar Gate is superficial** — regex-only credential scan with 5 rules. The API has 13 domain-specialist personas but none are accessible from the CLI
3. **Local audit has 3 hardcoded checks** — no pluggable checklist, no integration with the 13 risk surfaces the API already knows about
4. **No sandbox/isolation** — `/omargate deep` runs in the same process context as everything else, no adversarial independence
5. **No AI invocation from CLI** — all AI reasoning happens server-side via the API. The CLI has no local AI client
6. **No cost tracking** — the CLI doesn't track or display token/API costs
7. **No session management** — no persistence, no resume, no history
8. **No AIdenID CLI** — AIdenID has 22 demo scripts but no formal CLI commands; no integration path to SentiNelayer CLI
9. **Persona orchestrator is static** — the CLI's `/persona` command generates static instruction templates; the API's `PersonaCalibrationService` with dynamic contracts is unreachable from the CLI

---

## Architecture Patterns Borrowed from Claude Code

| Claude Code Pattern | Relevance to SentiNelayer CLI |
|---|---|
| **Commander.js subcommand tree** (`commands.ts` → `commands/`) | Scalable command registration with lazy-loaded subcommands |
| **Tool interface + registry** (`Tool.ts`, `tools.ts`) | Pluggable "tool" pattern for spec generators, prompt builders, scanners |
| **Permission system** (`PermissionMode`, sandbox) | Gate destructive operations (API calls, file writes) behind explicit consent |
| **Layered config** (global → project → managed → env) | `.sentinelayer.yml` at project root, `~/.sentinelayer/config.yml` global, env vars |
| **Cost tracker** (`cost-tracker.ts`, `modelCost.ts`) | Token budget management for optional AI invocation mode |
| **Session management** (session IDs, resume, persistence) | Persist spec-generation sessions for iterative refinement |
| **Ink/React TUI** (spinners, markdown rendering, progress) | Rich terminal output for spec previews and scan results |
| **MCP integration** (`services/mcp/`) | Future: expose SentiNelayer tools via MCP for IDE integration |
| **Hooks system** (`hooks/`) | Pre/post lifecycle hooks for spec generation pipeline |
| **Analytics with privacy guards** (`logEvent`, `AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS`) | Opt-in telemetry with strict no-code/no-filepath policy |
| **GrowthBook feature flags** | Progressive rollout of CLI features |
| **Plugin/skill loading** (`plugins/`, `skills/`) | Community-contributed spec templates and policy packs |
| **Token budget system** (`tokenBudget.ts`) | Hard caps on API spend with diminishing-returns detection |
| **Sandbox system** (`sandbox-adapter.ts`, `@anthropic-ai/sandbox-runtime`) | Isolated reviewer execution: read-only filesystem, network deny, OS-level containment (macOS sandbox-exec / Linux bubblewrap) |
| **Agent worktree isolation** (`AgentTool.tsx` → `createAgentWorktree`) | Spawn reviewer in an isolated git worktree — clean copy of repo, no shared mutable state with the coding agent |
| **In-process teammate isolation** (`spawnInProcess.ts`, `AsyncLocalStorage`) | Run agents in the same Node.js process with fully isolated context via `AsyncLocalStorage` — no shared conversation history |
| **Teammate mailbox** (`teammateMailbox.ts`) | File-based inter-agent messaging with file locks — reviewer sends findings to orchestrator without sharing memory |
| **Subprocess env scrubbing** (`subprocessEnv.ts`) | Strip API keys and secrets from child processes to prevent exfiltration — essential for sandboxed reviewer |
| **Permission gating** (`permissions.ts`, `PermissionMode`) | Multi-level permission pipeline: deny → ask → tool-specific check → mode check → allow. Reviewer gets `plan` mode (read-only) |
| **Agent definition system** (`loadAgentsDir.ts`) | Declarative agent configs: `isolation`, `omitClaudeMd`, `disallowedTools`, `permissionMode`, `maxTurns` per agent type |
| **Team orchestration** (`spawnMultiAgent.ts`, `teamHelpers.ts`) | Multi-agent spawn, team files, color-coded spinner tree — directly maps to audit swarm visualization |
| **AIdenID Identity API** (`/v1/identities`, `/v1/identities/bulk`) | Ephemeral identity provisioning with TTL, tags, policy, bulk creation up to 10K, idempotency keys |
| **AIdenID Extraction Pipeline** (`extraction.py` — rules-v1 → LLM fallback) | OTP/verification-link extraction from inbound emails: regex first, AI fallback with circuit breaker |
| **AIdenID Lifecycle Engine** (`lifecycle_service.py`, `workers/scheduler`) | Automatic squash on TTL expiry, tombstone creation, raw blob deletion, site DNS cleanup — irreversible |
| **AIdenID Simulation System** (`simulation_service.py`, `/v1/simulations`) | DRY_RUN + LIVE modes with compiled manifests, policy hashes, stop conditions, telemetry, reproducibility artifacts |
| **AIdenID Identity Lineage** (`identity_service.py` lineage, child identities, budget envelopes) | Parent→child identity trees with delegated policies, TTL inheritance, event budgets — swarm identity hierarchy |
| **AIdenID Temporary Sites** (`sites.py`, `TemporarySite`) | Ephemeral callback domains linked to identity lifecycle — auto-teardown on squash |
| **AIdenID Target Registry** (`domains.py`, ownership proofs, domain verification) | Domain ownership verification with DNS proofs, freeze/unfreeze controls, target policy enforcement |
| **AIdenID Email Router** (`workers/email-router/src/index.ts`) | Cloudflare Worker: resolve recipient → archive raw → queue → extract. Edge routing for identity mailboxes |
| **AIdenID SDK** (`packages/sdk/src/index.ts`) | TypeScript client: `exchangeToken()`, `me()`, `createCheckoutSession()` — thin API wrapper with timeout + abort |

---

## Phase 0 — Foundation & CLI Skeleton
**Priority:** P0 (must-ship first) · **Complexity:** Medium · **Dependencies:** None

> 📍 **Starting point:** The existing `create-sentinelayer` CLI (`bin/create-sentinelayer.js`) is a ~1200-line single ESM file with 3 deps (`open`, `picocolors`, `prompts`). It already has auth flow, API integration, `/omargate`, `/audit`, `/persona`, `/apply` slash commands, and `npm run sentinel:*` script injection. This phase migrates it to a proper multi-file TypeScript project with a subcommand framework — preserving all existing functionality.

### PR 0.1: CLI Entrypoint & Commander.js Subcommand Tree
**Inspired by:** `commands.ts` command registration pattern, `cli/main.ts` entrypoint
**Migrates from:** `bin/create-sentinelayer.js` monolith → `src/` directory with lazy-loaded subcommands

- Migrate existing `create-sentinelayer.js` to TypeScript project with ESM, `tsx` for dev, `esbuild` for bundling
- Extract existing slash commands (`/omargate`, `/audit`, `/persona`, `/apply`) into separate command modules
- Set up Commander.js with `program.command()` registration, replacing the manual `tryRunLocalCommandMode()` dispatch
- Preserve existing `run()` flow as `sentinelayer init` (scaffold + auth + generate)
- Lazy-load command handlers (dynamic `import()`) to keep startup < 200ms
- Add `--version`, `--help`, `--verbose`, `--json` global flags
- Entry: `#!/usr/bin/env node` bin in `package.json`
- **Migration test:** All existing e2e tests (`tests/e2e.test.mjs`) must continue to pass

### PR 0.2: Layered Configuration System
**Inspired by:** Claude Code's `utils/config.ts`, `settings/`, global → project → managed → env layering

- `~/.sentinelayer/config.yml` — global defaults (default model, API keys, output dir)
- `.sentinelayer.yml` at project root — project-level overrides
- Environment variables: `SENTINELAYER_TOKEN`, `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `GOOGLE_API_KEY`
- Config schema validation with Zod
- `sentinelayer config set/get/list/edit` subcommands
- Config migration support for future schema changes

### PR 0.3: Output Directory & Artifact Writer
**Inspired by:** Claude Code's tool result persistence (`toolResultStorage.ts`)

- Default output: `.sentinelayer/` at project root (configurable via `--output-dir` or config)

---

## Phase 1 — Local Spec & Prompt Generation (Offline-First)
**Priority:** P0 · **Complexity:** Medium-High · **Dependencies:** Phase 0

> 🔌 **No API key required** — all Phase 1 features work fully offline.

### PR 1.1: Codebase Ingestion Engine
**Inspired by:** Omar Gate's Phase 1 deterministic analysis (codebase ingest layer), Claude Code's file scanning in tools
**Builds on existing:** `buildRepoIngestSummary()` (dirs + files + package.json parsing), `collectScanFiles()` (recursive walk with ignore dirs)

- Upgrade existing `buildRepoIngestSummary()` from text summary to structured `CODEBASE_INGEST.json`
- Add tech stack detection (package.json, requirements.txt, go.mod, Cargo.toml, pyproject.toml — the API's `OmarCoreService._RISK_SURFACE_HINTS` already knows these)
- Build file tree with LOC counts, language breakdown, entry points
- Detect frameworks (Next.js, Express, Django, FastAPI, Rails, etc.)
- Map detected surfaces to the API's 13 risk surface categories
- Respect `.sentinelayerignore` (already exists in the v1-action) and `.gitignore`
- Performance target: < 5s for 50K LOC projects

### PR 1.2: Spec Generation Engine (Template-Based)
**Inspired by:** Sentinelayer Spec Builder web UI, Claude Code's `skills/` pattern

- `sentinelayer spec generate` — interactive or `--description "..."` mode
- Template engine: Handlebars/EJS templates for spec documents
- Built-in templates: SaaS app, API service, CLI tool, library, mobile app
- Inputs: codebase ingest + user description + template
- Outputs: `SPEC.md` (phases, schema, endpoints, security checklist, acceptance criteria)
- `sentinelayer spec list-templates` / `sentinelayer spec show-template <name>`

### PR 1.3: AI Builder Prompt Generator
**Inspired by:** Spec Builder's "AI builder prompt you can paste into Cursor, Claude Code, Copilot"

- `sentinelayer prompt generate` — reads `SPEC.md` and produces agent-ready prompts
- Target formats: Claude Code system prompt, Cursor rules, Copilot instructions, generic
- `--agent cursor|claude|copilot|codex|generic` flag
- Prompt includes: project context, architecture constraints, phase-by-phase instructions
- Output: `PROMPT.md` or `PROMPT_<agent>.md`
- `sentinelayer prompt preview` — renders prompt in terminal with markdown formatting

### PR 1.4: Omar Gate Config Generator
**Inspired by:** Omar Gate action.yml input contract

- `sentinelayer scan init` — generates `.github/workflows/security-review.yml`
- Reads spec to determine appropriate `scan_mode`, `severity_gate`, Playwright/SBOM settings
- Interactive wizard: "Do you have E2E tests?" → sets `playwright_mode`
- Outputs workflow file + instructions for setting `SENTINELAYER_TOKEN` secret
- `sentinelayer scan validate` — validates existing workflow against current spec

### PR 1.5: Build Guide Generator
**Inspired by:** Spec Builder's "phase-by-phase build guide"

- `sentinelayer guide generate` — reads spec and produces step-by-step implementation guide
- Phases with estimated effort, dependencies, acceptance criteria
- Outputs: `BUILD_GUIDE.md`
- `sentinelayer guide export --format jira|linear|github-issues` — export phases as issue tracker tickets

---

## Phase 2 — Rich Terminal UI & Developer Experience
**Priority:** P1 · **Complexity:** Medium · **Dependencies:** Phase 0

### PR 2.1: Ink-Based Interactive Mode
**Inspired by:** Claude Code's Ink/React TUI (`ink/ink.tsx`, `components/Spinner.tsx`)

- `sentinelayer` (no subcommand) → launches interactive REPL mode
- Ink-based UI with: spinner during generation, progress bars, markdown preview
- Interactive spec refinement: "Add a payments module" → re-generates spec
- Arrow-key navigation for template selection
- Full-screen spec preview with scrolling

### PR 2.2: Terminal Markdown Renderer
**Inspired by:** Claude Code's `components/Markdown.tsx`, `utils/markdown.ts`

- Render spec/prompt/guide output as styled terminal markdown
- Syntax highlighting for code blocks (using `cli-highlight`)
- Table rendering for schema definitions and endpoint lists
- `sentinelayer spec show` / `sentinelayer prompt show` — preview artifacts in terminal

### PR 2.3: Diff-Aware Regeneration
**Inspired by:** Claude Code's session management, `StreamingMarkdown`

- Track which sections of a spec were manually edited vs generated
- `sentinelayer spec regenerate` — re-runs generation, preserves manual edits
- Show diff before overwriting: green/red terminal diff output
- `--dry-run` flag to preview changes without writing

### PR 2.4: Progress & Notifications
**Inspired by:** Claude Code's `terminal.ts` Progress type, `useTerminalNotification.ts`

- Terminal progress indicators (OSC 9;4) for long operations
- Desktop notifications (iTerm2/Kitty/Ghostty) on completion
- Bell notification on error
- `--quiet` mode for CI environments

---

## Phase 3 — Optional AI-Powered Enhancement (API Key Required)
**Priority:** P1 · **Complexity:** High · **Dependencies:** Phase 0, Phase 1

> ⚠️ **Requires API key** — these features invoke AI models directly. Works with standard OpenAI/Anthropic/Google API keys (no enterprise tier needed).

### PR 3.1: Multi-Provider API Client
**Inspired by:** Claude Code's `services/api/` (Anthropic, Bedrock, Vertex), `utils/model/providers.ts`

- Support: OpenAI, Anthropic, Google (Gemini) via standard API keys
- Provider auto-detection from env vars: `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `GOOGLE_API_KEY`
- `sentinelayer config set provider openai` / `--provider` flag
- Model selection: `--model gpt-4o` / `--model claude-sonnet-4` / `--model gemini-2.5-pro`
- Retry logic with exponential backoff
- Streaming support for real-time output

### PR 3.2: Cost Tracking & Token Budget System
**Inspired by:** Claude Code's `cost-tracker.ts`, `tokenBudget.ts`, `modelCost.ts`

- Track token usage per session: input, output, cache read/write
- Cost calculation per provider/model (pricing table)
- `--max-cost <dollars>` hard cap (default: $1.00 per invocation)
- `--max-tokens <count>` output token limit
- `sentinelayer cost` — show session costs
- Diminishing-returns detection: stop if AI is looping without progress
- Cost summary in terminal after each AI invocation
- Per-project cost history in `.sentinelayer/cost-history.json`

### PR 3.3: AI-Enhanced Spec Generation
**Inspired by:** Claude Code's query loop, system prompts, tool use patterns

- `sentinelayer spec generate --ai` — uses AI to generate richer specs
- Sends codebase ingest + user description to AI
- AI generates: detailed schema, API endpoints, security considerations, edge cases
- Structured output parsing (JSON mode) for reliable spec extraction
- Falls back to template-based generation if API fails or budget exceeded
- Show cost estimate before invoking: "This will cost ~$0.03. Proceed? [Y/n]"

### PR 3.4: AI-Powered Security Pre-Scan
**Inspired by:** Omar Gate's AI phase (Layer 5), Claude Code's tool use patterns

- `sentinelayer scan preview --ai` — local AI-powered security pre-scan before pushing
- Uses codebase ingest to identify high-risk files (auth, payments, DB, env)
- Sends only high-risk file diffs to AI for analysis (token-efficient)
- Outputs: `SECURITY_PREVIEW.md` with findings, severity, suggested fixes
- Budget: capped at `--max-cost $0.50` default for scan operations
- No Sentinelayer API required — runs entirely local with user's own API key

---

## Phase 4 — Session Management & Persistence
**Priority:** P2 · **Complexity:** Medium · **Dependencies:** Phase 1

### PR 4.1: Session System
**Inspired by:** Claude Code's session management (`state/`, session IDs, resume)

- Each `sentinelayer spec generate` creates a session with UUID
- Sessions stored in `.sentinelayer/sessions/<uuid>/`
- Contains: inputs, generated artifacts, conversation history (if AI mode)
- `sentinelayer sessions list` / `sentinelayer sessions resume <uuid>`
- Auto-resume last session if artifacts exist and spec hasn't changed

### PR 4.2: Spec Versioning & History
**Inspired by:** Claude Code's `saveCurrentSessionCosts`, project config persistence

- Track spec revisions: `SPEC.v1.md`, `SPEC.v2.md` or git-style diffs
- `sentinelayer spec history` — show revision timeline
- `sentinelayer spec diff v1 v2` — compare spec versions
- `sentinelayer spec rollback <version>` — restore previous version

### PR 4.3: Spec-to-Code Binding
**Inspired by:** Omar Gate's spec hash binding (`sentinelayer_spec_hash`, `spec_binding_mode`)

- Hash the spec and embed it in generated artifacts
- Omar Gate can verify PR code was built against the current spec
- `sentinelayer spec bind` — writes spec hash to `.sentinelayer/spec.lock`
- CI can fail if code diverges from bound spec

---

## Phase 5 — Plugin & Extensibility System
**Priority:** P2 · **Complexity:** High · **Dependencies:** Phase 0, Phase 1

### PR 5.1: Plugin Architecture
**Inspired by:** Claude Code's `plugins/` directory, skill loading, tool registry

- Plugin interface: `SentinelayerPlugin { name, version, register(cli) }`
- Plugins can register: new commands, spec templates, prompt formats, scanners
- Plugin discovery: `node_modules/sentinelayer-plugin-*`
- `sentinelayer plugin list` / `sentinelayer plugin install <name>`
- Plugin config in `.sentinelayer.yml` under `plugins:` key

### PR 5.2: Custom Spec Templates
**Inspired by:** Claude Code's `skills/` pattern, skill configuration

- Community-contributed spec templates as npm packages
- Template format: Handlebars + metadata YAML (name, description, variables)
- `sentinelayer template create` — scaffold a new template
- Template marketplace: `sentinelayer template search <query>`
- Local templates in `.sentinelayer/templates/`

### PR 5.3: Custom Policy Packs
**Inspired by:** Omar Gate's "community policy pack" vs "custom policy packs"

- Policy pack: set of security rules, scan configs, severity mappings
- Built-in: `community` (default), `strict`, `compliance-soc2`, `compliance-hipaa`
- Custom packs via plugin system
- `sentinelayer policy list` / `sentinelayer policy use <pack>`

---

## Phase 6 — MCP Integration & IDE Support
**Priority:** P2 · **Complexity:** High · **Dependencies:** Phase 1, Phase 3

### PR 6.1: MCP Server Mode
**Inspired by:** Claude Code's `services/mcp/` (server configs, tool discovery, transport)

- `sentinelayer mcp serve` — expose SentiNelayer tools as an MCP server
- Tools: `generate_spec`, `generate_prompt`, `scan_preview`, `show_ingest`
- Transport: stdio (for IDE integration) and SSE (for remote)
- Any MCP-compatible client (Claude Desktop, Cursor, VS Code) can use SentiNelayer tools
- Tool schemas follow MCP specification exactly

### PR 6.2: VS Code Extension Bridge
**Inspired by:** Claude Code's IDE integrations

- VS Code extension that launches `sentinelayer mcp serve` as a subprocess
- Commands in VS Code command palette: "SentiNelayer: Generate Spec", "SentiNelayer: Preview Prompt"
- Inline spec preview in editor webview
- Status bar showing current spec binding status

---

## Phase 7 — Advanced AI Features (Stretch Goals)
**Priority:** P3 · **Complexity:** Very High · **Dependencies:** Phase 3

> 🚨 **Higher API spend warning** — these features push toward Claude Code-style interactive AI usage. Flag estimated costs clearly.

### PR 7.1: Interactive AI Spec Refinement (REPL Mode)
**Inspired by:** Claude Code's REPL (`screens/REPL.tsx`), streaming responses

- `sentinelayer spec refine --ai` — enter conversational mode
- "Add authentication with OAuth2" → AI updates spec in real-time
- Streaming markdown rendering of spec changes
- Each refinement round shows cost delta
- Auto-save after each refinement step
- Estimated cost: $0.05–0.30 per refinement session

### PR 7.2: Hooks & Lifecycle System
**Inspired by:** Claude Code's `hooks/` system (pre/post tool execution)

- `sentinelayer.hooks.yml` — define lifecycle hooks
- Hooks: `pre-spec`, `post-spec`, `pre-prompt`, `post-prompt`, `pre-scan`, `post-scan`, `pre-review`, `post-review`, `pre-audit`, `post-audit`
- Hook types: shell command, Node.js script, HTTP webhook
- Use case: auto-commit generated artifacts, notify Slack, trigger CI
- **Maps to `AGENTS.md` §4 "Verification Before Done":** hooks can enforce "run tests before marking complete"

---

## Phase 9 — Local Omar Gate (Isolated Reviewer)
**Priority:** P1 · **Complexity:** Very High · **Dependencies:** Phase 1, Phase 3

> 🛡️ **The core security moat.** This phase brings Omar Gate's 7-layer security pipeline from GitHub Actions into the CLI, running locally with full codebase access and **adversarial isolation** from the coding agent.
>
> 📍 **Starting point:** The CLI already has `runLocalOmarGateCommand()` (5 regex rules, P1/P2 severity, report output) and `runLocalAuditCommand()` (3 readiness checks + credential scan). The API already has 13 domain-specialist personas with per-persona contracts, confidence floors, escalation targets, and calibration. This phase dramatically expands the CLI's local review capability and wires it to the persona system.
>
> **Maps to AGENTS.md:** "Verification Before Done" (§4), "Autonomous Bug Fixing" (§6), "No Laziness: Find root causes" (Core Principles)
> **Maps to SWE Framework:** Section E.4 (Security Coverage), Section K (Tool/MCP Security), Section J (Agent Harness Hygiene)

### PR 9.1: Reviewer Sandbox & Isolation Runtime
**Inspired by:** Claude Code's `sandbox-adapter.ts`, `SandboxManager`, `@anthropic-ai/sandbox-runtime` (macOS sandbox-exec / Linux bubblewrap)
**Maps to:** SWE Framework §K.1 (Tool Security Controls), §H.2 (Isolated build environments)

- Design `ReviewerSandbox` — an OS-level isolated execution environment for the reviewer
- **Filesystem:** Read-only access to project root + the diff under review. Write access only to `.sentinelayer/reviews/`
- **Network:** Deny all network by default. Allow only the configured AI provider endpoint (and only when `--ai` is passed)
- **Secrets:** Strip all env vars except explicitly allowlisted ones (`subprocessEnv.ts` pattern)
- **macOS:** Use `sandbox-exec` profiles (same approach as Claude Code)
- **Linux:** Use `bubblewrap` (bwrap) for namespace isolation (same approach as Claude Code)
- **Windows:** Use process-level isolation with restricted tokens; document limitations
- `sentinelayer config set sandbox.enabled true` to opt in (default: off for initial rollout)
- Complexity: Very High · API Key: No (sandbox is local) · Est. cost: $0

### PR 9.2: Deterministic Review Pipeline (The 80%)
**Inspired by:** Omar Gate's 4 deterministic layers, Claude Code's `shouldUseSandbox.ts`
**Builds on existing:** `runCredentialScan()` (5 regex rules), `runLocalAuditCommand()` (3 readiness checks), Omar action's `_discover_spec_sources()` and `_compute_spec_hash_from_sources()`
**Maps to:** SWE Framework §E.4 (SAST + dependency scanning + secret scanning), AGENTS.md "Simplicity First"

- `sentinelayer review <path|--diff|--staged>` — run deterministic checks locally
- **Layer 1 — Codebase Ingest:** Reuse PR 1.1's ingest engine to detect tech stack, entry points, risk surface (mapping to the API's 13 risk surface categories from `OmarCoreService._RISK_SURFACE_HINTS`)
- **Layer 2 — Structural Analysis:**
  - Upgrade existing 5-rule `runCredentialScan()` to 20+ rules covering AWS keys, private keys, API keys, hardcoded credentials, high-entropy strings, `.env` patterns, hardcoded URLs, database connection strings
  - Dependency audit: `npm audit`, `pip audit`, `cargo audit` (auto-detected by tech stack)
  - SBOM generation: `syft` or built-in lockfile parser
  - License compliance: scan dependency licenses against allowed/denied lists
- **Layer 3 — Static Analysis Orchestration:**
  - Run project's own linter/typecheck if detected: `eslint`, `tsc --noEmit`, `mypy`, `clippy`
  - Run formatters in check mode: `prettier --check`, `black --check`
  - Run test suite: detect and execute `npm test`, `pytest`, `cargo test` etc.
  - Capture pass/fail, coverage %, and timing
- **Layer 4 — Pattern Matching:**
  - `SWE_excellence_framework.md` checks automated: N+1 queries, god components, missing useEffect cleanup, stale closures
  - Omar Gate severity mapping: P0 (block), P1 (critical), P2 (warning), P3 (info)
  - Check against spec hash binding (PR 4.3): is the code built against the current spec?
- All findings include: **file path, line number, code excerpt, rule ID, severity, suggested fix**
- Output: `REVIEW_DETERMINISTIC.json` + `REVIEW_DETERMINISTIC.md`
- Runs in sandbox (PR 9.1) when enabled
- Complexity: High · API Key: No · Est. cost: $0

### PR 9.3: AI-Powered Review Layers (The 20%)
**Inspired by:** Omar Gate's AI layers (5–7), Claude Code's `runAgent.ts` with isolated `ToolUseContext`
**Wires up existing API capability:** `InvestigationPackService` persona dispatch (13 personas with per-persona contracts, confidence floors, escalation targets), `PersonaPromptRegistry` (13 system prompt files in `src/prompts/omar_personas/`), `PersonaCalibrationService`
**Maps to:** SWE Framework §F (AI Tooling Governance), §I (AI Evals), AGENTS.md "Demand Elegance"

- `sentinelayer review --ai <path|--diff>` — add AI reasoning on top of deterministic findings
- **Two modes:**
  - **Local mode** (default): CLI sends high-risk files + deterministic findings directly to user's AI provider API key. Uses embedded copies of the persona system prompts from `PersonaPromptRegistry`
  - **API mode** (`--via-api`): delegates to the Sentinelayer API's `InvestigationPackService` for full persona dispatch with calibration
- **Layer 5 — AI Code Review (maps to persona dispatch):**
  - Route findings to relevant personas based on detected risk surfaces (e.g., `security_overlay` files → Nina Patel persona, `data_layer` → Linh Tran, etc.)
  - Each persona applies its domain contract: `confidence_floor`, `evidence_requirements`, `escalation_targets`
  - System prompt embeds the `SWE_excellence_framework.md` scoring criteria
- **Layer 6 — AI Security Deep Dive:**
  - AI examines auth flows, payment handling, DB queries for logic vulnerabilities
  - Cross-references OWASP Top 10, CWE database
  - Produces exploit scenario descriptions (not just "this is risky" but "here's how it could be exploited")
- **Layer 7 — AI Spec Compliance:**
  - Compares implementation against `SPEC.md`: are all acceptance criteria met?
  - Detects scope creep: code that doesn't map to any spec phase
  - Detects missing implementations: spec phases with no corresponding code
- **Context isolation is critical:** The AI reviewer receives ONLY the codebase + diff + deterministic findings. It NEVER sees the coding agent's conversation history, reasoning, or intent. This preserves adversarial independence.
- Token budget: `--max-cost $1.00` default for review (configurable)
- Show cost estimate before invoking AI layers
- Output: `REVIEW_AI.json` + `REVIEW_AI.md`
- Complexity: Very High · API Key: Yes (standard) · Est. cost: $0.10–1.50 per review

### PR 9.4: Unified Review Report & Reconciliation
**Inspired by:** Claude Code's `writeAgentMetadata`, `recordSidechainTranscript`
**Maps to:** SWE Framework §M (HITL Governance), §L (Agent Observability), AGENTS.md §4 "Verification Before Done"

- Merge deterministic + AI findings into a single `REVIEW_REPORT.md`
- **Deduplication:** If AI and deterministic checks flag the same issue, consolidate with highest severity
- **Confidence scoring:** Each finding gets a confidence score (deterministic = 100%, AI = model-reported)
- **Severity matrix:** P0 (blocks merge), P1 (critical, fix before release), P2 (warning), P3 (info)
- **HITL interface:** `sentinelayer review accept|reject|defer <finding-id>` — human adjudication of each finding
- **SWE Framework §M.2 mapping:** Truth verdict, severity verdict, reproducibility verdict, remediation usefulness score
- Report includes: commit SHA, spec hash, tool versions, model + temperature used, timestamps
- `sentinelayer review show` — pretty-print the report in terminal
- `sentinelayer review export --format sarif|json|md|github-annotations` — export findings for CI integration
- Complexity: High · API Key: No · Est. cost: $0

### PR 9.5: Review Reproducibility & Replay
**Inspired by:** Claude Code's session management (session IDs, resume, persistence)
**Maps to:** SWE Framework §N (AI Delivery Metrics — reproducibility success rate), AGENTS.md "Verification Before Done"

- Every review run is assigned a UUID and persisted to `.sentinelayer/reviews/<uuid>/`
- Persisted data: git state (commit SHA, branch, dirty files), deterministic check outputs, AI prompts verbatim, model name + version + temperature, all findings, HITL adjudication decisions
- `sentinelayer review replay <uuid>` — re-run identical checks against the same codebase state
- Deterministic checks MUST produce identical results (if not, log a drift warning)
- AI checks log differences between original and replay (model non-determinism is expected; large divergence flags an issue)
- `sentinelayer review diff <uuid1> <uuid2>` — compare two review runs
- Complexity: Medium · API Key: Only for AI replay · Est. cost: $0 (deterministic) / $0.10–1.50 (AI replay)

---

## Phase 10 — Domain-Specific Audit Swarm (`sentinelayer audit`)
**Priority:** P2 · **Complexity:** Very High · **Dependencies:** Phase 9, Phase 3

> 🔬 **Flagship investor due diligence tool.** Deploys isolated specialist agents in parallel, each examining a specific quality domain. Produces a unified, reproducible audit report suitable for technical DD.
>
> **Maps to AGENTS.md:** "Subagent Strategy" (§2 — one task per subagent), "Verification Before Done" (§4)
> **Maps to SWE Framework:** Entire document — each agent maps to specific sections

### PR 10.1: Audit Orchestrator & Agent Registry
**Inspired by:** Claude Code's `spawnMultiAgent.ts` (team spawning, team files), `loadAgentsDir.ts` (agent definitions)
**Maps to:** AGENTS.md §2 "Subagent Strategy — one task per subagent for focused execution"

- `sentinelayer audit` — launches the full audit swarm
- **Orchestrator process:**
  - Reads config to determine which specialist agents to deploy
  - Spawns each agent in its own isolated context (no cross-contamination)
  - Monitors progress and collects findings
  - Produces the unified report
- **Agent registry maps to existing API persona system:**
  - The API's `PersonaPromptRegistry` already defines 13 named personas. The CLI's audit agents embed the same persona identities and domain expertise locally:
    - **Nina Patel** (Security) → Security Agent, **Maya Volkov** (Backend) → Architecture Agent, **Jules Tanaka** (Frontend) → Frontend Agent, **Linh Tran** (Data) → Data Layer Agent, **Omar Singh** (Release Eng) → Release Agent, **Kat Hughes** (Infra) → Infrastructure Agent, **Noah Ben-David** (SRE) → Reliability Agent, **Sofia Alvarez** (Observability) → Observability Agent, **Priya Raman** (Testing) → Testing Agent, **Nora Kline** (Supply Chain) → Supply Chain Agent, **Ethan Park** (Code Quality) → Code Quality Agent, **Samir Okafor** (Docs) → Documentation Agent, **Amina Chen** (AI Pipeline) → AI Governance Agent
  - Per-persona contracts from `InvestigationPackService` apply: `confidence_floor`, `evidence_requirements`, `escalation_targets`
  - Agent config: `name`, `domain`, `tools`, `permissionMode: 'plan'`, `maxTurns`, `system_prompt`
  - Built-in agents ship with the CLI (persona prompts embedded); custom agents via plugin system (Phase 5)
- `sentinelayer audit --agents security,architecture,testing` — run specific agents only (maps to `--personas nina_patel,maya_volkov,priya_raman`)
- `sentinelayer audit --max-parallel 3` — control concurrency (for API rate limits)
- Complexity: Very High · API Key: Yes (for AI-powered agents) · Est. cost: $1–5 total for all agents

### PR 10.2: Security Specialist Agent
**Inspired by:** Claude Code's `Explore` agent (read-only, `disallowedTools`, `omitClaudeMd`), Omar Gate's security layers
**Maps to:** SWE Framework §E.4 (Security Coverage), §K (Tool/MCP Security)

- **Domain:** Vulnerability scanning, dependency audit, secrets detection, OWASP checks
- **Isolation:** Read-only filesystem access, `permissionMode: 'plan'`, `disallowedTools: [FileEdit, FileWrite, Bash(destructive)]`
- **Deterministic tools:** `npm audit`, `pip audit`, secret regex scanner, license checker, SBOM generator
- **AI analysis (if API key):** Examines auth flows, injection surfaces, data handling patterns
- **System prompt:** Embeds SWE Framework §E.4 checklist + OWASP Top 10
- **Output:** `AUDIT_SECURITY.md` with findings keyed to file:line with severity P0–P3
- Estimated cost: $0 (deterministic-only) / $0.20–0.50 (with AI)

### PR 10.3: Architecture Specialist Agent
**Inspired by:** Claude Code's agent `isolation: 'worktree'` pattern (read-only copy of repo)
**Maps to:** SWE Framework §D (Data Flow & Wiring), §B.4 (External Service Integration)

- **Domain:** Design pattern analysis, coupling/cohesion metrics, scalability review, circular dependency detection
- **Deterministic tools:** `madge --circular`, dependency graph builder, LOC distribution, component count
- **AI analysis:** Coupling/cohesion assessment, scalability bottleneck identification, single-point-of-failure detection
- **System prompt:** Embeds SWE Framework §D (Data Flow), §B.5 (Scaling Readiness), §C (Infrastructure Consistency)
- **Output:** `AUDIT_ARCHITECTURE.md`
- Estimated cost: $0 (deterministic-only) / $0.20–0.50 (with AI)

### PR 10.4: Testing Specialist Agent
**Inspired by:** Claude Code's tool execution patterns (BashTool for running tests)
**Maps to:** SWE Framework Appendix "QA Lifecycle Coverage", AGENTS.md §4 "run tests, check logs"

- **Domain:** Coverage analysis, test quality assessment, missing test detection
- **Deterministic tools:** Run test suite, parse coverage reports (istanbul, coverage.py, tarpaulin)
- **AI analysis:** Identify untested critical paths, assess test quality (assertions, edge cases), detect flaky patterns
- **System prompt:** Embeds SWE Framework QA Lifecycle Coverage matrix
- **Output:** `AUDIT_TESTING.md` with coverage %, critical untested paths, test quality score
- Estimated cost: $0 (deterministic-only) / $0.15–0.30 (with AI)

### PR 10.5: Performance Specialist Agent
**Inspired by:** Claude Code's cost tracker pattern (measuring efficiency per operation)
**Maps to:** SWE Framework §A.2 (Core Web Vitals), §B.1 (Query Optimization), §B.5 (Traffic Scaling)

- **Domain:** Algorithmic complexity, memory leak patterns, N+1 queries, bundle size
- **Deterministic tools:** Bundle analyzer, `madge` for import graph size, regex for N+1 patterns, Lighthouse CI
- **AI analysis:** Algorithmic complexity assessment, memory leak pattern detection, query optimization suggestions
- **System prompt:** Embeds SWE Framework §A.2 (CWV targets), §A.3 (Bundle thresholds), §B.1 (Query targets)
- **Output:** `AUDIT_PERFORMANCE.md`
- Estimated cost: $0 (deterministic-only) / $0.15–0.30 (with AI)

### PR 10.6: Compliance Specialist Agent
**Inspired by:** Omar Gate's policy pack system, Claude Code's managed settings (enterprise policy enforcement)
**Maps to:** SWE Framework §H (AI Change Provenance), §O (AI Release Controls), §F (AI Tooling Governance)

- **Domain:** License compliance, data handling, regulatory requirements, AI governance
- **Deterministic tools:** License scanner, SBOM generator, `.env` auditor, AI instruction file checker
- **AI analysis:** Data flow tracing for PII/PHI, regulatory gap analysis, policy compliance assessment
- **System prompt:** Embeds SWE Framework §F (AI Tooling Governance), §H (Provenance), §O (Release Controls)
- **Checks from SWE Framework §G:** Verifies presence of `AGENTS.md`, `.github/copilot-instructions.md`, path-scoped instruction files for `auth/`, `payments/`, `db/`, `infra/`
- **Output:** `AUDIT_COMPLIANCE.md`
- Estimated cost: $0 (deterministic-only) / $0.15–0.30 (with AI)

### PR 10.7: Documentation Specialist Agent
**Inspired by:** Claude Code's `Explore` agent (read-only analysis)
**Maps to:** SWE Framework §G (AI Instruction Topology), §E.5 (DD Evidence Index)

- **Domain:** API documentation completeness, README accuracy, inline comment quality
- **Deterministic tools:** JSDoc/TSDoc coverage, README link checker, OpenAPI spec validator
- **AI analysis:** Documentation accuracy vs code, missing documentation for public APIs, stale comments
- **Output:** `AUDIT_DOCUMENTATION.md`
- Estimated cost: $0 (deterministic-only) / $0.10–0.20 (with AI)

### PR 10.8: Unified Audit Report & DD Package
**Inspired by:** Claude Code's `TeammateSpinnerTree` (multi-agent progress visualization), `teamHelpers.ts` (team file aggregation)
**Maps to:** SWE Framework §E.2 (Overall Score Weights), §E.5 (DD Evidence Index), §N (AI Delivery Metrics)

- **Merge all specialist reports** into a single `AUDIT_REPORT.md` — the flagship deliverable
- **Scoring system** based on SWE Framework §E.1 and §E.2:
  - Security: 20%, Code Quality: 13%, Architecture: 13%, Testing: 8%, Infrastructure: 10%
  - Scalability: 7%, Tech Debt: 4%, Knowledge Risk: 3%, Operations: 4%, Data Flow: 4%, AI Governance: 14%
- **Evidence index** (SWE Framework §E.5): Each finding linked to exact file:line with artifact proof
- **Red flag summary** (SWE Framework §E.3 + §O.2): Auto-checked deal-breakers with pass/fail status
- **Manifest:** Commit SHA, spec hash, CLI version, agent versions, model versions, timestamps, all check IDs
- **HITL dashboard:** `sentinelayer audit review` — interactive terminal UI to adjudicate findings
  - Per-finding: accept / reject / defer + severity override + notes
  - Adjudication exported as `AUDIT_ADJUDICATION.json`
- **Export formats:** `sentinelayer audit export --format pdf|html|json|sarif|csv`
- **Executive summary:** 1-page overview suitable for investor/acquirer consumption
- Complexity: Very High · API Key: No (aggregation only) · Est. cost: $0

### PR 10.9: Audit Reproducibility & Drift Detection
**Inspired by:** Claude Code's session persistence, cost tracking per session
**Maps to:** SWE Framework §N (Reproducibility success rate), AGENTS.md §4 "Verification Before Done"

- Every audit run persisted to `.sentinelayer/audits/<uuid>/`
- Full reproducibility manifest: git state, tool versions, AI prompts, model versions, temperature, all findings
- `sentinelayer audit replay <uuid>` — re-run entire audit and diff against original
- `sentinelayer audit compare <uuid1> <uuid2>` — compare two audits (e.g., before/after a sprint)
- **Trend tracking:** `sentinelayer audit trend` — show score trajectory over time (chart in terminal)
- **CI integration:** `sentinelayer audit --ci --fail-on P0` — exit non-zero if any P0 findings (for quality gates)
- Complexity: High · API Key: Only for AI replay · Est. cost: $0 (deterministic) / $1–5 (full AI replay)

---

## Phase 8 — Analytics, Telemetry & Quality
**Priority:** P3 · **Complexity:** Medium · **Dependencies:** Phase 0

### PR 8.1: Opt-In Telemetry
**Inspired by:** Claude Code's `services/analytics/` (sink pattern, `logEvent`, privacy guards)

- Telemetry is **opt-in** (off by default): `sentinelayer config set telemetry true`
- Events: command usage, feature adoption, error rates (never code or file paths)
- Privacy guard type: `AnalyticsMetadata_NO_CODE_OR_FILEPATHS` pattern
- Local event queue with batch export
- `sentinelayer telemetry status` / `sentinelayer telemetry disable`

### PR 8.2: Error Reporting & Diagnostics
**Inspired by:** Claude Code's error logging, `logError`, diagnostic output

- Structured error types with error codes: `SNTL-001`, `SNTL-002`, etc.
- `sentinelayer doctor` — diagnose configuration issues
- `--debug` flag for verbose logging
- Error reports include: OS, Node version, CLI version, sanitized stack trace

### PR 8.3: Test Suite & CI Pipeline
**Inspired by:** Omar Gate's 186-test suite, Claude Code's extensive test infrastructure

- Unit tests for: config parsing, spec generation, prompt formatting, cost tracking
- Integration tests for: CLI commands end-to-end, file output verification
- CI: GitHub Actions workflow with quality gates
- Coverage target: 80%+ for core modules

---

## Phase 11 — AIdenID Identity Engine (`sentinelayer identity`)
**Priority:** P1 · **Complexity:** Very High · **Dependencies:** Phase 0, Phase 3

> 🪪 **Ephemeral identity control plane for AI agents.** Integrates AIdenID's programmable inbox identities into the SentiNelayer CLI as a native subcommand. Every identity is short-lived, cryptographically isolated, and automatically squashed after use.
>
> **Maps to AGENTS.md:** §2 "Subagent Strategy" (each agent gets its own identity), §4 "Verification Before Done" (identity lifecycle must complete cleanly)
> **Maps to SWE Framework:** §K (Tool/MCP Security), §J (Agent Harness Hygiene), §E.4 (Security Coverage), §F (AI Tooling Governance)
>
> ⚠️ **Requires:** AIdenID API key (`AIDENID_API_KEY`) + AIdenID project. All identity operations require network access to the AIdenID API.

### PR 11.1: AIdenID SDK Integration & Auth
**Inspired by:** Claude Code's multi-provider API client (`services/api/`), AIdenID SDK (`packages/sdk/src/index.ts`)
**Maps to:** SWE Framework §K.1 (Tool Security Controls), §B.4 (External Service Integration)

- Bundle `@aidenid/sdk` as a dependency or embed a thin client (mirrors the existing TS SDK pattern)
- `sentinelayer identity login` — authenticate with AIdenID API key, store in `~/.sentinelayer/credentials.yml` (encrypted at rest)
- `sentinelayer identity whoami` — calls `/v1/me` to show org, project, role, scopes
- Config integration: `aidenid.apiKey`, `aidenid.baseUrl`, `aidenid.organizationId`, `aidenid.projectId` in `.sentinelayer.yml`
- Auto-detect from env vars: `AIDENID_API_KEY`, `AIDENID_ORG_ID`, `AIDENID_PROJECT_ID`
- Token exchange: `exchangeToken()` with configurable TTL (default 30 min)
- Retry logic with exponential backoff + circuit breaker (same pattern as AIdenID's `resilient_http_client.py`)
- Complexity: Medium · API Key: AIdenID · Est. cost: Free (auth only)

### PR 11.2: Identity Provisioning & Lifecycle CLI
**Inspired by:** AIdenID `/v1/identities` API, Claude Code's tool registry pattern (`Tool.ts`, `tools.ts`)
**Maps to:** SWE Framework §E.4 (Security), AGENTS.md "Simplicity First"

- `sentinelayer identity create` — provision a single ephemeral identity
  - Flags: `--alias <template>`, `--ttl <hours>` (1–720), `--tags <a,b,c>`, `--domain-pool <id>`
  - Policy options: `--receive-mode edge_accept`, `--extraction-types otp,link`
  - Returns: identity ID, email address, expiration time, status
- `sentinelayer identity create --count <N>` — bulk create up to 10,000 identities (uses `/v1/identities/bulk`)
  - Progress bar showing provisioning rate
  - Idempotency key auto-generated per batch
- `sentinelayer identity list` — paginated list with cursor support
  - Filters: `--status active|expired|squashed`, `--tags <filter>`
- `sentinelayer identity show <id>` — detailed view: email, status, TTL remaining, events, lineage
- `sentinelayer identity squash <id>` — manually squash (irreversible)
- `sentinelayer identity squash --tags <tag> --all` — bulk squash by tag (requires `--confirm-all` for safety)
- `sentinelayer identity extend <id> --ttl <hours>` — extend TTL before expiration
- All mutations require Idempotency-Key header (auto-generated, logged)
- Complexity: High · API Key: AIdenID · Est. cost: Per-identity billing (see AIdenID pricing)

### PR 11.3: OTP & Verification Link Extraction
**Inspired by:** AIdenID extraction pipeline (`extraction.py` — rules-v1 → LLM fallback), Claude Code's structured output parsing
**Maps to:** SWE Framework §F (AI Tooling Governance — structured JSON extraction), AGENTS.md §6 "Autonomous Bug Fixing"

- `sentinelayer identity wait-for-otp <id>` — poll until an OTP/verification link arrives, then return it
  - Uses `/v1/identities/{id}/latest-extraction` with polling interval (default 2s, max 120s)
  - Returns structured JSON: `{ otp: "123456", primaryActionUrl: "https://...", confidence: 0.95 }`
  - `--timeout <seconds>` flag (default 60s)
  - Exits with non-zero if timeout or extraction fails
- `sentinelayer identity events <id>` — list all inbound events for an identity
- `sentinelayer identity latest <id>` — show latest event + extraction
- Extraction pipeline transparency: show whether result came from `RULES` (deterministic) or `LLM` (AI fallback)
- Confidence threshold: `--min-confidence 0.8` — reject extractions below threshold
- Complexity: Medium · API Key: AIdenID · Est. cost: Included in identity billing

### PR 11.4: Child Identities & Lineage
**Inspired by:** AIdenID's parent→child identity model, Claude Code's agent memory hierarchy
**Maps to:** SWE Framework §D (Data Flow & Wiring — lineage graphs), AGENTS.md §2 "Subagent Strategy"

- `sentinelayer identity create-child <parent-id>` — mint a child identity under a parent
  - Policy delegation enforcement: child `receiveMode` must match parent, child `extractionTypes` ⊆ parent types
  - Child TTL cannot exceed parent remaining TTL
  - `--event-budget <N>` — cap inbound events for the child (budget envelope)
- `sentinelayer identity lineage <id>` — show identity tree (parent → children → grandchildren)
  - Terminal tree visualization (like `tree` command)
  - Shows: identity ID, email, status, TTL, depth
- `sentinelayer identity revoke-children <id>` — recursively squash all descendants
- Use case: parent identity = "test campaign", children = individual agent identities
- Complexity: Medium · API Key: AIdenID · Est. cost: Per-identity billing

### PR 11.5: Domain & Target Management
**Inspired by:** AIdenID domain registry (`/v1/domains`, `/v1/targets`), Claude Code's managed settings
**Maps to:** SWE Framework §H.2 (Isolated environments), §K (Tool/MCP Security)

- `sentinelayer identity domain create <hostname>` — register a custom domain for identity emails
  - Returns DNS proof record for verification
- `sentinelayer identity domain verify <id>` — verify domain ownership via DNS TXT record
- `sentinelayer identity domain freeze <id>` — freeze domain (no new identities, no new emails)
- `sentinelayer identity target create <url>` — register a target application for simulation/testing
  - Returns ownership proof for verification
- `sentinelayer identity target verify <id>` — verify target ownership
- `sentinelayer identity target show <id>` — show target details, policy, verification status
- Complexity: Medium · API Key: AIdenID · Est. cost: Per-domain billing

### PR 11.6: Temporary Sites (Ephemeral Callback Domains)
**Inspired by:** AIdenID `TemporarySite` model + lifecycle-linked teardown, Claude Code's sandbox system
**Maps to:** SWE Framework §H.2 (Isolated build environments), AGENTS.md §4 "Verification Before Done"

- `sentinelayer identity site create <identity-id>` — provision ephemeral callback domain
  - Returns: `test-abc123.aidenid.dev` (or custom domain)
  - Auto-linked to identity lifecycle: squash identity → site DNS cleanup
  - Use case: OAuth callback URL, webhook receiver, test endpoint
- `sentinelayer identity site list` — show active temporary sites
- Sites auto-expire with their linked identity (no manual cleanup needed)
- `TEARDOWN_PENDING` → `DECOMMISSIONED` lifecycle visible in CLI
- Complexity: Medium · API Key: AIdenID · Est. cost: Per-site billing

---

## Phase 12 — Agent QA Swarm (`sentinelayer swarm`)
**Priority:** P2 · **Complexity:** Extreme · **Dependencies:** Phase 10 (Audit Swarm), Phase 11 (AIdenID Identity Engine), Phase 3 (AI Enhancement)

> 🐝 **The flagship enterprise QA capability.** Deploys swarms of browser-driving AI agents, each with its own AIdenID ephemeral identity, to autonomously test auth flows, onboarding funnels, and application workflows at scale. Then auto-squashes all identities.
>
> **Maps to AGENTS.md:** §2 "Subagent Strategy — one task per subagent", §4 "Verification Before Done", §6 "Autonomous Bug Fixing"
> **Maps to SWE Framework:** §E.4 (Security Coverage), §K (Tool/MCP Security), §J (Agent Harness Hygiene), §F (AI Tooling Governance), QA Lifecycle Coverage
>
> ⚠️ **Requires:** AIdenID API key + AI provider API key (OpenAI/Anthropic/Google). Higher API spend — cost estimates shown before deployment.

### PR 12.1: Swarm Orchestrator & Agent Factory
**Inspired by:** Claude Code's `spawnMultiAgent.ts` (team spawning), AIdenID's `BulkCreateIdentitiesRequest` (count up to 10K)
**Maps to:** AGENTS.md §2 "Subagent Strategy", SWE Framework §J (Agent Harness Hygiene)

- `sentinelayer swarm create` — define a new swarm run
  - `--scenario <name>` — built-in or custom scenario (password-reset, signup, onboarding, invitation)
  - `--target <url>` — target application URL (must be registered and verified in AIdenID)
  - `--count <N>` — number of agents (1–5000, default 10)
  - `--concurrency <N>` — max parallel agents (default 5, respects target policy `maxConcurrency`)
  - `--rate-limit <N>/s` — max new agent starts per second (default 2, respects target policy `maxRps`)
  - `--ttl <hours>` — identity TTL (default 1 hour, max 24)
  - `--tags <campaign-name>` — tag all identities for easy bulk squash
- **Orchestrator architecture:**
  1. Provisions N identities via AIdenID bulk API (`/v1/identities/bulk`)
  2. Spawns agent processes (Playwright-based browser agents) — one per identity
  3. Each agent is isolated: own browser context, own identity, own sandbox
  4. Monitors progress via real-time event stream
  5. On completion or timeout: bulk-squashes all identities (`/v1/identities/bulk-squash`)
- **Pre-flight checks before deployment:**
  - Target must be registered and verified in AIdenID
  - Target policy must allow the scenario class
  - Cost estimate displayed: "This swarm will cost ~$X.XX (N identities × $Y.YY + AI cost). Proceed? [Y/n]"
  - `--dry-run` flag: provision identities and plan agents but don't execute
- Complexity: Extreme · API Key: AIdenID + AI provider · Est. cost: $0.50–10.00 per swarm (depends on N and AI usage)

### PR 12.2: Playwright Agent Runtime
**Inspired by:** Claude Code's `BashTool` subprocess execution, sandbox system, `WebFetchTool`
**Maps to:** SWE Framework §K.1 (Tool Security Controls), AGENTS.md §6 "Autonomous Bug Fixing"

- Each swarm agent runs a headless Playwright browser in an isolated subprocess
- Agent capabilities:
  - Navigate to target URL
  - Fill forms (using identity's email address, generated display name, password)
  - Submit forms, wait for redirects
  - Call `sentinelayer identity wait-for-otp <id>` when OTP/verification is needed
  - Enter OTP or click verification link
  - Continue through the flow (onboarding steps, dashboard, etc.)
  - Capture screenshots at each step (stored in `.sentinelayer/swarm/<run-id>/screenshots/`)
- Agent isolation:
  - Separate browser context (no shared cookies/localStorage between agents)
  - Subprocess runs in sandbox (PR 9.1) with network restricted to target domain + AIdenID API
  - Identity credentials never cross agent boundaries
- Agent timeout: configurable per-agent (default 120s), auto-kill on timeout
- Complexity: Very High · API Key: AI provider (for navigation decisions) · Est. cost: $0.02–0.10 per agent

### PR 12.3: Scenario Definition Language
**Inspired by:** AIdenID's simulation manifest system (compiled manifests, scenario classes, steps), Claude Code's tool definition schema
**Maps to:** SWE Framework §G (AI Instruction Topology — path-scoped instruction files)

- **Scenario files:** `.sentinelayer/scenarios/<name>.yml` — declarative flow definitions
- Built-in scenarios:
  ```yaml
  name: password-reset
  version: "1.0"
  steps:
    - name: navigate-to-reset
      action: navigate
      url: "{{target}}/forgot-password"
    - name: enter-email
      action: fill
      selector: "input[name=email]"
      value: "{{identity.emailAddress}}"
    - name: submit-form
      action: click
      selector: "button[type=submit]"
    - name: wait-for-otp
      action: wait-extraction
      type: otp
      timeout: 60
    - name: enter-otp
      action: fill
      selector: "input[name=otp]"
      value: "{{extraction.otp}}"
    - name: submit-otp
      action: click
      selector: "button[type=submit]"
    - name: verify-success
      action: assert
      selector: ".success-message"
      exists: true
  ```
- `sentinelayer swarm scenario list` — show available scenarios
- `sentinelayer swarm scenario create <name>` — scaffold a new scenario
- `sentinelayer swarm scenario validate <name>` — dry-run validate a scenario file
- Template variables: `{{target}}`, `{{identity.emailAddress}}`, `{{identity.id}}`, `{{extraction.otp}}`, `{{extraction.primaryActionUrl}}`
- **AI-assisted mode:** If `--ai` is passed, the agent uses AI to navigate forms it hasn't seen before (selector discovery), falling back to scenario steps as guardrails
- Complexity: High · API Key: No (scenario definition is offline) · Est. cost: $0

### PR 12.4: Real-Time Swarm Dashboard
**Inspired by:** Claude Code's `TeammateSpinnerTree` progress UI, AIdenID's web dashboard (`apps/web/app/dashboard/`)
**Maps to:** AGENTS.md §4 "Verification Before Done", SWE Framework §L (Agent Observability)

- `sentinelayer swarm status <run-id>` — live terminal dashboard (Ink/React TUI)
- Dashboard panels:
  - **Agent grid:** status of each agent (🟢 running, ✅ passed, ❌ failed, ⏱️ timeout, 🔄 waiting-for-otp)
  - **Progress bar:** X/N agents completed, estimated time remaining
  - **Success/failure rate:** real-time percentage with error categorization
  - **Timing histogram:** p50/p95/p99 flow completion times
  - **Cost tracker:** identities provisioned, API calls made, current spend
  - **Live log:** scrollable event stream (agent-3: submitted form, agent-7: received OTP)
- `sentinelayer swarm watch <run-id>` — auto-refresh dashboard (like `watch` command)
- `sentinelayer swarm stop <run-id>` — emergency stop: kill all agents + bulk squash identities
- Terminal notifications (PR 2.4 pattern) on swarm completion
- Complexity: High · API Key: No (dashboard is read-only) · Est. cost: $0

### PR 12.5: Swarm Execution Report
**Inspired by:** AIdenID's simulation report system (`SimulationReportResponse` with steps, metrics, artifacts, stops), Claude Code's `writeAgentMetadata`
**Maps to:** SWE Framework §N (AI Delivery Metrics), §E.5 (DD Evidence Index), AGENTS.md §4 "Verification Before Done"

- Auto-generated after swarm completion: `SWARM_REPORT.md` + `SWARM_REPORT.json`
- Report contents:
  - **Summary:** total agents, pass/fail/timeout counts, success rate
  - **Timing:** flow duration histogram (p50, p95, p99), step-by-step timing breakdown
  - **Error taxonomy:** categorized failures (form not found, OTP timeout, verification failed, unexpected redirect)
  - **Per-agent detail:** each agent's step-by-step execution log with screenshots
  - **Identity lifecycle:** all identities provisioned, their status (should be SQUASHED), any that failed to squash
  - **Cost breakdown:** identity cost, AI API cost, total
- **Manifest & reproducibility:**
  - Commit SHA, scenario file hash, target URL, swarm config, AIdenID API version
  - `sentinelayer swarm replay <run-id>` — re-run the same swarm (new identities, same scenario)
  - `sentinelayer swarm compare <run1> <run2>` — diff two swarm runs (regression detection)
- `sentinelayer swarm export <run-id> --format json|html|pdf` — export for stakeholders
- Complexity: High · API Key: No (report generation is local) · Est. cost: $0

### PR 12.6: Security & Pen-Test Agent Mode
**Inspired by:** AIdenID's target policy enforcement (allowed methods, paths, scenarios), Claude Code's permission gating
**Maps to:** SWE Framework §E.4 (Security Coverage), §K (Tool/MCP Security), AGENTS.md "No Laziness: Find root causes"

- `sentinelayer swarm create --scenario pen-test --target <url>`
- **Security-specific agent capabilities:**
  - Rate limit probing: send N requests/sec, detect at what threshold the app rate-limits
  - Input validation testing: inject XSS/SQLi payloads in form fields, check for sanitization
  - Privilege escalation: attempt to access admin endpoints with standard user identity
  - Auth bypass: try expired tokens, malformed JWTs, missing headers
  - CSRF checks: submit forms without CSRF tokens
- **Strict target policy enforcement:**
  - Agent MUST operate within AIdenID target policy (`allowedPaths`, `allowedMethods`, `maxRps`)
  - CLI refuses to run if target is not verified or policy is not approved
  - All agent HTTP requests logged with full headers/body for audit trail
- **Built-in pen-test scenarios:** `auth-bypass`, `rate-limit-probe`, `input-validation`, `privilege-escalation`
- Output: `PENTEST_REPORT.md` with findings keyed to OWASP categories
- Complexity: Very High · API Key: AIdenID + AI provider · Est. cost: $1–5 per pen-test run

### PR 12.7: Swarm Identity Security Hardening
**Inspired by:** AIdenID's idempotency keys, legal holds, tombstones, audit events; Claude Code's `subprocessEnv.ts` secret scrubbing
**Maps to:** SWE Framework §K.2 (Credential Management), §H (AI Change Provenance), §O.2 (Safety Guards)

- **Zero-trust identity isolation:**
  - Each agent receives only its own identity credentials (never the full identity list)
  - Agent subprocess env scrubbed: no `AIDENID_API_KEY`, no other agents' emails
  - Inter-agent communication blocked: agents cannot discover other swarm members
- **Cryptographic audit trail:**
  - Every identity mutation logged with: timestamp, actor, action, target, idempotency key
  - Audit events signed with HMAC (mirrors AIdenID's `record_audit_event`)
  - Swarm audit log: `.sentinelayer/swarm/<run-id>/audit.jsonl`
  - Tamper detection: hash chain on audit entries (each entry includes previous entry's hash)
- **Guaranteed squash:**
  - Post-swarm cleanup runs even if the CLI process crashes (cleanup job scheduled in AIdenID)
  - `sentinelayer identity audit --stale` — find identities that should have been squashed but weren't
  - Kill switch: `sentinelayer identity kill-all --tags <campaign>` — emergency bulk squash
- **Legal hold compliance:**
  - If an identity is under legal hold (AIdenID feature), squash is blocked and CLI reports it
  - `sentinelayer identity legal-hold status <id>` — check legal hold status
- Complexity: High · API Key: AIdenID · Est. cost: $0 (security hardening is local)

---

## Dependency Graph

```
Phase 0 (Foundation)
  ├── Phase 1 (Offline Spec/Prompt Gen) ──┬── Phase 4 (Sessions)
  │                                        ├── Phase 5 (Plugins)
  │                                        └── Phase 6 (MCP/IDE)
  ├── Phase 2 (TUI/DX) ──────────────────────────┘
  ├── Phase 3 (AI Enhancement) ──┬── Phase 7 (Advanced AI) [stretch]
  │                               │
  │   Phase 1 + Phase 3 ─────────┴── Phase 9 (Local Omar Gate) ── Phase 10 (Audit Swarm)
  │                                                                       │
  │   Phase 0 + Phase 3 ──── Phase 11 (AIdenID Identity Engine) ──────────┤
  │                                        │                              │
  │                                        └── Phase 12 (Agent QA Swarm) ─┘
  │                                              (depends on Phase 10 swarm patterns
  │                                               + Phase 11 identity provisioning)
  └── Phase 8 (Analytics/Quality)
```

---

## Summary Table

| Phase | PRs | Priority | API Required? | Est. Effort | Key Deliverable |
|-------|-----|----------|---------------|-------------|-----------------|
| **0 — Foundation** | 3 | P0 | No | 2 weeks | CLI skeleton, config, artifact writer |
| **1 — Offline Gen** | 5 | P0 | No | 3 weeks | Spec, prompt, guide, Omar config generation |
| **2 — TUI/DX** | 4 | P1 | No | 2 weeks | Interactive mode, markdown preview, diff |
| **3 — AI Enhancement** | 4 | P1 | Yes (standard key) | 3 weeks | Multi-provider client, cost tracking, AI spec gen |
| **4 — Sessions** | 3 | P2 | No | 2 weeks | Session persistence, spec versioning |
| **5 — Plugins** | 3 | P2 | No | 3 weeks | Plugin architecture, custom templates |
| **6 — MCP/IDE** | 2 | P2 | No | 2 weeks | MCP server, VS Code extension |
| **7 — Advanced AI** | 2 | P3 (stretch) | Yes (higher spend) | 3 weeks | REPL refinement, hooks |
| **8 — Analytics** | 3 | P3 | No | 2 weeks | Telemetry, diagnostics, test suite |
| **9 — Local Omar Gate** | 5 | P1 | Partial (AI layers) | 6 weeks | Isolated reviewer, 7-layer local pipeline, reproducible reviews |
| **10 — Audit Swarm** | 9 | P2 | Partial (AI layers) | 8 weeks | 6 specialist agents, unified DD report, reproducibility |
| **11 — AIdenID Identity Engine** | 6 | P1 | AIdenID API key | 5 weeks | Identity provisioning, OTP extraction, lineage, domains, sites |
| **12 — Agent QA Swarm** | 7 | P2 | AIdenID + AI provider | 8 weeks | Playwright agent swarm, scenario DSL, dashboard, pen-test, reports |
| **Total** | **56 PRs** | | | **~49 weeks** | |

---

## Cost Guardrails Summary

| Feature | Default Budget | Configurable? | Offline Alternative |
|---------|---------------|---------------|---------------------|
| AI Spec Generation | $1.00/invocation | `--max-cost` | Template-based spec gen |
| AI Security Pre-Scan | $0.50/scan | `--max-cost` | Deterministic regex scan |
| AI Spec Refinement (REPL) | $0.30/session | `--max-cost` | Manual spec editing |
| **Local Omar Review (deterministic)** | **$0** | N/A | **Always free — no API needed** |
| **Local Omar Review (AI layers)** | **$1.00/review** | `--max-cost` | **Deterministic-only mode** |
| **Audit Swarm (deterministic-only)** | **$0** | N/A | **Always free — no API needed** |
| **Audit Swarm (all agents + AI)** | **$5.00/audit** | `--max-cost` | **Deterministic-only mode** |
| **Audit Replay** | $0–5.00/replay | `--max-cost` | Deterministic replay is free |
| **Identity provisioning (single)** | **Per AIdenID pricing** | N/A | **No offline alternative (requires API)** |
| **Identity provisioning (bulk, 5K)** | **Per AIdenID pricing** | N/A | **No offline alternative (requires API)** |
| **Agent QA Swarm (10 agents)** | **$0.50–2.00/swarm** | `--max-cost` | **Scenario-only dry-run ($0)** |
| **Agent QA Swarm (5K agents)** | **$10–50/swarm** | `--max-cost` | **Scenario-only dry-run ($0)** |
| **Pen-Test Swarm** | **$1–5/run** | `--max-cost` | **Deterministic-only pen-test ($0)** |

All AI features show cost estimates **before** invoking and require explicit `[Y/n]` confirmation unless `--yes` is passed.

**Deterministic-only mode** (`sentinelayer review --no-ai` / `sentinelayer audit --no-ai`) runs the full pipeline with zero API cost. This is the default when no API key is configured.

**AIdenID features** always require network access and an AIdenID API key. Identity costs are billed through your AIdenID account. The CLI displays cost estimates before bulk operations.

---

## CLI Command Reference (Target)

```
sentinelayer                          # Interactive REPL mode
sentinelayer init                     # Initialize project (existing scaffold behavior)

# Spec & Prompt Generation (Phase 1)
sentinelayer spec generate            # Generate spec from codebase + description
sentinelayer spec generate --ai       # AI-enhanced spec generation
sentinelayer spec show                # Preview spec in terminal
sentinelayer spec regenerate          # Re-generate, preserving manual edits
sentinelayer spec history             # Show spec revision history
sentinelayer spec bind                # Lock spec hash for CI verification
sentinelayer prompt generate          # Generate AI agent prompts from spec
sentinelayer prompt preview           # Preview prompts in terminal
sentinelayer guide generate           # Generate build guide from spec
sentinelayer guide export             # Export to Jira/Linear/GitHub Issues
sentinelayer scan init                # Generate Omar Gate workflow
sentinelayer scan validate            # Validate workflow against spec

# Local Omar Gate Review (Phase 9)
sentinelayer review <path>            # Deterministic review (free, no API key)
sentinelayer review --diff            # Review staged git changes
sentinelayer review --ai              # Add AI reasoning layers ($1.00 default budget)
sentinelayer review show              # Pretty-print latest review report
sentinelayer review accept|reject <id> # HITL finding adjudication
sentinelayer review replay <uuid>     # Re-run a previous review for reproducibility
sentinelayer review diff <u1> <u2>    # Compare two review runs
sentinelayer review export --format sarif|json|md # Export for CI integration

# Audit Swarm (Phase 10)
sentinelayer audit                    # Full audit swarm (all agents)
sentinelayer audit --agents sec,arch  # Run specific specialist agents
sentinelayer audit --no-ai            # Deterministic-only audit (free)
sentinelayer audit --max-parallel 3   # Control agent concurrency
sentinelayer audit review             # Interactive HITL adjudication UI
sentinelayer audit export --format pdf|html|json # Export DD package
sentinelayer audit trend              # Score trajectory over time
sentinelayer audit replay <uuid>      # Reproducibility replay
sentinelayer audit compare <u1> <u2>  # Compare two audit runs
sentinelayer audit --ci --fail-on P0  # CI mode: exit non-zero on findings

# AIdenID Identity Engine (Phase 11)
sentinelayer identity login           # Authenticate with AIdenID API key
sentinelayer identity whoami          # Show org, project, scopes
sentinelayer identity create          # Provision single ephemeral identity
sentinelayer identity create --count N # Bulk create up to 10,000 identities
sentinelayer identity list            # List identities with filters
sentinelayer identity show <id>       # Detailed identity view
sentinelayer identity squash <id>     # Manually squash (irreversible)
sentinelayer identity extend <id>     # Extend TTL before expiry
sentinelayer identity wait-for-otp <id> # Poll for OTP/verification link
sentinelayer identity events <id>     # List inbound events
sentinelayer identity create-child <id> # Mint child identity under parent
sentinelayer identity lineage <id>    # Show identity family tree
sentinelayer identity domain create   # Register custom email domain
sentinelayer identity domain verify   # Verify domain via DNS
sentinelayer identity site create <id> # Provision ephemeral callback domain
sentinelayer identity target create   # Register target application
sentinelayer identity audit --stale   # Find orphaned un-squashed identities
sentinelayer identity kill-all --tags # Emergency bulk squash

# Agent QA Swarm (Phase 12)
sentinelayer swarm create             # Define & launch a new swarm run
sentinelayer swarm create --scenario  # Use built-in or custom scenario
sentinelayer swarm create --dry-run   # Provision identities, plan agents, don't execute
sentinelayer swarm status <run-id>    # Live terminal dashboard (Ink TUI)
sentinelayer swarm watch <run-id>     # Auto-refresh dashboard
sentinelayer swarm stop <run-id>      # Emergency stop + bulk squash
sentinelayer swarm replay <run-id>    # Re-run swarm (new identities, same scenario)
sentinelayer swarm compare <r1> <r2>  # Diff two swarm runs (regression detection)
sentinelayer swarm export <run-id>    # Export report (json|html|pdf)
sentinelayer swarm scenario list      # Show available scenarios
sentinelayer swarm scenario create    # Scaffold custom scenario YAML
sentinelayer swarm scenario validate  # Dry-run validate scenario file

# Configuration & Management
sentinelayer config set/get/list      # Configuration management
sentinelayer cost                     # Show session costs
sentinelayer sessions list/resume     # Session management
sentinelayer plugin list/install      # Plugin management
sentinelayer template list/search     # Template marketplace
sentinelayer policy list/use          # Policy pack management
sentinelayer mcp serve                # Start MCP server
sentinelayer doctor                   # Diagnose configuration
sentinelayer telemetry status         # Telemetry management
```

---

## Claude Code Pattern → SentiNelayer Mapping (Phase 9 & 10 Deep Dive)

This section details exactly which Claude Code source files and patterns inform the Local Omar Gate and Audit Swarm architecture.

### Isolation Architecture

| Claude Code Pattern | Source File | SentiNelayer Application |
|---|---|---|
| OS-level sandbox (macOS sandbox-exec, Linux bwrap) | `utils/sandbox/sandbox-adapter.ts` | `ReviewerSandbox` runtime: read-only FS, network deny, secrets stripped |
| Sandbox settings schema (enable, failIfUnavailable, filesystem, network) | `entrypoints/sandboxTypes.ts` | `.sentinelayer.yml` sandbox config: `sandbox.enabled`, `sandbox.filesystem.denyWrite`, `sandbox.network.allowedDomains` |
| `wrapWithSandbox()` command wrapping | `sandbox-adapter.ts:704` | Wrap reviewer's subprocess commands in sandbox before execution |
| `subprocessEnv()` secret scrubbing | `utils/subprocessEnv.ts` | Strip `OPENAI_API_KEY`, `ANTHROPIC_API_KEY` etc. from reviewer subprocess env (reviewer only needs them via orchestrator proxy) |
| `shouldUseSandbox()` decision logic | `tools/BashTool/shouldUseSandbox.ts` | Decide whether each review check runs sandboxed based on config |
| Agent worktree isolation | `AgentTool.tsx:590` → `createAgentWorktree(slug)` | Reviewer operates on a git worktree clone — mutations in worktree don't affect working copy |
| In-process isolation via AsyncLocalStorage | `utils/swarm/spawnInProcess.ts` | Lightweight isolation for deterministic-only review agents (no subprocess overhead) |

### Agent Spawning & Orchestration

| Claude Code Pattern | Source File | SentiNelayer Application |
|---|---|---|
| `spawnTeammate()` with team file | `tools/shared/spawnMultiAgent.ts` | Audit orchestrator spawns specialist agents, tracks in team file |
| `TeammateSpinnerTree` progress UI | `components/Spinner/TeammateSpinnerTree.tsx` | Real-time progress visualization showing each audit agent's status |
| Agent definitions (tools, permissions, model, isolation, maxTurns) | `tools/AgentTool/loadAgentsDir.ts` | Specialist agent configs: Security agent gets `disallowedTools: [FileEdit, FileWrite]`, `permissionMode: 'plan'` |
| `omitClaudeMd` for read-only agents | `loadAgentsDir.ts:128` | Audit agents don't need CLAUDE.md guidelines — they're read-only analysts |
| Teammate mailbox (file-based messaging) | `utils/teammateMailbox.ts` | Specialist agents write findings to orchestrator's inbox; no shared memory |
| Agent memory scope (`'user' \| 'project' \| 'local'`) | `tools/AgentTool/agentMemory.ts` | Audit agents can persist learnings: "this codebase uses Prisma" → skip Rails checks next time |
| `createSubagentContext()` with isolated AbortController | `tools/AgentTool/runAgent.ts:700` | Each specialist gets independent abort controller — one agent failure doesn't kill the swarm |

### Permission Gating for Reviewers

| Claude Code Pattern | Source File | SentiNelayer Application |
|---|---|---|
| `PermissionMode: 'plan'` (read-only, no execution) | `types/permissions.ts`, `utils/permissions/PermissionMode.ts` | Reviewer agent runs in `plan` mode — can read and analyze but cannot modify files |
| `disallowedTools` per agent | `loadAgentsDir.ts:110` | Reviewer has `disallowedTools: ['FileEdit', 'FileWrite', 'Bash(rm)', 'Bash(mv)']` |
| Permission pipeline (deny → ask → tool-check → mode) | `utils/permissions/permissions.ts:1158` | If reviewer tries to write, permission system blocks it before execution |
| `FsReadRestrictionConfig` / `FsWriteRestrictionConfig` | `sandbox-adapter.ts` | Reviewer sandbox allows reads everywhere, writes only to `.sentinelayer/reviews/` |

### AIdenID Integration & Agent QA Swarm (Phase 11 & 12)

| AIdenID / Claude Code Pattern | Source | SentiNelayer Application |
|---|---|---|
| AIdenID identity lifecycle (ACTIVE → EXPIRED → SQUASHED) | `lifecycle_service.py` | `sentinelayer identity create/squash` — full lifecycle in CLI with guaranteed cleanup |
| AIdenID bulk create with idempotency | `/v1/identities/bulk`, `BulkCreateIdentitiesRequest` | `sentinelayer identity create --count 5000` — provision swarm identities atomically |
| AIdenID extraction pipeline (rules-v1 → LLM fallback) | `extraction.py`, `ExtractionResult` | `sentinelayer identity wait-for-otp` — poll for structured OTP/link extraction |
| AIdenID simulation system (DRY_RUN, LIVE, compiled manifest) | `simulation_service.py`, `SimulationReportResponse` | `sentinelayer swarm create --dry-run` — preview before deploying |
| AIdenID parent→child identity lineage | `identity_service.py`, `IdentityLineageNode` | `sentinelayer identity create-child` — hierarchical swarm identity management |
| AIdenID temporary sites (lifecycle-linked DNS) | `TemporarySite`, `sites.py` | `sentinelayer identity site create` — ephemeral callback domains for OAuth/webhook testing |
| AIdenID target policy enforcement | `domains.py`, `TargetPolicy` (maxRps, maxConcurrency, allowedPaths) | Swarm orchestrator respects target rate limits — prevents abuse |
| AIdenID audit events (signed, timestamped) | `record_audit_event()` | Tamper-evident hash chain audit log in `.sentinelayer/swarm/<run-id>/audit.jsonl` |
| Claude Code `spawnMultiAgent.ts` team spawning | `tools/shared/spawnMultiAgent.ts` | Swarm orchestrator spawns N browser agents with isolated contexts |
| Claude Code `TeammateSpinnerTree` | `components/Spinner/TeammateSpinnerTree.tsx` | Real-time swarm dashboard showing per-agent status |
| Claude Code `subprocessEnv.ts` secret scrubbing | `utils/subprocessEnv.ts` | Each browser agent gets only its own identity — no API keys, no other agents' data |
| Claude Code sandbox system | `sandbox-adapter.ts` | Browser agents sandboxed: network restricted to target + AIdenID API |
| Claude Code `WebFetchTool` web interaction | `tools/WebFetchTool/WebFetchTool.ts` | Playwright agent navigates and interacts with target web application |
| Claude Code session persistence | `state/`, session management | Swarm runs persisted with full reproducibility manifest |

---

*Roadmap generated 2026-03-31 · Updated 2026-03-31 with Phase 9 (Local Omar Gate), Phase 10 (Audit Swarm), Phase 11 (AIdenID Identity Engine), and Phase 12 (Agent QA Swarm)*
*Based on analysis of: Claude Code CLI source (Anthropic), SentiNelayer v1 Action (PlexAura Inc), AIdenID (mrrCarter/AIdenID), AGENTS.md, and SWE_excellence_framework.md*
*Copyright © 2026 PlexAura Inc — All rights reserved*

