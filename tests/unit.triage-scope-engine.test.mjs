import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { Command } from "commander";

import { registerSessionCommand } from "../src/commands/session.js";
import {
  ISSUE_SCOPE_ENVELOPE_VERSION,
  buildIssueScopeEnvelope,
  getScopeEngineRun,
  validateIssueScopeEnvelope,
} from "../src/daemon/scope-engine.js";
import { validateAgentEvent } from "../src/events/schema.js";
import { createSession } from "../src/session/store.js";
import { readStream } from "../src/session/stream.js";

async function seedWorkspace(rootPath) {
  await mkdir(path.join(rootPath, "src", "api", "auth"), { recursive: true });
  await mkdir(path.join(rootPath, "src", "payments"), { recursive: true });
  await mkdir(path.join(rootPath, "scripts"), { recursive: true });
  await mkdir(path.join(rootPath, "docs"), { recursive: true });

  await writeFile(
    path.join(rootPath, "package.json"),
    JSON.stringify(
      {
        name: "scope-engine-fixture",
        version: "1.0.0",
        type: "module",
        dependencies: {
          express: "^4.19.0",
        },
      },
      null,
      2
    ),
    "utf-8"
  );

  await writeFile(
    path.join(rootPath, "src", "api", "auth", "helpers.js"),
    `export function verifyToken(token) {
  return Boolean(token && token.startsWith("Bearer "));
}
`,
    "utf-8"
  );
  await writeFile(
    path.join(rootPath, "src", "api", "auth", "login.js"),
    `import { verifyToken } from "./helpers.js";

export async function loginHandler(req, res) {
  const token = req.headers.authorization || "";
  if (!verifyToken(token)) {
    return res.status(401).json({ ok: false });
  }
  return res.json({ ok: true });
}

export function registerAuthRoutes(app) {
  app.post("/api/v1/auth/login", loginHandler);
}
`,
    "utf-8"
  );
  await writeFile(
    path.join(rootPath, "src", "payments", "charge.js"),
    `export async function chargeCard(details) {
  return { ok: true, details };
}
`,
    "utf-8"
  );
  await writeFile(
    path.join(rootPath, "scripts", "maintenance.js"),
    `export async function runMaintenance() {
  return "ok";
}
`,
    "utf-8"
  );
  await writeFile(path.join(rootPath, "docs", "README.md"), "# Docs\n", "utf-8");
}

async function seedKillFixture(rootPath) {
  await seedWorkspace(rootPath);
  await mkdir(path.join(rootPath, "src", "generated"), { recursive: true });
  for (let index = 0; index < 220; index += 1) {
    await writeFile(
      path.join(rootPath, "src", "generated", `module-${index}.js`),
      `export function module${index}() {
  return ${index};
}
`,
      "utf-8"
    );
  }
}

function createSessionProgram() {
  const program = new Command();
  program
    .name("sl")
    .exitOverride()
    .configureOutput({
      writeOut: () => {},
      writeErr: () => {},
    });
  registerSessionCommand(program);
  return program;
}

async function withCapturedConsole(run) {
  const logs = [];
  const originalLog = console.log;
  console.log = (...args) => {
    logs.push(args.map((part) => String(part)).join(" "));
  };
  try {
    await run();
  } finally {
    console.log = originalLog;
  }
  return logs;
}

