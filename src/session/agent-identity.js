function normalizeString(value) {
  return String(value || "").trim();
}

function normalizeLookup(value) {
  return normalizeString(value).toLowerCase();
}

function titleFromIdentifier(value) {
  const parts = normalizeString(value)
    .replace(/[_-]+/g, " ")
    .split(/\s+/)
    .map((part) => part.trim())
    .filter(Boolean);
  if (!parts.length) return "";
  return parts
    .map((part) => {
      if (/^[0-9]+$/.test(part)) return part;
      return `${part.charAt(0).toUpperCase()}${part.slice(1)}`;
    })
    .join(" ");
}

function isWeakModel(value) {
  const normalized = normalizeLookup(value);
  return !normalized || ["anonymous", "cli", "unknown", "unreported"].includes(normalized);
}

function inferFamily(agentId, model) {
  const haystack = `${agentId} ${model}`.toLowerCase();
  if (haystack.includes("claude") || haystack.includes("sonnet") || haystack.includes("opus")) {
    return "claude";
  }
  if (haystack.includes("codex") || haystack.includes("gpt-") || haystack.includes("openai")) {
    return "codex";
  }
  if (haystack.includes("gemini") || haystack.includes("google")) return "gemini";
  if (haystack.includes("grok") || haystack.includes("xai")) return "grok";
  if (haystack.includes("senti") || haystack.includes("sentinelayer")) return "senti";
  return "";
}

function inferModel(family) {
  if (family === "codex") return "gpt-5-codex";
  if (family === "claude") return "claude";
  if (family === "gemini") return "gemini";
  if (family === "grok") return "grok";
  if (family === "senti") return "gpt-5.4-mini";
  return "";
}

function inferProvider(family, model) {
  const normalizedModel = normalizeLookup(model);
  if (family === "claude" || normalizedModel.includes("claude")) return "anthropic";
  if (family === "codex" || normalizedModel.includes("gpt") || normalizedModel.includes("openai")) {
    return "openai";
  }
  if (family === "gemini" || normalizedModel.includes("gemini")) return "google";
  if (family === "grok" || normalizedModel.includes("grok")) return "xai";
  if (family === "senti") return "sentinelayer";
  return "";
}

function inferClientKind(family) {
  if (family === "codex") return "codex";
  if (family === "claude") return "claude";
  if (family === "gemini") return "gemini";
  if (family === "grok") return "grok";
  if (family === "senti") return "senti";
  return "";
}

function inferDisplayName(agentId, family) {
  const normalizedId = normalizeLookup(agentId);
  if (normalizedId === "senti") return "Senti";
  if (normalizedId.includes("claude-verifier")) return "Claude Verifier";
  if (normalizedId.startsWith("claude")) return "Claude";
  if (normalizedId.startsWith("codex")) return "Codex";
  if (normalizedId.startsWith("gemini")) return "Gemini";
  if (normalizedId.startsWith("grok")) return "Grok";
  if (family) return titleFromIdentifier(family);
  return titleFromIdentifier(agentId);
}

export function inferSessionAgentIdentity(input = {}) {
  const source =
    input && typeof input === "object" && !Array.isArray(input)
      ? input
      : {};
  const {
    agentId = "",
    model = "",
    displayName = "",
    provider = "",
    clientKind = "",
  } = source;
  const normalizedAgentId = normalizeString(agentId);
  const explicitModel = normalizeString(model);
  const family = inferFamily(normalizedAgentId, explicitModel);
  const resolvedModel = isWeakModel(explicitModel)
    ? inferModel(family) || explicitModel || "unknown"
    : explicitModel;
  const resolvedProvider = normalizeString(provider) || inferProvider(family, resolvedModel);
  const resolvedClientKind = normalizeString(clientKind) || inferClientKind(family) || "cli";
  const resolvedDisplayName =
    normalizeString(displayName) || inferDisplayName(normalizedAgentId, family);

  return Object.fromEntries(
    Object.entries({
      agentId: normalizedAgentId,
      model: resolvedModel,
      displayName: resolvedDisplayName,
      provider: resolvedProvider,
      clientKind: resolvedClientKind,
    }).filter(([, value]) => normalizeString(value)),
  );
}

export { titleFromIdentifier };
