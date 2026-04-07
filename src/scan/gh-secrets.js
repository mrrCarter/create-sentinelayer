import { spawnSync } from "node:child_process";
import process from "node:process";
import fs from "node:fs";

function getGhCommand() {
  return String(process.env.SENTINELAYER_GH_BIN || "").trim() || "gh";
}

function normalizeRepoSlug(value) {
  return String(value || "").trim().replace(/\.git$/i, "");
}

function isValidRepoSlug(value) {
  return /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(normalizeRepoSlug(value));
}

function isValidSecretName(value) {
  return /^[A-Z][A-Z0-9_]{1,127}$/.test(String(value || "").trim());
}

function ensureGhCliAvailable(ghCommand) {
  const ghVersion = spawnSync(ghCommand, ["--version"], { encoding: "utf-8" });
  if (ghVersion.status !== 0) {
    throw new Error("GitHub CLI (gh) is not installed or not in PATH.");
  }
}

function detectRepoSlug(cwd) {
  const ghCommand = getGhCommand();
  const result = spawnSync(ghCommand, ["repo", "view", "--json", "nameWithOwner", "--jq", ".nameWithOwner"], {
    cwd,
    encoding: "utf-8",
  });
  if (result.status === 0 && result.stdout) {
    return String(result.stdout).trim();
  }
  return null;
}

export function setupSecrets({ repoSlug, secretName, secretValue, dryRun }) {
  const normalizedRepo = normalizeRepoSlug(repoSlug);
  const ghCommand = getGhCommand();

  if (!isValidRepoSlug(normalizedRepo)) {
    return { ok: false, reason: "Invalid repo format. Use owner/repo." };
  }
  if (!isValidSecretName(secretName)) {
    return { ok: false, reason: `Invalid secret name: ${secretName}. Must match /^[A-Z][A-Z0-9_]{1,127}$/.` };
  }

  if (dryRun) {
    return {
      ok: true,
      dryRun: true,
      repo: normalizedRepo,
      secretName,
      instructions: [
        `gh secret set ${secretName} --repo ${normalizedRepo}`,
        `# Paste your SentinelLayer token when prompted`,
        `gh secret list --repo ${normalizedRepo}`,
        `# Verify ${secretName} appears in the list`,
      ],
    };
  }

  const secretSinkFile = String(process.env.SENTINELAYER_SECRET_SINK_FILE || "").trim();
  if (secretSinkFile) {
    try {
      fs.appendFileSync(secretSinkFile, `${normalizedRepo}|${secretName}|${secretValue}\n`, "utf-8");
      return { ok: true, repo: normalizedRepo, secretName, method: "sink-file" };
    } catch (error) {
      return { ok: false, reason: `Failed to write SENTINELAYER_SECRET_SINK_FILE: ${error instanceof Error ? error.message : String(error)}` };
    }
  }

  try {
    ensureGhCliAvailable(ghCommand);
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : String(error) };
  }

  const result = spawnSync(ghCommand, ["secret", "set", secretName, "--repo", normalizedRepo], {
    encoding: "utf-8",
    input: `${secretValue}\n`,
  });
  if (result.status !== 0) {
    return { ok: false, reason: String(result.stderr || result.stdout || "gh secret set failed").trim() };
  }

  const verifyResult = spawnSync(ghCommand, ["secret", "list", "--repo", normalizedRepo], {
    encoding: "utf-8",
  });
  if (verifyResult.status !== 0) {
    return { ok: false, reason: String(verifyResult.stderr || verifyResult.stdout || "gh secret list failed").trim() };
  }

  const listedSecrets = String(verifyResult.stdout || "");
  const escapedSecretName = String(secretName || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const secretRegex = new RegExp(`(^|\\r?\\n)\\s*${escapedSecretName}(\\s|$)`, "m");
  if (!secretRegex.test(listedSecrets)) {
    return { ok: false, reason: `Secret '${secretName}' was not visible in gh secret list output after injection.` };
  }

  return { ok: true, repo: normalizedRepo, secretName, method: "gh-cli" };
}

export { detectRepoSlug };
