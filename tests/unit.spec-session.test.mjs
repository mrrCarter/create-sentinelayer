import test from "node:test";
import assert from "node:assert/strict";

import {
  generateSpecMarkdown,
  resolveSpecTemplate,
} from "../src/spec/generator.js";
import { generateExecutionPrompt } from "../src/prompt/generator.js";
import { generateBuildGuide, renderGuideExport } from "../src/guide/generator.js";
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

test("Unit spec session: session tooling forces coordination phase by default", () => {
  const template = resolveSpecTemplate("api-service");
  const markdown = generateSpecMarkdown({
    template,
    description: "Deliver a single-owner internal utility.",
    ingest: sampleIngest(),
    projectPath: "/repo/demo",
    agentsMarkdown: "# AGENTS\n- single owner\n",
    sessionActive: false,
  });
  assert.match(markdown, /Multi-Agent Coordination Protocol/);
  assert.match(markdown, /plan: <scope>; files: <paths>/);
  assert.match(markdown, /lock: <file> - <intent>/);
  assert.match(markdown, /sl review --diff/);
  assert.match(markdown, /sl --help/);
});

test("Unit spec session: coordination phase can be omitted when session tooling is unavailable", () => {
  const template = resolveSpecTemplate("api-service");
  const markdown = generateSpecMarkdown({
    template,
    description: "Deliver a single-owner internal utility.",
    ingest: sampleIngest(),
    projectPath: "/repo/demo",
    agentsMarkdown: "# AGENTS\n- single owner\n",
    sessionActive: false,
    sessionToolsAvailable: false,
  });
  assert.doesNotMatch(markdown, /Multi-Agent Coordination Protocol/);
});

test("Unit spec session: prompt generator always appends session operating rules", () => {
  const prompt = generateExecutionPrompt({
    target: "codex",
    projectPath: "/repo/demo",
    specMarkdown: `# SPEC

## Goal
Ship a deterministic CLI feature.
`,
  });
  assert.match(prompt, /Find the recent Senti session for this codebase/);
  assert.match(prompt, /plan: <scope>; files: <paths>/);
  assert.match(prompt, /sl review --diff/);
  assert.match(prompt, /sl --help/);
});

test("Unit spec session: guide markdown and tracker exports include coordination rules", () => {
  const guide = generateBuildGuide({
    projectPath: "/repo/demo",
    specPath: "/repo/demo/SPEC.md",
    specMarkdown: `# SPEC - Guide Session Demo

## Goal
Ship deterministic coordination.

## Acceptance Criteria
1. Coordination is visible.

## Phase Plan
### Phase 1 - Foundation
1. Build the feature.
`,
  });

  assert.match(guide.markdown, /## Multi-Agent Coordination Protocol/);
  assert.match(guide.markdown, /sl session list --path \./);
  assert.match(guide.tickets[0].description, /Coordination rules:/);
  assert.match(guide.tickets[0].description, /sl review --diff/);

  const jira = JSON.parse(renderGuideExport({ format: "jira", guide }));
  const linear = JSON.parse(renderGuideExport({ format: "linear", guide }));
  const github = renderGuideExport({ format: "github-issues", guide });

  assert.match(jira.issues[0].description, /Coordination rules:/);
  assert.match(linear.issues[0].description, /lock: <file> - <intent>/);
  assert.match(github, /sl --help/);
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
  assert.match(handoff, /sl session listen --session <id> --agent <your-name> --interval 60 --active-interval 5 --emit ndjson/);
  assert.match(handoff, /sl session sync <id> --json/);
  assert.match(handoff, /sl --help/);

  const guide = buildAgentsSessionGuideContent();
  assert.match(guide, /SentinelLayer Session Guide for AI Agents/);
  assert.match(guide, /sl session list/);
  assert.match(guide, /sl session say <id>/);
  assert.match(guide, /sl session listen --session <id>/);
  assert.match(guide, /sl review --diff/);
});
