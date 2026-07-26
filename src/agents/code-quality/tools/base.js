// Shared helpers for Ethan's (code-quality) domain tools (#A16).

import {
  DEFAULT_IGNORED_DIRS,
  MAX_FILE_SIZE_BYTES,
  SEVERITIES,
  createFinding as createDomainFinding,
  normalizeSeverity,
  toPosix,
  walkRepoFiles as walkDomainRepoFiles,
} from "../../shared-tools/domain-base.js";

const DEFAULT_PERSONA = "code-quality";

export {
  DEFAULT_IGNORED_DIRS,
  MAX_FILE_SIZE_BYTES,
  SEVERITIES,
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
