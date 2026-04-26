# Investor-DD + Coordination + devTestBot — Build Spec

**Date:** 2026-04-26
**Author:** Carter (vision) + Claude Opus 4.7 (audit + spec)
**Audience:** the implementing agent (you, reading this now)

---

## 0. Read this preamble first. Do not skim.

You are a senior staff engineer with 12+ years of full-stack experience: TypeScript, Python, Node, distributed systems, multi-agent orchestration, browser automation, and security tooling. You have shipped Jules-class agentic loops, designed event-driven swarms, and built dashboards that consume NDJSON event spines.

You are stepping into a working enterprise CLI (`create-sentinelayer`, currently v0.8.11 on npm). The codebase is real and large. **Do not rewrite what works. Borrow patterns; do not import-and-rewrap.** When this spec says "borrow from `src/X`", you study X, copy the pattern, and write tight new code adjacent to your feature — you do not import X into a circular dependency, and you do not blanket-refactor X.

You **may** add new architecture where this spec flags a real gap. The spec marks those with **`[ADD-NEW]`**. Everything else is a wiring fix or a delta on existing code.

You are working under a strict scope-discipline rule: one PR per scoped change, small reviewable diffs, Omar Gate green before merge. See `CLAUDE.md` in the repo root for the loop contract.

You will run streaming audits as you go. When you finish a file or are PR-ready, you will run `/review` on the diff. You will post your plan, your file-claims, your findings, and your help-requests into the Senti session for this codebase. You will check `sl --help` whenever you hit a workflow you don't already know.

Your output for each PR is: a passing Omar Gate, a green test suite, and a streaming run that demonstrates the feature live.

---

## 1. Mission

Carter wants the CLI to deliver three outcomes that today are partially shipped:

1. **Investor-DD** that is genuinely Jules-parity across all 13 personas — agentic, isolated, reconciled, individually invokable, fully streaming with live token counts.
2. **Coordinated swarms** at every level: orchestrator → personas → per-persona sub-swarms, all visible live in the shell, plus a reusable agent-coordination etiquette injected into every spec/prompt/AGENTS.md the CLI generates.
3. **AIdenID devTestBot** integration — full UI/system test (PW reset, console, network, a11y, Lighthouse, click coverage), engaged automatically by DD, with an end-of-DD email bundling code findings + bot reports + recorded videos.

Everything must be live-streamable in the terminal. Token counters must tick in real time. Every actor must emit start AND end events. False positives must drop. `/omargate` must remain provably stronger locally than its GitHub Action sibling.

---

## 2. State of the enterprise (with evidence)

This section is the ground truth as of 2026-04-26. **Trust this map; verify it before you act.**

### 2.1 Slash command surface — ✅ healthy

- 37 commands wired across `src/cli.js:6-127` and the legacy fallback in `src/legacy-cli.js`.
- Modern Commander path: `config, ingest, spec, prompt, scan, guide, cost, telemetry, auth, watch, mcp, plugin, ai, review, chat, policy, swarm, daemon, session, omargate`.
- Legacy slash routes still parsed by `src/legacy-cli.js`: `init, audit, persona, apply`.
- No silent no-ops detected. `apply` lives only on the legacy path and is untested in the new test suite — flag it but do not gut it.
- **Gap:** routing asymmetry. Only `/omargate` is wrapped by Commander. `/audit, /persona, /apply` parse args via legacy string handling. This is a maintainability tax, not a user-visible bug today.

### 2.2 `/review` — ✅ correct reuse, per-file + per-diff supported

- Entry: `src/commands/review.js:274` (`registerReviewCommand`).
- Deterministic 22-rule pipeline: `src/review/local-review.js:111-303` defines `DETERMINISTIC_REVIEW_RULES`; pipeline runner at `src/review/local-review.js:1137` (`runDeterministicReviewPipeline`).
- AI layer: `src/review/ai-review.js:378` (`runAiReviewLayer`).
- Unified report dedup + multi-source confidence: `src/review/report.js:65-170`.
- Flags: `--diff`, `--staged`, `--mode {full|diff|staged}` at `src/commands/review.js:36-62, 280-282`.
- **Same code path as `/omargate deep`'s deterministic stage** — this is the shared base. Don't duplicate it when you build out DD.

### 2.3 `/omargate deep` — ⚠️ stronger than GH, but no swarm fanout, no audit-integration, soft confidence floor

