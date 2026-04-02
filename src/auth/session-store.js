import crypto from "node:crypto";
import os from "node:os";
import path from "node:path";
import fsp from "node:fs/promises";
import process from "node:process";

const CREDENTIALS_VERSION = 1;
const KEYRING_SERVICE = "sentinelayer-cli";

function nowIso() {
  return new Date().toISOString();
}

function resolveHomeDir(homeDir) {
  return path.resolve(String(homeDir || os.homedir()));
}

/**
 * Resolve the deterministic credentials metadata file path for the current user/home override.
 *
 * @param {{ homeDir?: string }} [options]
 * @returns {string}
 */
export function resolveCredentialsFilePath({ homeDir } = {}) {
  const resolvedHome = resolveHomeDir(homeDir);
  return path.join(resolvedHome, ".sentinelayer", "credentials.json");
}

function buildKeyringAccountName(apiUrl) {
  const digest = crypto
    .createHash("sha256")
    .update(String(apiUrl || "").trim().toLowerCase())
    .digest("hex")
    .slice(0, 16);
  return `default-${digest}`;
}

function normalizeUser(user = {}) {
  return {
    id: String(user.id || "").trim(),
    githubUsername: String(user.githubUsername || user.github_username || "").trim(),
    email: String(user.email || "").trim(),
    avatarUrl: String(user.avatarUrl || user.avatar_url || "").trim(),
    isAdmin: Boolean(user.isAdmin || user.is_admin),
  };
}

function normalizeMetadata(raw = {}) {
  return {
    version: Number(raw.version || CREDENTIALS_VERSION),
    apiUrl: String(raw.apiUrl || "").trim(),
    storage: String(raw.storage || "file").trim(),
    keyringService: String(raw.keyringService || KEYRING_SERVICE).trim(),
    keyringAccount: String(raw.keyringAccount || "").trim(),
    tokenId: String(raw.tokenId || "").trim() || null,
    tokenPrefix: String(raw.tokenPrefix || "").trim() || null,
    tokenExpiresAt: String(raw.tokenExpiresAt || "").trim() || null,
    createdAt: String(raw.createdAt || "").trim() || nowIso(),
    updatedAt: String(raw.updatedAt || "").trim() || nowIso(),
    user: normalizeUser(raw.user),
    token: String(raw.token || "").trim() || null,
  };
}

async function loadKeytarClient() {
  const disableKeyring = String(process.env.SENTINELAYER_DISABLE_KEYRING || "")
    .trim()
    .toLowerCase();
  if (disableKeyring === "1" || disableKeyring === "true" || disableKeyring === "yes" || disableKeyring === "on") {
    return null;
  }
  try {
    const mod = await import("keytar");
    const client = mod && typeof mod === "object" ? mod.default || mod : null;
    if (!client) {
      return null;
    }
    if (
      typeof client.getPassword !== "function" ||
      typeof client.setPassword !== "function" ||
      typeof client.deletePassword !== "function"
    ) {
      return null;
    }
    return client;
  } catch {
    return null;
  }
}

async function readMetadata({ homeDir } = {}) {
  const filePath = resolveCredentialsFilePath({ homeDir });
  try {
    const raw = await fsp.readFile(filePath, "utf-8");
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return { filePath, metadata: null };
    }
    return { filePath, metadata: normalizeMetadata(parsed) };
  } catch (error) {
    if (error && typeof error === "object" && error.code === "ENOENT") {
      return { filePath, metadata: null };
    }
    throw error;
  }
}

async function writeMetadata(filePath, metadata) {
  await fsp.mkdir(path.dirname(filePath), { recursive: true });
  await fsp.writeFile(filePath, `${JSON.stringify(metadata, null, 2)}\n`, {
    encoding: "utf-8",
    mode: 0o600,
  });
  try {
    await fsp.chmod(filePath, 0o600);
  } catch {
    // Windows does not reliably support POSIX chmod semantics.
  }
}

/**
 * Load the active stored session, resolving keyring-backed tokens when configured.
 *
 * @param {{ homeDir?: string }} [options]
 * @returns {Promise<null | {
 *   version: number,
 *   apiUrl: string,
 *   storage: "file" | "keyring",
 *   keyringService: string,
 *   keyringAccount: string,
 *   tokenId: string | null,
 *   tokenPrefix: string | null,
 *   tokenExpiresAt: string | null,
 *   createdAt: string,
 *   updatedAt: string,
 *   user: {
 *     id: string,
 *     githubUsername: string,
 *     email: string,
 *     avatarUrl: string,
 *     isAdmin: boolean
 *   },
 *   token: string,
 *   filePath: string
 * }>}
 */
export async function readStoredSession({ homeDir } = {}) {
  const { filePath, metadata } = await readMetadata({ homeDir });
  if (!metadata) {
    return null;
  }

  if (metadata.storage === "keyring") {
    const keytar = await loadKeytarClient();
    if (!keytar || !metadata.keyringAccount) {
      return null;
    }
    const token = await keytar.getPassword(
      metadata.keyringService || KEYRING_SERVICE,
      metadata.keyringAccount
    );
    if (!token) {
      return null;
    }
    return {
      ...metadata,
      filePath,
      token,
      storage: "keyring",
    };
  }

  if (!metadata.token) {
    return null;
  }
  return {
    ...metadata,
    filePath,
    token: metadata.token,
    storage: "file",
  };
}

