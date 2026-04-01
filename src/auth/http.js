import { setTimeout as sleep } from "node:timers/promises";

export const DEFAULT_REQUEST_TIMEOUT_MS = 20_000;

function normalizeApiError(errorPayload = {}) {
  if (!errorPayload || typeof errorPayload !== "object" || Array.isArray(errorPayload)) {
    return {
      code: "UNKNOWN",
      message: "Unknown API error",
      requestId: null,
    };
  }
  return {
    code: String(errorPayload.code || "UNKNOWN"),
    message: String(errorPayload.message || "Unknown API error"),
    requestId: errorPayload.request_id ? String(errorPayload.request_id) : null,
  };
}

export class SentinelayerApiError extends Error {
  constructor(message, { status = 500, code = "UNKNOWN", requestId = null } = {}) {
    super(String(message || "Sentinelayer API error"));
    this.name = "SentinelayerApiError";
    this.status = Number(status || 500);
    this.code = String(code || "UNKNOWN");
    this.requestId = requestId ? String(requestId) : null;
  }
}

export async function requestJson(
  url,
  { method = "GET", headers = {}, body, timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS } = {}
) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), Number(timeoutMs || DEFAULT_REQUEST_TIMEOUT_MS));

  try {
    const response = await fetch(String(url), {
      method,
      headers: {
        "Content-Type": "application/json",
        ...headers,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: controller.signal,
    });

    const rawBody = await response.text();
    let json = {};
    if (rawBody.trim()) {
      try {
        json = JSON.parse(rawBody);
      } catch {
        throw new SentinelayerApiError("Invalid JSON returned by API.", {
          status: response.status,
          code: "INVALID_JSON",
        });
      }
    }

    if (!response.ok) {
      const apiError = normalizeApiError(json && typeof json === "object" ? json.error : {});
      throw new SentinelayerApiError(apiError.message, {
        status: response.status,
        code: apiError.code,
        requestId: apiError.requestId,
      });
    }

    return json;
  } catch (error) {
    if (error instanceof SentinelayerApiError) {
      throw error;
    }
    if (error && typeof error === "object" && error.name === "AbortError") {
      throw new SentinelayerApiError("Request timed out.", {
        status: 408,
        code: "TIMEOUT",
      });
    }
    throw new SentinelayerApiError(
      error instanceof Error ? error.message : String(error || "Request failed"),
      {
        status: 503,
        code: "NETWORK_ERROR",
      }
    );
  } finally {
    clearTimeout(timeout);
    await sleep(0);
  }
}