**Confirmed strong:**
- Entry: `src/commands/omargate.js:9` → `src/legacy-cli.js:1110-1160` (`runLocalOmarGateCommand`).
- Runs 22-rule pipeline (NOT the legacy 5-rule scan): `src/legacy-cli.js:1195-1200`.
- Calls `runAiReviewLayer` by default; disable with `--no-ai`: `src/legacy-cli.js:1165, 1217-1245`.
- Codebase ingest with AST + framework detection + entry-point analysis: `src/review/local-review.js:1157-1161` → `resolveCodebaseIngest`.
- 13 personas dispatched in parallel (max 4 concurrent) via `runWithConcurrency`: `src/review/omargate-orchestrator.js:30-48, 163-327`.
- Per-persona budget split: `src/review/omargate-orchestrator.js:160`.
- Live NDJSON events: `omargate_start, persona_start, persona_finding, persona_complete, persona_error, persona_health_warning, omargate_complete` (`src/review/omargate-orchestrator.js:149, 206, 252, 268, 303, 435, 450`).
- Stronger than GH Action: GH only runs `node bin/sl.js review` (5–7 rules, no ingest, no AI on untrusted forks). Local has 22 rules + ingest + 13 personas + AI by default. (`.github/workflows/omar-gate.yml:71-118`, `.github/actions/omar-gate/action.yml:57`.)

**Real gaps:**
- **No file-count / LOC threshold to swarm-fan a persona.** Each persona makes a single `runAiReviewLayer` call regardless of codebase size. Token-limit risk on >5,000 LOC. Swarm decision logic exists at `src/agents/jules/swarm/orchestrator.js:23-56` (`shouldSpawnSubAgents`, thresholds: `minFilesForSwarm: 15, minRouteGroupsForSwarm: 3, minLocForSwarm: 5000, maxFilesPerScanner: 12, maxConcurrentAgents: 4`) — **but is not called from omargate**. Grep confirms zero `swarm`/`subagent` references in `src/review/omargate-orchestrator.js`.
- **Confidence floor is prompt-only.** `src/review/persona-prompts.js:326-328` instructs personas "Only report findings you have HIGH confidence in (>= 0.7)". The LLM may ignore. Not enforced in code post-hoc.
- **No `/omargate` ↔ `/audit` reuse.** `/audit` does not consume `/omargate` findings; deterministic work is repeated across both commands. Cross-grep returns empty.
- **No 11-lens evidence verification** (the Jules pattern) wired into omargate.

### 2.4 Investor-DD — ⚠️ orchestrator works, but persona depth is asymmetric

This is the central architectural finding. **Read carefully.**

There are **two persona orchestrators** in the repo:

| Path | Used by | How personas run |
|---|---|---|
| `src/audit/orchestrator.js:299-323, 467-480` | `/audit`, `/investor-dd` | Personas are **specialist filters** routing findings off the Omar deterministic baseline. Only Jules (frontend) runs as a fully-agentic explorer. The other personas dedup + classify; they do not generate findings via independent LLM agentic loops. |
| `src/review/omargate-orchestrator.js:163-327` | `/omargate deep` | Each persona makes a fresh `runAiReviewLayer` LLM call with its own context window. |

The user's ask ("all personas have similar prompt and tool use to Jules, super isolated") is **only true for `/omargate`'s pipeline**, and even there each persona is one LLM call, not an agentic loop with `file_read / grep / glob / shell / file_edit / dispatch` — those tools live exclusively in `src/agents/jules/tools/*.js` and are wired only into `julesAuditLoop` (`src/agents/jules/loop.js`).

**Confirmed real:**
- 15 agents defined (Omar + 14 specialists): `src/audit/registry.js:4-170`, each with name, domain, tools, budget, confidence floor.
- Unified findings envelope: `src/events/schema.js:76-116`.
- Dedup `(file:line:message.toLowerCase())`: `src/audit/orchestrator.js:467-480`.
- Jules' baseline reconciliation `(file:line:severity)`: `src/commands/audit.js:1072-1138`.
- Run isolation in `/audit`: each persona gets a fresh LLM client + new runId, queries the shared blackboard registry (not the transcript) (`src/audit/orchestrator.js:299-323`).
- Jules runs "blind-first" — does not see Omar baseline until reconciliation phase.
- Entry + 7-phase pipeline: `sl audit --path . [--agents security] [--max-parallel 3]` → `src/commands/audit.js:54-122` → `src/audit/orchestrator.js:219-556`.
- Individual-persona invocation: `--agents security` works.
- Streaming + per-event token usage: `src/agents/jules/stream.js:23-187`, `src/agents/jules/tools/dispatch.js:148-175`.

**Real gaps:**
1. **Persona depth asymmetry** — non-Jules personas in `/audit` do not run agentic loops with the full Jules tool dispatch. They route + filter. The user's expectation is full Jules-parity for all 13.
2. **No per-persona sub-swarm fanout** in either orchestrator. The swarm system exists; nothing wires it in.
3. **Two divergent orchestrators** — same persona name, different runtime semantics. Pick one; ideally collapse `/omargate`'s persona stage into a thin caller of `audit/orchestrator.js` so reconciliation and isolation rules live in one place.

