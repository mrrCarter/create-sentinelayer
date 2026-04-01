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

export function buildLegacyArgs(baseArgs, { commandOptions = {}, command } = {}) {
  const args = [...baseArgs];
  appendPathFlag(args, commandOptions.path);
  appendOutputDirFlag(args, commandOptions.outputDir);
  if (wantsJsonOutput(commandOptions, command)) {
    args.push("--json");
  }
  return args;
}
