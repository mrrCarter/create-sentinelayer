import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import fsp from "node:fs/promises";
import process from "node:process";

const CREDENTIALS_VERSION = 1;
const KEYRING_SERVICE = "sentinelayer-cli";
const FILE_TOKEN_ENCRYPTION_VERSION = 2;
const LEGACY_FILE_TOKEN_ENCRYPTION_VERSION = 1;
const MACHINE_BINDING_KEY_FILENAME = "machine-binding.key";

function nowIso() {
  return new Date().toISOString();
}

function resolveHomeDir(homeDir) {
  return path.resolve(String(homeDir || os.homedir()));
}

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
    tokenEncVersion: Number(raw.tokenEncVersion || 0) || null,
    tokenKeyId: String(raw.tokenKeyId || "").trim() || null,
    tokenCiphertext: String(raw.tokenCiphertext || "").trim() || null,
    tokenIv: String(raw.tokenIv || "").trim() || null,
    tokenTag: String(raw.tokenTag || "").trim() || null,
    tokenSalt: String(raw.tokenSalt || "").trim() || null,
    token: null,
  };
}

function isTruthy(value) {
  const normalized = String(value || "").trim().toLowerCase();
  return normalized === "1" || normalized === "true" || normalized === "yes" || normalized === "on";
}

function fileTokenStorageAllowed() {
  return isTruthy(process.env.SENTINELAYER_ALLOW_FILE_TOKEN_STORAGE);
}

function resolveMachineBindingKeyPath({ homeDir } = {}) {
  const resolvedHome = resolveHomeDir(homeDir);
  return path.join(resolvedHome, ".sentinelayer", MACHINE_BINDING_KEY_FILENAME);
}

function resolveMachineBindingKey({ homeDir } = {}) {
  const keyPath = resolveMachineBindingKeyPath({ homeDir });
  try {
    const existing = fs.readFileSync(keyPath, "utf-8").trim();
    if (existing) {
      return existing;
    }
  } catch {
    // Create a deterministic machine-bound secret when absent.
  }

  const generated = crypto.randomBytes(32).toString("base64url");
  fs.mkdirSync(path.dirname(keyPath), { recursive: true });
  fs.writeFileSync(keyPath, `${generated}\n`, { encoding: "utf-8", mode: 0o600 });
  try {
    fs.chmodSync(keyPath, 0o600);
  } catch {
    // Windows does not reliably support POSIX chmod semantics.
  }
  return generated;
}

function resolveLegacyEncryptionPassphrase() {
  const explicit = String(process.env.SENTINELAYER_FILE_TOKEN_ENCRYPTION_KEY || "").trim();
  if (!explicit) {
    throw new Error(
      "Missing SENTINELAYER_FILE_TOKEN_ENCRYPTION_KEY for encrypted file token storage. Configure a high-entropy key or enable OS keyring."
    );
  }

  if (explicit.length < 24) {
    throw new Error(
      "SENTINELAYER_FILE_TOKEN_ENCRYPTION_KEY must be at least 24 characters."
    );
  }
  return explicit;
}

function resolveEncryptionMaterial({ apiUrl, homeDir, keyId = null }) {
  const explicit = resolveLegacyEncryptionPassphrase();
  const runningInCi = isTruthy(process.env.CI);
  const allowCiStorage =
    process.env.NODE_ENV === "test" || isTruthy(process.env.SENTINELAYER_ALLOW_CI_FILE_TOKEN_STORAGE);
  if (runningInCi && !allowCiStorage) {
    throw new Error(
      "Refusing encrypted file-token storage in CI without SENTINELAYER_ALLOW_CI_FILE_TOKEN_STORAGE=true."
    );
  }

  const normalizedApiUrl = String(apiUrl || "").trim().toLowerCase();
  const machineBindingKey = resolveMachineBindingKey({ homeDir });
  const derivedKeyId = crypto
    .createHash("sha256")
    .update(`${normalizedApiUrl}:${machineBindingKey}`)
    .digest("hex")
    .slice(0, 16);

  if (keyId && keyId !== derivedKeyId) {
    throw new Error("Stored token key id does not match this machine binding context.");
  }

  return {
    passphrase: `${explicit}:${machineBindingKey}:${normalizedApiUrl}`,
    keyId: derivedKeyId,
  };
}