### 2.5 Live streaming — ✅ best-in-class for shell visibility

- 18+ event types defined in `src/events/schema.js:1-190` and `src/agents/jules/stream.js:177-187` (constant `AGENT_EVENT_STREAM = "sl_event"`).
- `--stream` parses at `src/commands/audit.js:754, 763` and `src/commands/omargate.js:22, 49`. Hot path emits `console.log(JSON.stringify(evt))` synchronously per event.
- Per-subagent start/end pair guarantee: `src/agents/jules/swarm/sub-agent.js:42, 92, 102, 153, 168, 172`. Every `agent_start` has exactly one terminal event (`agent_complete | agent_abort | agent_error | budget_stop`).
- Live token counters: `emitLLMInteraction()` in `src/session/usage.js:82-156`, called immediately after each LLM response — not batched. Carries `inputTokens / outputTokens / totalTokens / costUsd / durationMs / prompt+response snippets`.
- Subagent token rollups: `src/agents/jules/swarm/sub-agent.js:115-118`.
- Session relay (fire-and-forget, circuit-breakered): `src/session/stream.js:256` → POST `/api/v1/sessions/{id}/events`. 500 events/min cap, 3-failure circuit, 60s reset.
- **Soft gap:** orchestrator emits `progress` events with prose (`src/commands/audit.js:782, 802, 939`) instead of dedicated `orchestrator_start / dispatch / reconcile_start` events. Dashboard parsing is harder than it should be. Adding typed orchestrator events is a small win.
- **Soft gap:** there is no TUI overlay. With `--stream` you get raw NDJSON. Pipe to `jq` for now; a TUI is a Phase-3 polish, not a blocker.

### 2.6 Senti coordination etiquette — ⚠️ ~80% in place

- Spec coordination phase: `src/spec/generator.js:507-528` (`buildCoordinationPhase`) emits `sl session join`, status updates every 5 min, finding posting, help requests, leave on done. Conditional on `shouldIncludeCoordinationPhase` (`src/spec/generator.js:564-572`).
- Prompt guidance constant: `src/prompt/generator.js:37-41` (`SESSION_COORDINATION_GUIDANCE`).
- AGENTS.md / CLAUDE.md upsert: `src/session/setup-guides.js:25-56` (`buildSessionCoordinationSection`) and `:227-265` (`setupSessionGuides`).
- AIdenID guidance block: `src/prompt/generator.js:104-114`.
- Session `--title` flag: `src/commands/session.js:268, 361, 376-381, 408`.
- Auto-resume: `--resume` is documented but not implemented in the create flow. `--reuse-window-seconds` is in the description, not the action body.
- Session naming derivation from codebase + date: missing. `src/session/senti-naming.js` exists for friendly agent names (`claude-1`, `codex-2`) but does not auto-derive session titles.
- Setup-guides injection during spec/prompt generation: not auto-called. User must manually run `setupSessionGuides()`.
- Background polling pattern for agents: not exposed. `src/session/sync.js` has the circuit-breaker primitives but no agent-facing background listener.
- Guide export to Jira/Linear/GitHub Issues at `src/guide/generator.js:185-251` does not include coordination rules.

### 2.7 AIdenID devTestBot — ⚠️ provisioning live, automation absent

- AIdenID provisioning works: `src/ai/aidenid.js:114-150+` (`buildProvisionEmailPayload`, `buildChildIdentityPayload`), `src/ai/identity-store.js:110-150+` (`listIdentities`, `getIdentityById`, `recordProvisionedIdentity`). Programmatic N-identity provisioning supported.
- Tool wired: `src/agents/jules/tools/aidenid-email.js:20-48` (`AIDENID_EMAIL_TOOL`) supports `provision`, `wait_for_otp`, `status`. Dispatched via Jules tool registry.
- **No browser automation.** Playwright / Puppeteer / Cypress / Browser-MCP all absent from `package.json`. Confirmed.
- **No devTestBot agent persona.** No system prompt, no role, no orchestrator hook.
- **No a11y / Lighthouse libs** in API or web `package.json`s.
- **No DD orchestrator → devTestBot trigger** today.

### 2.8 DD email synthesis — ⚠️ Resend + S3 ready, no DD endpoint

- Resend client: `sentinelayer-api/src/services/email_service.py:1-32, 35-128+`. `_ensure_init()` lazy-init pattern is reusable.
- Config: `sentinelayer-api/src/config.py:231` (`resend_from_email, resend_reply_to, resend_api_key`).
- Demo signup uses Resend: `sentinelayer-api/src/routes/auth.py:1464, 1551`.
- S3 artifact storage with presigned URLs: `sentinelayer-api/src/services/artifact_service.py:45-111` (`generate_upload_urls`, 15-min TTL). Bucket layout `{prefix}/{run_id}/{artifact_name}`. Already supports `.mp4` blobs.
- **Missing:** `POST /api/v1/runs/{run_id}/send-report-email` endpoint, DD report HTML template, code that bundles findings + devTestBot reports + video URLs into one email.