test("Unit triage scope engine: envelope includes deterministic pack, scoped paths, and canonical stream event", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "create-sentinelayer-scope-engine-"));
  try {
    await seedWorkspace(tempRoot);
    const session = await createSession({ targetPath: tempRoot, ttlSeconds: 120 });
    const result = await buildIssueScopeEnvelope({
      sessionId: session.sessionId,
      workItemId: "work-auth-1",
      targetPath: tempRoot,
      intakeEvent: {
        service: "auth",
        endpoint: "/api/v1/auth/login",
        error_code: "AUTH_TIMEOUT",
        message: "login request timeout while verifying token",
        severity: "P1",
      },
    });

    assert.equal(result.envelope.version, ISSUE_SCOPE_ENVELOPE_VERSION);
    assert.equal(validateIssueScopeEnvelope(result.envelope), true);
    assert.equal(result.envelope.deterministicPack.locBucket.length > 0, true);
    assert.equal(result.envelope.deterministicPack.frameworks.includes("express"), true);
    assert.equal(result.envelope.candidateFiles.length > 0, true);
    assert.equal(
      result.envelope.candidateFiles.some((candidate) => candidate.path.endsWith("src/api/auth/login.js")),
      true
    );
    assert.equal(result.envelope.endpointMapping[0].endpoint, "/api/v1/auth/login");
    assert.equal(
      result.envelope.endpointMapping[0].files.some((filePath) => filePath.endsWith("src/api/auth/login.js")),
      true
    );
    assert.equal(result.envelope.budgetEnvelope.allowedPaths.includes("src/**"), true);
    assert.equal(
      result.envelope.budgetEnvelope.allowedPaths.some((pattern) => pattern.startsWith("scripts/")),
      false
    );
    assert.equal(result.envelope.budgetEnvelope.deniedPaths.includes("scripts/**"), true);
    assert.equal(result.envelope.budgetEnvelope.deniedPaths.includes("docs/**"), true);

    const artifactPayload = JSON.parse(await readFile(result.artifactPath, "utf-8"));
    assert.equal(validateIssueScopeEnvelope(artifactPayload), true);
    assert.equal(artifactPayload.version, ISSUE_SCOPE_ENVELOPE_VERSION);

    const stream = await readStream(session.sessionId, { tail: 20, targetPath: tempRoot });
    const scopeEvent = stream.find(
      (event) => event.event === "scope_envelope_built" && event.payload.workItemId === "work-auth-1"
    );
    assert.ok(scopeEvent);
    assert.equal(validateAgentEvent(scopeEvent, { allowLegacy: false }), true);
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("Unit triage scope engine: semantic overlay attaches only when signal crosses threshold", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "create-sentinelayer-scope-overlay-"));
  try {
    await seedWorkspace(tempRoot);
    const highSignal = await buildIssueScopeEnvelope({
      workItemId: "work-overlay-high",
      targetPath: tempRoot,
      intakeEvent: {
        service: "auth",
        endpoint: "/api/v1/auth/login",
        error_code: "AUTH_TIMEOUT",
        message: "auth login endpoint timeout",
        severity: "P1",
      },
    });
    assert.ok(highSignal.envelope.semanticOverlay);
    assert.equal(Array.isArray(highSignal.envelope.semanticOverlay.symbols), true);
    assert.equal(Array.isArray(highSignal.envelope.semanticOverlay.callHierarchy), true);

    const lowSignal = await buildIssueScopeEnvelope({
      workItemId: "work-overlay-low",
      targetPath: tempRoot,
      intakeEvent: {
        service: "metrics",
        endpoint: "/internal/healthz",
        error_code: "PING_FAILED",
        message: "synthetic health check failed",
        severity: "P3",
      },
    });
    assert.equal(lowSignal.envelope.semanticOverlay, undefined);
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("Unit triage scope engine: frozen v1 schema validator rejects version drift", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "create-sentinelayer-scope-schema-"));
  try {
    await seedWorkspace(tempRoot);
    const result = await buildIssueScopeEnvelope({
      workItemId: "work-schema-1",
      targetPath: tempRoot,
      intakeEvent: {
        service: "auth",
        endpoint: "/api/v1/auth/login",
        error_code: "AUTH_TIMEOUT",
        message: "auth timeout",
      },
    });

    const artifactPayload = JSON.parse(await readFile(result.artifactPath, "utf-8"));
    assert.equal(validateIssueScopeEnvelope(artifactPayload), true);
    const drifted = {
      ...artifactPayload,
      version: "scope-envelope/v0",
    };
    assert.equal(validateIssueScopeEnvelope(drifted), false);
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("Unit triage scope engine: session kill --agent scope-engine aborts active run and emits agent_killed", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "create-sentinelayer-scope-kill-"));
  try {
    await seedKillFixture(tempRoot);
    const session = await createSession({ targetPath: tempRoot, ttlSeconds: 120 });

    const buildPromise = buildIssueScopeEnvelope({
      sessionId: session.sessionId,
      workItemId: "work-kill-1",
      targetPath: tempRoot,
      intakeEvent: {
        service: "auth",
        endpoint: "/api/v1/auth/login",
        error_code: "AUTH_TIMEOUT",
        message: "auth login timeout in route",
        severity: "P1",
      },
    });

    const activeRun = getScopeEngineRun(session.sessionId, {
      workItemId: "work-kill-1",
      targetPath: tempRoot,
    });
    assert.ok(activeRun, "Expected scope-engine run to be active before kill.");
    const buildAbort = assert.rejects(buildPromise, /Scope engine run aborted/i);

    const program = createSessionProgram();
    const logs = await withCapturedConsole(async () => {
      await program.parseAsync(
        [
          "session",
          "kill",
          "--id",
          session.sessionId,
          "--agent",
          "scope-engine",
          "--path",
          tempRoot,
          "--json",
        ],
        { from: "user" }
      );
    });
    assert.equal(logs.length > 0, true);
    const payload = JSON.parse(logs[logs.length - 1]);
    assert.equal(payload.command, "session kill");
    assert.equal(payload.agentId, "scope-engine");
    assert.equal(payload.stopped, true);
    assert.equal(payload.scopeStops >= 1, true);

    await buildAbort;

    const stream = await readStream(session.sessionId, { tail: 30, targetPath: tempRoot });
    const killEvent = stream.find(
      (event) => event.event === "agent_killed" && event.agent.id === "scope-engine"
    );
    assert.ok(killEvent);
    assert.equal(validateAgentEvent(killEvent, { allowLegacy: false }), true);
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});
