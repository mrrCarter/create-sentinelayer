// Shared helpers for Arjun's (performance) domain tools (#A16).

import {
  DEFAULT_IGNORED_DIRS,
  MAX_FILE_SIZE_BYTES,
  SEVERITIES,
  createFinding as createDomainFinding,
  findLineMatches,
  getLineContent,
  iterateFiles,
  normalizeSeverity,
  toPosix,
  walkRepoFiles as walkDomainRepoFiles,
} from "../../shared-tools/domain-base.js";

const DEFAULT_PERSONA = "performance";

export {
  DEFAULT_IGNORED_DIRS,
  MAX_FILE_SIZE_BYTES,
  SEVERITIES,
  findLineMatches,
  getLineContent,
  iterateFiles,
  normalizeSeverity,
  toPosix,
};

export function createFinding(options = {}) {
  return createDomainFinding(options, {
    defaultPersona: DEFAULT_PERSONA,
    defaultKind: DEFAULT_PERSONA,
  });
}

export async function* walkRepoFiles(options = {}) {
  yield* walkDomainRepoFiles(options, { entryMetadata: "sizeBytes" });
}
