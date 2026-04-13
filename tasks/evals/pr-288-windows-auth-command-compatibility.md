# Eval Evidence - PR 288 Windows Auth Command Compatibility

Date: 2026-04-13
Branch: fix/windows-auth-command-paths

## Impacted AI Surface
- `src/ai/aidenid.js` (AIdenID credential-missing login hints)
- `src/ai/proxy.js` (proxy-auth login hint)

## Risk
- PowerShell users can be directed to `sl auth login`, which resolves to `Set-Location` and fails.
- AI command hints can produce unusable remediation paths on Windows shells.
- Operators may misdiagnose valid auth sessions as token failures due incorrect command guidance.

## Deterministic Verification
- `npm run check` -> pass
- `node --test tests/unit.command-hints.test.mjs` -> pass
- `npm run verify` -> pass

## Assertions Verified
- Runtime hint selection is platform-aware (`sentinelayer-cli` on `win32`, `sl` elsewhere) with optional override via `SENTINELAYER_CLI_COMMAND`.
- Auth-related failure messages in AI/AIdenID paths now emit executable command hints on Windows.
- New npm aliases (`slc`, `sl-cli`) provide permanent non-colliding command paths without removing existing `sl` support.
