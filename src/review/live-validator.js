/**
 * Live-web validator for investor-DD (#investor-dd-25..28).
 *
 * Jules owns this lane. For each interactive element discovered by
 * scanning the frontend source (buttons, forms, links), the validator
 * provisions an ephemeral AIdenID identity, drives devTestBot to
 * perform the interaction against the running site, and captures:
 *
 *   - the observed HTTP status
 *   - console errors
 *   - network errors
 *   - navigation outcome
 *   - a short free-form observed-behavior summary
 *   - trace + video URIs (supplied by devTestBot)
 *
 * The module is driven through a pluggable client surface so the main
 * flow can be unit-tested without spinning up a real browser and a
 * real AIdenID tenant. Production wiring is a separate PR that swaps
 * the stub client for the real devTestBot + AIdenID SDKs.
 */

import fsp from "node:fs/promises";
import path from "node:path";

const INTERACTIVE_TAGS = Object.freeze([
  "button",
  "a",
  "input",
  "form",
  "select",
  "textarea",
]);

const SOURCE_EXTENSIONS = Object.freeze([".tsx", ".jsx", ".html", ".vue", ".svelte"]);

/**
 * Walk the frontend directory and extract candidate interactive
 * elements from JSX/HTML-like files. Deliberately simple regex-based
 * extraction; misses dynamic elements. Caller can fall back to a live
 * DOM crawl when static extraction returns < 80% of expected element
 * counts.
 *
 * @param {string} rootPath
 * @param {string[]} [globLike]  Optional include roots (default common frontend folders).
 * @returns {Promise<Array<{elementLabel: string, sourceFile: string, lineIndex: number}>>}
 */
export async function discoverInteractiveElements(rootPath, globLike = null) {
  const candidateRoots = globLike || [
    "src",
    "app",
    "pages",
    "components",
    "web",
    "frontend",
    "client",
  ];
  const elements = [];
  for (const candidate of candidateRoots) {
    const abs = path.join(rootPath, candidate);
    try {
      await fsp.access(abs);
    } catch {
      continue;
    }
    await walk(abs, candidate);
  }
  return elements;

  async function walk(abs, rel) {
    let entries;
    try {
      entries = await fsp.readdir(abs, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.name.startsWith(".")) continue;
      const absPath = path.join(abs, entry.name);
      const relPath = `${rel}/${entry.name}`;
      if (entry.isDirectory()) {
        if (entry.name === "node_modules" || entry.name === "dist") continue;
        await walk(absPath, relPath);
      } else if (entry.isFile()) {
        const ext = path.extname(entry.name).toLowerCase();
        if (!SOURCE_EXTENSIONS.includes(ext)) continue;
        try {
          const stat = await fsp.stat(absPath);
          if (stat.size > 512 * 1024) continue;
          const text = await fsp.readFile(absPath, "utf-8");
          extractFromText(text, relPath, elements);
        } catch {
          // skip unreadable
        }
      }
    }
  }
}

function extractFromText(text, sourceFile, elements) {
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    for (const tag of INTERACTIVE_TAGS) {
      // Match both lowercase and Capitalized component forms; avoid
      // overmatching by requiring a tag-like opener.
      const re = new RegExp(`<${tag}[\\s>]|<${tag[0].toUpperCase()}${tag.slice(1)}[\\s>]`, "i");
      if (!re.test(line)) continue;
      const labelMatch =
        /(?:aria-label|title|data-testid|id)="([^"]+)"/i.exec(line) ||
        />([^<]{1,40})</.exec(line);
      const elementLabel = labelMatch ? labelMatch[1].trim() : `${tag}-anon-${i}`;
      elements.push({
        elementLabel,
        sourceFile,
        lineIndex: i + 1,
      });
      break;
    }
  }
}

/**
 * @typedef {object} DevTestBotClient
 * @property {(element: {elementLabel: string, sourceFile: string}, identity: object) => Promise<LiveObservation>} interact
 * @property {(runId: string) => Promise<{videoUri: string, traceUri: string}>} [artifact]
 */

