// Test-bootstrap module, imported first by every test file (and via
// `node --import ./tests/setup-env.mjs --test ...` in package.json scripts).
//
// 1. SENTINELAYER_SKIP_REMOTE_SYNC=1 short-circuits the gated session/event
//    sync writes (without it, every `sl session start` in a test posted an orphan
//    session into the prod dashboard).
// 2. SENTINELAYER_SKIP_SENTI_AUTOSTART=1 keeps tests from spawning the daemon.
// 3. Isolated home: HOME/USERPROFILE/APPDATA/LOCALAPPDATA/XDG_CONFIG_HOME point
//    at a fresh temp dir, and the OS keyring is disabled, so no test can load the
//    developer's real stored credentials or write circuit-breaker state into the
//    real ~/.sentinelayer. (os.homedir() reads USERPROFILE on Windows and HOME
//    elsewhere, at call time.)
// 4. Fail-closed egress guard: globalThis.fetch refuses any non-loopback host.
//    The skip flag above is checked by only some call sites (and some tests clear
//    it), so the guard, not the flag, is the safety boundary.
//    SENTINELAYER_TEST_EGRESS_GUARD=1 is inherited by spawned children, whose
//    src/session/sync.js and src/auth/http.js install the same guard at load.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { installTestEgressGuard } from "../src/net/test-egress-guard.js";

process.env.SENTINELAYER_SKIP_REMOTE_SYNC = "1";
process.env.SENTINELAYER_SKIP_SENTI_AUTOSTART = "1";

// A fresh home per test process (concurrent test files never share state).
const testHome = fs.mkdtempSync(path.join(os.tmpdir(), "sl-test-home-"));
process.on("exit", () => {
  try {
    fs.rmSync(testHome, { recursive: true, force: true });
  } catch {
    // best effort
  }
});
process.env.SENTINELAYER_TEST_HOME = testHome;
process.env.HOME = testHome;
process.env.USERPROFILE = testHome;
process.env.APPDATA = path.join(testHome, "AppData", "Roaming");
process.env.LOCALAPPDATA = path.join(testHome, "AppData", "Local");
process.env.XDG_CONFIG_HOME = path.join(testHome, ".config");
process.env.SENTINELAYER_DISABLE_KEYRING = "1";

process.env.SENTINELAYER_TEST_EGRESS_GUARD = "1";
installTestEgressGuard({ force: true });
