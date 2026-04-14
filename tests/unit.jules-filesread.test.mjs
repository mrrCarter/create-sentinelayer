import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { createAgentContext } from "../src/agents/jules/tools/dispatch.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const dispatchSource = readFileSync(
  join(__dirname, "../src/agents/jules/tools/dispatch.js"),
  "utf-8",
);
const subAgentSource = readFileSync(
  join(__dirname, "../src/agents/jules/swarm/sub-agent.js"),
  "utf-8",
);

test("createAgentContext initializes filesRead as empty Set", () => {
  const ctx = createAgentContext({
    agentIdentity: { id: "test", persona: "Test Agent" },
    budget: { maxCostUsd: 1.0 },
  });

  assert.ok(ctx.usage.filesRead instanceof Set, "filesRead must be a Set");
  assert.equal(ctx.usage.filesRead.size, 0, "filesRead must start empty");
});

test("filesRead tracks unique file paths and deduplicates", () => {
  const ctx = createAgentContext({
    agentIdentity: { id: "test", persona: "Test Agent" },
    budget: { maxCostUsd: 1.0 },
  });

  ctx.usage.filesRead.add("src/app/page.tsx");
  ctx.usage.filesRead.add("src/app/layout.tsx");
  ctx.usage.filesRead.add("src/app/page.tsx"); // duplicate

  assert.equal(ctx.usage.filesRead.size, 2);
  assert.ok(ctx.usage.filesRead.has("src/app/page.tsx"));
  assert.ok(ctx.usage.filesRead.has("src/app/layout.tsx"));
});

test("filesRead converts to array via spread for serialization", () => {
  const ctx = createAgentContext({
    agentIdentity: { id: "test", persona: "Test Agent" },
    budget: { maxCostUsd: 1.0 },
  });

  ctx.usage.filesRead.add("a.tsx");
  ctx.usage.filesRead.add("b.tsx");

  const arr = [...ctx.usage.filesRead];
  assert.ok(Array.isArray(arr));
  assert.equal(arr.length, 2);
});

test("dispatch tracks FileRead calls in filesRead set", () => {
  assert.ok(
    dispatchSource.includes('toolName === "FileRead"'),
    "dispatch must check for FileRead tool to track reads",
  );
  assert.ok(
    dispatchSource.includes("ctx.usage.filesRead.add("),
    "dispatch must add file path to filesRead set",
  );
});

test("dispatch snapshotUsage includes filesRead array", () => {
  assert.ok(
    dispatchSource.includes("filesRead: [...(ctx.usage.filesRead"),
    "snapshotUsage must include filesRead",
  );
});

test("sub-agent buildResult includes filesRead from ctx.usage", () => {
  assert.ok(
    subAgentSource.includes("filesRead: [...(this.ctx.usage.filesRead"),
    "sub-agent buildResult must include filesRead",
  );
});
