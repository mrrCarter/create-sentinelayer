#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");
const TAG_PATTERN = /^v\d+\.\d+\.\d+(?:[.-][0-9A-Za-z.-]+)?$/;
export const REMOTE_TAG_REF_RETRY_DELAYS_MS = Object.freeze([500, 1000, 2000, 4000, 5000]);
export const RELEASE_PLEASE_RUN_RETRY_DELAYS_MS = Object.freeze([
  5000,
  10000,
  20000,
  30000,
  60000,
  120000,
  180000,
  300000,
]);
const RELEASE_PLEASE_RUNS_PER_PAGE = 100;
const RELEASE_PLEASE_RUN_PAGE_LIMIT = 50;
export const COMMAND_CAPTURE_MAX_BUFFER_BYTES = 8 * 1024 * 1024;

export function parseArgs(argv) {
  const options = {
    tag: "",
    notesFile: "",
    generateNotes: false,
    repository: "",
    help: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    switch (arg) {
      case "--tag":
        options.tag = requireValue(argv, index, arg);
        index += 1;
        break;
      case "--notes-file":
        options.notesFile = requireValue(argv, index, arg);
        index += 1;
        break;
      case "--generate-notes":
        options.generateNotes = true;
        break;
      case "--repo":
        options.repository = requireValue(argv, index, arg);
        index += 1;
        break;
      case "--help":
      case "-h":
        options.help = true;
        break;
      default:
        throw new Error(`Unknown option '${arg}'.`);
    }
  }

  if (options.notesFile && options.generateNotes) {
    throw new Error("Use either --notes-file or --generate-notes, not both.");
  }

  return options;
}

export function versionToTag(version) {
  const normalized = String(version || "").trim();
  if (!normalized) {
    throw new Error("package.json version is empty.");
  }
  return `v${normalized}`;
}

export function assertSemverTag(tag) {
  if (!TAG_PATTERN.test(String(tag || ""))) {
    throw new Error(`Release tag '${tag}' must match v<major>.<minor>.<patch>.`);
  }
}

export function assertTagMatchesVersion(tag, version) {
  const expected = versionToTag(version);
  if (tag !== expected) {
    throw new Error(`Release tag '${tag}' does not match package.json version '${version}' (${expected}).`);
  }
}

export function normalizePolicy(policy) {
  const allowedActors = normalizeList(policy?.allowed_tag_actors);
  const allowedSignerEmails = normalizeList(policy?.allowed_tag_signer_emails, (value) =>
    value.toLowerCase()
  );
  if (allowedActors.length === 0) {
    throw new Error("release-tag-policy.json has no allowed_tag_actors.");
  }
  if (allowedSignerEmails.length === 0) {
    throw new Error("release-tag-policy.json has no allowed_tag_signer_emails.");
  }
  return {
    allowedActors,
    allowedSignerEmails,
  };
}

export function normalizeReleaseWorkflowPolicy(policy) {
  const requiredPath = String(policy?.required_release_workflow_path || "").trim();
  const requiredName = String(policy?.required_release_workflow_name || "").trim();
  const requiredActors = Array.isArray(policy?.required_release_workflow_actors)
    ? normalizeList(policy.required_release_workflow_actors)
    : normalizeList([policy?.required_release_workflow_actor]);

  if (!requiredPath) {
    throw new Error("release-tag-policy.json has no required_release_workflow_path.");
  }
  if (!requiredName) {
    throw new Error("release-tag-policy.json has no required_release_workflow_name.");
  }
  if (requiredActors.length === 0) {
    throw new Error("release-tag-policy.json has no required release workflow actor allowlist.");
  }

  return {
    requiredPath,
    requiredName,
    requiredActors,
    workflowId: requiredPath.split(/[\\/]/).filter(Boolean).pop(),
  };
}

export function assertAllowedActor(actor, policy) {
  const normalized = normalizePolicy(policy);
  const candidate = String(actor || "").trim();
  if (!normalized.allowedActors.includes(candidate)) {
    throw new Error(
      `GitHub actor '${candidate || "<none>"}' is not allowed to create release tags.`
    );
  }
  return candidate;
}

