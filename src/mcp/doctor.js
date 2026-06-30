/**
 * `sl mcp doctor` probe logic.
 *
 * Diagnoses whether the hosted Sentinelayer MCP server is correctly set up for
 * remote-agent (ChatGPT / Claude) OAuth authentication. All probes are
 * UNAUTHENTICATED on purpose: they read public OAuth discovery documents and
 * confirm the resource server REJECTS an unauthenticated call. No bearer token
 * is sent and no token is minted, so the command is side-effect-free and safe
 * to run before `sl auth login`.
 *
 * Checks (RFCs map to the WARDEN hosted-MCP-auth build-spec §2/§4):
 *   1. Protected Resource Metadata  GET /.well-known/oauth-protected-resource  (RFC 9728)
 *   2. Authorization Server Metadata GET /.well-known/oauth-authorization-server (RFC 8414)
 *   3. JSON Web Key Set             GET /.well-known/jwks.json
 *   4. Enforcement                  POST /mcp with no Authorization -> must 401 + WWW-Authenticate
 */

export const DEFAULT_DOCTOR_TIMEOUT_MS = 10_000;

const PASS = "PASS";
const WARN = "WARN";
const FAIL = "FAIL";

function joinUrl(base, suffix) {
  const normalizedBase = String(base || "").replace(/\/+$/, "");
  const normalizedSuffix = String(suffix || "").replace(/^\/+/, "");
  return `${normalizedBase}/${normalizedSuffix}`;
}

async function probeRequest(fetchImpl, url, { method = "GET", headers, body, timeoutMs } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(url, { method, headers, body, signal: controller.signal });
    const text = await response.text().catch(() => "");
    let json = null;
    if (text) {
      try {
        json = JSON.parse(text);
      } catch {
        json = null;
      }
    }
    return { reached: true, status: response.status, headers: response.headers, json };
  } catch (error) {
    const aborted = Boolean(error) && error.name === "AbortError";
    return {
      reached: false,
      status: 0,
      detail: aborted ? `timed out after ${timeoutMs}ms` : String((error && error.message) || error),
    };
  } finally {
    clearTimeout(timer);
  }
}

function headerValue(headers, name) {
  if (headers && typeof headers.get === "function") {
    return String(headers.get(name) || "");
  }
  if (headers && typeof headers === "object") {
    return String(headers[name] || headers[name.toLowerCase()] || "");
  }
  return "";
}

/**
 * Run the hosted MCP auth discovery + enforcement probes.
 *
 * @param {{ apiBaseUrl: string, timeoutMs?: number, fetchImpl?: typeof fetch }} params
 * @returns {Promise<{ apiBaseUrl: string, ok: boolean, probes: Array<{id:string,label:string,url:string,status:number,verdict:string,detail:string}> }>}
 */
