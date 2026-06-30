import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

import {
  assertAllowedActor,
  assertRegisteredSshSigningKey,
  assertSemverTag,
  assertTagMatchesVersion,
  assertTrustedRemoteTag,
  buildGhReleaseArgs,
  COMMAND_CAPTURE_MAX_BUFFER_BYTES,
  matchingSuccessfulReleasePleaseRuns,
  normalizeReleaseWorkflowPolicy,
  normalizeSshPublicKey,
  parseArgs,
  selectSuccessfulReleasePleaseRun,
  waitForSuccessfulReleasePleaseRun,
  waitForRemoteTagRef,
  versionToTag,
} from "../scripts/release-publish.mjs";

const POLICY = {
  allowed_tag_actors: ["mrrCarter", "github-actions[bot]"],
  allowed_tag_signer_emails: [
    "32074640+mrrCarter@users.noreply.github.com",
    "41898282+github-actions[bot]@users.noreply.github.com",
  ],
};

const RELEASE_POLICY = {
  ...POLICY,
  required_release_workflow_path: ".github/workflows/release-please.yml",
  required_release_workflow_name: "Release Please",
  required_release_workflow_actors: ["github-actions[bot]", "mrrCarter"],
};

function releasePleaseRun(overrides = {}) {
  return {
    id: 101,
    conclusion: "success",
    event: "push",
    head_branch: "main",
    head_sha: "release-sha",
    path: ".github/workflows/release-please.yml",
    name: "Release Please",
    actor: { login: "github-actions[bot]" },
    run_number: 77,
    run_attempt: 1,
    created_at: "2026-06-30T04:00:00Z",
    updated_at: "2026-06-30T04:01:00Z",
    ...overrides,
  };
}

test("Release publish helper parses release arguments", () => {
  assert.deepEqual(
    parseArgs([
      "--tag",
      "v1.2.3",
      "--notes-file",
      "release-notes.md",
      "--repo",
      "mrrCarter/create-sentinelayer",
    ]),
    {
      tag: "v1.2.3",
      notesFile: "release-notes.md",
      generateNotes: false,
      repository: "mrrCarter/create-sentinelayer",
      help: false,
    }
  );

  assert.throws(
    () => parseArgs(["--notes-file", "notes.md", "--generate-notes"]),
    /either --notes-file or --generate-notes/
  );
});

test("Release publish helper validates version tags", () => {
  assert.equal(versionToTag("0.17.0"), "v0.17.0");
  assert.doesNotThrow(() => assertSemverTag("v1.2.3"));
  assert.doesNotThrow(() => assertSemverTag("v1.2.3-rc.1"));
  assert.throws(() => assertSemverTag("1.2.3"), /must match/);
  assert.throws(() => assertTagMatchesVersion("v0.18.0", "0.17.0"), /does not match/);
});

test("Release publish helper refuses actors outside the tag policy", () => {
  assert.equal(assertAllowedActor("mrrCarter", POLICY), "mrrCarter");
  assert.throws(() => assertAllowedActor("octocat", POLICY), /not allowed/);
});

test("Release publish helper refuses lightweight remote tags before GitHub release creation", () => {
  assert.throws(
    () =>
      assertTrustedRemoteTag({
        tag: "v0.17.0",
        ref: { object: { type: "commit", sha: "abc123" } },
        tagObject: {},
        policy: POLICY,
      }),
    /lightweight tag/
  );
});

test("Release publish helper requires GitHub-verified allowlisted tag signatures", () => {
  const ref = { object: { type: "tag", sha: "tag-sha" } };

  assert.throws(
    () =>
      assertTrustedRemoteTag({
        tag: "v0.17.0",
        ref,
        tagObject: {
          verification: { verified: false, reason: "unsigned" },
          tagger: { email: "32074640+mrrCarter@users.noreply.github.com" },
        },
        policy: POLICY,
      }),
    /not cryptographically verified/
  );

  assert.throws(
    () =>
      assertTrustedRemoteTag({
        tag: "v0.17.0",
        ref,
        tagObject: {
          verification: { verified: true, reason: "valid" },
          tagger: { email: "nobody@example.com" },
        },
        policy: POLICY,
      }),
    /not allowlisted/
  );

  assert.deepEqual(
    assertTrustedRemoteTag({
      tag: "v0.17.0",
      ref,
      tagObject: {
        verification: { verified: true, reason: "valid" },
        tagger: { email: "32074640+mrrCarter@users.noreply.github.com" },
        object: { sha: "release-sha" },
      },
      policy: POLICY,
      expectedTargetSha: "release-sha",
    }),
    {
      objectType: "tag",
      signerEmail: "32074640+mrrcarter@users.noreply.github.com",
      targetSha: "release-sha",
      verificationReason: "valid",
    }
  );

  assert.throws(
    () =>
      assertTrustedRemoteTag({
        tag: "v0.17.0",
        ref,
        tagObject: {
          verification: { verified: true, reason: "valid" },
          tagger: { email: "32074640+mrrCarter@users.noreply.github.com" },
          object: { sha: "old-sha" },
        },
        policy: POLICY,
        expectedTargetSha: "release-sha",
      }),
    /not expected release commit/
  );
});

