import process from "node:process";

import { DEFAULT_REQUEST_TIMEOUT_MS } from "../auth/http.js";
import { requestHostedMcpAccessToken } from "./token-service.js";

const PASS = "PASS";
const FAIL = "FAIL";

function joinUrl(base, suffix) {
  const normalizedBase = String(base || "").replace(/\/+$/, "");
  const normalizedSuffix = String(suffix || "").replace(/^\/+/, "");
  return `${normalizedBase}/${normalizedSuffix}`;
}

function normalizePositiveNumber(rawValue, field, fallbackValue) {
  if (rawValue === undefined || rawValue === null || String(rawValue).trim() === "") {
    return fallbackValue;
  }
  const normalized = Number(rawValue);
  if (!Number.isFinite(normalized) || normalized <= 0) {
    throw new Error(`${field} must be a positive number.`);
  }
  return normalized;
}

function normalizeOptionalPositiveInteger(rawValue, field) {
  if (rawValue === undefined || rawValue === null || String(rawValue).trim() === "") {
    return null;
  }
  const normalized = Number(rawValue);
  if (!Number.isFinite(normalized) || normalized <= 0 || !Number.isInteger(normalized)) {
    throw new Error(`${field} must be a positive integer.`);
  }
  return normalized;
}

function normalizeSessionId(rawValue) {
  return String(rawValue || "").trim();
}

function redactExactSecret(text, secret) {
  const normalizedSecret = String(secret || "");
  if (!normalizedSecret) {
    return text;
  }
  return String(text).split(normalizedSecret).join("[REDACTED]");
}

export function redactMcpSmokeText(value, secrets = []) {
  let text = String(value || "");
  for (const secret of Array.isArray(secrets) ? secrets : [secrets]) {
    text = redactExactSecret(text, secret);
  }
  return text
    .replace(/\bBearer\s+[A-Za-z0-9._~+/-]+=*/gi, "Bearer [REDACTED]")
    .replace(
      /\b(?:access[_-]?token|refresh[_-]?token|id[_-]?token|api[_-]?key|token|secret|password)\b\s*[:=]\s*["']?[^"',\s}]+/gi,
      (match) => {
        const [prefix = "token"] = match.split(/[:=]/);
        return `${prefix.trim()}=[REDACTED]`;
      },
    );
}

function summarizeJsonRpcError(error, secrets = []) {
  if (!error) {
    return "unknown JSON-RPC error";
  }
  const code = error.code === undefined || error.code === null ? "unknown" : String(error.code);
  const message = redactMcpSmokeText(error.message || "JSON-RPC error", secrets);
  return `JSON-RPC error ${code}: ${message}`;
}

async function postJsonRpc({
  fetchImpl,
  url,
  accessToken,
  payload,
  timeoutMs,
  redactionSecrets = [],
}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    const text = await response.text().catch(() => "");
    let json = null;
    if (text) {
      try {
        json = JSON.parse(text);
      } catch {
        json = null;
      }
    }
    return {
      reached: true,
      status: response.status,
      json,
      detail: json ? "" : redactMcpSmokeText(text, redactionSecrets),
    };
  } catch (error) {
    const aborted = Boolean(error) && error.name === "AbortError";
    return {
      reached: false,
      status: 0,
      json: null,
      detail: aborted
        ? `timed out after ${timeoutMs}ms`
        : redactMcpSmokeText(
            error instanceof Error ? error.message : String(error || "network error"),
            redactionSecrets,
          ),
    };
  } finally {
    clearTimeout(timer);
  }
}

function structuredEvents(result) {
  const structured = result?.structuredContent;
  if (structured && Array.isArray(structured.events)) {
    return structured.events;
  }
  return [];
}

/**
 * Smoke the hosted MCP resource with a short-lived in-memory bearer.
 *
 * This intentionally returns token metadata only. The bearer value is used for
 * the /mcp calls and then discarded so JSON/text output can be pasted into
 * Senti or PRs without exposing credentials.
 */
