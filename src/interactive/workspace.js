import fs from "node:fs";
import path from "node:path";
import prompts from "prompts";
import pc from "picocolors";

/**
 * Multi-repo workspace detection + interactive repo selection.
 *
 * Scans the current directory and parent for git repositories.
 * If multiple found, presents arrow-key selector.
 * If single found, auto-selects it.
 */

/**
 * Detect git repositories in the workspace.
 * Scans cwd and one level up for directories containing .git.
 *
 * @param {string} [startPath] - Starting directory (default: cwd)
 * @returns {{ repos: Array<{name, path, isCurrentDir}>, parentDir: string }}
 */
export function detectRepos(startPath) {
  const cwd = path.resolve(startPath || process.cwd());
  const parentDir = path.dirname(cwd);
  const repos = [];

  // Check if cwd itself is a git repo
  if (fs.existsSync(path.join(cwd, ".git"))) {
    repos.push({
      name: path.basename(cwd),
      path: cwd,
      isCurrentDir: true,
    });
  }

  // Scan parent directory for sibling repos
  try {
    const siblings = fs.readdirSync(parentDir, { withFileTypes: true });
    for (const entry of siblings) {
      if (!entry.isDirectory()) continue;
      const siblingPath = path.join(parentDir, entry.name);
      if (siblingPath === cwd) continue; // skip self (already added if it's a repo)
      if (fs.existsSync(path.join(siblingPath, ".git"))) {
        repos.push({
          name: entry.name,
          path: siblingPath,
          isCurrentDir: false,
        });
      }
    }
  } catch { /* parent unreadable — only current dir */ }

  return { repos, parentDir };
}

/**
 * Interactive repo selector.
 * If single repo: auto-selects.
 * If multiple: presents arrow-key menu.
 * If none: returns null.
 *
 * @param {object} [options]
 * @param {string} [options.startPath]
 * @returns {Promise<{name, path}|null>}
 */
export async function selectRepo(options = {}) {
  const { repos } = detectRepos(options.startPath);

  if (repos.length === 0) {
    console.error(pc.yellow("No git repositories found in this workspace."));
    return null;
  }

  if (repos.length === 1) {
    console.error(pc.gray("Repository: " + repos[0].name + " (" + repos[0].path + ")"));
    return repos[0];
  }

  // Multiple repos — present selection
  console.error(pc.bold("Multiple repositories detected:"));
  const response = await prompts({
    type: "select",
    name: "repo",
    message: "Which repository?",
    choices: repos.map(r => ({
      title: r.name + (r.isCurrentDir ? pc.gray(" (current)") : ""),
      value: r,
      description: r.path,
    })),
  });

  return response.repo || null;
}
