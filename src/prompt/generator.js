export const SUPPORTED_PROMPT_TARGETS = Object.freeze([
  "claude",
  "cursor",
  "copilot",
  "codex",
  "generic",
]);

const TARGET_GUIDANCE = Object.freeze({
  claude: [
    "Use strict PR-scoped execution with explicit plan -> implement -> verify loop.",
    "Prioritize deterministic checks before optional AI-dependent steps.",
    "Record evidence for every claim in the final report.",
  ],
  cursor: [
    "Apply edits in small, reviewable commits.",
    "Keep changes aligned with existing project conventions and tests.",
    "Run local verification before proposing follow-up iterations.",
  ],
  copilot: [
    "Generate code with strong type and error-path handling.",
    "Avoid introducing implicit behavior changes in existing modules.",
    "Include targeted tests for all new logic paths.",
  ],
  codex: [
    "Operate autonomously but keep one PR scope at a time.",
    "Use deterministic ingest/spec context as primary source of truth.",
    "Fail closed when requirements are ambiguous or unsafe.",
  ],
  generic: [
    "Follow the provided spec exactly.",
    "Implement in incremental, verifiable steps.",
    "Document assumptions and unresolved risks.",
  ],
});

function normalizeTarget(target) {
  const normalized = String(target || "generic").trim().toLowerCase();
  if (!SUPPORTED_PROMPT_TARGETS.includes(normalized)) {
    throw new Error(
      `Unsupported prompt target '${target}'. Use one of: ${SUPPORTED_PROMPT_TARGETS.join(", ")}`
    );
  }
  return normalized;
}

function buildAgentHeader(target) {
  const headers = {
    claude: "Claude Code execution prompt",
    cursor: "Cursor execution prompt",
    copilot: "GitHub Copilot execution prompt",
    codex: "Codex execution prompt",
    generic: "Generic execution prompt",
  };
  return headers[target] || headers.generic;
}

export function resolvePromptTarget(target) {
  return normalizeTarget(target);
}

export function defaultPromptFileName(target) {
  const normalized = normalizeTarget(target);
  if (normalized === "generic") {
    return "PROMPT.md";
  }
  return `PROMPT_${normalized}.md`;
}

export function generateExecutionPrompt({
  specMarkdown,
  target = "generic",
  projectPath,
  generatedAt = new Date().toISOString(),
} = {}) {
  const resolvedTarget = normalizeTarget(target);
  const guidance = TARGET_GUIDANCE[resolvedTarget] || TARGET_GUIDANCE.generic;

  const specText = String(specMarkdown || "").trim();
  if (!specText) {
    throw new Error("Spec content is empty. Generate or provide a spec before creating a prompt.");
  }

  const guidanceMarkdown = guidance.map((item, index) => `${index + 1}. ${item}`).join("\n");

  const hasAidenId = specText.toLowerCase().includes("aidenid");
  const aidenidGuidance = hasAidenId
    ? `
## AIdenID E2E Testing
- AIdenID credentials are auto-provisioned via \`sl auth login\`. No manual env vars needed.
- Run \`sl auth status\` to confirm AIdenID is provisioned before using identity commands.
- Use \`sl ai provision-email --execute --json\` to create ephemeral test emails.
- Use \`sl ai identity wait-for-otp <identityId> --timeout 30\` to poll for OTP extraction.
- Revoke test identities after verification: \`sl ai identity revoke <identityId>\`.
`
    : "";

  return `# ${buildAgentHeader(resolvedTarget)}

Generated: ${generatedAt}
Agent target: ${resolvedTarget}
Workspace: ${projectPath || "(not provided)"}

## Operating Rules
${guidanceMarkdown}

## Execution Workflow
1. Read the full spec and derive a concrete PR-scoped implementation plan.
2. Implement only the current scope with deterministic checkpoints.
3. Run verification commands and capture outcomes.
4. Report findings first (bugs/regressions), then summarize changes.
${aidenidGuidance}
## Source Spec (Authoritative)
\n\`\`\`markdown
${specText}
\`\`\`
`;
}
