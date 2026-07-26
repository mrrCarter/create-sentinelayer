# SentinelLayer Engineering Onboarding

This brief is the fastest safe path for a new engineer or coding agent to join
SentinelLayer work without drifting across repos, duplicating active slices, or
weakening the Omar gate. Read this after `README.md`, `AGENTS.md`, and
`docs/sessions.md`.

## Product Map

SentinelLayer is a coordination and audit platform for AI-assisted software
work. The product is split across four active surfaces:

- `create-sentinelayer` ships the `sentinelayer-cli` package, Senti session
  commands, Omar gate command surface, Investor-DD orchestration, release
  workflows, and generated project artifacts.
- `sentinelayer-api` owns authenticated session persistence, usage ledgers,
  checkpoint storage, message actions, membership/share primitives, AIdenID
  projections, and deploy-time GitHub/Omar integrations.
- `sentinelayer-web` renders the dashboard: session transcript, actions,
  checkpoints, usage/cost header stats, share/invite flows, AIdenID panels,
  and operator controls.
- `sentinellayer-aws-terraform` owns production infrastructure, CloudFront,
  ECS services, RDS, Redis, alarms, deployment roles, and safety preconditions.

The CLI, API, and web are intentionally independent repos. A feature is not
done until the user-facing path is proven across every repo it depends on.

## Request Flow

Most Senti session work moves through this chain:

1. Agent or human uses `sl session ...` or the dashboard.
2. CLI authenticates and sends a request to `https://api.sentinelayer.com`.
3. API writes durable session rows with stable ids, sequence ids, cursors,
   actor identity, usage metadata, and action projections.
4. Web reads canonical API pages and streams live updates; it must recover from
   gaps by falling back to durable event reads.
5. Checkpoints, exports, usage ledgers, and Omar artifacts become audit evidence.

Do not treat a green frontend or a healthy `/health` endpoint as end-to-end
proof. For session features, prove the CLI or web action persists through the
API and can be read back from the human surface.

## Repo Responsibilities

Use the narrowest repo that owns the behavior:

| Need | Primary repo | Proof target |
| --- | --- | --- |
| New `sl` command, help text, release packaging, local session behavior | `create-sentinelayer` | `npm run check`, focused unit/e2e, `sl ... --help`, npm smoke after publish |
| Auth, durable session rows, actions, usage, checkpoints, membership, API contracts | `sentinelayer-api` | focused pytest, ruff, compileall, live API readback after deploy |
| Dashboard UX, transcript loading, checkpoint cards, stats, invite/share controls | `sentinelayer-web` | focused vitest, lint, typecheck, build, production release proof |
| ECS, RDS, Redis, CloudFront, alarms, deploy permissions | `sentinellayer-aws-terraform` | plan artifacts, policy checks, guarded apply/deploy proof |

If a feature spans repos, ship it as small PRs in dependency order: API
contract first, then CLI/web consumers, then release/deploy proof.

## Senti Coordination Rules

Use Senti as the coordination record, not as a status spam channel.

- Join the active session before material work and sign substantive posts with
  your agent name.
- Read the latest human and peer messages before each implementation block.
- Post only material updates: plan changes, ownership claims, PR links, deploy
  evidence, peer-review requests, and blockers.
- Use actions for low-noise signals: `ack`, `view`, `working_on`, reactions,
  and threaded replies.
- Keep polling quiet. Polling does not require top-level ACK messages.
- If a peer owns a non-conflicting slice, do not duplicate it. Audit their PR
  or move to the next independent slice.

Useful commands:

```bash
sl session read <session-id> --remote --tail 20
sl session say <session-id> "material update" --agent codex --to carter
sl session action <session-id> working_on --target-sequence <n> --note "scope"
sl session reply <session-id> <sequence> "threaded review"
sl session checkpoint list <session-id> --json
sl session checkpoint show <session-id> <checkpoint-id> --json
```

On Windows PowerShell, use `sl.cmd` if `sl` resolves to `Set-Location`.

## Omar And Release Gates

Every implementation PR must preserve the visible Omar and quality gates.

- The trusted create-sentinelayer Omar check is named `Omar Gate (Deep Scan)`.
- The GitHub run must contain the real `Run Omar Gate` step and publish an Omar
  run id such as `ghdeep_*` with P0/P1/P2/P3 counts.
- P0 and P1 findings block merge. P2 findings require judgment and evidence.
- Do not rely on bridge comments, SBOM artifacts, or wrapper names as proof that
  the deep scan ran.
- After merging, watch main branch Quality, Omar, Attestation, and Release
  Please gates for the merge SHA.
- For CLI releases, npm registry state is the user-facing proof. A merged release
  PR is not enough.

Use guarded deploy workflows for production API/web changes. For API-shaped data
features, verify both `GET /health` build SHA and a live authenticated response
from the relevant endpoint before calling the feature live.

## Current High-Priority Backlog

The active dogfood priorities should be handled in PR-sized slices:

1. Onboarding and architecture clarity for new collaborators.
2. Invite, membership, share, visibility, hard caps, and role-rate-limit polish.
3. Session loading resilience: durable pagination, duplicate replay, cursor
   monotonicity, export parity, and recovery from stream gaps.
4. Reply/action/export parity: replies, reactions, ACKs, `working_on`, and
   reply-level actions must appear in CLI, web, and markdown exports.
5. Omar parity across CLI, API, web, and Terraform: real managed LLM gate proof,
   no comment-only fallback, and visible run evidence.
6. Token metering and pricing UX: per-agent tokens, cost, margin, report/export
   totals, and billing-grade session usage.
7. Scale tuning after real load: RDS/Redis sizing, stream fanout, alarms, and
   partitioning only when production volume justifies it.

Keep this list honest. If a slice lands only in one repo, mark it partial until
the dependent repo and production path are proven.

## Local Work Checklist

Before opening a PR:

1. Sync from `origin/main` and create one branch for one scope.
2. Inspect the owning repo's `AGENTS.md`, `README.md`, and nearby tests.
3. Update `tasks/todo.md` in the operator workspace with plan and evidence.
4. Implement the smallest durable fix.
5. Run changed-scope tests plus repo-required checks.
6. Run `git diff --check`.
7. Open the PR with evidence: scope, risk, affected files, tests, Omar proof,
   release/deploy impact, and follow-ups.

After merge:

1. Watch main branch checks for the merge SHA.
2. Deploy through the guarded workflow when needed.
3. Verify the live user-facing path, not only CI.
4. Update the Senti session with proof and the next non-conflicting slice.
5. Update local `tasks/todo.md` and `tasks/lessons.md` if a correction occurred.

## Common Failure Modes

- Calling a feature done from a green web deploy while the API serving its data
  is still on the old build.
- Losing Senti awareness while waiting on CI or ECS bake windows.
- Publishing CLI changes in source but not proving the npm dist-tag and fresh
  install smoke.
- Treating session stream delivery as canonical while durable `/events` or
  exports disagree.
- Reintroducing obsolete public Omar/comment language through workflow names,
  PR comments, helper scripts, or fixtures.
- Hiding partial DD or billing work behind optimistic wording. Sellable-ready
  claims need durable usage, report, artifact, and live workflow proof.

When in doubt, prove the exact surface Carter or a collaborator will touch.
