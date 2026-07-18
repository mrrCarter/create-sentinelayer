// Shared helpers for Nina's (security) domain tools (#A13).

import {
  DEFAULT_IGNORED_DIRS,
  MAX_FILE_SIZE_BYTES,
  SEVERITIES,
  createFinding as createDomainFinding,
  evidenceAroundMatch,
  lineNumberOf,
  normalizeSeverity,
  toPosix,
  walkRepoFiles as walkDomainRepoFiles,
} from "../../shared-tools/domain-base.js";

const DEFAULT_PERSONA = "security";

export {
  DEFAULT_IGNORED_DIRS,
  MAX_FILE_SIZE_BYTES,
  SEVERITIES,
  evidenceAroundMatch,
  lineNumberOf,
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
