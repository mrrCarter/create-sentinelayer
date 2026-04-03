import crypto from "node:crypto";
import os from "node:os";
import path from "node:path";
import fsp from "node:fs/promises";
import process from "node:process";

const CREDENTIALS_VERSION = 1;
const KEYRING_SERVICE = "sentinelayer-cli";
const FILE_TOKEN_KEY_BYTES = 32;
const FILE_TOKEN_IV_BYTES = 12;

export class StoredSessionError extends Error {
  constructor(message, { code = "STORED_SESSION_ERROR", filePath = null } = {}) {
    super(String(message || "Stored session error"));
    this.name = "StoredSessionError";
    this.code = String(code || "STORED_SESSION_ERROR");
    this.filePath = filePath ? String(filePath) : null;
  }
}

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

function resolveCredentialsKeyPath({ homeDir } = {}) {
  const resolvedHome = resolveHomeDir(homeDir);
  return path.join(resolvedHome, ".sentinelayer-secrets", "credentials.key");
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
    storageDowngraded: Boolean(raw.storageDowngraded || raw.storage_downgraded),
    createdAt: String(raw.createdAt || "").trim() || nowIso(),
    updatedAt: String(raw.updatedAt || "").trim() || nowIso(),
    user: normalizeUser(raw.user),
    token: String(raw.token || "").trim() || null,
    tokenCiphertext: String(raw.tokenCiphertext || "").trim() || null,
    tokenIv: String(raw.tokenIv || "").trim() || null,
    tokenTag: String(raw.tokenTag || "").trim() || null,
  };
}

function isKeyringDisabledByEnv() {
  const disableKeyring = String(process.env.SENTINELAYER_DISABLE_KEYRING || "")
    .trim()
    .toLowerCase();
  return disableKeyring === "1" || disableKeyring === "true" || disableKeyring === "yes" || disableKeyring === "on";
}