export async function runHostedMcpSmoke({
  cwd = process.cwd(),
  env = process.env,
  explicitApiUrl = "",
  autoRotate = true,
  scope = "sessions:read",
  ttlSeconds = null,
  timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS,
  sessionId = "",
  limit = 5,
  homeDir,
  requestTokenImpl = requestHostedMcpAccessToken,
  fetchImpl = fetch,
} = {}) {
  const normalizedTimeoutMs = normalizePositiveNumber(timeoutMs, "timeoutMs", DEFAULT_REQUEST_TIMEOUT_MS);
  const normalizedLimit = normalizeOptionalPositiveInteger(limit, "limit") || 5;
  const normalizedSessionId = normalizeSessionId(sessionId);

  const minted = await requestTokenImpl({
    cwd,
    env,
    explicitApiUrl,
    autoRotate,
    scope,
    ttlSeconds,
    timeoutMs: normalizedTimeoutMs,
    homeDir,
  });
  const accessToken = String(minted.accessToken || "");
  if (!accessToken) {
    throw new Error("Hosted MCP token mint succeeded but returned no access token.");
  }
  const redactionSecrets = [accessToken];

  const mcpUrl = joinUrl(minted.apiUrl, "/mcp");
  const probes = [];
  const toolNames = [];

  const toolsResponse = await postJsonRpc({
    fetchImpl,
    url: mcpUrl,
    accessToken,
    timeoutMs: normalizedTimeoutMs,
    redactionSecrets,
    payload: {
      jsonrpc: "2.0",
      id: "mcp-smoke-tools",
      method: "tools/list",
      params: {},
    },
  });

  if (!toolsResponse.reached) {
    probes.push({
      id: "tools_list",
      label: "MCP tools/list",
      status: toolsResponse.status,
      verdict: FAIL,
      detail: toolsResponse.detail,
    });
  } else if (toolsResponse.status !== 200) {
    probes.push({
      id: "tools_list",
      label: "MCP tools/list",
      status: toolsResponse.status,
      verdict: FAIL,
      detail: `expected HTTP 200, got HTTP ${toolsResponse.status}`,
    });
  } else if (toolsResponse.json?.error) {
    probes.push({
      id: "tools_list",
      label: "MCP tools/list",
      status: toolsResponse.status,
      verdict: FAIL,
      detail: summarizeJsonRpcError(toolsResponse.json.error, redactionSecrets),
    });
  } else {
    for (const tool of toolsResponse.json?.result?.tools || []) {
      const name = String(tool?.name || "").trim();
      if (name) {
        toolNames.push(name);
      }
    }
    probes.push({
      id: "tools_list",
      label: "MCP tools/list",
      status: toolsResponse.status,
      verdict: toolNames.length > 0 ? PASS : FAIL,
      detail: toolNames.length > 0 ? `${toolNames.length} tool(s) returned` : "tools/list returned no tools",
      toolNames,
    });
  }

  if (normalizedSessionId) {
    if (!toolNames.includes("sessions.events.list")) {
      probes.push({
        id: "session_events_list",
        label: "MCP sessions.events.list",
        status: 0,
        verdict: FAIL,
        detail: "sessions.events.list tool was not advertised by tools/list",
        sessionId: normalizedSessionId,
      });
    } else {
      const eventsResponse = await postJsonRpc({
        fetchImpl,
        url: mcpUrl,
        accessToken,
        timeoutMs: normalizedTimeoutMs,
        redactionSecrets,
        payload: {
          jsonrpc: "2.0",
          id: "mcp-smoke-events",
          method: "tools/call",
          params: {
            name: "sessions.events.list",
            arguments: {
              sessionId: normalizedSessionId,
              limit: normalizedLimit,
            },
          },
        },
      });

      if (!eventsResponse.reached) {
        probes.push({
          id: "session_events_list",
          label: "MCP sessions.events.list",
          status: eventsResponse.status,
          verdict: FAIL,
          detail: eventsResponse.detail,
          sessionId: normalizedSessionId,
        });
      } else if (eventsResponse.status !== 200) {
        probes.push({
          id: "session_events_list",
          label: "MCP sessions.events.list",
          status: eventsResponse.status,
          verdict: FAIL,
          detail: `expected HTTP 200, got HTTP ${eventsResponse.status}`,
          sessionId: normalizedSessionId,
        });
      } else if (eventsResponse.json?.error) {
        probes.push({
          id: "session_events_list",
          label: "MCP sessions.events.list",
          status: eventsResponse.status,
          verdict: FAIL,
          detail: summarizeJsonRpcError(eventsResponse.json.error, redactionSecrets),
          sessionId: normalizedSessionId,
        });
      } else {
        const events = structuredEvents(eventsResponse.json?.result);
        const sequences = events
          .map((event) => Number(event?.sequenceId))
          .filter((value) => Number.isFinite(value));
        probes.push({
          id: "session_events_list",
          label: "MCP sessions.events.list",
          status: eventsResponse.status,
          verdict: PASS,
          detail: `${events.length} event(s) returned`,
          sessionId: normalizedSessionId,
          eventCount: events.length,
          firstSequenceId: sequences.length ? Math.min(...sequences) : null,
          lastSequenceId: sequences.length ? Math.max(...sequences) : null,
        });
      }
    }
  }

  return {
    apiUrl: minted.apiUrl,
    mcpUrl,
    ok: probes.every((probe) => probe.verdict !== FAIL),
    token: {
      redacted: true,
      tokenType: minted.tokenType,
      expiresIn: minted.expiresIn,
      expiresAt: minted.expiresAt,
      issuer: minted.issuer,
      audience: minted.audience,
      scope: minted.scope,
    },
    probes,
  };
}
