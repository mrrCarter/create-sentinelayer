import os from "node:os";
import path from "node:path";
import process from "node:process";

export function getGlobalConfigPath({ homeDir = os.homedir() } = {}) {
  return path.join(homeDir, ".sentinelayer", "config.yml");
}

export function getProjectConfigPath({ cwd = process.cwd() } = {}) {
  return path.join(path.resolve(cwd), ".sentinelayer.yml");
}

export function getConfigPaths({ cwd = process.cwd(), homeDir } = {}) {
  return {
    global: getGlobalConfigPath({ homeDir }),
    project: getProjectConfigPath({ cwd }),
  };
}