async function loadKeytarClient() {
  if (isKeyringDisabledByEnv()) {
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

async function syncDirectoryBestEffort(dirPath) {
  let directoryHandle = null;
  try {
    directoryHandle = await fsp.open(dirPath, "r");
    await directoryHandle.sync();
  } catch (error) {
    const code = String(error?.code || "");
    if (!["EINVAL", "EPERM", "ENOTSUP", "EISDIR", "ENOENT"].includes(code)) {
      throw error;
    }
  } finally {
    if (directoryHandle) {
      await directoryHandle.close();
    }
  }
}

async function writeMetadata(filePath, metadata) {
  const directoryPath = path.dirname(filePath);
  await fsp.mkdir(directoryPath, { recursive: true });
  const serialized = `${JSON.stringify(metadata, null, 2)}\n`;
  const tempPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  const tempHandle = await fsp.open(tempPath, "w", 0o600);
  try {
    await tempHandle.writeFile(serialized, { encoding: "utf-8" });
    await tempHandle.sync();
  } finally {
    await tempHandle.close();
  }
  try {
    await fsp.chmod(tempPath, 0o600);
  } catch {
    // Windows does not reliably support POSIX chmod semantics.
  }
  let renamed = false;
  try {
    await fsp.rename(tempPath, filePath);
    renamed = true;
  } finally {
    if (!renamed) {
      await fsp.rm(tempPath, { force: true });
    }
  }
  await syncDirectoryBestEffort(directoryPath);
  try {
    await fsp.chmod(filePath, 0o600);
  } catch {
    // Windows does not reliably support POSIX chmod semantics.
  }
}

async function persistEncryptedFileTokenMetadata({
  filePath,
  metadata,
  token,
  homeDir,
} = {}) {
  const keyMaterial = await loadFileTokenKey({ homeDir, createIfMissing: true });
  const encrypted = encryptFileToken(token, keyMaterial);
  const updatedMetadata = normalizeMetadata({
    ...metadata,
    storage: "file",
    token: null,
    tokenCiphertext: encrypted.tokenCiphertext,
    tokenIv: encrypted.tokenIv,
    tokenTag: encrypted.tokenTag,
    updatedAt: nowIso(),
  });
  await writeMetadata(filePath, updatedMetadata);
  return updatedMetadata;
}

async function writeSecretFile(filePath, contents) {
  const directoryPath = path.dirname(filePath);
  await fsp.mkdir(directoryPath, { recursive: true });
  const tempPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  const tempHandle = await fsp.open(tempPath, "w", 0o600);
  try {
    await tempHandle.writeFile(String(contents || ""), {
      encoding: "utf-8",
    });
    await tempHandle.sync();
  } finally {
    await tempHandle.close();
  }
  try {
    await fsp.chmod(tempPath, 0o600);
  } catch {
    // Windows does not reliably support POSIX chmod semantics.
  }
  let renamed = false;
  try {
    await fsp.rename(tempPath, filePath);
    renamed = true;
  } finally {
    if (!renamed) {
      await fsp.rm(tempPath, { force: true });
    }
  }
  await syncDirectoryBestEffort(directoryPath);
  try {
    await fsp.chmod(filePath, 0o600);
  } catch {
    // Windows does not reliably support POSIX chmod semantics.
  }
}

async function loadFileTokenKey({ homeDir, createIfMissing = false } = {}) {
  const keyPath = resolveCredentialsKeyPath({ homeDir });
  try {
    const raw = await fsp.readFile(keyPath, "utf-8");
    const material = Buffer.from(String(raw || "").trim(), "base64");
    if (material.length !== FILE_TOKEN_KEY_BYTES) {
      throw new StoredSessionError(
        "Stored file-token encryption key is invalid. Re-authenticate with `sl auth login`.",
        { code: "FILE_TOKEN_KEY_INVALID", filePath: keyPath }
      );
    }
    return material;
  } catch (error) {
    if (error && typeof error === "object" && error.code === "ENOENT" && createIfMissing) {
      const generated = crypto.randomBytes(FILE_TOKEN_KEY_BYTES);
      await writeSecretFile(keyPath, `${generated.toString("base64")}\n`);
      return generated;
    }
    if (error && typeof error === "object" && error.code === "ENOENT") {
      throw new StoredSessionError(
        "Stored file-token encryption key is missing. Re-authenticate with `sl auth login`.",
        { code: "FILE_TOKEN_KEY_MISSING", filePath: keyPath }
      );
    }
    throw error;
  }
}

function encryptFileToken(token, keyMaterial) {
  const iv = crypto.randomBytes(FILE_TOKEN_IV_BYTES);
  const cipher = crypto.createCipheriv("aes-256-gcm", keyMaterial, iv);
  const ciphertext = Buffer.concat([cipher.update(String(token || ""), "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return {
    tokenCiphertext: ciphertext.toString("base64"),
    tokenIv: iv.toString("base64"),
    tokenTag: tag.toString("base64"),
  };
}

function decryptFileToken({ tokenCiphertext, tokenIv, tokenTag }, keyMaterial) {
  try {
    const decipher = crypto.createDecipheriv(
      "aes-256-gcm",
      keyMaterial,
      Buffer.from(String(tokenIv || ""), "base64")
    );
    decipher.setAuthTag(Buffer.from(String(tokenTag || ""), "base64"));
    const plaintext = Buffer.concat([
      decipher.update(Buffer.from(String(tokenCiphertext || ""), "base64")),
      decipher.final(),
    ]);
    return plaintext.toString("utf8");
  } catch {
    throw new StoredSessionError(
      "Stored file-backed session token could not be decrypted. Re-authenticate with `sl auth login`.",
      { code: "FILE_TOKEN_DECRYPT_FAILED" }
    );
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
    if (!metadata.keyringAccount) {
      throw new StoredSessionError(
        "Stored keyring session metadata is missing keyringAccount. Re-authenticate with `sl auth login`.",
        { code: "KEYRING_ACCOUNT_MISSING", filePath }
      );
    }
    const keytar = await loadKeytarClient();
    if (!keytar) {
      throw new StoredSessionError(
        "Stored session requires keyring access, but keyring is unavailable. Re-authenticate with `sl auth login --no-keyring` or enable keyring support.",
        { code: "KEYRING_UNAVAILABLE", filePath }
      );
    }
    const token = await keytar.getPassword(
      metadata.keyringService || KEYRING_SERVICE,
      metadata.keyringAccount
    );
    if (!token) {
      throw new StoredSessionError(
        "Stored keyring session token is missing. Re-authenticate with `sl auth login`.",
        { code: "KEYRING_TOKEN_MISSING", filePath }
      );
    }
    return {
      ...metadata,
      filePath,
      token,
      storage: "keyring",
    };
  }

  let token = null;
  if (metadata.tokenCiphertext && metadata.tokenIv && metadata.tokenTag) {
    const keyMaterial = await loadFileTokenKey({ homeDir, createIfMissing: false });
    token = decryptFileToken(
      {
        tokenCiphertext: metadata.tokenCiphertext,
        tokenIv: metadata.tokenIv,
        tokenTag: metadata.tokenTag,
      },
      keyMaterial
    );
  } else if (metadata.token) {
    token = metadata.token;
    await persistEncryptedFileTokenMetadata({
      filePath,
      metadata,
      token,
      homeDir,
    });
  } else {
    throw new StoredSessionError(
      "Stored file-backed session token is missing. Re-authenticate with `sl auth login`.",
      { code: "FILE_TOKEN_MISSING", filePath }
    );
  }
  return {
    ...metadata,
    filePath,
    token,
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
  { homeDir, allowFileStorageFallback = false } = {}
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
  const keyringDisabledByEnv = isKeyringDisabledByEnv();
  const keytar = await loadKeytarClient();
  const keyringAccount = buildKeyringAccountName(normalizedApiUrl);
  const updatedAt = nowIso();

  if (!keytar && keyringDisabledByEnv && !allowFileStorageFallback) {
    throw new StoredSessionError(
      "Keyring is disabled by SENTINELAYER_DISABLE_KEYRING. Re-run `sl auth login --no-keyring` to explicitly allow file-backed credential storage.",
      { code: "KEYRING_FALLBACK_REQUIRES_CONSENT", filePath }
    );
  }

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
    nextMetadata.tokenCiphertext = null;
    nextMetadata.tokenIv = null;
    nextMetadata.tokenTag = null;
    nextMetadata.storageDowngraded = false;
  } else {
    const keyMaterial = await loadFileTokenKey({ homeDir, createIfMissing: true });
    const encrypted = encryptFileToken(normalizedToken, keyMaterial);
    nextMetadata.storage = "file";
    nextMetadata.keyringService = KEYRING_SERVICE;
    nextMetadata.keyringAccount = "";
    nextMetadata.token = null;
    nextMetadata.tokenCiphertext = encrypted.tokenCiphertext;
    nextMetadata.tokenIv = encrypted.tokenIv;
    nextMetadata.tokenTag = encrypted.tokenTag;
    nextMetadata.storageDowngraded = Boolean(keyringDisabledByEnv);
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
 * @returns {Promise<{ filePath: string, hadSession: boolean, clearedMetadata: boolean }>}
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
    await fsp.rm(filePath);
  } catch (error) {
    if (!error || typeof error !== "object" || error.code !== "ENOENT") {
      throw error;
    }
  }

  let clearedMetadata = true;
  try {
    await fsp.access(filePath);
    clearedMetadata = false;
  } catch (error) {
    if (!error || typeof error !== "object" || error.code !== "ENOENT") {
      throw error;
    }
  }

  return {
    filePath,
    hadSession: Boolean(metadata),
    clearedMetadata,
  };
}
