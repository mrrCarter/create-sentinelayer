import process from "node:process";

export function preferredCliCommand({ platform = process.platform, env = process.env } = {}) {
  const override = String(env?.SENTINELAYER_CLI_COMMAND || "").trim();
  if (override) {
    return override;
  }
  return platform === "win32" ? "sentinelayer-cli" : "sl";
}

export function authLoginHint({ platform = process.platform, env = process.env } = {}) {
  return `${preferredCliCommand({ platform, env })} auth login`;
}
