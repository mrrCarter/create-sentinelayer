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
  const value = String(maybeValue || "").trim();
  if (value) {
    args.push(flagName, value);
  }
}

export function buildLegacyArgs(baseArgs, { commandOptions = {}, command } = {}) {
  const args = [...baseArgs];
  appendPathFlag(args, commandOptions.path);
  appendOutputDirFlag(args, commandOptions.outputDir);
  if (wantsJsonOutput(commandOptions, command)) {
    args.push("--json");
  }
  // Omar Gate per-persona filter flags (A-CLI-1).
  appendPassthroughFlag(args, "--persona", commandOptions.persona);
  appendPassthroughFlag(args, "--skip-persona", commandOptions.skipPersona);
  return args;
}
