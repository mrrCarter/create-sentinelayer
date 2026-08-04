import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import {
  mkdtemp,
  mkdir,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";

import { SentinelayerApiError } from "../src/auth/http.js";
import {
  checkFileLock,
  guardFileLeases,
  listFileLocks,
  lockFile,
  normalizeFilePath,
  releaseFileLocksForAgent,
  renewFileLease,
  unlockFile,
} from "../src/session/file-locks.js";
import { resolveSessionPaths } from "../src/session/paths.js";
import { createSession } from "../src/session/store.js";
import { readStream } from "../src/session/stream.js";

const API_URL = "https://lease-authority.example";
const AUTH_TOKEN = "test-auth-token";
const TOKEN_HEADER = `Bearer ${AUTH_TOKEN}`;

function createLeaseAuthority({ nowMs = Date.parse("2026-07-29T12:00:00.000Z") } = {}) {
  const leases = new Map();
  const calls = [];
  let leaseSequence = 0;

  function pathKey(value) {
    return String(value || "").trim().normalize("NFC").toLowerCase().replace(/\/+$/u, "");
  }

  function covers(parent, child) {
    const parentKey = pathKey(parent);
    const childKey = pathKey(child);
    return childKey === parentKey || childKey.startsWith(`${parentKey}/`);
  }

  function overlaps(left, right) {
    return covers(left, right) || covers(right, left);
  }

  function liveRows() {
    return [...leases.values()].filter(
      (lease) => lease.status === "active" && Date.parse(lease.expiresAt) > nowMs,
    );
  }

  function publicLease(lease) {
    return {
      leaseId: lease.leaseId,
      sessionId: lease.sessionId,
      path: lease.path,
      holderId: lease.holderId,
      intent: lease.intent,
      status: lease.status,
      ttlSeconds: lease.ttlSeconds,
      revision: lease.revision,
      acquiredAt: lease.acquiredAt,
      renewedAt: lease.renewedAt,
      expiresAt: lease.expiresAt,
      releasedAt: lease.releasedAt || null,
      releaseReason: lease.releaseReason || null,
    };
  }

  function assertAuth(options) {
    assert.equal(options?.headers?.Authorization, TOKEN_HEADER);
  }

  async function request(url, options = {}) {
    calls.push({ kind: "read", url, options });
    assertAuth(options);
    assert.equal(options.method, "GET");
    return {
      ok: true,
      authoritative: true,
      count: liveRows().length,
      leases: liveRows().map(publicLease),
    };
  }

  async function requestMutation(url, options = {}) {
    calls.push({ kind: "mutation", url, options });
    assertAuth(options);
    const body = options.body || {};

    if (url.endsWith("/file-leases/guard")) {
      const denials = [];
      const guarded = [];
      for (const claim of body.claims || []) {
        const lease = liveRows().find((candidate) => covers(candidate.path, claim.path));
        if (!lease) {
          denials.push({ path: claim.path, reason: "lease_required" });
          continue;
        }
        if (!claim.leaseId || !claim.leaseToken) {
          denials.push({
            path: claim.path,
            reason: "holder_token_unavailable",
            lease: publicLease(lease),
          });
          continue;
        }
        if (claim.leaseId !== lease.leaseId) {
          denials.push({
            path: claim.path,
            reason: "lease_id_mismatch",
            lease: publicLease(lease),
          });
          continue;
        }
        if (body.holderId !== lease.holderId || claim.leaseToken !== lease.leaseToken) {
          denials.push({
            path: claim.path,
            reason: "holder_capability_mismatch",
            lease: publicLease(lease),
          });
          continue;
        }
        guarded.push({ path: claim.path, lease: publicLease(lease) });
      }
      return {
        ok: true,
        allowed: denials.length === 0 && guarded.length === body.claims.length,
        authoritative: true,
        sessionId: decodeURIComponent(
          /\/sessions\/([^/]+)\/file-leases\/guard$/u.exec(url)?.[1] || "",
        ),
        holderId: body.holderId,
        checkedAt: new Date(nowMs).toISOString(),
        validUntil:
          guarded.map((item) => item.lease.expiresAt).sort()[0] || null,
        guarded,
        denials,
      };
    }

    const memberMatch =
      /\/sessions\/([^/]+)\/file-leases\/([^/]+)\/(renew|release)$/u.exec(url);
    if (memberMatch) {
      const [, rawSessionId, rawLeaseId, action] = memberMatch;
      const sessionId = decodeURIComponent(rawSessionId);
      const leaseId = decodeURIComponent(rawLeaseId);
      const lease = leases.get(leaseId);
      if (!lease || lease.sessionId !== sessionId) {
        throw new SentinelayerApiError("File lease was not found.", {
          status: 404,
          code: "FILE_LEASE_NOT_FOUND",
        });
      }
      if (lease.holderId !== body.holderId || lease.leaseToken !== body.leaseToken) {
        throw new SentinelayerApiError("Holder capability mismatch.", {
          status: 403,
          code: "FILE_LEASE_HOLDER_MISMATCH",
        });
      }
      if (action === "renew") {
        if (lease.status !== "active" || Date.parse(lease.expiresAt) <= nowMs) {
          throw new SentinelayerApiError("File lease expired.", {
            status: 410,
            code: "FILE_LEASE_EXPIRED",
          });
        }
        lease.ttlSeconds = body.ttlSeconds;
        lease.revision += 1;
        lease.renewedAt = new Date(nowMs).toISOString();
        lease.expiresAt = new Date(nowMs + body.ttlSeconds * 1_000).toISOString();
        return {
          ok: true,
          authoritative: true,
          renewed: true,
          lease: publicLease(lease),
        };
      }
      const wasActive = lease.status === "active" && Date.parse(lease.expiresAt) > nowMs;
      lease.status = wasActive ? "released" : "expired";
      lease.releasedAt = wasActive ? new Date(nowMs).toISOString() : null;
      lease.releaseReason = wasActive ? body.reason : "ttl_expired";
      return {
        ok: true,
        authoritative: true,
        released: wasActive,
        expired: !wasActive,
        alreadyReleased: lease.status === "released" && !wasActive,
        lease: publicLease(lease),
      };
    }

    const collectionMatch = /\/sessions\/([^/]+)\/file-leases$/u.exec(url);
    assert.ok(collectionMatch, `unexpected mutation URL ${url}`);
    const sessionId = decodeURIComponent(collectionMatch[1]);
    const exact = liveRows().find((lease) => pathKey(lease.path) === pathKey(body.path));
    if (
      exact &&
      exact.holderId === body.holderId &&
      exact.leaseToken === body.leaseToken
    ) {
      return {
        ok: true,
        authoritative: true,
        acquired: false,
        duplicate: true,
        lease: publicLease(exact),
      };
    }
    const conflict = liveRows().find((lease) => overlaps(lease.path, body.path));
    if (conflict) {
      throw new SentinelayerApiError("Path conflicts with an active file lease.", {
        status: 409,
        code: "FILE_LEASE_CONFLICT",
      });
    }
    leaseSequence += 1;
    const acquiredAt = new Date(nowMs).toISOString();
    const lease = {
      leaseId: `00000000-0000-4000-8000-${String(leaseSequence).padStart(12, "0")}`,
      sessionId,
      path: body.path,
      holderId: body.holderId,
      leaseToken: body.leaseToken,
      intent: body.intent || "",
      status: "active",
      ttlSeconds: body.ttlSeconds,
      revision: 1,
      acquiredAt,
      renewedAt: acquiredAt,
      expiresAt: new Date(nowMs + body.ttlSeconds * 1_000).toISOString(),
    };
    leases.set(lease.leaseId, lease);
    return {
      ok: true,
      authoritative: true,
      acquired: true,
      duplicate: false,
      lease: publicLease(lease),
    };
  }

  const resolveAuthSession = async () => ({
    apiUrl: API_URL,
    token: AUTH_TOKEN,
  });

  return {
    calls,
    leases,
    request,
    requestMutation,
    resolveAuthSession,
    clear() {
      leases.clear();
    },
    setNow(value) {
      nowMs = Number(value);
    },
  };
}

function leaseOptions(authority, targetPath) {
  return {
    targetPath,
    resolveAuthSession: authority.resolveAuthSession,
    request: authority.request,
    requestMutation: authority.requestMutation,
  };
}

async function seedWorkspace(rootPath) {
  await writeFile(
    path.join(rootPath, "package.json"),
    JSON.stringify({ name: "session-file-leases-fixture", version: "1.0.0" }, null, 2),
    "utf-8",
  );
}

test("Unit session file leases: shared API authority rejects overlap across separate workspaces", async () => {
  const rootA = await mkdtemp(path.join(os.tmpdir(), "sentinelayer-file-lease-a-"));
  const rootB = await mkdtemp(path.join(os.tmpdir(), "sentinelayer-file-lease-b-"));
  const authority = createLeaseAuthority();
  try {
    await seedWorkspace(rootA);
    await seedWorkspace(rootB);
    const first = await lockFile(
      "sess-shared-authority",
      "codex",
      "src/auth",
      {
        ...leaseOptions(authority, rootA),
        intent: "auth refactor",
      },
    );
    const second = await lockFile(
      "sess-shared-authority",
      "claude",
      "src/auth/login.js",
      {
        ...leaseOptions(authority, rootB),
        intent: "login edit",
      },
    );

    assert.equal(first.locked, true);
    assert.equal(second.locked, false);
    assert.equal(second.reason, "held_by_other_agent");
    assert.equal(second.heldBy, "codex");
    assert.equal((await listFileLocks(
      "sess-shared-authority",
      leaseOptions(authority, rootB),
    )).length, 1);
  } finally {
    await rm(rootA, { recursive: true, force: true });
    await rm(rootB, { recursive: true, force: true });
  }
});

test("Unit session file leases: acquire renew guard release write zero transcript events", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "sentinelayer-file-lease-no-events-"));
  const authority = createLeaseAuthority();
  try {
    await seedWorkspace(tempRoot);
    const session = await createSession({ targetPath: tempRoot, ttlSeconds: 120 });
    const before = await readStream(session.sessionId, { tail: 100, targetPath: tempRoot });
    const options = leaseOptions(authority, tempRoot);

    const acquired = await lockFile(
      session.sessionId,
      "codex",
      "src/auth/login.js",
      options,
    );
    const renewed = await renewFileLease(
      session.sessionId,
      "codex",
      "src/auth/login.js",
      { ...options, ttlSeconds: 600 },
    );
    const guarded = await guardFileLeases(
      session.sessionId,
      "codex",
      ["src/auth/login.js"],
      options,
    );
    const released = await unlockFile(
      session.sessionId,
      "codex",
      "src/auth/login.js",
      options,
    );
    const after = await readStream(session.sessionId, { tail: 100, targetPath: tempRoot });

    assert.equal(acquired.locked, true);
    assert.equal(renewed.renewed, true);
    assert.equal(guarded.allowed, true);
    assert.equal(released.unlocked, true);
    assert.deepEqual(after, before);
    assert.equal(
      after.some((event) =>
        ["file_lock", "file_unlock", "file_lock_expired", "file_lock_renewed"].includes(
          event.event,
        ),
      ),
      false,
    );

    const source = await readFile(
      new URL("../src/session/file-locks.js", import.meta.url),
      "utf-8",
    );
    assert.doesNotMatch(source, /appendToStream|createAgentEvent/u);
    assert.doesNotMatch(
      source,
      /["']file_(?:lock|unlock|lock_expired|lock_renewed)["']/u,
    );
    const daemonSource = await readFile(
      new URL("../src/session/daemon.js", import.meta.url),
      "utf-8",
    );
    assert.doesNotMatch(daemonSource, /from\s+["']\.\/file-locks\.js["']/u);
    assert.doesNotMatch(
      daemonSource,
      /file_(?:lock|unlock)_denied|parseSessionDirective|splitFileAndIntent/u,
    );
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("Unit session file leases: stale local capability cannot override server revocation", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "sentinelayer-file-lease-stale-cache-"));
  const authority = createLeaseAuthority();
  try {
    await seedWorkspace(tempRoot);
    const options = leaseOptions(authority, tempRoot);
    await lockFile(
      "sess-stale-cache",
      "codex",
      "src/auth/login.js",
      options,
    );
    const paths = resolveSessionPaths("sess-stale-cache", { targetPath: tempRoot });
    const cacheBefore = JSON.parse(
      await readFile(paths.fileLeaseCapabilitiesPath, "utf-8"),
    );
    assert.equal(cacheBefore.authoritative, false);
    assert.equal(cacheBefore.claims.length, 1);

    authority.clear();
    const guarded = await guardFileLeases(
      "sess-stale-cache",
      "codex",
      ["src/auth/login.js"],
      options,
    );
    assert.equal(guarded.allowed, false);
    assert.equal(guarded.denials[0].reason, "lease_required");
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("Unit session file leases: capability is holder-bound and never appears in public results", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "sentinelayer-file-lease-holder-"));
  const authority = createLeaseAuthority();
  try {
    await seedWorkspace(tempRoot);
    const options = leaseOptions(authority, tempRoot);
    const acquired = await lockFile(
      "sess-holder-bound",
      "codex",
      "src/auth/login.js",
      options,
    );
    const attacker = await guardFileLeases(
      "sess-holder-bound",
      "claude",
      ["src/auth/login.js"],
      options,
    );
    const listed = await listFileLocks("sess-holder-bound", options);

    assert.equal(attacker.allowed, false);
    assert.equal(attacker.denials[0].reason, "holder_token_unavailable");
    assert.equal(listed[0].agentId, "codex");
    assert.doesNotMatch(JSON.stringify([acquired, listed, attacker]), /leaseToken/u);
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("Unit session file leases: parent scope guards child but child cannot guard parent", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "sentinelayer-file-lease-scope-"));
  const authority = createLeaseAuthority();
  try {
    await seedWorkspace(tempRoot);
    const options = leaseOptions(authority, tempRoot);
    await lockFile("sess-scope", "codex", "src/auth", options);
    const child = await guardFileLeases(
      "sess-scope",
      "codex",
      ["src/auth/login.js"],
      options,
    );
    const parentCheck = await checkFileLock(
      "sess-scope",
      "src/auth/login.js",
      options,
    );

    assert.equal(child.allowed, true);
    assert.equal(parentCheck.file, "src/auth");

    const childRoot = await mkdtemp(path.join(os.tmpdir(), "sentinelayer-file-lease-child-"));
    try {
      await seedWorkspace(childRoot);
      const childAuthority = createLeaseAuthority();
      const childOptions = leaseOptions(childAuthority, childRoot);
      await lockFile("sess-child-only", "codex", "src/auth/login.js", childOptions);
      const tooBroad = await guardFileLeases(
        "sess-child-only",
        "codex",
        ["src/auth"],
        childOptions,
      );
      assert.equal(tooBroad.allowed, false);
      assert.equal(tooBroad.denials[0].reason, "lease_required");
    } finally {
      await rm(childRoot, { recursive: true, force: true });
    }
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("Unit session file leases: release-all uses holder capabilities and reports unresolved remote leases", async () => {
  const rootA = await mkdtemp(path.join(os.tmpdir(), "sentinelayer-file-lease-release-a-"));
  const rootB = await mkdtemp(path.join(os.tmpdir(), "sentinelayer-file-lease-release-b-"));
  const authority = createLeaseAuthority();
  try {
    await seedWorkspace(rootA);
    await seedWorkspace(rootB);
    await lockFile("sess-release-all", "codex", "src/a.js", {
      ...leaseOptions(authority, rootA),
      intent: "a",
    });
    await lockFile("sess-release-all", "claude", "src/b.js", {
      ...leaseOptions(authority, rootB),
      intent: "b",
    });

    const released = await releaseFileLocksForAgent(
      "sess-release-all",
      "codex",
      {
        ...leaseOptions(authority, rootA),
        reason: "agent_killed:test",
      },
    );
    assert.equal(released.releasedCount, 1);
    assert.deepEqual(released.failures, []);
    assert.deepEqual(released.unresolved, []);
    assert.equal(released.unresolvedKnown, true);
    assert.equal(released.authority.authoritative, true);
    assert.deepEqual(released.events, []);
    assert.equal((await listFileLocks(
      "sess-release-all",
      leaseOptions(authority, rootA),
    )).map((lease) => lease.agentId).join(","), "claude");
  } finally {
    await rm(rootA, { recursive: true, force: true });
    await rm(rootB, { recursive: true, force: true });
  }
});

test("Unit session file leases: release-all cleanup reports unknown authority without blocking", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "sentinelayer-file-lease-cleanup-"));
  try {
    await seedWorkspace(tempRoot);
    const result = await releaseFileLocksForAgent(
      "sess-cleanup-outage",
      "codex",
      {
        targetPath: tempRoot,
        resolveAuthSession: async () => ({
          apiUrl: API_URL,
          token: AUTH_TOKEN,
        }),
        request: async () => {
          throw new SentinelayerApiError("authority unavailable", {
            status: 503,
            code: "FILE_LEASE_STORAGE_UNAVAILABLE",
          });
        },
        requestMutation: async () => {
          throw new Error("must not release without a cached capability");
        },
      },
    );

    assert.equal(result.releasedCount, 0);
    assert.deepEqual(result.unresolved, []);
    assert.equal(result.unresolvedKnown, false);
    assert.deepEqual(result.authority, {
      ok: false,
      authoritative: false,
      code: "FILE_LEASE_STORAGE_UNAVAILABLE",
    });
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("Unit session file leases: path validation rejects traversal and outside-workspace absolutes", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "sentinelayer-file-lease-paths-"));
  try {
    assert.equal(
      normalizeFilePath(path.join(tempRoot, "src", "auth.js"), {
        targetPath: tempRoot,
      }),
      "src/auth.js",
    );
    assert.throws(
      () => normalizeFilePath("../outside.js", { targetPath: tempRoot }),
      /traverse/u,
    );
    assert.throws(
      () => normalizeFilePath(path.dirname(tempRoot), { targetPath: tempRoot }),
      /inside the workspace/u,
    );
    assert.throws(
      () => normalizeFilePath("src/\nsecret.js", { targetPath: tempRoot }),
      /control/u,
    );
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("Unit session file leases: authority outage blocks even when a local capability exists", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "sentinelayer-file-lease-outage-"));
  const authority = createLeaseAuthority();
  try {
    await seedWorkspace(tempRoot);
    const options = leaseOptions(authority, tempRoot);
    await lockFile("sess-outage", "codex", "src/auth.js", options);

    await assert.rejects(
      guardFileLeases(
        "sess-outage",
        "codex",
        ["src/auth.js"],
        {
          ...options,
          requestMutation: async () => {
            throw new SentinelayerApiError("Authority unavailable.", {
              status: 503,
              code: "FILE_LEASE_STORAGE_UNAVAILABLE",
            });
          },
        },
      ),
      /Authority unavailable/u,
    );
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("Unit session file leases: lifecycle responses without authority proof fail closed", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "sentinelayer-file-lease-marker-"));
  const authority = createLeaseAuthority();
  try {
    await seedWorkspace(tempRoot);
    await assert.rejects(
      lockFile(
        "sess-authority-marker",
        "codex",
        "src/auth.js",
        {
          ...leaseOptions(authority, tempRoot),
          requestMutation: async (...args) => ({
            ...(await authority.requestMutation(...args)),
            authoritative: false,
          }),
        },
      ),
      /invalid acquire response/u,
    );
    const paths = resolveSessionPaths("sess-authority-marker", {
      targetPath: tempRoot,
    });
    await assert.rejects(
      readFile(paths.fileLeaseCapabilitiesPath, "utf-8"),
      { code: "ENOENT" },
    );
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("Unit session file leases: expired lease can be atomically reacquired by a second holder", async () => {
  const rootA = await mkdtemp(path.join(os.tmpdir(), "sentinelayer-file-lease-expire-a-"));
  const rootB = await mkdtemp(path.join(os.tmpdir(), "sentinelayer-file-lease-expire-b-"));
  const authority = createLeaseAuthority();
  try {
    await seedWorkspace(rootA);
    await seedWorkspace(rootB);
    const first = await lockFile("sess-expired-reacquire", "codex", "src/auth.js", {
      ...leaseOptions(authority, rootA),
      ttlSeconds: 15,
    });
    authority.setNow(Date.parse("2026-07-29T12:00:16.000Z"));
    const second = await lockFile(
      "sess-expired-reacquire",
      "claude",
      "src/auth.js",
      leaseOptions(authority, rootB),
    );

    assert.equal(first.locked, true);
    assert.equal(second.locked, true);
    assert.equal(second.lock.agentId, "claude");
    const active = await listFileLocks(
      "sess-expired-reacquire",
      leaseOptions(authority, rootA),
    );
    assert.deepEqual(active.map((lease) => lease.agentId), ["claude"]);
  } finally {
    await rm(rootA, { recursive: true, force: true });
    await rm(rootB, { recursive: true, force: true });
  }
});

test("Unit session file leases: forged capability cannot renew or release", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "sentinelayer-file-lease-forgery-"));
  const authority = createLeaseAuthority();
  try {
    await seedWorkspace(tempRoot);
    const options = leaseOptions(authority, tempRoot);
    await lockFile("sess-forged-capability", "codex", "src/auth.js", options);
    const paths = resolveSessionPaths("sess-forged-capability", {
      targetPath: tempRoot,
    });
    const store = JSON.parse(
      await readFile(paths.fileLeaseCapabilitiesPath, "utf-8"),
    );
    const originalToken = store.claims[0].leaseToken;
    store.claims[0].leaseToken = "Z".repeat(43);
    await writeFile(
      paths.fileLeaseCapabilitiesPath,
      `${JSON.stringify(store, null, 2)}\n`,
      "utf-8",
    );

    await assert.rejects(
      renewFileLease(
        "sess-forged-capability",
        "codex",
        "src/auth.js",
        options,
      ),
      (error) => error?.code === "FILE_LEASE_HOLDER_MISMATCH",
    );
    await assert.rejects(
      unlockFile(
        "sess-forged-capability",
        "codex",
        "src/auth.js",
        options,
      ),
      (error) => error?.code === "FILE_LEASE_HOLDER_MISMATCH",
    );
    assert.equal(
      (await listFileLocks("sess-forged-capability", options)).length,
      1,
    );

    store.claims[0].leaseToken = originalToken;
    await writeFile(
      paths.fileLeaseCapabilitiesPath,
      `${JSON.stringify(store, null, 2)}\n`,
      "utf-8",
    );
    assert.equal(
      (await unlockFile(
        "sess-forged-capability",
        "codex",
        "src/auth.js",
        options,
      )).unlocked,
      true,
    );
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("Unit session file leases: symlink aliases canonicalize to one authority path", async (t) => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "sentinelayer-file-lease-alias-"));
  const authority = createLeaseAuthority();
  try {
    await seedWorkspace(tempRoot);
    const realDir = path.join(tempRoot, "src", "shared");
    const aliasDir = path.join(tempRoot, "src", "alias");
    await mkdir(realDir, { recursive: true });
    await writeFile(path.join(realDir, "auth.js"), "export {};\n", "utf-8");
    try {
      await symlink(
        realDir,
        aliasDir,
        process.platform === "win32" ? "junction" : "dir",
      );
    } catch (error) {
      if (error?.code === "EPERM") {
        t.skip("symlink creation is unavailable for this test user");
        return;
      }
      throw error;
    }

    const options = leaseOptions(authority, tempRoot);
    const direct = await lockFile(
      "sess-path-alias",
      "codex",
      "src/shared/auth.js",
      options,
    );
    const alias = await lockFile(
      "sess-path-alias",
      "claude",
      "src/alias/auth.js",
      options,
    );

    assert.equal(direct.locked, true);
    assert.equal(direct.file, "src/shared/auth.js");
    assert.equal(alias.locked, false);
    assert.equal(alias.file, "src/shared/auth.js");
    assert.equal(alias.heldBy, "codex");
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("Unit session file leases: symlink escape outside workspace is rejected", async (t) => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "sentinelayer-file-lease-escape-"));
  const outsideRoot = await mkdtemp(path.join(os.tmpdir(), "sentinelayer-file-lease-outside-"));
  const authority = createLeaseAuthority();
  try {
    await seedWorkspace(tempRoot);
    const aliasDir = path.join(tempRoot, "src", "outside");
    await mkdir(path.dirname(aliasDir), { recursive: true });
    await writeFile(path.join(outsideRoot, "secret.js"), "secret\n", "utf-8");
    try {
      await symlink(
        outsideRoot,
        aliasDir,
        process.platform === "win32" ? "junction" : "dir",
      );
    } catch (error) {
      if (error?.code === "EPERM") {
        t.skip("symlink creation is unavailable for this test user");
        return;
      }
      throw error;
    }

    await assert.rejects(
      lockFile(
        "sess-path-escape",
        "codex",
        "src/outside/secret.js",
        leaseOptions(authority, tempRoot),
      ),
      /outside the workspace/u,
    );
    assert.equal(authority.calls.length, 0);
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
    await rm(outsideRoot, { recursive: true, force: true });
  }
});
