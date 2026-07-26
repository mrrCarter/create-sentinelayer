// Shared helpers for Priya's (testing) domain tools (#A15).

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

const DEFAULT_PERSONA = "testing";

const TEST_FILE_PATTERNS = [
  /\.test\.(js|jsx|ts|tsx|mjs|cjs)$/,
  /\.spec\.(js|jsx|ts|tsx|mjs|cjs)$/,
  /(^|\/)tests?\//,
  /(^|\/)__tests__\//,
  /_test\.py$/,
  /\.test\.py$/,
  /(^|\/)tests?\/[^/]*\.py$/,
];

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
  yield* walkDomainRepoFiles(options, { entryMetadata: "stat" });
}

export function isTestFile(relativePath) {
  const normalized = toPosix(relativePath);
  return TEST_FILE_PATTERNS.some((pattern) => pattern.test(normalized));
}
