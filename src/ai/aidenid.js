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

function normalizePositiveInteger(rawValue, field, { min = 1, max = Number.MAX_SAFE_INTEGER } = {}) {
  const normalized = Number(rawValue);
  if (!Number.isFinite(normalized) || normalized < min || normalized > max) {
    throw new Error(`${field} must be between ${min} and ${max}.`);
  }
  return Math.round(normalized);
}

function normalizeIdentityId(rawValue) {
  const normalized = String(rawValue || "").trim();
  if (!normalized) {
    throw new Error("identityId is required.");
  }
  return normalized;
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

function normalizeEventBudget(rawValue) {
  if (rawValue === undefined || rawValue === null || String(rawValue).trim() === "") {
    return null;
  }
  return normalizePositiveInteger(rawValue, "eventBudget", { min: 1, max: 1000000 });
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

export function buildChildIdentityPayload({
  aliasTemplate = "",
  ttlHours = 24,
  tags = [],
  domainPoolId = "",
  receiveMode = "EDGE_ACCEPT",
  allowWebhooks = true,
  extractionTypes = ["otp", "link"],
  eventBudget = null,
} = {}) {
  const base = buildProvisionEmailPayload({
    aliasTemplate,
    ttlHours,
    tags,
    domainPoolId,
    receiveMode,
    allowWebhooks,
    extractionTypes,
  });

  return {
    ...base,
    eventBudget: normalizeEventBudget(eventBudget),
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

function buildReadHeaders({ apiKey, orgId, projectId }) {
  return {
    Accept: "application/json",
    Authorization: `Bearer ${String(apiKey || "").trim()}`,
    "X-Org-Id": String(orgId || "").trim(),
    "X-Project-Id": String(projectId || "").trim(),
  };
}

function normalizeExtractionPayload(payload = {}) {
  if (!payload || typeof payload !== "object") {
    return {
      otp: null,
      primaryActionUrl: null,
      confidence: null,
      source: "UNKNOWN",
      extractedAt: null,
      raw: payload,
    };
  }

  const rawOtp = payload.otp ?? payload.code ?? payload.oneTimeCode ?? null;
  const rawPrimaryActionUrl =
    payload.primaryActionUrl ?? payload.primary_action_url ?? payload.verificationUrl ?? payload.link ?? null;
  const rawConfidence = payload.confidence ?? payload.score ?? payload.extractionConfidence ?? null;
  const numericConfidence = Number(rawConfidence);
  const normalizedConfidence = Number.isFinite(numericConfidence) ? numericConfidence : null;
  const rawSource = payload.source ?? payload.extractionSource ?? payload.engine ?? payload.method ?? null;

  return {
    otp: String(rawOtp || "").trim() || null,
    primaryActionUrl: String(rawPrimaryActionUrl || "").trim() || null,
    confidence: normalizedConfidence,
    source: String(rawSource || "").trim() || "UNKNOWN",
    extractedAt: String(payload.extractedAt || payload.createdAt || payload.timestamp || "").trim() || null,
    raw: payload,
  };
}

function normalizeEventsResponse(payload = {}) {
  if (Array.isArray(payload)) {
    return {
      events: payload,
      nextCursor: null,
      previousCursor: null,
    };
  }

  if (!payload || typeof payload !== "object") {
    return {
      events: [],
      nextCursor: null,
      previousCursor: null,
    };
  }

  const events = Array.isArray(payload.events)
    ? payload.events
    : Array.isArray(payload.items)
      ? payload.items
      : Array.isArray(payload.data)
        ? payload.data
        : [];

  return {
    events,
    nextCursor:
      String(payload.nextCursor || payload.next_cursor || payload.cursor || payload.next || "").trim() || null,
    previousCursor:
      String(payload.previousCursor || payload.previous_cursor || payload.prev || "").trim() || null,
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

  const normalizedIdentityId = normalizeIdentityId(identityId);

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

export async function listIdentityEvents({
  apiUrl,
  apiKey,
  orgId,
  projectId,
  identityId,
  cursor = "",
  limit = 50,
  fetchImpl = fetch,
} = {}) {
  if (typeof fetchImpl !== "function") {
    throw new Error("fetchImpl must be a function.");
  }

  const normalizedIdentityId = normalizeIdentityId(identityId);
  const normalizedApiUrl = normalizeApiUrl(apiUrl);
  const normalizedLimit = normalizePositiveInteger(limit, "limit", { min: 1, max: 500 });
  const normalizedCursor = String(cursor || "").trim();
  const requestHeaders = buildReadHeaders({ apiKey, orgId, projectId });

  const endpoint = new URL(
    `${normalizedApiUrl}/v1/identities/${encodeURIComponent(normalizedIdentityId)}/events`
  );
  endpoint.searchParams.set("limit", String(normalizedLimit));
  if (normalizedCursor) {
    endpoint.searchParams.set("cursor", normalizedCursor);
  }

  const response = await fetchImpl(endpoint.toString(), {
    method: "GET",
    headers: requestHeaders,
  });

  if (!response.ok) {
    const details = await parseErrorBody(response);
    throw new Error(
      `AIdenID identity events request failed with status ${response.status}${details ? `: ${details}` : ""}`
    );
  }

  const body = await response.json();
  const normalized = normalizeEventsResponse(body);
  return {
    apiUrl: normalizedApiUrl,
    response: body,
    requestHeaders,
    events: normalized.events,
    nextCursor: normalized.nextCursor,
    previousCursor: normalized.previousCursor,
  };
}

export async function getLatestIdentityExtraction({
  apiUrl,
  apiKey,
  orgId,
  projectId,
  identityId,
  fetchImpl = fetch,
} = {}) {
  if (typeof fetchImpl !== "function") {
    throw new Error("fetchImpl must be a function.");
  }

  const normalizedIdentityId = normalizeIdentityId(identityId);
  const normalizedApiUrl = normalizeApiUrl(apiUrl);
  const requestHeaders = buildReadHeaders({ apiKey, orgId, projectId });

  const response = await fetchImpl(
    `${normalizedApiUrl}/v1/identities/${encodeURIComponent(normalizedIdentityId)}/latest-extraction`,
    {
      method: "GET",
      headers: requestHeaders,
    }
  );

  if (response.status === 404) {
    return {
      apiUrl: normalizedApiUrl,
      response: null,
      requestHeaders,
      extraction: normalizeExtractionPayload({}),
      notFound: true,
    };
  }

  if (!response.ok) {
    const details = await parseErrorBody(response);
    throw new Error(
      `AIdenID latest extraction request failed with status ${response.status}${
        details ? `: ${details}` : ""
      }`
    );
  }

  const body = await response.json();
  const extractionPayload =
    body && typeof body === "object" && body.extraction && typeof body.extraction === "object"
      ? body.extraction
      : body;

  return {
    apiUrl: normalizedApiUrl,
    response: body,
    requestHeaders,
    extraction: normalizeExtractionPayload(extractionPayload),
    notFound: false,
  };
}

export async function createChildIdentity({
  apiUrl,
  apiKey,
  orgId,
  projectId,
  parentIdentityId,
  idempotencyKey,
  payload,
  fetchImpl = fetch,
} = {}) {
  if (typeof fetchImpl !== "function") {
    throw new Error("fetchImpl must be a function.");
  }

  const normalizedParentIdentityId = normalizeIdentityId(parentIdentityId);
  const normalizedApiUrl = normalizeApiUrl(apiUrl);
  const requestHeaders = buildProvisionHeaders({
    apiKey,
    orgId,
    projectId,
    idempotencyKey,
  });

  const response = await fetchImpl(
    `${normalizedApiUrl}/v1/identities/${encodeURIComponent(normalizedParentIdentityId)}/children`,
    {
      method: "POST",
      headers: requestHeaders,
      body: JSON.stringify(payload || {}),
    }
  );

  if (!response.ok) {
    const details = await parseErrorBody(response);
    throw new Error(
      `AIdenID create child request failed with status ${response.status}${details ? `: ${details}` : ""}`
    );
  }

  const body = await response.json();
  return {
    apiUrl: normalizedApiUrl,
    response: body,
    requestHeaders,
  };
}

export async function getIdentityLineage({
  apiUrl,
  apiKey,
  orgId,
  projectId,
  identityId,
  fetchImpl = fetch,
} = {}) {
  if (typeof fetchImpl !== "function") {
    throw new Error("fetchImpl must be a function.");
  }

  const normalizedIdentityId = normalizeIdentityId(identityId);
  const normalizedApiUrl = normalizeApiUrl(apiUrl);
  const requestHeaders = buildReadHeaders({ apiKey, orgId, projectId });

  const response = await fetchImpl(
    `${normalizedApiUrl}/v1/identities/${encodeURIComponent(normalizedIdentityId)}/lineage`,
    {
      method: "GET",
      headers: requestHeaders,
    }
  );

  if (!response.ok) {
    const details = await parseErrorBody(response);
    throw new Error(
      `AIdenID identity lineage request failed with status ${response.status}${details ? `: ${details}` : ""}`
    );
  }

  const body = await response.json();
  const nodes = Array.isArray(body?.nodes) ? body.nodes : [];
  const edges = Array.isArray(body?.edges) ? body.edges : [];
  const rootIdentityId = String(body?.rootIdentityId || "").trim() || normalizedIdentityId;
  return {
    apiUrl: normalizedApiUrl,
    response: body,
    requestHeaders,
    rootIdentityId,
    nodes,
    edges,
  };
}

export async function revokeIdentityChildren({
  apiUrl,
  apiKey,
  orgId,
  projectId,
  identityId,
  idempotencyKey,
  fetchImpl = fetch,
} = {}) {
  if (typeof fetchImpl !== "function") {
    throw new Error("fetchImpl must be a function.");
  }

  const normalizedIdentityId = normalizeIdentityId(identityId);
  const normalizedApiUrl = normalizeApiUrl(apiUrl);
  const requestHeaders = buildProvisionHeaders({
    apiKey,
    orgId,
    projectId,
    idempotencyKey,
  });

  const response = await fetchImpl(
    `${normalizedApiUrl}/v1/identities/${encodeURIComponent(normalizedIdentityId)}/revoke-children`,
    {
      method: "POST",
      headers: requestHeaders,
    }
  );

  if (!response.ok) {
    const details = await parseErrorBody(response);
    throw new Error(
      `AIdenID revoke children request failed with status ${response.status}${details ? `: ${details}` : ""}`
    );
  }

  const body = await response.json();
  const revokedIdentityIds = Array.isArray(body?.revokedIdentityIds) ? body.revokedIdentityIds : [];
  const revokedCount = Number.isFinite(Number(body?.revokedCount))
    ? Number(body.revokedCount)
    : revokedIdentityIds.length;
  return {
    apiUrl: normalizedApiUrl,
    response: body,
    requestHeaders,
    parentIdentityId: String(body?.parentIdentityId || "").trim() || normalizedIdentityId,
    revokedCount,
    revokedIdentityIds,
  };
}
