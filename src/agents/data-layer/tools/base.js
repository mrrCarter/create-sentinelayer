// Shared helpers for Imani's (data-layer) domain tools (#A17).

import {
  DEFAULT_IGNORED_DIRS,
  MAX_FILE_SIZE_BYTES,
  SEVERITIES,
  createFinding as createDomainFinding,
  findLineMatches,
  getLineContent,
  normalizeSeverity,
  toPosix,
  walkRepoFiles as walkDomainRepoFiles,
} from "../../shared-tools/domain-base.js";

const DEFAULT_PERSONA = "data-layer";

export {
  DEFAULT_IGNORED_DIRS,
  MAX_FILE_SIZE_BYTES,
  SEVERITIES,
  findLineMatches,
  getLineContent,
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
  yield* walkDomainRepoFiles(options);
}