---

## 3. Build batches — ordered PRs

Each PR is a small reviewable scope. Follow `CLAUDE.md` (Omar Loop Contract). Squash-merge only after Omar Gate is green. Use the branch names below verbatim.

### Batch A — DD parity foundations (high leverage, low risk)

#### **PR-A1** ☐ Persona Jules-parity tool grant in `/audit`
- **Branch:** `dd/pr-a1-persona-jules-tools`
- **Problem:** non-Jules personas in `src/audit/orchestrator.js` route + filter; they don't run agentic loops with the file-read/grep/glob/shell/edit/dispatch toolset that Jules has. The user expects all 13 to feel like Jules.
- **Borrow pattern from:**
  - `src/agents/jules/loop.js` — `julesAuditLoop` agentic structure (read; do not import).
  - `src/agents/jules/tools/index.js` — tool registry shape (file_read, grep, glob, shell, file_edit, dispatch).
  - `src/agents/jules/config/system-prompt.js` — system-prompt shape with the 11-lens evidence contract.
  - `src/agents/jules/tools/dispatch.js:148-175` — usage events emitted per tool call.
- **Work:**
  1. Extend `src/audit/registry.js` agent definitions: each persona gets a `tools: [...]` array (default = full Jules set; allow per-persona narrowing).
  2. Add a thin `runPersonaAgenticLoop(personaId, scope, ctx)` in a new file `src/audit/persona-loop.js` that runs N turns (cap at the persona's `defaultBudget`) with the granted tools. It must not import from `src/agents/jules/loop.js`; it borrows the structure.
  3. Wire `src/audit/orchestrator.js` to call the new loop instead of the deterministic-filter path for non-Jules personas. Preserve Jules's existing flow.
  4. Each persona must emit `agent_start / agent_complete / agent_error / agent_abort` (reuse the schema, do not re-author it — `src/events/schema.js:76-116`).
- **Done when:**
  - `sl /audit --path . --agents security --stream` shows the security persona making real tool calls (NDJSON events with `tool_call` + `tool_result`) and emitting findings — not just routing baseline output.
  - Per-persona `usage.outputTokens > 0` for every persona that ran.
  - Test: a fixture repo with one obvious bug in each persona's domain — every persona finds its bug.

#### **PR-A2** ☐ Persona run isolation hardening
- **Branch:** `dd/pr-a2-persona-isolation`
- **Problem:** ensure no transcript bleed across personas in `/audit`. Today personas read shared blackboard finding registry, which is correct, but their LLM clients should not share context windows or message histories.
- **Borrow pattern from:**
  - `src/audit/orchestrator.js:299-323` (existing fresh-client-per-persona scaffolding).
  - `src/agents/jules/loop.js` — note how it constructs a clean message history per turn.
- **Work:**
  1. Add an explicit `createIsolatedPersonaContext({ personaId, runId })` helper in `src/audit/persona-loop.js`. Returns `{ client, runId, blackboard, emitter, tools }`.
  2. Assert (with a test) that no two persona contexts share a message history reference.
  3. Add a `--isolation strict|relaxed` flag to `sl audit` (default `strict`).
- **Done when:**
  - Test: spy on the LLM client; confirm two parallel personas have disjoint message arrays.

#### **PR-A3** ☐ Reconciliation events as first-class typed events
- **Branch:** `dd/pr-a3-reconcile-events`
- **Problem:** orchestrator emits `progress` events with prose for setup / ingest / baseline / reconciliation phases. Dashboards have to regex-match the text. Add typed events.
- **Borrow pattern from:**
  - `src/events/schema.js:76-116` event envelope.
  - `src/review/omargate-orchestrator.js` for `omargate_start / omargate_complete` typed events.
- **Work:**
  1. Add to `src/events/schema.js` valid event names: `orchestrator_start, phase_start, phase_complete, dispatch, reconcile_start, reconcile_complete, orchestrator_complete`.
  2. Replace the prose `progress` events at `src/commands/audit.js:782, 802, 939` with the typed equivalents, while still emitting a `progress` shadow event (backwards-compatible) for one release.
  3. Update tests.
- **Done when:**
  - `sl /audit --path . --stream | jq -r 'select(.event | startswith("phase_") or startswith("reconcile_")) | .event'` shows the new lifecycle.

### Batch B — Swarm fanout for omargate + DD personas

#### **PR-B1** ☐ Wire swarm-fanout into `/omargate` per-persona stage
- **Branch:** `dd/pr-b1-omargate-swarm`
- **Problem:** `src/review/omargate-orchestrator.js:163-327` runs each persona as a single LLM call. Token-limit hazard on >5,000 LOC.
- **Borrow pattern from:**
  - `src/agents/jules/swarm/orchestrator.js:23-56` (`shouldSpawnSubAgents`, thresholds).
  - `src/agents/jules/swarm/file-scanner.js` — file partitioning logic.
  - `src/agents/jules/swarm/sub-agent.js:41-227` — subagent lifecycle + start/end events.
- **Work:**
  1. Add `decideSwarm({ scope })` helper in `src/review/omargate-orchestrator.js` borrowing the threshold logic.
  2. When swarm is decided, partition the persona's file scope (≤12 files per scanner) and dispatch sub-agents with a parent-bound budget (split the persona's `perPersonaCost`). Cap concurrency at 4.
  3. Each subagent emits its own `agent_start / agent_complete` with the persona id + subagent index. Findings roll up via blackboard, dedupe at the orchestrator.