export function assertTrustedRemoteTag({ tag, ref, tagObject, policy, expectedTargetSha = "" }) {
  const objectType = ref?.object?.type || "";
  if (objectType !== "tag") {
    throw new Error(
      `Remote tag '${tag}' is '${objectType || "<unknown>"}', not an annotated tag. Refusing to create a GitHub release for a lightweight tag.`
    );
  }

  const verification = tagObject?.verification || {};
  if (verification.verified !== true) {
    throw new Error(
      `Remote tag '${tag}' is not cryptographically verified (reason=${verification.reason || "unknown"}).`
    );
  }

  const normalized = normalizePolicy(policy);
  const signerEmail = String(tagObject?.tagger?.email || "").trim().toLowerCase();
  if (!normalized.allowedSignerEmails.includes(signerEmail)) {
    throw new Error(
      `Remote tag '${tag}' signer '${signerEmail || "<none>"}' is not allowlisted.`
    );
  }

  const targetSha = String(tagObject?.object?.sha || "").trim();
  if (expectedTargetSha && targetSha !== expectedTargetSha) {
    throw new Error(
      `Remote tag '${tag}' points at '${targetSha || "<unknown>"}', not expected release commit '${expectedTargetSha}'.`
    );
  }

  return {
    objectType,
    signerEmail,
    targetSha,
    verificationReason: verification.reason || "unknown",
  };
}

export function buildGhReleaseArgs(tag, options) {
  const args = ["release", "create", tag, "--verify-tag", "--title", tag];
  if (options.notesFile) {
    args.push("--notes-file", options.notesFile);
  } else {
    args.push("--generate-notes");
  }
  return args;
}

export function normalizeSshPublicKey(value) {
  const parts = String(value || "")
    .replace(/\r/g, "")
    .replace(/^key::/, "")
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  const keyTypeIndex = parts.findIndex((part) =>
    /^(?:ssh-|ecdsa-|sk-ssh-|sk-ecdsa-)/.test(part)
  );
  if (keyTypeIndex < 0 || !parts[keyTypeIndex + 1]) return "";
  return `${parts[keyTypeIndex]} ${parts[keyTypeIndex + 1]}`;
}

export function assertRegisteredSshSigningKey({ viewer, signingKey, githubKeys }) {
  const normalizedSigningKey = normalizeSshPublicKey(signingKey);
  if (!normalizedSigningKey) {
    throw new Error("Git SSH signing key could not be normalized.");
  }

  const normalizedGithubKeys = normalizeList(githubKeys, normalizeSshPublicKey);
  if (!normalizedGithubKeys.includes(normalizedSigningKey)) {
    throw new Error(
      `GitHub user '${viewer}' does not expose the configured SSH signing key. Add the public key as an SSH signing key in GitHub before publishing this release.`
    );
  }

  return normalizedSigningKey;
}

function requireValue(argv, index, optionName) {
  const value = argv[index + 1];
  if (!value || value.startsWith("--")) {
    throw new Error(`${optionName} requires a value.`);
  }
  return value;
}

function normalizeList(value, map = (item) => item) {
  if (!Array.isArray(value)) return [];
  return [
    ...new Set(
      value
        .map((item) => map(String(item || "").trim()))
        .filter(Boolean)
    ),
  ];
}

function readJson(relativePath) {
  return JSON.parse(fs.readFileSync(path.join(ROOT, relativePath), "utf8"));
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: ROOT,
    encoding: "utf8",
    maxBuffer: COMMAND_CAPTURE_MAX_BUFFER_BYTES,
    stdio: options.capture ? ["ignore", "pipe", "pipe"] : "inherit",
  });
  if (result.status !== 0) {
    const stderr = result.stderr ? `\n${result.stderr.trim()}` : "";
    throw new Error(`Command failed: ${command} ${args.join(" ")}${stderr}`);
  }
  return result.stdout || "";
}

