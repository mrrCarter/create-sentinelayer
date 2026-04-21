// Unit tests for the live-web validator (#investor-dd-25..28).

import test from "node:test";
import assert from "node:assert/strict";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  discoverInteractiveElements,
  runLiveValidator,
  buildObservationIndex,
  createFindingObservationPair,
} from "../src/review/live-validator.js";

async function makeTempRepo() {
  return fsp.mkdtemp(path.join(os.tmpdir(), "senti-live-"));
}

async function writeFile(root, relativePath, content) {
  const fullPath = path.join(root, relativePath);
  await fsp.mkdir(path.dirname(fullPath), { recursive: true });
  await fsp.writeFile(fullPath, content, "utf-8");
}

test("discoverInteractiveElements: extracts buttons + forms from JSX", async () => {
  const root = await makeTempRepo();
  try {
    await writeFile(
      root,
      "src/components/Login.tsx",
      `
export function Login() {
  return (
    <form onSubmit={submit}>
      <input name="email" aria-label="email-input" />
      <button data-testid="login-submit">Sign in</button>
    </form>
  );
}
`,
    );
    const elements = await discoverInteractiveElements(root);
    assert.ok(elements.some((e) => e.elementLabel === "login-submit"));
    assert.ok(elements.some((e) => e.elementLabel === "email-input"));
    assert.ok(elements.every((e) => e.sourceFile.endsWith("Login.tsx")));
    assert.ok(elements.every((e) => e.lineIndex >= 1));
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});

test("discoverInteractiveElements: accepts capitalized component tags", async () => {
  const root = await makeTempRepo();
  try {
    await writeFile(
      root,
      "src/pages/Home.tsx",
      `<Button data-testid="cta-primary">Go</Button>\n`,
    );
    const elements = await discoverInteractiveElements(root);
    assert.ok(elements.some((e) => e.elementLabel === "cta-primary"));
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});

test("discoverInteractiveElements: skips backend source", async () => {
  const root = await makeTempRepo();
  try {
    await writeFile(root, "src/api/server.ts", "app.post('/users', handler);\n");
    const elements = await discoverInteractiveElements(root);
    // server.ts is .ts not .tsx so gets skipped entirely.
    assert.equal(elements.length, 0);
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});

test("runLiveValidator: calls devTestBot for each element and aggregates observations", async () => {
  const elements = [
    { elementLabel: "btn-a", sourceFile: "src/App.tsx", lineIndex: 10 },
    { elementLabel: "btn-b", sourceFile: "src/App.tsx", lineIndex: 20 },
  ];
  const provisioned = { identityId: "id-1", email: "x@aidenid.test" };
  const interactions = [];
  const client = {
    interact: async (element) => {
      interactions.push(element);
      return {
        interactionId: `i-${element.elementLabel}`,
        statusCodeObserved: 200,
        consoleErrors: [],
      };
    },
  };
  const aidenid = {
    provisionEphemeralIdentity: async () => provisioned,
    release: async () => {},
  };
  const events = [];
  const result = await runLiveValidator({
    runId: "run-42",
    elements,
    devTestBot: client,
    aidenid,
    onEvent: (e) => events.push(e),
  });

  assert.equal(result.observations.length, 2);
  assert.equal(result.identity.identityId, "id-1");
  assert.equal(interactions.length, 2);
  assert.ok(events.some((e) => e.type === "live_validator_identity_ready"));
  assert.ok(events.some((e) => e.type === "live_validator_interaction_complete"));
  assert.ok(events.some((e) => e.type === "live_validator_complete"));
});

test("runLiveValidator: skips elements when interact throws and reports count", async () => {
  const elements = [
    { elementLabel: "btn-a", sourceFile: "a.tsx" },
    { elementLabel: "btn-b", sourceFile: "a.tsx" },
  ];
  let n = 0;
  const client = {
    interact: async () => {
      n += 1;
      if (n === 1) throw new Error("flakey");
      return { interactionId: "ok", statusCodeObserved: 200 };
    },
  };
  const aidenid = {
    provisionEphemeralIdentity: async () => ({ identityId: "x", email: "y" }),
  };
  const result = await runLiveValidator({
    runId: "run-43",
    elements,
    devTestBot: client,
    aidenid,
  });
  assert.equal(result.observations.length, 1);
  assert.equal(result.skipped, 1);
});

test("runLiveValidator: maxInteractions caps the run", async () => {
  const elements = [
    { elementLabel: "a", sourceFile: "x.tsx" },
    { elementLabel: "b", sourceFile: "x.tsx" },
    { elementLabel: "c", sourceFile: "x.tsx" },
  ];
  const client = {
    interact: async () => ({ interactionId: "i", statusCodeObserved: 200 }),
  };
  const aidenid = {
    provisionEphemeralIdentity: async () => ({ identityId: "x", email: "y" }),
  };
  const result = await runLiveValidator({
    runId: "run-44",
    elements,
    devTestBot: client,
    aidenid,
    maxInteractions: 2,
  });
  assert.equal(result.observations.length, 2);
});

test("runLiveValidator: rejects missing clients", async () => {
  await assert.rejects(
    () => runLiveValidator({ runId: "r", elements: [] }),
    /devTestBot/,
  );
  await assert.rejects(
    () =>
      runLiveValidator({
        runId: "r",
        elements: [],
        devTestBot: { interact: async () => ({}) },
      }),
    /AIdenID/,
  );
});

test("buildObservationIndex + createFindingObservationPair", () => {
  const observations = [
    { sourceFile: "a.tsx", lineIndex: 10, interactionId: "i1" },
    { sourceFile: "b.tsx", interactionId: "i2" },
  ];
  const index = buildObservationIndex(observations);
  const pair = createFindingObservationPair(index);

  assert.equal(pair({ file: "a.tsx", line: 10 }).interactionId, "i1");
  assert.equal(pair({ file: "b.tsx" }).interactionId, "i2");
  assert.equal(pair({ file: "nope.tsx" }), null);
  assert.equal(pair(null), null);
});