/**
 * Read persisted session metadata without returning secret token material.
 *
 * @param {{ homeDir?: string }} [options]
 * @returns {Promise<null | {
 *   version: number,
 *   apiUrl: string,
 *   storage: string,
 *   keyringService: string,
 *   keyringAccount: string,
 *   tokenId: string | null,
 *   tokenPrefix: string | null,
 *   tokenExpiresAt: string | null,
 *   createdAt: string,
 *   updatedAt: string,
 *   user: {
 *     id: string,
 *     githubUsername: string,
 *     email: string,
 *     avatarUrl: string,
 *     isAdmin: boolean
 *   },
 *   filePath: string,
 *   token: null
 * }>}
 */
export async function readStoredSessionMetadata({ homeDir } = {}) {
  const { filePath, metadata } = await readMetadata({ homeDir });
  if (!metadata) {
    return null;
  }
  return {
    ...metadata,
    filePath,
    token: null,
  };
}

/**
 * Persist a new session token and metadata using keyring storage when available.
 *
 * @param {{
 *   apiUrl: string,
 *   token: string,
 *   tokenId?: string | null,
 *   tokenPrefix?: string | null,
 *   tokenExpiresAt?: string | null,
 *   user?: Record<string, unknown>
 * }} [session]
 * @param {{ homeDir?: string }} [options]
 * @returns {Promise<{
 *   version: number,
 *   apiUrl: string,
 *   storage: "file" | "keyring",
 *   keyringService: string,
 *   keyringAccount: string,
 *   tokenId: string | null,
 *   tokenPrefix: string | null,
 *   tokenExpiresAt: string | null,
 *   createdAt: string,
 *   updatedAt: string,
 *   user: {
 *     id: string,
 *     githubUsername: string,
 *     email: string,
 *     avatarUrl: string,
 *     isAdmin: boolean
 *   },
 *   filePath: string,
 *   token: string
 * }>}
 */
export async function writeStoredSession(
  {
    apiUrl,
    token,
    tokenId = null,
    tokenPrefix = null,
    tokenExpiresAt = null,
    user = {},
  } = {},
  { homeDir } = {}
) {
  const normalizedApiUrl = String(apiUrl || "").trim();
  const normalizedToken = String(token || "").trim();
  if (!normalizedApiUrl) {
    throw new Error("apiUrl is required to persist CLI auth session.");
  }
  if (!normalizedToken) {
    throw new Error("token is required to persist CLI auth session.");
  }

  const { filePath, metadata: existingMetadata } = await readMetadata({ homeDir });
  const keytar = await loadKeytarClient();
  const keyringAccount = buildKeyringAccountName(normalizedApiUrl);
  const updatedAt = nowIso();

  const nextMetadata = normalizeMetadata({
    version: CREDENTIALS_VERSION,
    apiUrl: normalizedApiUrl,
    tokenId,
    tokenPrefix,
    tokenExpiresAt,
    user: normalizeUser(user),
    createdAt: existingMetadata?.createdAt || updatedAt,
    updatedAt,
  });

  if (keytar) {
    const previousKeyringAccount = String(existingMetadata?.keyringAccount || "").trim();
    const previousStorage = String(existingMetadata?.storage || "").trim();
    if (previousStorage === "keyring" && previousKeyringAccount && previousKeyringAccount !== keyringAccount) {
      await keytar.deletePassword(KEYRING_SERVICE, previousKeyringAccount);
    }

    await keytar.setPassword(KEYRING_SERVICE, keyringAccount, normalizedToken);
    nextMetadata.storage = "keyring";
    nextMetadata.keyringService = KEYRING_SERVICE;
    nextMetadata.keyringAccount = keyringAccount;
    nextMetadata.token = null;
  } else {
    nextMetadata.storage = "file";
    nextMetadata.keyringService = KEYRING_SERVICE;
    nextMetadata.keyringAccount = "";
    nextMetadata.token = normalizedToken;
  }

  await writeMetadata(filePath, nextMetadata);

  return {
    ...nextMetadata,
    filePath,
    token: normalizedToken,
  };
}

/**
 * Remove local session metadata and keyring credentials for the active account.
 *
 * @param {{ homeDir?: string }} [options]
 * @returns {Promise<{ filePath: string, hadSession: boolean }>}
 */
export async function clearStoredSession({ homeDir } = {}) {
  const { filePath, metadata } = await readMetadata({ homeDir });
  if (metadata && metadata.storage === "keyring") {
    const keytar = await loadKeytarClient();
    if (keytar && metadata.keyringAccount) {
      await keytar.deletePassword(metadata.keyringService || KEYRING_SERVICE, metadata.keyringAccount);
    }
  }

  try {
    await fsp.rm(filePath, { force: true });
  } catch {
    // Ignore cleanup errors.
  }

  return {
    filePath,
    hadSession: Boolean(metadata),
  };
}
