// A stand-in for the GitHub CLI that records every invocation. It is this Node.js binary under the
// name gh (a hard link, a copy, or a symlink) plus a preload that acts only when the process was
// started as gh. Pass `env` to the CLI under test; `calls()` returns each invocation's arguments.
import fs from "node:fs";
import path from "node:path";

const PRELOAD = `
const fs = require("fs");
const path = require("path");
if (/^gh(\\.exe)?$/i.test(path.basename(process.argv0 || ""))) {
  const [script, ...rest] = process.argv.slice(1);
  const args = [path.basename(script || ""), ...rest];
  const log = process.env.GH_SPY_LOG;
  let input = "";
  if (args[0] === "secret" && args[1] === "set") {
    try { input = fs.readFileSync(0, "utf8"); } catch {}
  }
  fs.appendFileSync(log, JSON.stringify({ args, input }) + "\\n");
  if (args[0] === "api") {
    const permissions = JSON.parse(process.env.GH_SPY_PERMISSIONS || "{}");
    const repo = String(args[1] || "").replace(/^repos\\//, "");
    process.stdout.write(JSON.stringify({ full_name: repo, permissions }));
  } else if (args[0] === "secret" && args[1] === "list") {
    const set = fs.readFileSync(log, "utf8").trim().split("\\n").map((line) => JSON.parse(line))
      .filter((call) => call.args[0] === "secret" && call.args[1] === "set").map((call) => call.args[2]);
    process.stdout.write(set.map((name) => name + "\\tUpdated now").join("\\n") + "\\n");
  }
  process.exit(0);
}
`;

export function createGhSpy(dir, { permissions = { admin: true, push: true } } = {}) {
  fs.mkdirSync(dir, { recursive: true });
  const bin = path.join(dir, process.platform === "win32" ? "gh.exe" : "gh");
  try {
    fs.linkSync(process.execPath, bin);
  } catch {
    if (process.platform === "win32") fs.copyFileSync(process.execPath, bin);
    else fs.symlinkSync(process.execPath, bin);
  }
  const preload = path.join(dir, "gh-spy-preload.cjs");
  const log = path.join(dir, "gh-spy-calls.jsonl");
  fs.writeFileSync(preload, PRELOAD);
  return {
    env: {
      SENTINELAYER_GH_BIN: bin,
      // forward slashes: NODE_OPTIONS treats a backslash inside quotes as an escape
      NODE_OPTIONS: `--require="${preload.split(path.sep).join("/")}"`,
      GH_SPY_LOG: log,
      GH_SPY_PERMISSIONS: JSON.stringify(permissions),
    },
    // `gh --version` is answered by Node.js itself and is not recorded.
    calls: () =>
      fs.existsSync(log)
        ? fs.readFileSync(log, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line))
        : [],
  };
}
