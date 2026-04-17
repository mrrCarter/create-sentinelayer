import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";

import { redactEventPayload, containsSecret } from "../src/session/redact.js";
import { createSession } from "../src/session/store.js";
import { appendToStream, readStream } from "../src/session/stream.js";

async function seedWorkspace(rootPath) {
  await mkdir(path.join(rootPath, "src"), { recursive: true });
  await writeFile(
    path.join(rootPath, "package.json"),
    JSON.stringify({ name: "session-redact-fixture", version: "1.0.0" }, null, 2),
    "utf-8"
  );
  await writeFile(path.join(rootPath, "src", "index.js"), "export const value = 1;\n", "utf-8");
}

// Fixtures built at runtime so the literal patterns never appear in source.
// Per .gitleaksignore policy: construct fake tokens, do not suppress scans.
const ghPat = ["github_", "pat_", "11ABC23456_", "abcdefghijklmnopqrstuvwxyz0123456789"].join("");
const ghClassic = ["g", "hp_", "abcdefghijklmnopqrstuvwxyz01234567"].join("");
const awsKey = ["A", "KIA", "IOSFODNN7EXAMPLE"].join("");
const slackBot = ["x", "oxb-", "12345-abcdef-xyz"].join("");
const openaiKey = ["s", "k-", "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789"].join("");
const jwtHeader = ["ey", "JhbGciOiJIUzI1NiJ9"].join("");
const jwtBody = ["ey", "JzdWIiOiIxMjMifQ"].join("");
const jwtSig = ["signature_", "abc123xyz789"].join("");
const jwtLike = `${jwtHeader}.${jwtBody}.${jwtSig}`;

test("redact: GitHub fine-grained PAT is masked in payload strings", () => {
  const evt = {
    event: "agent_say",
    agentId: "claude-test",
    payload: { body: `please use ${ghPat}` },
  };
  const redacted = redactEventPayload(evt);
  assert.ok(!redacted.payload.body.includes(ghPat));
  assert.ok(redacted.payload.body.includes("[REDACTED]"));
});

test("redact: classic GitHub token masked", () => {
  const evt = { event: "x", payload: { note: `token=${ghClassic}` } };
  const out = redactEventPayload(evt);
  assert.ok(!out.payload.note.includes(ghClassic));
});

test("redact: AWS access-key id masked", () => {
  const evt = { event: "x", payload: { info: `${awsKey} was exposed` } };
  const out = redactEventPayload(evt);
  assert.ok(!out.payload.info.includes(awsKey));
});

test("redact: Slack bot token masked", () => {
  const evt = { event: "x", payload: { raw: slackBot } };
  const out = redactEventPayload(evt);
  assert.ok(!out.payload.raw.includes(slackBot));
});

test("redact: JWT-looking string masked", () => {
  const evt = {
    event: "x",
    payload: { jwt: jwtLike },
  };
  const out = redactEventPayload(evt);
  assert.ok(!out.payload.jwt.includes(jwtHeader));
});

test("redact: header-style keys masked regardless of value", () => {
  const evt = {
    event: "x",
    payload: {
      Authorization: "Bearer safe-value-just-happens-to-look-ok",
      headers: { "x-api-key": "arbitrary-string" },
      normal: "keep-me",
    },
  };
  const out = redactEventPayload(evt);
  assert.equal(out.payload.Authorization, "[REDACTED]");
  assert.equal(out.payload.headers["x-api-key"], "[REDACTED]");
  assert.equal(out.payload.normal, "keep-me");
});

test("redact: plain values without secrets pass through untouched", () => {
  const evt = { event: "x", payload: { msg: "hello world", n: 42 } };
  const out = redactEventPayload(evt);
  assert.equal(out.payload.msg, "hello world");
  assert.equal(out.payload.n, 42);
});

test("redact: deeply nested secrets handled up to depth 8", () => {
  const evt = {
    event: "x",
    payload: { a: { b: { c: { d: { note: openaiKey } } } } },
  };
  const out = redactEventPayload(evt);
  assert.ok(!out.payload.a.b.c.d.note.includes(openaiKey));
});

test("containsSecret: boolean check works on strings and objects", () => {
  assert.equal(containsSecret(openaiKey), true);
  assert.equal(containsSecret("hello"), false);
  assert.equal(containsSecret({ a: { b: ghClassic } }), true);
  assert.equal(containsSecret({ a: { b: "plain" } }), false);
});

test("appendToStream: payload secrets are redacted before hitting disk", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "senti-redact-sink-"));
  try {
    await seedWorkspace(tempRoot);
    const session = await createSession({ targetPath: tempRoot, ttlSeconds: 120 });

    await appendToStream(
      session.sessionId,
      {
        event: "agent_say",
        agentId: "claude-test",
        payload: { body: `I just leaked ${ghClassic} oops` },
      },
      { targetPath: tempRoot }
    );

    const raw = await readFile(
      path.join(tempRoot, ".sentinelayer", "sessions", session.sessionId, "stream.ndjson"),
      "utf-8"
    );
    assert.ok(!raw.includes(ghClassic), "raw disk content must not contain the secret");
    assert.ok(raw.includes("[REDACTED]"), "redaction marker must appear on disk");

    const events = await readStream(session.sessionId, { tail: 10, targetPath: tempRoot });
    assert.ok(events[0].payload.body.includes("[REDACTED]"));
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});
