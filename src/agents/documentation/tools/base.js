// Shared helpers for Samir's (documentation) domain tools (#A23).

import {
  createFinding as createDomainFinding,
  toPosix,
  walkRepoFiles as walkDomainRepoFiles,
} from "../../shared-tools/domain-base.js";

const DEFAULT_PERSONA = "documentation";

export { toPosix };

export function createFinding(options = {}) {
  return createDomainFinding(options, {
    defaultPersona: DEFAULT_PERSONA,
    defaultKind: DEFAULT_PERSONA,
    severityFallback: "P3",
  });
}

export async function* walkRepoFiles(options = {}) {
  yield* walkDomainRepoFiles(options, { entryMetadata: "stat" });
}