- **Done when:**
  - On a fixture repo with >15 files and >5,000 LOC: `sl /omargate deep --stream` emits `swarm_start` for at least one persona and >1 subagent lifecycle.
  - Total cost stays within the per-persona budget cap.

#### **PR-B2** ☐ Same swarm-fanout for `/audit` personas
- **Branch:** `dd/pr-b2-audit-swarm`
- **Problem:** matches PR-A1 — once non-Jules personas are agentic, big repos can starve them. Mirror the omargate work.
- **Borrow pattern from:** PR-B1 + the same swarm primitives.
- **Work:** wire the swarm decision into `src/audit/persona-loop.js`. Same lifecycle events + budget rules.
- **Done when:** the same fixture-repo invariant as PR-B1, but for `sl /audit`.

### Batch C — Cross-pipeline reconciliation + false-positive guard

#### **PR-C1** ☐ Hard-enforce confidence floor in code (post-prompt)
- **Branch:** `dd/pr-c1-confidence-floor`
- **Problem:** `src/review/persona-prompts.js:326-328` asks for `confidence >= 0.7`. The LLM may ignore. Add a code gate.
- **Borrow pattern from:** `src/review/report.js:65-170` dedup + multi-source confidence boost.
- **Work:**
  1. In `src/review/report.js`, add `dropBelowConfidence(threshold)` that filters findings whose `confidence` is below the persona's `confidenceFloor` (default 0.7) UNLESS the finding has multi-source confirmation.
  2. Apply at the merge step.
  3. Surface dropped count in the run summary so we can see the FP guard's impact.
- **Done when:** test: a persona that emits 5 low-confidence findings on a fixture; the report has 0; the summary says "5 findings dropped below confidence floor (single-source)".

#### **PR-C2** ☐ Reuse `/omargate` deterministic findings in `/audit`
- **Branch:** `dd/pr-c2-omargate-audit-reuse`
- **Problem:** `/audit` re-runs deterministic work that `/omargate` already did. Wasted compute, divergent findings.
- **Borrow pattern from:**
  - `src/review/local-review.js` (where deterministic results are written to disk under `.sentinelayer/`).
  - `src/audit/orchestrator.js` ingest phase.
- **Work:**
  1. After `/omargate deep` writes its run, persist deterministic findings under a stable path `.sentinelayer/runs/<runId>/deterministic.json`.
  2. `/audit` accepts `--reuse-omargate <runId>` (or auto-detects the latest run for the same `targetPath`) and skips the deterministic phase, feeding the cached findings into the blackboard.
  3. If reuse not available, behavior is unchanged.
- **Done when:** `sl /omargate deep --path .` then `sl /audit --path . --reuse-omargate latest` skips deterministic and references the prior runId in the report header.

#### **PR-C3** ☐ 11-lens evidence verification ported to omargate
- **Branch:** `dd/pr-c3-eleven-lens-omargate`
- **Problem:** Jules has the 11-lens evidence contract; `/omargate`'s personas don't.
- **Borrow pattern from:** `src/agents/jules/config/system-prompt.js` (the 11-lens checklist); `src/review/persona-prompts.js` (existing persona prompts).
- **Work:** add a generic 11-lens evidence appendix to all 13 omargate personas; rerun a fixture and measure FP delta.
- **Done when:** the prompt update lands and a measured FP-rate drop on a labeled fixture is recorded in the PR description.

### Batch D — Senti coordination injection (the agent-etiquette work)