function tryRun(command, args) {
  const result = spawnSync(command, args, {
    cwd: ROOT,
    encoding: "utf8",
    maxBuffer: COMMAND_CAPTURE_MAX_BUFFER_BYTES,
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.status !== 0) {
    return null;
  }
  return result.stdout || "";
}

function sleepMs(delayMs) {
  const normalized = Number(delayMs);
  if (!Number.isFinite(normalized) || normalized <= 0) return;
  const lock = new Int32Array(new SharedArrayBuffer(4));
  Atomics.wait(lock, 0, 0, normalized);
}

function resolvePathFromGitConfig(value) {
  const trimmed = String(value || "").trim();
  if (trimmed.startsWith("~/") || trimmed.startsWith("~\\") || trimmed === "~") {
    return path.join(os.homedir(), trimmed.slice(2));
  }
  return path.resolve(ROOT, trimmed);
}

function resolveConfiguredSshSigningKey() {
  const configured = tryRun("git", ["config", "--get", "user.signingkey"])?.trim() || "";
  if (!configured) {
    throw new Error("Git SSH tag signing is enabled, but user.signingkey is not configured.");
  }

  const inlineKey = normalizeSshPublicKey(configured);
  if (inlineKey) return inlineKey;

  const configuredPath = resolvePathFromGitConfig(configured);
  const candidates = configuredPath.endsWith(".pub")
    ? [configuredPath]
    : [configuredPath, `${configuredPath}.pub`];
  for (const candidate of candidates) {
    if (!fs.existsSync(candidate)) continue;
    const key = normalizeSshPublicKey(fs.readFileSync(candidate, "utf8"));
    if (key) return key;
  }

  throw new Error(`Configured SSH signing key '${configured}' is not a readable public key.`);
}

function githubSshSigningKeys(viewer) {
  return JSON.parse(
    run("gh", ["api", `users/${viewer}/ssh_signing_keys`, "--jq", "[.[].key]"], {
      capture: true,
    }) || "[]"
  );
}

function assertGitHubCanVerifyConfiguredSigningKey(viewer) {
  const signingFormat = tryRun("git", ["config", "--get", "gpg.format"])?.trim() || "";
  if (signingFormat !== "ssh") return;

  assertRegisteredSshSigningKey({
    viewer,
    signingKey: resolveConfiguredSshSigningKey(),
    githubKeys: githubSshSigningKeys(viewer),
  });
}

function resolveRepository(explicitRepository) {
  if (explicitRepository) return explicitRepository;
  if (process.env.GITHUB_REPOSITORY) return process.env.GITHUB_REPOSITORY;
  return run("gh", ["repo", "view", "--json", "nameWithOwner", "--jq", ".nameWithOwner"], {
    capture: true,
  }).trim();
}

function resolveViewer() {
  return run("gh", ["api", "user", "--jq", ".login"], { capture: true }).trim();
}

function remoteTagRef(repository, tag) {
  const output = tryRun("gh", ["api", `repos/${repository}/git/ref/tags/${tag}`]);
  if (!output) return null;
  return JSON.parse(output);
}

export function waitForRemoteTagRef(
  repository,
  tag,
  { resolveRef = remoteTagRef, sleep = sleepMs, delaysMs = REMOTE_TAG_REF_RETRY_DELAYS_MS } = {}
) {
  const delays = Array.isArray(delaysMs) ? delaysMs : [];
  for (let attempt = 0; attempt <= delays.length; attempt += 1) {
    const ref = resolveRef(repository, tag);
    if (ref) return ref;
    if (attempt < delays.length) {
      sleep(delays[attempt]);
    }
  }
  return null;
}

export function matchingSuccessfulReleasePleaseRuns(runs, targetSha, policy) {
  const normalized = normalizeReleaseWorkflowPolicy(policy);
  const sha = String(targetSha || "").trim();
  if (!sha) {
    throw new Error("Target release commit SHA is required before checking Release Please state.");
  }

  return (Array.isArray(runs) ? runs : [])
    .filter((run) => {
      const actor = String(run?.actor?.login || "").trim();
      return (
        run?.conclusion === "success" &&
        run?.event === "push" &&
        run?.head_branch === "main" &&
        run?.head_sha === sha &&
        run?.path === normalized.requiredPath &&
        run?.name === normalized.requiredName &&
        normalized.requiredActors.includes(actor)
      );
    })
    .map((run) => ({
      id: String(run.id || "").trim(),
      run_number: Number(run.run_number || 0),
      run_attempt: Number(run.run_attempt || 0),
      created_at: String(run.created_at || "").trim(),
      updated_at: String(run.updated_at || "").trim(),
    }))
    .sort((a, b) => {
      if (a.run_number !== b.run_number) return a.run_number - b.run_number;
      if (a.run_attempt !== b.run_attempt) return a.run_attempt - b.run_attempt;
      return `${a.updated_at}${a.created_at}`.localeCompare(`${b.updated_at}${b.created_at}`);
    });
}

export function selectSuccessfulReleasePleaseRun(runs, targetSha, policy) {
  const candidates = matchingSuccessfulReleasePleaseRuns(runs, targetSha, policy);
  if (candidates.length === 0) return null;
  if (candidates.length > 1) {
    throw new Error(
      `Multiple successful Release Please runs found for ${targetSha}; refusing nondeterministic publish selection (${candidates
        .map((candidate) => candidate.id)
        .join(",")}).`
    );
  }
  return candidates[0];
}

function releasePleaseRunsPage(repository, page, policy) {
  const normalized = normalizeReleaseWorkflowPolicy(policy);
  return JSON.parse(
    run(
      "gh",
      [
        "api",
        `repos/${repository}/actions/workflows/${normalized.workflowId}/runs?event=push&branch=main&status=completed&per_page=${RELEASE_PLEASE_RUNS_PER_PAGE}&page=${page}`,
      ],
      { capture: true }
    ) || "{}"
  );
}

export function waitForSuccessfulReleasePleaseRun(
  repository,
  targetSha,
  policy,
  {
    fetchRunsPage = releasePleaseRunsPage,
    sleep = sleepMs,
    delaysMs = RELEASE_PLEASE_RUN_RETRY_DELAYS_MS,
    pageLimit = RELEASE_PLEASE_RUN_PAGE_LIMIT,
    logger = console.log,
  } = {}
) {
  const delays = Array.isArray(delaysMs) ? delaysMs : [];
  const normalized = normalizeReleaseWorkflowPolicy(policy);

  for (let attempt = 0; attempt <= delays.length; attempt += 1) {
    const runs = [];
    for (let page = 1; page <= pageLimit; page += 1) {
      const pageJson = fetchRunsPage(repository, page, policy) || {};
      const workflowRuns = Array.isArray(pageJson.workflow_runs) ? pageJson.workflow_runs : [];
      runs.push(...workflowRuns);
      if (workflowRuns.length < RELEASE_PLEASE_RUNS_PER_PAGE) break;
      if (page === pageLimit) {
        throw new Error(
          `Pagination exceeded ${pageLimit} pages while resolving Release Please candidates for ${targetSha}.`
        );
      }
    }

    const selected = selectSuccessfulReleasePleaseRun(runs, targetSha, policy);
    if (selected) return selected;

    if (attempt < delays.length) {
      logger?.(
        `Waiting for successful ${normalized.requiredName} run on main for ${targetSha} before creating the release tag...`
      );
      sleep(delays[attempt]);
    }
  }

  throw new Error(
    `No successful ${normalized.requiredName} workflow run found on main for release commit ${targetSha}. Wait for the main Release Please run to finish, then rerun npm run release:publish.`
  );
}

function remoteTagObject(repository, tagObjectSha) {
  return JSON.parse(
    run("gh", ["api", `repos/${repository}/git/tags/${tagObjectSha}`], {
      capture: true,
    })
  );
}

function ensureMainHead() {
  run("git", ["fetch", "origin", "main", "--tags"]);
  const head = run("git", ["rev-parse", "HEAD"], { capture: true }).trim();
  const originMain = run("git", ["rev-parse", "origin/main"], { capture: true }).trim();
  if (head !== originMain) {
    throw new Error("Release tags must be created from the current origin/main commit.");
  }
  return head;
}

function ensureCleanWorktree() {
  const status = run("git", ["status", "--porcelain"], { capture: true }).trim();
  if (status) {
    throw new Error("Worktree must be clean before creating a release tag.");
  }
}

function localTagType(tag) {
  const exists = tryRun("git", ["rev-parse", "-q", "--verify", `refs/tags/${tag}`]);
  if (!exists) return "";
  return run("git", ["cat-file", "-t", tag], { capture: true }).trim();
}

function ensureLocalSignedTag(tag) {
  const type = localTagType(tag);
  if (type && type !== "tag") {
    throw new Error(`Local tag '${tag}' is '${type}', not an annotated tag.`);
  }
  if (!type) {
    run("git", ["tag", "-s", tag, "-m", `sentinelayer-cli ${tag}`]);
  }
  run("git", ["tag", "-v", tag]);
}

function printUsage() {
  console.log(`Usage: npm run release:publish -- [--tag vX.Y.Z] [--notes-file file | --generate-notes] [--repo owner/repo]

Confirms the main Release Please run has succeeded for the release commit, then creates and verifies the signed annotated release tag before creating the GitHub release.
The command refuses to create a GitHub release when Release Please evidence is missing or the remote tag is lightweight or unverified.`);
}

export function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  if (options.help) {
    printUsage();
    return;
  }

  const packageJson = readJson("package.json");
  const tag = options.tag || versionToTag(packageJson.version);
  assertSemverTag(tag);
  assertTagMatchesVersion(tag, packageJson.version);

  const policy = readJson(".github/policies/release-tag-policy.json");
  const repository = resolveRepository(options.repository);
  const viewer = resolveViewer();
  assertAllowedActor(viewer, policy);
  ensureCleanWorktree();
  const expectedTargetSha = ensureMainHead();
  const releasePleaseRun = waitForSuccessfulReleasePleaseRun(repository, expectedTargetSha, policy);
  console.log(
    `Confirmed Release Please run ${releasePleaseRun.id} succeeded on main for ${expectedTargetSha}.`
  );

  const existingRemoteRef = remoteTagRef(repository, tag);
  if (existingRemoteRef) {
    if (existingRemoteRef?.object?.type !== "tag") {
      assertTrustedRemoteTag({
        tag,
        ref: existingRemoteRef,
        tagObject: {},
        policy,
        expectedTargetSha,
      });
    }
    const existingTagObject = remoteTagObject(repository, existingRemoteRef.object.sha);
    const trusted = assertTrustedRemoteTag({
      tag,
      ref: existingRemoteRef,
      tagObject: existingTagObject,
      policy,
      expectedTargetSha,
    });
    console.log(
      `Remote tag ${tag} already exists as a verified annotated tag signed by ${trusted.signerEmail}.`
    );
  } else {
    assertGitHubCanVerifyConfiguredSigningKey(viewer);
    ensureLocalSignedTag(tag);
    run("git", ["push", "origin", tag]);

    const pushedRef = waitForRemoteTagRef(repository, tag);
    if (!pushedRef) {
      throw new Error(
        `Failed to resolve pushed remote tag '${tag}' after ${REMOTE_TAG_REF_RETRY_DELAYS_MS.length + 1} attempts.`
      );
    }
    if (pushedRef?.object?.type !== "tag") {
      assertTrustedRemoteTag({
        tag,
        ref: pushedRef,
        tagObject: {},
        policy,
        expectedTargetSha,
      });
    }
    const pushedTagObject = remoteTagObject(repository, pushedRef.object.sha);
    const trusted = assertTrustedRemoteTag({
      tag,
      ref: pushedRef,
      tagObject: pushedTagObject,
      policy,
      expectedTargetSha,
    });
    console.log(`Pushed verified annotated tag ${tag} signed by ${trusted.signerEmail}.`);
  }

  run("gh", buildGhReleaseArgs(tag, options));
  console.log(`Created GitHub release ${tag}; tag push will drive the protected Release workflow.`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
