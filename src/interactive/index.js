import pc from "picocolors";
import { selectRepo } from "./workspace.js";
import { autoIngestWithProgress } from "./auto-ingest.js";
import { showActionMenu } from "./action-menu.js";
import { preferredCliCommand } from "../ui/command-hints.js";

/**
 * Interactive CLI mode — the "sl" experience with no args.
 *
 * Flow:
 * 1. Detect repos in workspace → select if multiple
 * 2. Auto-ingest with live progress
 * 3. Present action menu
 * 4. Route to the selected command
 */

/**
 * Run the interactive flow.
 *
 * @param {object} [options]
 * @param {function} [options.executeCommand] - Command executor (receives action + args)
 * @returns {Promise<void>}
 */
export async function runInteractiveMode(options = {}) {
  console.error("");
  console.error(pc.bold("  SentinelLayer CLI") + pc.gray(" — security-first development platform"));
  console.error("");

  // Step 1: Repo selection
  const repo = await selectRepo();
  if (!repo) {
    console.error(pc.yellow(`No repository selected. Run ${preferredCliCommand()} --help for available commands.`));
    return;
  }

  // Step 2: Auto-ingest
  const ingest = await autoIngestWithProgress(repo.path);

  // Step 3: Action menu
  const choice = await showActionMenu();
  if (choice.action === "exit") {
    return;
  }

  // Step 4: Route to command
  console.error("");
  if (options.executeCommand) {
    await options.executeCommand(choice, repo, ingest);
  } else {
    // Print the equivalent CLI command for the user
    const cmd = buildEquivalentCommand(choice, repo);
    if (cmd) {
      console.error(pc.gray("  Equivalent command: ") + pc.cyan(cmd));
      console.error("");
    }
  }
}

/**
 * Build the equivalent CLI command string for a menu choice.
 */
function buildEquivalentCommand(choice, repo) {
  const cli = preferredCliCommand();
  const pathFlag = " --path " + repo.path;

  switch (choice.action) {
    case "audit":
      if (choice.subAction === "deep") return `${cli} audit${pathFlag} --json`;
      return `${cli} audit ${choice.subAction}${pathFlag} --stream`;
    case "review":
      if (choice.subAction === "diff") return `${cli} review scan --mode diff${pathFlag} --json`;
      if (choice.subAction === "staged") return `${cli} review scan --mode staged${pathFlag} --json`;
      return `${cli} review scan --mode full${pathFlag} --json`;
    case "feature":
      return `${cli} spec generate --description "${(choice.input || "").slice(0, 50)}..."${pathFlag}`;
    case "create":
      return `${cli} init`;
    case "cost":
      return `${cli} cost show${pathFlag} --json`;
    case "telemetry":
      return `${cli} telemetry show${pathFlag} --json`;
    case "config":
      return `${cli} config list --json`;
    case "auth-status":
      return `${cli} auth status --json`;
    case "plugins":
      return `${cli} plugin list --json`;
    case "watch":
      return `${cli} watch history${pathFlag} --json`;
    case "ai":
      return `${cli} ai provision-email --json`;
    case "daemon":
      return `${cli} daemon budget status${pathFlag} --json`;
    default:
      return null;
  }
}