#### **PR-D1** ☐ Auto-inject coordination etiquette into spec/prompt/AGENTS.md generation
- **Branch:** `dd/pr-d1-coordination-autoinject`
- **Problem:** the coordination phase already exists but isn't auto-applied; agents miss it unless someone runs `setupSessionGuides()` manually.
- **Borrow pattern from:**
  - `src/session/setup-guides.js:25-56, 227-265`
  - `src/spec/generator.js:507-528`
  - `src/prompt/generator.js:37-41, 64-70, 104-114`
- **Work:**
  1. Make `src/spec/generator.js` always emit the coordination phase when **any** session-related tool is configured (not just when explicit signals are detected).
  2. Make `src/prompt/generator.js` always append `SESSION_COORDINATION_GUIDANCE`.
  3. Make `src/guide/generator.js:185-251` include coordination rules in Jira/Linear/GitHub Issues exports.
  4. Update the canonical etiquette text to teach: **join recent senti session for the codebase**, post **plan**, **claim files** (`lock:` / `unlock:`), poll every 5 min, run `/review` on each finished file or PR-ready diff, post findings via `sl session say`, ask for help, offer non-conflicting work to peers, and run `sl --help` when stuck.
- **Done when:** `sl spec generate` and `sl prompt generate` and `sl guide generate` always include the coordination block.

#### **PR-D2** ☐ Session auto-naming `<codebase>-<YYYY-MM-DD>` + auto-resume
- **Branch:** `dd/pr-d2-session-auto-name-resume`
- **Problem:** session titles must be set with `--title`; agents joining cold can't find "the right" session.
- **Borrow pattern from:**
  - `src/session/senti-naming.js` (the friendly-agent-name utility; mirror its approach for sessions).
  - `src/commands/session.js:268, 361, 376-381` (title flag wiring).
- **Work:**
  1. Add `deriveSessionTitle(targetPath)` in `src/session/senti-naming.js` that returns `<basename(targetPath)>-<YYYY-MM-DD>`.
  2. In `sl session start`, when no `--title` is passed, set the title to the derived value.
  3. Implement `--resume` (default true) and `--reuse-window-seconds` for real: list active sessions for the current `targetPath`, pick the most recent within the window, join it; only mint a new session if none qualify.
  4. New `sl session ensure --path .` returns `{ sessionId, title, resumed: bool }` — the canonical "join or create" call agents will use.
- **Done when:** running the same `sl session ensure --path .` twice within the window returns the same id; outside the window mints a new session named with today's date.

#### **PR-D3** ☐ Background poll listener for agents (`sl session listen`)
- **Branch:** `dd/pr-d3-session-listen`
- **Problem:** agents have no out-of-band way to receive direct messages from peers / Senti / Carter.
- **Borrow pattern from:**
  - `src/session/sync.js` (circuit-breaker, rate-limit primitives).
  - `src/agents/jules/stream.js` (NDJSON framing).
- **Work:**
  1. New `sl session listen --session <id> --interval 60 --emit ndjson` that long-polls the session events endpoint and emits any event whose `to` field matches the agent (or is broadcast).
  2. Reuse the existing circuit breaker.
  3. Document in the coordination etiquette (PR-D1) how agents should run this in the background.
- **Done when:** two terminals; one runs `listen`; the other runs `say`; the listener prints the message NDJSON within `interval` seconds.

### Batch E — AIdenID devTestBot

#### **PR-E1** ☐ [ADD-NEW] Browser automation primitives (Playwright)
- **Branch:** `dd/pr-e1-playwright-base`
- **Problem:** no browser automation library in the repo.
- **Work:**
  1. Add `playwright` to `package.json` (NOT a direct dep on `puppeteer` — Playwright covers Chromium/Firefox/WebKit and has a stronger a11y/trace story).
  2. New `src/agents/devtestbot/runner.js` that exports `launch({ baseUrl, identityCreds })` returning a wrapped `Page` instrumented with: console capture, network capture, axe-core a11y scan, Lighthouse run, click-coverage tracker, video recording.
  3. Add deps: `axe-core`, `@axe-core/playwright`, `lighthouse`.
  4. Tests: a smoke run against a static fixture confirms each capture lane records something.
- **Done when:** unit test launches a local fixture, opens a page, and produces a recorded `.mp4` plus an a11y JSON plus a Lighthouse JSON.

#### **PR-E2** ☐ [ADD-NEW] devTestBot agent persona
- **Branch:** `dd/pr-e2-devtestbot-persona`
- **Problem:** no devTestBot agent.
- **Borrow pattern from:**
  - `src/agents/jules/config/definition.js` and `src/agents/jules/config/system-prompt.js` for shape.
  - `src/ai/aidenid.js` and `src/agents/jules/tools/aidenid-email.js` for identity provisioning.
