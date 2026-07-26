// Shared helpers for Amina's (ai-governance) domain tools (#A24).

import {
  createFinding as createDomainFinding,
  findLineMatches,
  getLineContent,
  toPosix,
  walkRepoFiles as walkDomainRepoFiles,
} from "../../shared-tools/domain-base.js";

const DEFAULT_PERSONA = "ai-governance";

export { findLineMatches, getLineContent, toPosix };

export function createFinding(options = {}) {
  return createDomainFinding(options, {
    defaultPersona: DEFAULT_PERSONA,
    defaultKind: DEFAULT_PERSONA,
  });
}

export async function* walkRepoFiles(options = {}) {
  yield* walkDomainRepoFiles(options, { entryMetadata: "stat" });
}