test("Release publish helper creates GitHub releases with --verify-tag only", () => {
  assert.deepEqual(buildGhReleaseArgs("v0.17.0", { notesFile: "notes.md" }), [
    "release",
    "create",
    "v0.17.0",
    "--verify-tag",
    "--title",
    "v0.17.0",
    "--notes-file",
    "notes.md",
  ]);
  assert.deepEqual(buildGhReleaseArgs("v0.17.0", {}), [
    "release",
    "create",
    "v0.17.0",
    "--verify-tag",
    "--title",
    "v0.17.0",
    "--generate-notes",
  ]);
});

test("Release publish helper waits for pushed remote tag refs to become visible", () => {
  const visibleRef = { object: { type: "tag", sha: "tag-sha" } };
  const seenDelays = [];
  let attempts = 0;

  const ref = waitForRemoteTagRef("mrrCarter/create-sentinelayer", "v0.17.0", {
    delaysMs: [10, 20, 30],
    sleep: (delayMs) => seenDelays.push(delayMs),
    resolveRef: (repository, tag) => {
      assert.equal(repository, "mrrCarter/create-sentinelayer");
      assert.equal(tag, "v0.17.0");
      attempts += 1;
      return attempts === 3 ? visibleRef : null;
    },
  });

  assert.equal(ref, visibleRef);
  assert.equal(attempts, 3);
  assert.deepEqual(seenDelays, [10, 20]);
});

test("Release publish helper selects the required successful main Release Please run", () => {
  assert.deepEqual(normalizeReleaseWorkflowPolicy(RELEASE_POLICY), {
    requiredPath: ".github/workflows/release-please.yml",
    requiredName: "Release Please",
    requiredActors: ["github-actions[bot]", "mrrCarter"],
    workflowId: "release-please.yml",
  });

  const candidates = matchingSuccessfulReleasePleaseRuns(
    [
      releasePleaseRun({ id: 1, conclusion: "failure" }),
      releasePleaseRun({ id: 2, head_sha: "other-sha" }),
      releasePleaseRun({ id: 3, head_branch: "release" }),
      releasePleaseRun({ id: 4, path: ".github/workflows/release.yml" }),
      releasePleaseRun({ id: 5, actor: { login: "octocat" } }),
      releasePleaseRun({ id: 6 }),
    ],
    "release-sha",
    RELEASE_POLICY
  );

  assert.deepEqual(candidates, [
    {
      id: "6",
      run_number: 77,
      run_attempt: 1,
      created_at: "2026-06-30T04:00:00Z",
      updated_at: "2026-06-30T04:01:00Z",
    },
  ]);
});

test("Release publish helper waits for Release Please before tag creation", () => {
  const delays = [];
  const logs = [];
  let attempts = 0;

  const selected = waitForSuccessfulReleasePleaseRun(
    "mrrCarter/create-sentinelayer",
    "release-sha",
    RELEASE_POLICY,
    {
      delaysMs: [10, 20],
      sleep: (delayMs) => delays.push(delayMs),
      logger: (message) => logs.push(message),
      fetchRunsPage: (repository, page) => {
        assert.equal(repository, "mrrCarter/create-sentinelayer");
        assert.equal(page, 1);
        attempts += 1;
        return attempts === 1 ? { workflow_runs: [] } : { workflow_runs: [releasePleaseRun()] };
      },
    }
  );

  assert.equal(selected.id, "101");
  assert.equal(attempts, 2);
  assert.deepEqual(delays, [10]);
  assert.equal(logs.length, 1);
  assert.match(logs[0], /before creating the release tag/);
});