- **Work:**
  1. New `src/agents/devtestbot/config/definition.js` + `system-prompt.js` describing: scan-only mandate, no data extraction, scope = full system test, lanes = console errors, network errors, a11y, Lighthouse, click-coverage, PW reset E2E.
  2. New tool `devtestbot.run_session` that takes `{ scope, identityId, recordVideo: true }` and returns artifacts via the runner from PR-E1.
  3. Output normalized findings into the same envelope as Jules (`src/events/schema.js:76-116`).
- **Done when:** `sl swarm run --agent devtestbot --scope smoke` produces findings + an artifact bundle.

#### **PR-E3** ☐ DD orchestrator engages devTestBot
- **Branch:** `dd/pr-e3-dd-engages-devtestbot`
- **Problem:** DD does not auto-run devTestBot.
- **Borrow pattern from:** `src/commands/audit.js:54-122` and `src/audit/orchestrator.js:219-556` for how phases are ordered.
- **Work:**
  1. Add a phase to the DD pipeline that:
     - asks the orchestrator to decide `{ identityCount, swarmCount, perSwarmBudget, scope }` (LLM call inside the orchestrator with the Jules client; no new agent).
     - provisions `identityCount` AIdenIDs via `recordProvisionedIdentity()`.
     - dispatches `swarmCount` devTestBot subagents in parallel (cap at `maxConcurrentAgents: 4`), each with its own scope.
     - merges artifacts + findings into the run package.
  2. Cap total bot cost via the orchestrator budget.
- **Done when:** `sl /omargate investor-dd --path . --stream` emits `devtestbot_start` events and concludes with bundled artifacts in `.sentinelayer/runs/<runId>/devtestbot/`.

### Batch F — DD email synthesis

#### **PR-F1** ☐ API: `POST /api/v1/runs/{run_id}/send-report-email`
- **Branch:** `dd/pr-f1-dd-email-endpoint`
- **Problem:** no DD report email exists.
- **Borrow pattern from:**
  - `sentinelayer-api/src/services/email_service.py:1-128+` (`_ensure_init`, `send_welcome_email`).
  - `sentinelayer-api/src/services/artifact_service.py:45-111` (presigned URL generation, `generate_upload_urls`).
  - `sentinelayer-api/src/routes/auth.py:1464, 1551` (Resend integration call site).
- **Work:**
  1. New `dd_report_service.py` that loads the run's findings, devTestBot reports, and S3 video URLs (presigned, 24h TTL), renders an HTML template, and sends via Resend.
  2. New route `POST /api/v1/runs/{run_id}/send-report-email` requiring run owner auth; rate-limited.
  3. Email body: hero summary (P0/P1/P2 counts), top 10 findings with file:line, devTestBot capture summary, embedded thumbnails linking to videos.
  4. Idempotency key on the request to prevent double-send.
- **Done when:** integration test sends a fixture run; the rendered HTML matches a snapshot; Resend mock receives the payload.

#### **PR-F2** ☐ CLI: orchestrator-triggered email at end of DD
- **Branch:** `dd/pr-f2-dd-orchestrator-email`
- **Problem:** orchestrator doesn't trigger the new endpoint.
- **Borrow pattern from:** `src/telemetry/sync.js:120` (fire-and-forget pattern with circuit breaker).
- **Work:**
  1. New `--email-on-complete <to>` flag on `sl /omargate investor-dd`.
  2. After all phases finish, POST to the new API endpoint.
  3. Emit `dd_email_queued` event in the stream.
- **Done when:** `sl /omargate investor-dd --path . --email-on-complete carther@bu.edu --stream` ends with the event and a delivered email.

---

## 4. Quality bar (non-negotiable)

- **No secret leakage** in code, logs, artifacts, PR comments. Test for it.
- **Omar Gate green** before every merge.
- **Tests written** for every new code path. No "tested manually."
- **Streaming demonstrated** for every PR that touches an actor — paste the NDJSON output in the PR description.
- **No new top-level abstractions** unless this spec marks `[ADD-NEW]` or you can name three current callers that need it.
- **Borrow, don't import.** If you find yourself adding `import ...` from `src/agents/jules/` into something outside that namespace, stop and copy the small piece you need into your feature directory. Jules is a citizen, not a library.
- **One concern per PR.** Branch names map 1:1 to the PRs above.

---

## 5. Borrowed-code map (study; do not import)

