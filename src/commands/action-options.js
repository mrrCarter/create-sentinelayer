export function resolveActionOptions(options = {}, command = null) {
  const localOptions = options && typeof options.opts === "function" ? options.opts() : { ...options };
  const parent = command?.parent;
  if (!parent || typeof parent.opts !== "function") {
    return localOptions;
  }

  const parentOptions = parent.opts();
  const merged = {
    ...parentOptions,
    ...localOptions,
  };

  for (const [key, value] of Object.entries(parentOptions)) {
    const parentSource =
      typeof parent.getOptionValueSource === "function" ? parent.getOptionValueSource(key) : null;
    const localSource =
      typeof command?.getOptionValueSource === "function" ? command.getOptionValueSource(key) : null;
    const parentWasProvided = parentSource && parentSource !== "default";
    const localIsOnlyDefault = localSource === "default" || localOptions[key] === undefined;
    if (parentWasProvided && localIsOnlyDefault) {
      merged[key] = value;
    }
  }

  return merged;
}
