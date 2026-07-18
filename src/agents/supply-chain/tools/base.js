// Shared helpers for Dima's (supply-chain) domain tools (#A22).

import {
  createFinding as createDomainFinding,
  toPosix,
  walkRepoFiles as walkDomainRepoFiles,
} from "../../shared-tools/domain-base.js";

const DEFAULT_PERSONA = "supply-chain";

export { toPosix };

export function createFinding(options = {}) {
  return createDomainFinding(options, {
    defaultPersona: DEFAULT_PERSONA,
    defaultKind: DEFAULT_PERSONA,
  });
}

export async function* walkRepoFiles(options = {}) {
  yield* walkDomainRepoFiles(options);
}
