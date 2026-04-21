// runPersona — single-persona execution driver (#A27 runtime integration).
//
// Takes a persona id + mode and runs that persona's domain-tool sweep over
// the given repo root / file list. Today this is what's wired to the CLI
// `persona run <id>` and to omargate.persona_dispatch.
//
// - Audit mode (default): invokes the persona's `runAll<X>Tools` and
//   returns the resulting Finding[]. No LLM call, no file writes.
// - Codegen mode: runs the same tool sweep AND attaches the mode config
//   from `agents/mode.js` (allowed-tools + prompt suffix) to the result.
//   The actual LLM spawn + edit loop happens in the caller — this driver
//   only produces the deterministic baseline + plan envelope.

import {
  buildPersonaConfigForMode,
  listKnownPersonaIds,
  normalizePersonaMode,
} from "./mode.js";

// Lazy-load each persona's module to avoid paying the import cost for
// every persona on every invocation. Each entry is a thunk that returns
// the persona's runAll* function.
const PERSONA_LOADERS = Object.freeze({
  "ai-governance": async () =>
    (await import("./ai-governance/index.js")).runAllAiGovernanceTools,
  "backend": async () =>
    (await import("./backend/index.js")).runAllBackendTools,
  "code-quality": async () =>
    (await import("./code-quality/index.js")).runAllCodeQualityTools,
  "data-layer": async () =>
    (await import("./data-layer/index.js")).runAllDataLayerTools,
  "documentation": async () =>
    (await import("./documentation/index.js")).runAllDocumentationTools,
  "infrastructure": async () =>
    (await import("./infrastructure/index.js")).runAllInfrastructureTools,
  "observability": async () =>
    (await import("./observability/index.js")).runAllObservabilityTools,
  "release": async () =>
    (await import("./release/index.js")).runAllReleaseTools,
  "reliability": async () =>
    (await import("./reliability/index.js")).runAllReliabilityTools,
  "security": async () =>
    (await import("./security/index.js")).runAllSecurityTools,
  "supply-chain": async () =>
    (await import("./supply-chain/index.js")).runAllSupplyChainTools,
  "testing": async () =>
    (await import("./testing/index.js")).runAllTestingTools,
});

export const SUPPORTED_PERSONA_IDS = Object.freeze(
  Object.keys(PERSONA_LOADERS).sort()
);

function normalizePersonaId(personaId) {
  return String(personaId || "").trim().toLowerCase();
}

function normalizeFiles(files) {
  if (!files) return [];
  if (Array.isArray(files)) {
    return files.map((f) => String(f || "").trim()).filter(Boolean);
  }
  return String(files)
    .split(",")
    .map((f) => f.trim())
    .filter(Boolean);
}

export async function runPersona({
  personaId,
  mode = "audit",
  rootPath,
  files = null,
} = {}) {
  const id = normalizePersonaId(personaId);
  if (!id) {
    throw new Error("personaId is required.");
  }
  if (!PERSONA_LOADERS[id]) {
    throw new Error(
      `Unknown persona id: ${personaId}. Supported: ${SUPPORTED_PERSONA_IDS.join(", ")}`
    );
  }
  const normalizedMode = normalizePersonaMode(mode);
  const normalizedFiles = normalizeFiles(files);
  const loader = PERSONA_LOADERS[id];
  const runAllTools = await loader();

  const toolFiles = normalizedFiles.length > 0 ? normalizedFiles : null;
  const findings = await runAllTools({
    rootPath: String(rootPath || "."),
    files: toolFiles,
  });

  const modeConfig = buildPersonaConfigForMode(id, normalizedMode);
  return {
    personaId: id,
    mode: normalizedMode,
    rootPath: String(rootPath || "."),
    files: normalizedFiles,
    findings: Array.isArray(findings) ? findings : [],
    mode_config: {
      allowedTools: modeConfig.allowedTools,
      promptSuffix: modeConfig.promptSuffix,
    },
  };
}

export { listKnownPersonaIds };
