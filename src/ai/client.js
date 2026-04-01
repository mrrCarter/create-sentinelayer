const PROVIDER_ENV_KEYS = Object.freeze({
  openai: "OPENAI_API_KEY",
  anthropic: "ANTHROPIC_API_KEY",
  google: "GOOGLE_API_KEY",
});

const DEFAULT_MODELS = Object.freeze({
  openai: "gpt-4o",
  anthropic: "claude-sonnet-4",
  google: "gemini-2.5-pro",
});

const SUPPORTED_PROVIDERS = Object.freeze(Object.keys(PROVIDER_ENV_KEYS));

function normalizeProvider(provider) {
  const normalized = String(provider || "")
    .trim()
    .toLowerCase();
  if (!normalized) {
    return "";
  }
  if (!SUPPORTED_PROVIDERS.includes(normalized)) {
    throw new Error(
      `Unsupported provider '${provider}'. Use one of: ${SUPPORTED_PROVIDERS.join(", ")}`
    );
  }
  return normalized;
}

function isRetryableStatus(statusCode) {
  const numeric = Number(statusCode || 0);
  if (!Number.isFinite(numeric)) {
    return false;
  }
  return numeric === 429 || numeric >= 500;
}

function sleep(ms) {
  const normalized = Math.max(0, Number(ms || 0));
  return new Promise((resolve) => setTimeout(resolve, normalized));
}

function normalizePrompt(prompt) {
  const normalized = String(prompt || "").trim();
  if (!normalized) {
    throw new Error("Prompt is required.");
  }
  return normalized;
}

function parseStreamDataLine(line) {
  const trimmed = String(line || "").trim();
  if (!trimmed.startsWith("data:")) {
    return null;
  }
  const payload = trimmed.slice(5).trim();
  if (!payload || payload === "[DONE]") {
    return null;
  }
  return payload;
}

function parseStreamChunk(provider, payload) {
  try {
    const parsed = JSON.parse(payload);
    if (provider === "openai") {
      const value = parsed?.choices?.[0]?.delta?.content;
      return typeof value === "string" ? value : "";
    }
    if (provider === "anthropic") {
      if (parsed?.type === "content_block_delta") {
        return typeof parsed?.delta?.text === "string" ? parsed.delta.text : "";
      }
      return "";
    }
    if (provider === "google") {
      const value = parsed?.candidates?.[0]?.content?.parts?.[0]?.text;
      return typeof value === "string" ? value : "";
    }
    return "";
  } catch {
    return "";
  }
}

function extractTextFromResponse(provider, payload) {
  if (provider === "openai") {
    const text = payload?.choices?.[0]?.message?.content;
    if (typeof text === "string") {
      return text;
    }
    if (Array.isArray(text)) {
      return text
        .map((item) => (typeof item?.text === "string" ? item.text : ""))
        .join("")
        .trim();
    }
    return "";
  }

  if (provider === "anthropic") {
    const blocks = Array.isArray(payload?.content) ? payload.content : [];
    return blocks
      .map((block) => (typeof block?.text === "string" ? block.text : ""))
      .join("")
      .trim();
  }

  if (provider === "google") {
    const parts = payload?.candidates?.[0]?.content?.parts;
    if (!Array.isArray(parts)) {
      return "";
    }
    return parts
      .map((part) => (typeof part?.text === "string" ? part.text : ""))
      .join("")
      .trim();
  }

  return "";
}

function buildProviderRequest({ provider, apiKey, model, prompt, stream }) {
  const normalizedProvider = normalizeProvider(provider);
  const normalizedPrompt = normalizePrompt(prompt);

  if (normalizedProvider === "openai") {
    return {
      url: "https://api.openai.com/v1/chat/completions",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model,
        stream,
        messages: [{ role: "user", content: normalizedPrompt }],
      }),
    };
  }

  if (normalizedProvider === "anthropic") {
    return {
      url: "https://api.anthropic.com/v1/messages",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model,
        stream,
        max_tokens: 2048,
        messages: [{ role: "user", content: normalizedPrompt }],
      }),
    };
  }

  const method = stream ? "streamGenerateContent" : "generateContent";
  return {
    url: `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(
      model
    )}:${method}?key=${encodeURIComponent(apiKey)}`,
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      contents: [
        {
          role: "user",
          parts: [{ text: normalizedPrompt }],
        },
      ],
    }),
  };
}

