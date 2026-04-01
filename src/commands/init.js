export function registerInitCommand(program, invokeLegacy) {
  program
    .command("init [projectName]")
    .description("Run scaffold/auth generation flow")
    .option("--non-interactive", "Disable prompts and require interview payload")
    .option("--interview-file <path>", "Load interview JSON from file")
    .option("--skip-browser-open", "Do not auto-open browser during auth")
    .action(async (projectName, options) => {
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