function encryptFileToken({ token, apiUrl, homeDir }) {
  const salt = crypto.randomBytes(16);
  const iv = crypto.randomBytes(12);
  const material = resolveEncryptionMaterial({ apiUrl, homeDir });
  const passphrase = material.passphrase;
  const key = crypto.scryptSync(passphrase, salt, 32);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const encrypted = Buffer.concat([cipher.update(String(token || ""), "utf-8"), cipher.final()]);
  const tag = cipher.getAuthTag();

  return {
    tokenEncVersion: FILE_TOKEN_ENCRYPTION_VERSION,
    tokenKeyId: material.keyId,
    tokenCiphertext: encrypted.toString("base64"),
    tokenIv: iv.toString("base64"),
    tokenTag: tag.toString("base64"),
    tokenSalt: salt.toString("base64"),
  };
}

function decryptFileToken(metadata, { homeDir } = {}) {
  const encVersion = Number(metadata?.tokenEncVersion || 0);

  const ciphertext = String(metadata?.tokenCiphertext || "").trim();
  const iv = String(metadata?.tokenIv || "").trim();
  const tag = String(metadata?.tokenTag || "").trim();
  const salt = String(metadata?.tokenSalt || "").trim();
  const apiUrl = String(metadata?.apiUrl || "").trim();
  const tokenKeyId = String(metadata?.tokenKeyId || "").trim();

  if (!ciphertext || !iv || !tag || !salt || !apiUrl) {
    return null;
  }

  if (encVersion === FILE_TOKEN_ENCRYPTION_VERSION) {
    if (!tokenKeyId) {
      return null;
    }
    try {
      const material = resolveEncryptionMaterial({ apiUrl, homeDir, keyId: tokenKeyId });
      const key = crypto.scryptSync(material.passphrase, Buffer.from(salt, "base64"), 32);
      const decipher = crypto.createDecipheriv("aes-256-gcm", key, Buffer.from(iv, "base64"));
      decipher.setAuthTag(Buffer.from(tag, "base64"));
      const decrypted = Buffer.concat([
        decipher.update(Buffer.from(ciphertext, "base64")),
        decipher.final(),
      ]);
      return decrypted.toString("utf-8");
    } catch {
      return null;
    }
  }

  if (encVersion === LEGACY_FILE_TOKEN_ENCRYPTION_VERSION) {
    try {
      const key = crypto.scryptSync(resolveLegacyEncryptionPassphrase(), Buffer.from(salt, "base64"), 32);
      const decipher = crypto.createDecipheriv("aes-256-gcm", key, Buffer.from(iv, "base64"));
      decipher.setAuthTag(Buffer.from(tag, "base64"));
      const decrypted = Buffer.concat([
        decipher.update(Buffer.from(ciphertext, "base64")),
        decipher.final(),
      ]);
      return decrypted.toString("utf-8");
    } catch {
      return null;
    }
  }

  return null;
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

  const decryptedToken = decryptFileToken(metadata, { homeDir });
  if (!decryptedToken) {
    return null;
  }
  return {
    ...metadata,
    filePath,
    token: decryptedToken,
    storage: "file",
  };
}

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
    nextMetadata.tokenEncVersion = null;
    nextMetadata.tokenKeyId = null;
    nextMetadata.tokenCiphertext = null;
    nextMetadata.tokenIv = null;
    nextMetadata.tokenTag = null;
    nextMetadata.tokenSalt = null;
    nextMetadata.token = null;
  } else {
    if (!fileTokenStorageAllowed()) {
      throw new Error(
        "OS keyring is unavailable. Set SENTINELAYER_ALLOW_FILE_TOKEN_STORAGE=true only for explicit local fallback."
      );
    }
    const encryptedToken = encryptFileToken({
      token: normalizedToken,
      apiUrl: normalizedApiUrl,
      homeDir,
    });
    nextMetadata.storage = "file";
    nextMetadata.keyringService = KEYRING_SERVICE;
    nextMetadata.keyringAccount = "";
    nextMetadata.tokenEncVersion = encryptedToken.tokenEncVersion;
    nextMetadata.tokenKeyId = encryptedToken.tokenKeyId;
    nextMetadata.tokenCiphertext = encryptedToken.tokenCiphertext;
    nextMetadata.tokenIv = encryptedToken.tokenIv;
    nextMetadata.tokenTag = encryptedToken.tokenTag;
    nextMetadata.tokenSalt = encryptedToken.tokenSalt;
    nextMetadata.token = null;
  }

  await writeMetadata(filePath, nextMetadata);

  return {
    ...nextMetadata,
    filePath,
    token: normalizedToken,
  };
}

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