export async function runMcpDoctorProbes({
  apiBaseUrl,
  timeoutMs = DEFAULT_DOCTOR_TIMEOUT_MS,
  fetchImpl = fetch,
} = {}) {
  const base = String(apiBaseUrl || "").trim().replace(/\/+$/, "");
  if (!base) {
    throw new Error("apiBaseUrl is required to run MCP doctor probes.");
  }

  const probes = [];
  // Whether PRM advertised an authorization server changes how severe an
  // AS-metadata 503 is: advertised pointer + 503 is a broken chain (FAIL),
  // while omitted pointer + 503 is a consistent fail-closed state (WARN).
  let prmAdvertisesAuthServer = false;

  // 1. Protected Resource Metadata (RFC 9728)
  {
    const url = joinUrl(base, "/.well-known/oauth-protected-resource");
    const result = await probeRequest(fetchImpl, url, { timeoutMs });
    let verdict = FAIL;
    let detail;
    if (!result.reached) {
      detail = result.detail;
    } else if (result.status === 200 && result.json && typeof result.json.resource === "string" && result.json.resource) {
      verdict = PASS;
      const count = Array.isArray(result.json.authorization_servers)
        ? result.json.authorization_servers.length
        : 0;
      prmAdvertisesAuthServer = count > 0;
      detail = `resource=${result.json.resource}; authorization_servers=${count}`;
    } else if (result.status === 200) {
      verdict = WARN;
      detail = "200 but missing the required 'resource' field";
    } else {
      detail = `expected 200, got HTTP ${result.status}`;
    }
    probes.push({
      id: "protected_resource_metadata",
      label: "Protected Resource Metadata (RFC 9728)",
      url,
      status: result.status,
      verdict,
      detail,
    });
  }

  // 2. Authorization Server Metadata (RFC 8414)
  {
    const url = joinUrl(base, "/.well-known/oauth-authorization-server");
    const result = await probeRequest(fetchImpl, url, { timeoutMs });
    let verdict = FAIL;
    let detail;
    if (!result.reached) {
      detail = result.detail;
    } else if (result.status === 200) {
      verdict = PASS;
      detail =
        result.json && result.json.token_endpoint
          ? `token_endpoint=${result.json.token_endpoint}`
          : "advertised";
    } else if (result.status === 503) {
      if (prmAdvertisesAuthServer) {
        // Broken discovery chain: PRM points clients at an authorization server
        // that then returns 503. Clients WILL follow the pointer and fail.
        verdict = FAIL;
        detail =
          "PRM advertises authorization_servers but AS metadata is 503 — remote clients will follow the advertised pointer to an unconfigured authorization server (broken discovery chain)";
      } else {
        // Consistent fail-closed: no AS advertised, AS metadata not configured.
        verdict = WARN;
        detail =
          "503 unconfigured and PRM does not advertise an authorization server (fail-closed, consistent) — set MCP_OAUTH_AUTHORIZATION_ENDPOINT + MCP_OAUTH_TOKEN_ENDPOINT to enable remote auto-discovery";
      }
    } else {
      detail = `expected 200, got HTTP ${result.status}`;
    }
    probes.push({
      id: "authorization_server_metadata",
      label: "Authorization Server Metadata (RFC 8414)",
      url,
      status: result.status,
      verdict,
      detail,
    });
  }

  // 3. JSON Web Key Set
  {
    const url = joinUrl(base, "/.well-known/jwks.json");
    const result = await probeRequest(fetchImpl, url, { timeoutMs });
    let verdict = FAIL;
    let detail;
    if (!result.reached) {
      detail = result.detail;
    } else if (result.status === 200 && result.json && Array.isArray(result.json.keys) && result.json.keys.length > 0) {
      const keys = result.json.keys;
      // A PUBLIC JWKS must only ever publish ASYMMETRIC public keys. A symmetric
      // key (kty "oct" / HS* alg) here IS the shared HMAC signing secret — anyone
      // who can read it can forge MCP access tokens. Treat that as a hard failure.
      const symmetricKeys = keys.filter((key) => {
        const kty = String((key && key.kty) || "").toLowerCase();
        const alg = String((key && key.alg) || "").toUpperCase();
        return kty === "oct" || alg.startsWith("HS");
      });
      if (symmetricKeys.length > 0) {
        verdict = FAIL;
        detail = `CRITICAL: ${symmetricKeys.length} symmetric key(s) (kty=oct / HS*) published in the public JWKS — that is the HMAC signing secret and lets anyone forge MCP access tokens`;
      } else {
        verdict = PASS;
        const algs = [
          ...new Set(keys.map((key) => String((key && key.alg) || (key && key.kty) || "?"))),
        ].join(", ");
        detail = `${keys.length} asymmetric signing key(s) published (${algs})`;
      }
    } else if (result.status === 200) {
      verdict = WARN;
      detail = "200 but no signing keys published (expected for HS256/non-prod; production must publish an RS256 JWKS)";
    } else {
      detail = `expected 200, got HTTP ${result.status}`;
    }
    probes.push({
      id: "jwks",
      label: "JSON Web Key Set",
      url,
      status: result.status,
      verdict,
      detail,
    });
  }

  // 4. Enforcement: an unauthenticated /mcp call must be rejected with a
  //    401 + WWW-Authenticate challenge that points back at the PRM document.
  {
    const url = joinUrl(base, "/mcp");
    const result = await probeRequest(fetchImpl, url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: "mcp-doctor", method: "ping" }),
      timeoutMs,
    });
    let verdict = FAIL;
    let detail;
    if (!result.reached) {
      detail = result.detail;
    } else if (result.status === 401) {
      const challenge = headerValue(result.headers, "www-authenticate");
      if (challenge && /resource_metadata=/i.test(challenge)) {
        verdict = PASS;
        detail = "401 + WWW-Authenticate challenge advertises the protected-resource metadata";
      } else if (challenge) {
        verdict = WARN;
        detail = "401 but the WWW-Authenticate challenge omits resource_metadata (clients cannot auto-discover the AS)";
      } else {
        verdict = WARN;
        detail = "401 but no WWW-Authenticate header (clients cannot auto-discover the AS)";
      }
    } else if (result.status === 200) {
      detail = "CRITICAL: unauthenticated /mcp returned 200 — the resource server is NOT enforcing authentication";
    } else {
      detail = `expected 401, got HTTP ${result.status}`;
    }
    probes.push({
      id: "mcp_enforcement",
      label: "Unauthenticated /mcp is rejected",
      url,
      status: result.status,
      verdict,
      detail,
    });
  }

  const ok = probes.every((probe) => probe.verdict !== FAIL);
  return { apiBaseUrl: base, ok, probes };
}
