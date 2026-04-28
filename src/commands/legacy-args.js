function wantsJsonOutput(commandOptions, command) {
  const local = Boolean(commandOptions && commandOptions.json);
  const globalFromCommand =
    command && command.optsWithGlobals ? Boolean(command.optsWithGlobals().json) : false;
  return local || globalFromCommand;
}

function appendPathFlag(args, maybePath) {
  const value = String(maybePath || "").trim();
  if (value) {
    args.push("--path", value);
  }
}

function appendOutputDirFlag(args, maybeOutputDir) {
  const value = String(maybeOutputDir || "").trim();
  if (value) {
    args.push("--output-dir", value);
  }
}

function appendPassthroughFlag(args, flagName, maybeValue) {
  const value = maybeValue === undefined || maybeValue === null ? "" : String(maybeValue).trim();
  if (value) {
    args.push(flagName, value);
  }
}

function appendBooleanFlag(args, flagName, maybeValue) {
  if (Boolean(maybeValue)) {
    args.push(flagName);
  }
}

function appendNegatedBooleanFlag(args, flagName, maybeValue) {
  if (maybeValue === false) {
    args.push(flagName);
  }
}

export function buildLegacyArgs(baseArgs, { commandOptions = {}, command } = {}) {
  const args = [...baseArgs];
  appendPathFlag(args, commandOptions.path);
  appendOutputDirFlag(args, commandOptions.outputDir);
  if (wantsJsonOutput(commandOptions, command)) {
    args.push("--json");
  }
  appendNegatedBooleanFlag(args, "--no-ai", commandOptions.ai);
  appendBooleanFlag(args, "--ai-dry-run", commandOptions.aiDryRun);
  appendBooleanFlag(args, "--stream", commandOptions.stream);
  appendBooleanFlag(args, "--dry-run", commandOptions.dryRun);
  appendNegatedBooleanFlag(args, "--no-email", commandOptions.email);
  appendNegatedBooleanFlag(args, "--no-dashboard", commandOptions.dashboard);
  appendPassthroughFlag(args, "--scan-mode", commandOptions.scanMode);
  appendPassthroughFlag(args, "--max-parallel", commandOptions.maxParallel);
  appendPassthroughFlag(args, "--max-cost", commandOptions.maxCost);
  appendPassthroughFlag(args, "--max-runtime-minutes", commandOptions.maxRuntimeMinutes);
  appendPassthroughFlag(args, "--model", commandOptions.model);
  appendPassthroughFlag(args, "--provider", commandOptions.provider);
  appendPassthroughFlag(args, "--reuse-omargate", commandOptions.reuseOmargate);
  appendPassthroughFlag(args, "--notify-email", commandOptions.notifyEmail);
  appendPassthroughFlag(args, "--notify-session", commandOptions.notifySession);
  // Omar Gate per-persona filter flags (A-CLI-1).
  appendPassthroughFlag(args, "--persona", commandOptions.persona);
  appendPassthroughFlag(args, "--skip-persona", commandOptions.skipPersona);
  return args;
}