/**
 * @typedef {object} AidenidClient
 * @property {(runId: string) => Promise<{identityId: string, email: string}>} provisionEphemeralIdentity
 * @property {(identityId: string) => Promise<void>} [release]
 */

/**
 * Run the live validator across the discovered element plan.
 *
 * @param {object} params
 * @param {string} params.runId
 * @param {Array<{elementLabel: string, sourceFile: string}>} params.elements
 * @param {DevTestBotClient} params.devTestBot
 * @param {AidenidClient} params.aidenid
 * @param {Function} [params.onEvent]
 * @param {number} [params.maxInteractions]  - Cap; defaults to elements.length.
 * @returns {Promise<{identity: object, observations: Array<object>, skipped: number}>}
 */
export async function runLiveValidator({
  runId,
  elements,
  devTestBot,
  aidenid,
  onEvent = () => {},
  maxInteractions = Infinity,
} = {}) {
  if (!runId) throw new TypeError("runLiveValidator requires runId");
  if (!Array.isArray(elements)) throw new TypeError("runLiveValidator requires elements array");
  if (!devTestBot || typeof devTestBot.interact !== "function") {
    throw new TypeError("runLiveValidator requires a devTestBot client with interact()");
  }
  if (!aidenid || typeof aidenid.provisionEphemeralIdentity !== "function") {
    throw new TypeError(
      "runLiveValidator requires an AIdenID client with provisionEphemeralIdentity()",
    );
  }

  onEvent({ type: "live_validator_start", runId, elementCount: elements.length });
  const identity = await aidenid.provisionEphemeralIdentity(runId);
  onEvent({ type: "live_validator_identity_ready", runId, identityId: identity.identityId });

  const observations = [];
  let skipped = 0;
  const budget = Number.isFinite(maxInteractions) ? maxInteractions : elements.length;
  for (let i = 0; i < Math.min(elements.length, budget); i += 1) {
    const element = elements[i];
    onEvent({ type: "live_validator_interaction_start", runId, element });
    try {
      const obs = await devTestBot.interact(element, identity);
      const enriched = {
        ...obs,
        sourceFile: element.sourceFile,
        elementLabel: element.elementLabel,
        interactionId: obs.interactionId || `${element.sourceFile}#${i}`,
      };
      observations.push(enriched);
      onEvent({
        type: "live_validator_interaction_complete",
        runId,
        interactionId: enriched.interactionId,
      });
    } catch (err) {
      skipped += 1;
      onEvent({
        type: "live_validator_interaction_error",
        runId,
        element,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  if (typeof aidenid.release === "function") {
    try {
      await aidenid.release(identity.identityId);
    } catch {
      // release errors never block the report
    }
  }

  onEvent({
    type: "live_validator_complete",
    runId,
    observationCount: observations.length,
    skipped,
  });
  return { identity, observations, skipped };
}

/**
 * Build a lookup map keyed by `sourceFile:lineIndex` so the
 * reconciliation engine can pair each source finding with 0 or 1
 * matching live observation.
 *
 * @param {Array<{sourceFile: string, lineIndex?: number, interactionId: string}>} observations
 * @returns {Map<string, object>}
 */
export function buildObservationIndex(observations) {
  const map = new Map();
  for (const obs of observations || []) {
    if (!obs.sourceFile) continue;
    const fileKey = obs.sourceFile;
    if (obs.lineIndex) {
      map.set(`${fileKey}:${obs.lineIndex}`, obs);
    }
    if (!map.has(fileKey)) {
      map.set(fileKey, obs);
    }
  }
  return map;
}

/**
 * Pair function factory for reconcileFindings(). Looks up an
 * observation for each finding by (file, line) or (file) fallback.
 *
 * @param {Map<string, object>} index
 * @returns {(finding: object) => object | null}
 */
export function createFindingObservationPair(index) {
  return (finding) => {
    if (!finding || !finding.file) return null;
    const key = finding.line ? `${finding.file}:${finding.line}` : finding.file;
    return index.get(key) || index.get(finding.file) || null;
  };
}
