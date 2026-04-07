import prompts from "prompts";
import pc from "picocolors";

import { PERSONA_VISUALS, listPersonaIds } from "../agents/jules/config/definition.js";

/**
 * Interactive action menu — presented after ingest completes.
 * Arrow-key navigation for primary actions + submenus.
 */

/**
 * Present the main action menu.
 *
 * @returns {Promise<{ action: string, subAction?: string, input?: string }>}
 */
export async function showActionMenu() {
  const response = await prompts({
    type: "select",
    name: "action",
    message: "What would you like to do?",
    choices: [
      { title: pc.red("🔍 Audit"), value: "audit", description: "Run security + quality audit (baseline + personas)" },
      { title: pc.yellow("📝 Review"), value: "review", description: "Quick review of current changes" },
      { title: pc.green("🏗️  Add Feature"), value: "feature", description: "Describe a feature and generate spec + prompt" },
      { title: pc.blue("🆕 Create Project"), value: "create", description: "Scaffold a new project with spec + Omar Gate" },
      { title: pc.gray("⚙️  More options..."), value: "more", description: "Config, cost, telemetry, watch, plugins" },
    ],
  });

  if (!response.action) return { action: "exit" };

  // Route to submenu
  if (response.action === "audit") return showAuditMenu();
  if (response.action === "review") return showReviewMenu();
  if (response.action === "feature") return showFeaturePrompt();
  if (response.action === "more") return showMoreMenu();

  return { action: response.action };
}

/**
 * Audit submenu — all 13 personas + full audit.
 */
async function showAuditMenu() {
  const personaIds = listPersonaIds();
  const choices = [
    {
      title: pc.bold("🎯 Full Audit (all 13 personas in parallel)"),
      value: { action: "audit", subAction: "deep" },
      description: "Omar baseline → 13 specialist agents → reconciliation",
    },
  ];

  for (const id of personaIds) {
    const visual = PERSONA_VISUALS[id];
    if (!visual) continue;
    choices.push({
      title: (visual.avatar || "") + " " + visual.fullName + pc.gray(" (" + id + ")"),
      value: { action: "audit", subAction: id },
      description: visual.specialty ? visual.specialty.slice(0, 80) : visual.domain || id,
    });
  }

  const response = await prompts({
    type: "select",
    name: "choice",
    message: "Which audit?",
    choices,
  });

  return response.choice || { action: "exit" };
}

/**
 * Review submenu.
 */
async function showReviewMenu() {
  const response = await prompts({
    type: "select",
    name: "choice",
    message: "Review mode?",
    choices: [
      { title: "📋 Full review", value: { action: "review", subAction: "full" }, description: "Scan entire codebase (22-rule deterministic + AI)" },
      { title: "📝 Diff review", value: { action: "review", subAction: "diff" }, description: "Review only uncommitted changes" },
      { title: "📌 Staged review", value: { action: "review", subAction: "staged" }, description: "Review only staged files" },
    ],
  });

  return response.choice || { action: "exit" };
}

/**
 * Feature description prompt.
 */
async function showFeaturePrompt() {
  const response = await prompts({
    type: "text",
    name: "description",
    message: "Describe the feature you want to add:",
    validate: v => (v && v.trim().length > 5) ? true : "Please describe the feature (at least a few words)",
  });

  if (!response.description) return { action: "exit" };

  return {
    action: "feature",
    input: response.description.trim(),
  };
}

/**
 * More options submenu.
 */
async function showMoreMenu() {
  const response = await prompts({
    type: "select",
    name: "choice",
    message: "More options:",
    choices: [
      { title: "📊 Cost & usage summary", value: { action: "cost" }, description: "View token usage and cost tracking" },
      { title: "📈 Telemetry", value: { action: "telemetry" }, description: "View run event telemetry" },
      { title: "⚙️  Config", value: { action: "config" }, description: "View and edit configuration" },
      { title: "👤 Auth status", value: { action: "auth-status" }, description: "Check authentication" },
      { title: "🔌 Plugins", value: { action: "plugins" }, description: "List installed plugins" },
      { title: "📡 Watch events", value: { action: "watch" }, description: "Stream runtime events" },
      { title: "🤖 AI identity", value: { action: "ai" }, description: "AIdenID provisioning" },
      { title: "🐛 Daemon status", value: { action: "daemon" }, description: "Error queue and budget status" },
    ],
  });

  return response.choice || { action: "exit" };
}
