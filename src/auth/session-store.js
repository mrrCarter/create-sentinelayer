import crypto from "node:crypto";
import os from "node:os";
import path from "node:path";
import fsp from "node:fs/promises";
import process from "node:process";

const CREDENTIALS_VERSION = 1;
const KEYRING_SERVICE = "sentinelayer-cli";
const SESSION_WARNING_PREFIX = "sentinelayer.auth.session";
const SESSION_WARNING_REDACT_KEYS = /token|secret|password|key|authorization/i;
const SESSION_WARNING_MAX_VALUE_LENGTH = 200;

function nowIso() {
  return new Date().toISOString();
}

function createSessionWarningId() {
  try {
    return crypto.randomUUID();
  } catch {
    return `session-${Date.now().toString(36)}-${crypto.randomBytes(8).toString("hex")}`;
  }
}

function sanitizeSessionWarningValue(value, depth = 0) {
  if (value === null || value === undefined) {
    return value;
  }
  if (depth > 3) {
    return "[TRUNCATED]";
  }
  if (Array.isArray(value)) {
    return value.map((entry) => sanitizeSessionWarningValue(entry, depth + 1));
  }
  if (typeof value === "object") {
    const sanitized = {};
    for (const [key, entry] of Object.entries(value)) {
      if (SESSION_WARNING_REDACT_KEYS.test(key)) {
        sanitized[key] = "[REDACTED]";
        continue;
      }
      sanitized[key] = sanitizeSessionWarningValue(entry, depth + 1);
    }
    return sanitized;
  }
  if (typeof value === "string") {
    if (value.length > SESSION_WARNING_MAX_VALUE_LENGTH) {
      return `${value.slice(0, SESSION_WARNING_MAX_VALUE_LENGTH)}…`;
    }
    return value;
  }
  return value;
}

function sanitizeSessionWarningDetails(details) {
  if (!details || typeof details !== "object") {
    return {};
  }
  return sanitizeSessionWarningValue(details, 0);
}

function emitSessionWarning(code, details = {}) {
  const payload = {
    level: "warn",
    code: String(code || "SESSION_WARNING").toUpperCase(),
    warningId: createSessionWarningId(),
    timestamp: nowIso(),
    ...sanitizeSessionWarningDetails(details),
  };
  try {
    console.warn(`${SESSION_WARNING_PREFIX} ${JSON.stringify(payload)}`);
  } catch {
    console.warn(`${SESSION_WARNING_PREFIX} ${payload.code}`);
  }
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
  return path.join(resolvedHome, ".sentinelayer", "keys", "credentials.key");
}

function resolveLegacyCredentialsKeyPath({ homeDir } = {}) {
  const resolvedHome = resolveHomeDir(homeDir);
  return path.join(resolvedHome, ".sentinelayer", "credentials.key");
}

async function loadOrCreateFileKey({ homeDir } = {}) {
  const keyPath = resolveCredentialsKeyPath({ homeDir });
  const legacyKeyPath = resolveLegacyCredentialsKeyPath({ homeDir });
  try {
    const raw = await fsp.readFile(keyPath, "utf-8");
    const key = Buffer.from(String(raw || "").trim(), "base64");
    if (key.length === 32) {
      return key;
    }
  } catch (error) {
    if (!(error && typeof error === "object" && error.code === "ENOENT")) {
      throw error;
    }
  }

  try {
    const legacyRaw = await fsp.readFile(legacyKeyPath, "utf-8");
    const legacyKey = Buffer.from(String(legacyRaw || "").trim(), "base64");
    if (legacyKey.length === 32) {
      await fsp.mkdir(path.dirname(keyPath), { recursive: true, mode: 0o700 });
      await fsp.writeFile(keyPath, legacyKey.toString("base64"), { encoding: "utf-8", mode: 0o600 });
      try {
        await fsp.chmod(keyPath, 0o600);
      } catch {
        // Windows does not reliably support POSIX chmod semantics.
      }
      let verified = false;
      try {
        const verifyRaw = await fsp.readFile(keyPath, "utf-8");
        const verifyKey = Buffer.from(String(verifyRaw || "").trim(), "base64");
        verified = verifyKey.length === 32 && verifyKey.equals(legacyKey);
      } catch {
        verified = false;
      }
      if (verified) {
        await fsp.rm(legacyKeyPath, { force: true });
      }
      return legacyKey;
    }
  } catch (error) {
    if (!(error && typeof error === "object" && error.code === "ENOENT")) {
      throw error;
    }
  }

  const key = crypto.randomBytes(32);
  await fsp.mkdir(path.dirname(keyPath), { recursive: true, mode: 0o700 });
  await fsp.writeFile(keyPath, key.toString("base64"), { encoding: "utf-8", mode: 0o600 });
  try {
    await fsp.chmod(keyPath, 0o600);
  } catch {
    // Windows does not reliably support POSIX chmod semantics.
  }
  return key;
}

