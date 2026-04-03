import fsp from "node:fs/promises";
import path from "node:path";

import { parse, stringify } from "yaml";

import {
  PLAINTEXT_CONFIG_SECRETS_ENV,
  findPersistedSecretKeys,
  getPersistedConfigSchema,
} from "./schema.js";

function assertNoPlaintextSecrets({ parsed, filePath, allowPlaintextSecrets }) {
  const secretKeys = findPersistedSecretKeys(parsed);
  if (!secretKeys.length || allowPlaintextSecrets) {
    return;
  }
  throw new Error(
    `Invalid config at ${filePath}: plaintext secrets (${secretKeys.join(
      ", "
    )}) are blocked. Use environment variables/keyring, or set ${PLAINTEXT_CONFIG_SECRETS_ENV}=1 for explicit legacy override.`
  );
}

function parseConfigObject(raw, filePath, { allowPlaintextSecrets = false } = {}) {
  const parsed = parse(raw);
  if (parsed === null || parsed === undefined) {
    return {};
  }
  if (typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`Config at ${filePath} must be a YAML mapping/object.`);
  }

  assertNoPlaintextSecrets({ parsed, filePath, allowPlaintextSecrets });
  const normalized = getPersistedConfigSchema({ allowPlaintextSecrets }).safeParse(parsed);
  if (!normalized.success) {
    throw new Error(`Invalid config at ${filePath}: ${normalized.error.issues[0]?.message || "schema error"}`);
  }

  return normalized.data;
}

export async function readConfigFile(filePath, { allowPlaintextSecrets = false } = {}) {
  try {
    const raw = await fsp.readFile(filePath, "utf-8");
    if (!String(raw || "").trim()) {
      return {};
    }
    return parseConfigObject(raw, filePath, { allowPlaintextSecrets });
  } catch (error) {
    if (error && error.code === "ENOENT") {
      return {};
    }
    throw error;
  }
}

export async function writeConfigFile(filePath, data, { allowPlaintextSecrets = false } = {}) {
  assertNoPlaintextSecrets({ parsed: data || {}, filePath, allowPlaintextSecrets });
  const normalized = getPersistedConfigSchema({ allowPlaintextSecrets }).parse(data || {});
  await fsp.mkdir(path.dirname(filePath), { recursive: true });
  await fsp.writeFile(filePath, stringify(normalized), "utf-8");
}

export async function ensureConfigFile(filePath, { allowPlaintextSecrets = false } = {}) {
  try {
    await fsp.access(filePath);
  } catch (error) {
    if (error && error.code === "ENOENT") {
      await writeConfigFile(filePath, {}, { allowPlaintextSecrets });
      return;
    }
    throw error;
  }
}