| Capability | Reference src |
|---|---|
| Agentic loop turn structure | `src/agents/jules/loop.js` |
| Tool registry shape | `src/agents/jules/tools/index.js` |
| Per-tool usage event | `src/agents/jules/tools/dispatch.js:148-175` |
| 11-lens evidence checklist | `src/agents/jules/config/system-prompt.js` |
| Subagent lifecycle + budgets | `src/agents/jules/swarm/sub-agent.js:41-227` |
| Swarm decision thresholds | `src/agents/jules/swarm/orchestrator.js:23-56` |
| File partitioning | `src/agents/jules/swarm/file-scanner.js` |
| NDJSON event envelope | `src/events/schema.js:76-116, 177-187` |
| --stream wiring | `src/commands/audit.js:754, 763, 1142-1143` |
| Live token emission | `src/session/usage.js:82-156` |
| Session relay (fire-and-forget) | `src/session/stream.js:256` |
| Persona prompts (existing 13) | `src/review/persona-prompts.js:30-480` |
| Deterministic 22 rules | `src/review/local-review.js:111-303, 1137` |
| AI review layer + budget | `src/review/ai-review.js:378` |
| Multi-source dedup | `src/review/report.js:65-170` |
| Persona orchestration (omargate) | `src/review/omargate-orchestrator.js:30-48, 163-327` |
| Persona orchestration (audit) | `src/audit/orchestrator.js:219-556` |
| Spec coordination phase | `src/spec/generator.js:507-528` |
| Prompt coordination guidance | `src/prompt/generator.js:37-41, 104-114` |
| AGENTS.md upsert | `src/session/setup-guides.js:227-265` |
| Senti naming | `src/session/senti-naming.js` |
| Session sync + circuit breaker | `src/session/sync.js` |
| AIdenID provisioning | `src/ai/aidenid.js`, `src/ai/identity-store.js` |
| AIdenID Jules tool | `src/agents/jules/tools/aidenid-email.js:20-48` |
| Email service (API) | `sentinelayer-api/src/services/email_service.py` |
| Artifact storage (API) | `sentinelayer-api/src/services/artifact_service.py:45-111` |
| Telemetry fire-and-forget | `src/telemetry/sync.js:120` |

---

## 6. Test plan (what "done" looks like end-to-end)

When all batches are merged, this command should produce a clean, complete run:

```bash
sl /omargate investor-dd --path /path/to/repo --stream --email-on-complete carther@bu.edu | tee dd-run.ndjson
```

Expected event spine (slice; not exhaustive):

```
{"event":"orchestrator_start", ...}
{"event":"phase_start","phase":"ingest", ...}
{"event":"phase_complete","phase":"ingest", ...}
{"event":"phase_start","phase":"deterministic", ...}
{"event":"phase_complete","phase":"deterministic", ...}
{"event":"phase_start","phase":"personas", ...}
{"event":"agent_start","agent":{"id":"security"}, ...}
{"event":"swarm_start","parent":"security", ...}
{"event":"agent_start","agent":{"id":"security-sub-1"}, ...}
{"event":"tool_call","tool":"grep", ...}
{"event":"session_usage","totalTokens":..., "costUsd":...}
{"event":"finding","severity":"P1","persona":"security", ...}
{"event":"agent_complete","agent":{"id":"security-sub-1"}, ...}
{"event":"swarm_complete","parent":"security", ...}
{"event":"agent_complete","agent":{"id":"security"}, ...}
... (12 more personas) ...
{"event":"phase_start","phase":"devtestbot", ...}
{"event":"agent_start","agent":{"id":"devtestbot-1"}, ...}
{"event":"agent_complete","agent":{"id":"devtestbot-1"}, ...}
{"event":"phase_complete","phase":"devtestbot", ...}
{"event":"reconcile_start", ...}
{"event":"reconcile_complete","unique":..., "deduped":..., "dropped_low_confidence":...}
{"event":"dd_email_queued","to":"carther@bu.edu", ...}
{"event":"orchestrator_complete","durationMs":..., "totalCostUsd":..., "findings":{P0:0,P1:..,P2:..,P3:..}}
```

The user receives one email containing: hero P0/P1/P2 counts, top 10 findings with file:line evidence, devTestBot lane summaries, and embedded thumbnails linking to recorded videos in S3.

---

## 7. How to use this file

You (the agent) should:

1. **Open the Senti session for this codebase first.** `sl session ensure --path .` (after PR-D2; until then, `sl session start --title create-sentinelayer-2026-04-26`). Post a plan that lists which PRs you intend to do today, in order. Claim files. Listen for replies.
2. Tackle batches in order — A → B → C → D → E → F. Within a batch, PRs can run in parallel only if their branches don't touch the same files.
3. Each PR follows `CLAUDE.md`: branch from main, implement, `npm run verify`, `node bin/create-sentinelayer.js /omargate deep --path . --json`, push, open PR, watch Omar.
4. When a PR is ready for review, run `/review --diff` and paste the result into the PR description.
5. Post your findings — including blockers — into the Senti session so peers can pick up non-conflicting work.
6. **If this spec is wrong or incomplete, say so in the Senti session and update this file.** This is a babysitter, not a cage.

— end of spec —
