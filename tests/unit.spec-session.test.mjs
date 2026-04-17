import test from "node:test";
import assert from "node:assert/strict";

import {
  generateSpecMarkdown,
  resolveSpecTemplate,
} from "../src/spec/generator.js";
import { generateExecutionPrompt } from "../src/prompt/generator.js";
import {
  buildAgentsSessionGuideContent,
  buildHandoffPrompt,
  buildTodoContent,
} from "../src/legacy-cli.js";

function sampleIngest() {
  return {
    rootPath: "/repo/demo",
    summary: {
      filesScanned: 24,
      totalLoc: 2400,
    },
    languages: [{ language: "TypeScript", loc: 2200 }],
    frameworks: ["express"],
    entryPoints: ["src/index.ts"],
    riskSurfaces: [{ surface: "security_overlay" }, { surface: "reliability_sre" }],
    packageMetadata: { name: "demo-service" },
  };
}

test("Unit spec session: coordination phase appears when collaboration is detected", () => {
  const template = resolveSpecTemplate("api-service");
  const markdown = generateSpecMarkdown({
    template,
    description: "Pair with the team to deliver secure auth hardening.",
    ingest: sampleIngest(),
    projectPath: "/repo/demo",
    agentsMarkdown: `
# AGENTS
## Agents
- coder
- reviewer
`,
  });

  assert.match(markdown, /Multi-Agent Coordination Protocol/);
  assert.match(markdown, /sl session list/);
  assert.match(markdown, /sl session join <id>/);
  assert.match(markdown, /sl session leave <id>/);
});

test("Unit spec session: sessionActive flag forces coordination phase", () => {
  const template = resolveSpecTemplate("api-service");
  const markdown = generateSpecMarkdown({
    template,
    description: "Ship API improvements.",
    ingest: sampleIngest(),
    projectPath: "/repo/demo",
    sessionActive: true,
  });
  assert.match(markdown, /Multi-Agent Coordination Protocol/);
});

test("Unit spec session: no collaboration signal omits coordination phase", () => {
  const template = resolveSpecTemplate("api-service");
  const markdown = generateSpecMarkdown({
    template,
    description: "Deliver a single-owner internal utility.",
    ingest: sampleIngest(),
    projectPath: "/repo/demo",
    agentsMarkdown: "# AGENTS\n- single owner\n",
    sessionActive: false,
  });
  assert.doesNotMatch(markdown, /Multi-Agent Coordination Protocol/);
});

test("Unit spec session: prompt generator appends session operating rules when spec contains session guidance", () => {
  const prompt = generateExecutionPrompt({
    target: "codex",
    projectPath: "/repo/demo",
    specMarkdown: `# SPEC

## Phase 2: Multi-Agent Coordination Protocol
1. Check \`sl session list\`
`,
  });
  assert.match(prompt, /Multi-agent coordination: use `sl session` commands/);
  assert.match(prompt, /Never break your autonomous loop on unexpected file changes/);
});

test("Unit spec session: scaffold templates include todo, handoff, and session guide coordination content", () => {
  const todo = buildTodoContent({
    projectName: "demo-app",
    aiProvider: "openai",
    codingAgent: "codex",
    authMode: "sentinelayer",
    repoSlug: "acme/demo-app",
    buildFromExistingRepo: false,
    generationMode: "detailed",
    audienceLevel: "developer",
    projectType: "add_feature",
  });
  assert.match(todo, /join the SentinelLayer session and emit status updates/);
  assert.match(todo, /Update tasks\/lessons\.md with coordination patterns learned during this session/);

  const handoff = buildHandoffPrompt({
    projectName: "demo-app",
    repoSlug: "acme/demo-app",
    secretName: "SENTINELAYER_TOKEN",
    buildFromExistingRepo: false,
    authMode: "sentinelayer",
    codingAgent: "codex",
  });
  assert.match(handoff, /## Multi-Agent Coordination \(if session active\)/);
  assert.match(handoff, /sl session join <id> --name <your-name> --role coder/);
  assert.match(handoff, /sl session read <id> --tail 10/);

  const guide = buildAgentsSessionGuideContent();
  assert.match(guide, /SentinelLayer Session Guide for AI Agents/);
  assert.match(guide, /sl session list/);
  assert.match(guide, /sl session say <id>/);
});