function encryptToken(token, key) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([cipher.update(token, "utf-8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return {
    tokenEncrypted: ciphertext.toString("base64"),
    tokenIv: iv.toString("base64"),
    tokenTag: tag.toString("base64"),
  };
}

function decryptToken({ tokenEncrypted, tokenIv, tokenTag }, key) {
  const iv = Buffer.from(tokenIv, "base64");
  const tag = Buffer.from(tokenTag, "base64");
  const decipher = crypto.createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);
  const plaintext = Buffer.concat([
    decipher.update(Buffer.from(tokenEncrypted, "base64")),
    decipher.final(),
  ]);
  return plaintext.toString("utf-8");
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

function normalizeAidenId(raw) {
  if (!raw || typeof raw !== "object") return null;
  const orgId = String(raw.orgId || "").trim();
  const projectId = String(raw.projectId || "").trim();
  if (!orgId && !projectId) return null;
  return {
    orgId: orgId || null,
    projectId: projectId || null,
    apiKeyPrefix: String(raw.apiKeyPrefix || "").trim() || null,
    provisionedAt: String(raw.provisionedAt || "").trim() || null,
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
    tokenEncrypted: String(raw.tokenEncrypted || "").trim() || null,
    tokenIv: String(raw.tokenIv || "").trim() || null,
    tokenTag: String(raw.tokenTag || "").trim() || null,
    aidenid: normalizeAidenId(raw.aidenid),
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
  const directory = path.dirname(filePath);
  const tmpPath = path.join(
    directory,
    `.credentials.${process.pid}.${Date.now()}.${crypto.randomBytes(6).toString("hex")}.tmp`
  );
  const payload = `${JSON.stringify(metadata, null, 2)}\n`;
  try {
    await fsp.writeFile(tmpPath, payload, { encoding: "utf-8", mode: 0o600 });
    try {
      await fsp.chmod(tmpPath, 0o600);
    } catch {
      // Windows does not reliably support POSIX chmod semantics.
    }
    try {
      await fsp.rename(tmpPath, filePath);
    } catch (error) {
      if (error && typeof error === "object" && error.code === "EEXIST") {
        await fsp.rm(filePath, { force: true });
        await fsp.rename(tmpPath, filePath);
      } else if (error && typeof error === "object" && error.code === "EPERM") {
        await fsp.rm(filePath, { force: true });
        await fsp.rename(tmpPath, filePath);
      } else {
        throw error;
      }
    }
  } finally {
    await fsp.rm(tmpPath, { force: true }).catch(() => {});
  }
}

async function migratePlaintextTokenIfNeeded({ metadata, filePath, homeDir } = {}) {
  if (!metadata || !metadata.token) {
    return { metadata, token: null, migrated: false };
  }

  const plaintextToken = String(metadata.token || "").trim();
  if (!plaintextToken) {
    return { metadata: { ...metadata, token: null }, token: null, migrated: false };
  }

  const updatedAt = nowIso();
  const nextMetadata = normalizeMetadata({
    ...metadata,
    token: null,
    updatedAt,
  });

  const keytar = await loadKeytarClient();
  if (keytar) {
    const keyringAccount = metadata.keyringAccount || buildKeyringAccountName(metadata.apiUrl);
    await keytar.setPassword(KEYRING_SERVICE, keyringAccount, plaintextToken);
    nextMetadata.storage = "keyring";
    nextMetadata.keyringService = KEYRING_SERVICE;
    nextMetadata.keyringAccount = keyringAccount;
    const key = await loadOrCreateFileKey({ homeDir });
    const encrypted = encryptToken(plaintextToken, key);
    nextMetadata.tokenEncrypted = encrypted.tokenEncrypted;
    nextMetadata.tokenIv = encrypted.tokenIv;
    nextMetadata.tokenTag = encrypted.tokenTag;
  } else {
    const key = await loadOrCreateFileKey({ homeDir });
    const encrypted = encryptToken(plaintextToken, key);
    nextMetadata.storage = "file";
    nextMetadata.keyringService = KEYRING_SERVICE;
    nextMetadata.keyringAccount = "";
    nextMetadata.tokenEncrypted = encrypted.tokenEncrypted;
    nextMetadata.tokenIv = encrypted.tokenIv;
    nextMetadata.tokenTag = encrypted.tokenTag;
  }

  await writeMetadata(filePath, nextMetadata);
  const { metadata: verify } = await readMetadata({ homeDir });
  if (verify && verify.token) {
    throw new Error("Plaintext token migration failed: token field persisted.");
  }

  return { metadata: nextMetadata, token: plaintextToken, migrated: true };
}

async function tryDecryptFileToken({ metadata, homeDir }) {
  if (!metadata || !metadata.tokenEncrypted || !metadata.tokenIv || !metadata.tokenTag) {
    return null;
  }
  try {
    const key = await loadOrCreateFileKey({ homeDir });
    const token = decryptToken(
      {
        tokenEncrypted: metadata.tokenEncrypted,
        tokenIv: metadata.tokenIv,
        tokenTag: metadata.tokenTag,
      },
      key
    );
    return token || null;
  } catch {
    return null;
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

  if (metadata.token) {
    const migrated = await migratePlaintextTokenIfNeeded({ metadata, filePath, homeDir });
    if (migrated.migrated) {
      return {
        ...migrated.metadata,
        filePath,
        token: migrated.token,
        storage: migrated.metadata.storage || "file",
      };
    }
  }

  if (metadata.storage === "keyring") {
    const keytar = await loadKeytarClient();
    let keyringError = null;
    if (keytar && metadata.keyringAccount) {
      try {
        const token = await keytar.getPassword(
          metadata.keyringService || KEYRING_SERVICE,
          metadata.keyringAccount
        );
        if (token) {
          return {
            ...metadata,
            filePath,
            token,
            storage: "keyring",
          };
        }
        keyringError = new Error("Keyring token not found");
      } catch (error) {
        keyringError = error instanceof Error ? error : new Error("Keyring access failed");
      }
    } else {
      keyringError = new Error("Keyring unavailable");
    }
    const fallbackToken = await tryDecryptFileToken({ metadata, homeDir });
    if (fallbackToken) {
      emitSessionWarning("KEYRING_FALLBACK_USED", {
        reason: keyringError ? String(keyringError.message || keyringError) : "unknown",
        source: "file-encrypted",
      });
      return {
        ...metadata,
        filePath,
        token: fallbackToken,
        storage: "file",
      };
    }
    emitSessionWarning("KEYRING_FALLBACK_UNAVAILABLE", {
      reason: keyringError ? String(keyringError.message || keyringError) : "unknown",
      source: "keyring",
    });
    return null;
  }

  if (!metadata.token) {
    if (metadata.tokenEncrypted && metadata.tokenIv && metadata.tokenTag) {
      const token = await tryDecryptFileToken({ metadata, homeDir });
      if (!token) {
        return null;
      }
      return {
        ...metadata,
        filePath,
        token,
        storage: "file",
      };
    }
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
  if (metadata.token) {
    const migrated = await migratePlaintextTokenIfNeeded({ metadata, filePath, homeDir });
    return {
      ...migrated.metadata,
      filePath,
      token: null,
    };
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
    const key = await loadOrCreateFileKey({ homeDir });
    const encrypted = encryptToken(normalizedToken, key);
    nextMetadata.token = null;
    nextMetadata.tokenEncrypted = encrypted.tokenEncrypted;
    nextMetadata.tokenIv = encrypted.tokenIv;
    nextMetadata.tokenTag = encrypted.tokenTag;
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