test("Release publish helper captures mature GitHub Actions run pages", async () => {
  const script = await readFile(new URL("../scripts/release-publish.mjs", import.meta.url), "utf8");

  assert.ok(COMMAND_CAPTURE_MAX_BUFFER_BYTES >= 8 * 1024 * 1024);
  assert.match(script, /maxBuffer:\s*COMMAND_CAPTURE_MAX_BUFFER_BYTES/);
});

test("Release publish helper fails closed without unique Release Please evidence", () => {
  assert.throws(
    () =>
      waitForSuccessfulReleasePleaseRun(
        "mrrCarter/create-sentinelayer",
        "release-sha",
        RELEASE_POLICY,
        {
          delaysMs: [],
          fetchRunsPage: () => ({ workflow_runs: [] }),
          logger: null,
        }
      ),
    /No successful Release Please workflow run found/
  );

  assert.throws(
    () =>
      selectSuccessfulReleasePleaseRun(
        [releasePleaseRun({ id: 1 }), releasePleaseRun({ id: 2, run_attempt: 2 })],
        "release-sha",
        RELEASE_POLICY
      ),
    /Multiple successful Release Please runs/
  );
});

test("Release publish helper returns null after exhausting remote tag ref retries", () => {
  const seenDelays = [];
  let attempts = 0;

  const ref = waitForRemoteTagRef("mrrCarter/create-sentinelayer", "v0.17.0", {
    delaysMs: [10, 20],
    sleep: (delayMs) => seenDelays.push(delayMs),
    resolveRef: () => {
      attempts += 1;
      return null;
    },
  });

  assert.equal(ref, null);
  assert.equal(attempts, 3);
  assert.deepEqual(seenDelays, [10, 20]);
});

test("Release publish helper normalizes SSH public keys for GitHub verification", () => {
  const key = "ssh-rsa AAAAB3NzaC1yc2EAAAADAQABAAACAQCdemo carter@example.com";
  assert.equal(
    normalizeSshPublicKey(`32074640+mrrCarter@users.noreply.github.com ${key}`),
    "ssh-rsa AAAAB3NzaC1yc2EAAAADAQABAAACAQCdemo"
  );
  assert.equal(normalizeSshPublicKey(`\r\n${key}\r\n`), "ssh-rsa AAAAB3NzaC1yc2EAAAADAQABAAACAQCdemo");
  assert.equal(
    normalizeSshPublicKey("key::ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIdemo"),
    "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIdemo"
  );
  assert.equal(normalizeSshPublicKey("not-a-key"), "");
});

test("Release publish helper requires configured SSH signing key to be registered with GitHub", () => {
  const signingKey = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIdemo";
  assert.equal(
    assertRegisteredSshSigningKey({
      viewer: "mrrCarter",
      signingKey,
      githubKeys: [`${signingKey} github-web-key`],
    }),
    signingKey
  );

  assert.throws(
    () =>
      assertRegisteredSshSigningKey({
        viewer: "mrrCarter",
        signingKey,
        githubKeys: ["ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIother"],
      }),
    /does not expose the configured SSH signing key/
  );
});

test("Release workflow policy allows the repo-admin release-please actor", async () => {
  const policy = JSON.parse(
    await readFile(new URL("../.github/policies/release-tag-policy.json", import.meta.url), "utf8")
  );
  const workflowText = await readFile(new URL("../.github/workflows/release.yml", import.meta.url), "utf8");

  assert.deepEqual(policy.required_release_workflow_actors, ["github-actions[bot]", "mrrCarter"]);
  assert.match(workflowText, /required_release_workflow_actors/);
  assert.match(workflowText, /release_workflow_actor_allowlist/);
  assert.match(workflowText, /\(\.actor\.login \/\/ ""\) as \$actor/);
  assert.match(workflowText, /split\(","\) \| index\(\$actor\)/);
  assert.match(workflowText, /- name: Fail stale release runs[\s\S]*EVENT_CREATED: \$\{\{ github\.event\.created \|\| 'true' \}\}/);
  assert.doesNotMatch(workflowText, /split\(","\) \| index\(\.actor\.login \/\/ ""\)/);
  assert.doesNotMatch(workflowText, /\(\.actor\.login \/\/ ""\) == env\.required_release_workflow_actor/);
});
