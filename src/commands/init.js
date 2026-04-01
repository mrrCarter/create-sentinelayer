import process from "node:process";

import { loadConfig } from "../config/service.js";

function applyConfigEnvDefaults(resolvedConfig) {
  if (!process.env.SENTINELAYER_API_URL && resolvedConfig.apiUrl) {
    process.env.SENTINELAYER_API_URL = resolvedConfig.apiUrl;
  }
  if (!process.env.SENTINELAYER_WEB_URL && resolvedConfig.webUrl) {
    process.env.SENTINELAYER_WEB_URL = resolvedConfig.webUrl;
  }
  if (!process.env.SENTINELAYER_TOKEN && resolvedConfig.sentinelayerToken) {
    process.env.SENTINELAYER_TOKEN = resolvedConfig.sentinelayerToken;
  }
  if (!process.env.OPENAI_API_KEY && resolvedConfig.openaiApiKey) {
    process.env.OPENAI_API_KEY = resolvedConfig.openaiApiKey;
  }
  if (!process.env.ANTHROPIC_API_KEY && resolvedConfig.anthropicApiKey) {
    process.env.ANTHROPIC_API_KEY = resolvedConfig.anthropicApiKey;
  }
  if (!process.env.GOOGLE_API_KEY && resolvedConfig.googleApiKey) {
    process.env.GOOGLE_API_KEY = resolvedConfig.googleApiKey;
  }
}

export function registerInitCommand(program, invokeLegacy) {
  program
    .command("init [projectName]")
    .description("Run scaffold/auth generation flow")
    .option("--non-interactive", "Disable prompts and require interview payload")
    .option("--interview-file <path>", "Load interview JSON from file")
    .option("--skip-browser-open", "Do not auto-open browser during auth")
    .action(async (projectName, options) => {
      const config = await loadConfig();
      applyConfigEnvDefaults(config.resolved);

      const legacyArgs = [];
      const normalizedProjectName = String(projectName || "").trim();
      if (normalizedProjectName) {
        legacyArgs.push(normalizedProjectName);
      }
      if (options.nonInteractive) {
        legacyArgs.push("--non-interactive");
      }
      const interviewFile = String(options.interviewFile || "").trim();
      if (interviewFile) {
        legacyArgs.push("--interview-file", interviewFile);
      }
      if (options.skipBrowserOpen) {
        legacyArgs.push("--skip-browser-open");
      }

      await invokeLegacy(legacyArgs);
    });
}
