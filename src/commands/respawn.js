import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import process from "node:process";

/**
 * `sl respawn …` — ONE front door for the Respawn commands (disposable Firecracker microVM lives that
 * prove their rebirth). This is a thin PASSTHROUGH to the Respawn CLIs so there is exactly one
 * implementation and no drift:
 *   sl respawn <up|kill|rehydrate|status|liveness|receipts|console|exec|pr|ssh|extend|demo|receipt …>
 *       → `node <respawn cli>` (machine lane; orchestrator-side; honors RESPAWN_HOME / RESPAWN_ORCH_URL / RESPAWN_ADMIN_TOKEN)
 *   sl respawn bundle <…>   → `node <respawn-bundle cli>` (bundle lane: generate / verify / enroll / authority / receipts …)
 *   sl respawn life <…>     → `node <respawn-life.js>` (bundle lane, IN-BOX lifecycle CLI: birth / bind / note / checkpoint / prove / brief; mostly for dev on the host)
 *
 * Location of the CLIs (first match wins): RESPAWN_CLI / RESPAWN_BUNDLE_CLI / RESPAWN_LIFE_CLI env; ./machine/dist/cli.js + ./bundle/dist/cli.js
 * (inside a respawn checkout); ~/.respawn/repo (a checkout path recorded by `sl respawn use <repoDir>`);
 * /opt/respawn/orch/{machine,bundle}/dist/cli.js (a deployed orchestrator host).
 */

function candidates(kind) {
  const rel = kind === "bundle" ? path.join("bundle", "dist", "cli.js") : kind === "life" ? path.join("bundle", "dist", "respawn-life.js") : path.join("machine", "dist", "cli.js");
  const envVar = kind === "bundle" ? process.env.RESPAWN_BUNDLE_CLI : kind === "life" ? process.env.RESPAWN_LIFE_CLI : process.env.RESPAWN_CLI;
  const list = [];
  if (envVar) list.push(envVar);
  list.push(path.resolve(process.cwd(), rel));
  const pin = path.join(homedir(), ".respawn", "repo");
  if (existsSync(pin)) {
    try {
      const repo = String(readFileSync(pin, "utf8")).trim();
      if (repo) list.push(path.join(repo, rel));
    } catch {
      /* ignore */
    }
  }
  list.push(path.join("/opt/respawn/orch", rel));
  return list;
}

export function resolveRespawnCli(kind = "machine") {
  for (const c of candidates(kind)) if (c && existsSync(c)) return c;
  return null;
}

function runPassthrough(cliPath, args) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [cliPath, ...args], { stdio: "inherit", env: process.env });
    child.on("close", (code) => resolve(code ?? 1));
    child.on("error", () => resolve(1));
  });
}

/** direct passthrough entry (used by runCli BEFORE commander parses, so inner --help/--version/flags are never intercepted) */
export async function runRespawnPassthrough(list) {
  if (list[0] === "use") {
    const fs = await import("node:fs");
    const dir = path.resolve(process.cwd(), String(list[1] || "."));
    fs.mkdirSync(path.join(homedir(), ".respawn"), { recursive: true });
    fs.writeFileSync(path.join(homedir(), ".respawn", "repo"), dir + "\n");
    console.log(JSON.stringify({ ok: true, repo: dir, machineCli: resolveRespawnCli("machine"), bundleCli: resolveRespawnCli("bundle"), lifeCli: resolveRespawnCli("life") }));
    return;
  }
  const isBundle = list[0] === "bundle";
  const isLife = list[0] === "life";
  const kind = isBundle ? "bundle" : isLife ? "life" : "machine";
  const cli = resolveRespawnCli(kind);
  if (!cli) {
    console.error(JSON.stringify({ ok: false, error: `respawn ${kind} CLI not found`, hint: "set RESPAWN_CLI / RESPAWN_BUNDLE_CLI / RESPAWN_LIFE_CLI, run inside a respawn checkout, `sl respawn use <repoDir>`, or run on a deployed orchestrator host (/opt/respawn/orch)", searched: candidates(kind) }));
    process.exitCode = 2;
    return;
  }
  const forwarded = isBundle || isLife ? list.slice(1) : list;
  if (!forwarded.length) forwarded.push("--help");
  process.exitCode = await runPassthrough(cli, forwarded);
}

export function registerRespawnCommand(program) {
  const respawn = program
    .command("respawn")
    .description("Respawn: disposable Firecracker microVM lives that PROVE their rebirth (passthrough to the respawn CLIs; one implementation, no drift)")
    .allowUnknownOption(true)
    .allowExcessArguments(true)
    .helpOption(false)
    .argument("[args...]", "respawn command + args (up|kill|rehydrate|status|liveness|receipts|console|exec|pr|ssh|extend|demo|receipt verify)")
    .action(async () => {
      // normally runCli hands `sl respawn <…>` off BEFORE commander (see cli.js); this path only sees bare `sl respawn`
      const i = process.argv.indexOf("respawn");
      const list = i >= 0 ? process.argv.slice(i + 1) : [];
      if (!list.length || list[0] === "--help" || list[0] === "-h") {
        respawn.outputHelp();
        return;
      }
      await runRespawnPassthrough(list);
      return;
    });

  respawn.addHelpText(
    "after",
    `
Examples:
  sl respawn demo --pause                       the whole loop live (born → work → kill → rehydrate → prove → protected PR)
  sl respawn up ./bundle --workspace ./repo     birth a life; sl respawn kill <lifeId>; sl respawn rehydrate <checkpointDir> --challenge
  sl respawn status | liveness <lifeId> | ssh <lifeId> | extend <lifeId> --minutes 30 --by carter
  sl respawn bundle generate --description "…" --runtime claude-code --out ./bundle
  sl respawn bundle receipts verify chain.json --control-pub <pub>
  sl respawn life brief --checkpoint /respawn/checkpoint --workspace /workspace     (in-box: what a fresh model reads after rehydrate)
Honest language: every respawn is a NEW box + NEW identity reconstructing recorded state — nothing is restored, resumed, or woken.`,
  );
}
