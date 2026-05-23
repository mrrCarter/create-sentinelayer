import test from "node:test";
import assert from "node:assert/strict";

import {
  assertAllowedActor,
  assertSemverTag,
  assertTagMatchesVersion,
  assertTrustedRemoteTag,
  buildGhReleaseArgs,
  parseArgs,
  versionToTag,
} from "../scripts/release-publish.mjs";

const POLICY = {
  allowed_tag_actors: ["mrrCarter", "github-actions[bot]"],
  allowed_tag_signer_emails: [
    "32074640+mrrCarter@users.noreply.github.com",
    "41898282+github-actions[bot]@users.noreply.github.com",
  ],
};

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