async function parseStreamResponse({ provider, response, onChunk }) {
  if (!response.body || typeof response.body.getReader !== "function") {
    const fallbackPayload = await response.json();
    const fallbackText = extractTextFromResponse(provider, fallbackPayload);
    if (fallbackText && onChunk) {
      onChunk(fallbackText);
    }
    return fallbackText;
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder("utf-8");
  let buffered = "";
  let aggregated = "";

  while (true) {
    const { value, done } = await reader.read();
    if (done) {
      break;
    }
    buffered += decoder.decode(value, { stream: true });
    const lines = buffered.split(/\r?\n/);
    buffered = lines.pop() || "";

    for (const line of lines) {
      const dataPayload = parseStreamDataLine(line);
      if (!dataPayload) {
        continue;
      }
      const delta = parseStreamChunk(provider, dataPayload);
      if (!delta) {
        continue;
      }
      aggregated += delta;
      if (onChunk) {
        onChunk(delta);
      }
    }
  }

  buffered += decoder.decode();
  if (buffered.trim()) {
    const dataPayload = parseStreamDataLine(buffered);
    if (dataPayload) {
      const delta = parseStreamChunk(provider, dataPayload);
      if (delta) {
        aggregated += delta;
        if (onChunk) {
          onChunk(delta);
        }
      }
    }
  }

  return aggregated.trim();
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

export function detectProviderFromEnv(env = process.env) {
  for (const provider of SUPPORTED_PROVIDERS) {
    const envVar = PROVIDER_ENV_KEYS[provider];
    const value = String(env?.[envVar] || "").trim();
    if (value) {
      return provider;
    }
  }
  return null;
}

export function resolveProvider({ provider, configProvider, env = process.env } = {}) {
  const explicit = normalizeProvider(provider);
  if (explicit) {
    return explicit;
  }

  const configured = normalizeProvider(configProvider);
  if (configured) {
    return configured;
  }

  const detected = detectProviderFromEnv(env);
  if (detected) {
    return detected;
  }

  return "openai";
}

export function resolveModel({ provider, model, configModel } = {}) {
  const normalizedProvider = resolveProvider({ provider });
  const explicit = String(model || "").trim();
  if (explicit) {
    return explicit;
  }
  const configured = String(configModel || "").trim();
  if (configured) {
    return configured;
  }
  return DEFAULT_MODELS[normalizedProvider];
}

export function resolveApiKey({ provider, explicitApiKey, env = process.env } = {}) {
  const normalizedProvider = resolveProvider({ provider, env });
  const explicit = String(explicitApiKey || "").trim();
  if (explicit) {
    return explicit;
  }
  const envKey = PROVIDER_ENV_KEYS[normalizedProvider];
  const value = String(env?.[envKey] || "").trim();
  if (!value) {
    throw new Error(
      `Missing API key for provider '${normalizedProvider}'. Set ${envKey} or provide explicitApiKey.`
    );
  }
  return value;
}

export class MultiProviderApiClient {
  constructor({
    fetchImpl = fetch,
    maxRetries = 2,
    baseDelayMs = 250,
    requestTimeoutMs = 120000,
  } = {}) {
    if (typeof fetchImpl !== "function") {
      throw new Error("fetchImpl must be a function.");
    }
    this.fetchImpl = fetchImpl;
    this.maxRetries = Math.max(0, Number(maxRetries || 0));
    this.baseDelayMs = Math.max(0, Number(baseDelayMs || 0));
    this.requestTimeoutMs = Math.max(1000, Number(requestTimeoutMs || 0));
  }

  async invoke({
    provider,
    model,
    prompt,
    stream = false,
    apiKey,
    env = process.env,
    onChunk,
  } = {}) {
    const resolvedProvider = resolveProvider({ provider, env });
    const resolvedModel = resolveModel({ provider: resolvedProvider, model });
    const resolvedApiKey = resolveApiKey({
      provider: resolvedProvider,
      explicitApiKey: apiKey,
      env,
    });

    const request = buildProviderRequest({
      provider: resolvedProvider,
      apiKey: resolvedApiKey,
      model: resolvedModel,
      prompt,
      stream: Boolean(stream),
    });

    let attempt = 0;
    while (true) {
      const controller = new AbortController();
      const timeoutHandle = setTimeout(() => controller.abort(), this.requestTimeoutMs);
      try {
        const response = await this.fetchImpl(request.url, {
          method: "POST",
          headers: request.headers,
          body: request.body,
          signal: controller.signal,
        });

        if (!response.ok) {
          if (attempt < this.maxRetries && isRetryableStatus(response.status)) {
            const backoff = this.baseDelayMs * 2 ** attempt;
            attempt += 1;
            await sleep(backoff);
            continue;
          }

          const errorBody = await parseErrorBody(response);
          throw new Error(
            `Provider request failed (${resolvedProvider}) with status ${response.status}${
              errorBody ? `: ${errorBody}` : ""
            }`
          );
        }

        let text = "";
        if (stream) {
          text = await parseStreamResponse({
            provider: resolvedProvider,
            response,
            onChunk,
          });
        } else {
          const payload = await response.json();
          text = extractTextFromResponse(resolvedProvider, payload);
        }

        return {
          provider: resolvedProvider,
          model: resolvedModel,
          text,
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const isAbort = /aborted|abort/i.test(message);
        if (attempt < this.maxRetries && !isAbort) {
          const backoff = this.baseDelayMs * 2 ** attempt;
          attempt += 1;
          await sleep(backoff);
          continue;
        }
        throw error;
      } finally {
        clearTimeout(timeoutHandle);
      }
    }
  }
}

export function createMultiProviderApiClient(options = {}) {
  return new MultiProviderApiClient(options);
}

export function listSupportedProviders() {
  return [...SUPPORTED_PROVIDERS];
}

