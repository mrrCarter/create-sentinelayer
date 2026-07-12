// layering-check — flag lower architectural layers importing higher layers (#A14).

import { createFinding, toPosix } from "./base.js";
import { buildDependencyGraph } from "./dep-graph.js";

const RESOLUTION_EXTENSIONS = Object.freeze([
  ".js",
  ".jsx",
  ".ts",
  ".tsx",
  ".mjs",
  ".cjs",
]);

export const DEFAULT_LAYER_RULES = Object.freeze([
  Object.freeze({
    name: "shared",
    rank: 0,
    prefixes: Object.freeze(["src/shared/", "src/lib/", "shared/", "lib/"]),
  }),
  Object.freeze({
    name: "domain",
    rank: 1,
    prefixes: Object.freeze(["src/domain/", "src/core/", "domain/", "core/"]),
  }),
  Object.freeze({
    name: "data",
    rank: 2,
    prefixes: Object.freeze([
      "src/data/",
      "src/db/",
      "src/models/",
      "data/",
      "db/",
      "models/",
    ]),
  }),
  Object.freeze({
    name: "services",
    rank: 3,
    prefixes: Object.freeze(["src/services/", "src/server/", "services/", "server/"]),
  }),
  Object.freeze({
    name: "app",
    rank: 4,
    prefixes: Object.freeze([
      "src/app/",
      "src/api/",
      "src/controllers/",
      "src/handlers/",
      "src/pages/",
      "src/routes/",
      "app/",
      "api/",
      "controllers/",
      "handlers/",
      "pages/",
      "routes/",
    ]),
  }),
  Object.freeze({
    name: "ui",
    rank: 5,
    prefixes: Object.freeze(["src/components/", "src/ui/", "components/", "ui/"]),
  }),
]);

function normalizePathKey(value) {
  return toPosix(value).replace(/^\.\//, "").replace(/\/{2,}/g, "/");
}

function normalizePrefix(value) {
  const normalized = normalizePathKey(value);
  if (!normalized) {
    return "";
  }
  return normalized.endsWith("/") ? normalized : `${normalized}/`;
}

function normalizeLayers(layers) {
  const source = Array.isArray(layers) && layers.length > 0 ? layers : DEFAULT_LAYER_RULES;
  return source
    .map((layer, index) => ({
      name: String(layer?.name || `layer-${index}`).trim(),
      rank: Number.isFinite(Number(layer?.rank)) ? Number(layer.rank) : index,
      prefixes: Array.isArray(layer?.prefixes)
        ? layer.prefixes.map(normalizePrefix).filter(Boolean)
        : [],
    }))
    .filter((layer) => layer.name && layer.prefixes.length > 0);
}

export function classifyLayer(filePath, layers = DEFAULT_LAYER_RULES) {
  const normalized = normalizePathKey(filePath);
  if (!normalized) {
    return null;
  }
  let best = null;
  for (const layer of normalizeLayers(layers)) {
    for (const prefix of layer.prefixes) {
      if (normalized.startsWith(prefix) && (!best || prefix.length > best.prefix.length)) {
        best = { ...layer, prefix };
      }
    }
  }
  return best;
}

function isExternalEdge(edge) {
  const normalized = normalizePathKey(edge);
  return (
    !normalized ||
    normalized.startsWith("npm:") ||
    normalized.startsWith("/") ||
    /^[a-z][a-z0-9+.-]*:/i.test(normalized)
  );
}
export function resolveLocalEdge(edge, graphKeys = []) {
  const normalized = normalizePathKey(edge);
  if (!normalized || isExternalEdge(normalized)) {
    return null;
  }
  const keys = graphKeys instanceof Set ? graphKeys : new Set(graphKeys);
  if (keys.size === 0 || keys.has(normalized)) {
    return normalized;
  }

  const candidates = [];
  const hasExtension = /\.[^/.]+$/.test(normalized);
  if (!hasExtension) {
    for (const ext of RESOLUTION_EXTENSIONS) {
      candidates.push(`${normalized}${ext}`);
    }
    for (const ext of RESOLUTION_EXTENSIONS) {
      candidates.push(`${normalized}/index${ext}`);
    }
  }

  for (const candidate of candidates) {
    if (keys.has(candidate)) {
      return candidate;
    }
  }
  return normalized;
}

export function findLayerViolations({ graph, layers = DEFAULT_LAYER_RULES } = {}) {
  const graphKeys = new Set(Object.keys(graph || {}));
  const violations = [];
  for (const [source, edges] of Object.entries(graph || {}).sort(([a], [b]) =>
    a.localeCompare(b)
  )) {
    const sourceLayer = classifyLayer(source, layers);
    if (!sourceLayer || !Array.isArray(edges)) {
      continue;
    }
    for (const edge of edges.slice().sort()) {
      const target = resolveLocalEdge(edge, graphKeys);
      if (!target) {
        continue;
      }
      const targetLayer = classifyLayer(target, layers);
      if (!targetLayer) {
        continue;
      }
      if (targetLayer.rank > sourceLayer.rank) {
        violations.push({ source, target, sourceLayer, targetLayer });
      }
    }
  }
  return violations;
}

export async function runLayeringCheck({
  rootPath,
  files = null,
  layers = DEFAULT_LAYER_RULES,
} = {}) {
  const graph = await buildDependencyGraph({ rootPath, files });
  return findLayerViolations({ graph, layers }).map(
    ({ source, target, sourceLayer, targetLayer }) =>
      createFinding({
        tool: "layering-check",
        kind: "code-quality.layer-violation",
        severity: "P2",
        file: source,
        evidence: `${sourceLayer.name} imports higher ${targetLayer.name}: ${source} -> ${target}`,
        rootCause:
          "A lower-level module depends on a higher-level layer, which inverts the intended architecture boundary.",
        recommendedFix:
          "Move the shared contract into a lower layer or invert the dependency through an interface owned by the lower layer.",
        confidence: 0.78,
      })
  );
}
