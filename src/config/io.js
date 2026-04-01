import fsp from "node:fs/promises";
import path from "node:path";

import { parse, stringify } from "yaml";

import { configSchema } from "./schema.js";

function parseConfigObject(raw, filePath) {
  const parsed = parse(raw);
  if (parsed === null || parsed === undefined) {
    return {};
  }
  if (typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`Config at ${filePath} must be a YAML mapping/object.`);
  }

  const normalized = configSchema.safeParse(parsed);
  if (!normalized.success) {
    throw new Error(`Invalid config at ${filePath}: ${normalized.error.issues[0]?.message || "schema error"}`);
  }

  return normalized.data;
}

export async function readConfigFile(filePath) {
  try {
    const raw = await fsp.readFile(filePath, "utf-8");
    if (!String(raw || "").trim()) {
      return {};
    }
    return parseConfigObject(raw, filePath);
  } catch (error) {
    if (error && error.code === "ENOENT") {
      return {};
    }
    throw error;
  }
}

export async function writeConfigFile(filePath, data) {
  const normalized = configSchema.parse(data || {});
  await fsp.mkdir(path.dirname(filePath), { recursive: true });
  await fsp.writeFile(filePath, stringify(normalized), "utf-8");
}

export async function ensureConfigFile(filePath) {
  try {
    await fsp.access(filePath);
  } catch (error) {
    if (error && error.code === "ENOENT") {
      await writeConfigFile(filePath, {});
      return;
    }
    throw error;
  }
}
