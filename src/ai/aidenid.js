import process from "node:process";

export const DEFAULT_AIDENID_API_URL = "https://api.aidenid.com";

function normalizeApiUrl(rawValue) {
  const candidate = String(rawValue || "").trim() || DEFAULT_AIDENID_API_URL;
  let parsed;
  try {
    parsed = new URL(candidate);
  } catch {
    throw new Error(`Invalid AIdenID API URL '${candidate}'.`);
  }
  parsed.pathname = "/";
  parsed.search = "";
  parsed.hash = "";
  return parsed.toString().replace(/\/$/, "");
}

function normalizeCsvList(rawValue) {
  const input = String(rawValue || "").trim();
  if (!input) {
    return [];
  }
  const unique = new Set();
  for (const token of input.split(",")) {
    const normalized = token.trim();
    if (normalized) {
      unique.add(normalized);
    }
  }
  return [...unique];
}

function normalizeTtlHours(rawValue, fallbackValue = 24) {
  if (rawValue === undefined || rawValue === null || String(rawValue).trim() === "") {
    return fallbackValue;
  }
  const normalized = Number(rawValue);
  if (!Number.isFinite(normalized) || normalized <= 0 || normalized > 24 * 30) {
    throw new Error("ttlHours must be between 1 and 720.");
  }
  return Math.round(normalized);
}

function normalizeAliasTemplate(rawValue) {
  const normalized = String(rawValue || "").trim();
  return normalized || null;
}

function normalizeDomainPoolId(rawValue) {
  const normalized = String(rawValue || "").trim();
  return normalized || null;
}

function normalizeReceiveMode(rawValue) {
  const normalized = String(rawValue || "").trim();
  return normalized || "EDGE_ACCEPT";
}

function normalizeExtractionTypes(rawValue) {
  if (Array.isArray(rawValue)) {
    const unique = new Set();
    for (const item of rawValue) {
      const normalized = String(item || "").trim();
      if (normalized) {
        unique.add(normalized);
      }
    }
    return unique.size > 0 ? [...unique] : ["otp", "link"];
  }

  const parsed = normalizeCsvList(rawValue);
  return parsed.length > 0 ? parsed : ["otp", "link"];
}

function normalizeTags(rawValue) {
  if (Array.isArray(rawValue)) {
    const unique = new Set();
    for (const item of rawValue) {
      const normalized = String(item || "").trim();
      if (normalized) {
        unique.add(normalized);
      }
    }
    return [...unique];
  }
  return normalizeCsvList(rawValue);
}

export function buildProvisionEmailPayload({
  aliasTemplate = "",
  ttlHours = 24,
  tags = [],
  domainPoolId = "",
  receiveMode = "EDGE_ACCEPT",
  allowWebhooks = true,
  extractionTypes = ["otp", "link"],
} = {}) {
  return {
    aliasTemplate: normalizeAliasTemplate(aliasTemplate),
    ttlHours: normalizeTtlHours(ttlHours, 24),
    tags: normalizeTags(tags),
    domainPoolId: normalizeDomainPoolId(domainPoolId),
    policy: {
      receiveMode: normalizeReceiveMode(receiveMode),
      allowWebhooks: Boolean(allowWebhooks),
      extractionTypes: normalizeExtractionTypes(extractionTypes),
    },
  };
}

export function resolveAidenIdCredentials(
  {
    apiKey = "",
    orgId = "",
    projectId = "",
    env = process.env,
    requireAll = true,
  } = {}
) {
  const resolved = {
    apiKey: String(apiKey || env.AIDENID_API_KEY || "").trim(),
    orgId: String(orgId || env.AIDENID_ORG_ID || "").trim(),
    projectId: String(projectId || env.AIDENID_PROJECT_ID || "").trim(),
  };

  const missing = [];
  if (!resolved.apiKey) {
    missing.push("AIDENID_API_KEY");
  }
  if (!resolved.orgId) {
    missing.push("AIDENID_ORG_ID");
  }
  if (!resolved.projectId) {
    missing.push("AIDENID_PROJECT_ID");
  }

  if (requireAll && missing.length > 0) {
    throw new Error(`Missing AIdenID credentials: ${missing.join(", ")}.`);
  }

  return {
    ...resolved,
    missing,
  };
}

export function normalizeAidenIdApiUrl(rawValue) {
  return normalizeApiUrl(rawValue);
}

function buildProvisionHeaders({ apiKey, orgId, projectId, idempotencyKey }) {
  return {
    "Content-Type": "application/json",
    Authorization: `Bearer ${String(apiKey || "").trim()}`,
    "X-Org-Id": String(orgId || "").trim(),
    "X-Project-Id": String(projectId || "").trim(),
    "Idempotency-Key": String(idempotencyKey || "").trim(),
  };
}

async function parseErrorBody(response) {
  try {
    const payload = await response.json();
    return JSON.stringify(payload);
  } catch {
    try {
      return await response.text();
    } catch {
      return "";
    }
  }
}

export async function provisionEmailIdentity({
  apiUrl,
  apiKey,
  orgId,
  projectId,
  idempotencyKey,
  payload,
  fetchImpl = fetch,
} = {}) {
  if (typeof fetchImpl !== "function") {
    throw new Error("fetchImpl must be a function.");
  }

  const normalizedApiUrl = normalizeApiUrl(apiUrl);
  const requestHeaders = buildProvisionHeaders({
    apiKey,
    orgId,
    projectId,
    idempotencyKey,
  });

  const response = await fetchImpl(`${normalizedApiUrl}/v1/identities`, {
    method: "POST",
    headers: requestHeaders,
    body: JSON.stringify(payload || {}),
  });

  if (!response.ok) {
    const details = await parseErrorBody(response);
    throw new Error(
      `AIdenID provision request failed with status ${response.status}${
        details ? `: ${details}` : ""
      }`
    );
  }

  const body = await response.json();
  return {
    apiUrl: normalizedApiUrl,
    response: body,
    requestHeaders,
  };
}

export async function revokeIdentity({
  apiUrl,
  apiKey,
  orgId,
  projectId,
  idempotencyKey,
  identityId,
  fetchImpl = fetch,
} = {}) {
  if (typeof fetchImpl !== "function") {
    throw new Error("fetchImpl must be a function.");
  }

  const normalizedIdentityId = String(identityId || "").trim();
  if (!normalizedIdentityId) {
    throw new Error("identityId is required.");
  }

  const normalizedApiUrl = normalizeApiUrl(apiUrl);
  const requestHeaders = buildProvisionHeaders({
    apiKey,
    orgId,
    projectId,
    idempotencyKey,
  });

  const response = await fetchImpl(
    `${normalizedApiUrl}/v1/identities/${encodeURIComponent(normalizedIdentityId)}/revoke`,
    {
      method: "POST",
      headers: requestHeaders,
    }
  );

  if (!response.ok) {
    const details = await parseErrorBody(response);
    throw new Error(
      `AIdenID revoke request failed with status ${response.status}${details ? `: ${details}` : ""}`
    );
  }

  const body = await response.json();
  return {
    apiUrl: normalizedApiUrl,
    response: body,
    requestHeaders,
  };
}
