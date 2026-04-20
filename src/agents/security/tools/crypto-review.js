// crypto-review — flag weak crypto and insecure randomness (#A13).
//
// Scope:
//   - Deprecated hash algorithms (md5, sha1) used for anything security-ish
//   - Math.random / rand() used in security contexts (tokens, IDs, nonces)
//   - TLS verification disabled (rejectUnauthorized=false,
//     verify=false, InsecureSkipVerify)
//   - Hardcoded initialization vectors / salts
//
// We keep rules conservative (high confidence, narrow patterns) so this
// tool is deterministic enough to run unsupervised without spamming false
// positives. The persona LLM can widen the net later.

import fsp from "node:fs/promises";
import path from "node:path";

import { createFinding, walkRepoFiles } from "./base.js";

const CODE_EXTENSIONS = new Set([
  ".js",
  ".jsx",
  ".ts",
  ".tsx",
  ".mjs",
  ".cjs",
  ".py",
  ".go",
  ".rb",
  ".java",
  ".kt",
]);

const RULES = [
  {
    id: "crypto.md5",
    pattern: /createHash\s*\(\s*['"]md5['"]\s*\)|hashlib\.md5\s*\(|MessageDigest\.getInstance\s*\(\s*['"]MD5/i,
    severity: "P1",
    rootCause:
      "MD5 is collision-broken and MUST NOT be used for authentication, signing, or integrity outside of legacy interop.",
    recommendedFix:
      "Use SHA-256 (crypto.createHash('sha256'), hashlib.sha256, MessageDigest.getInstance('SHA-256')).",
    confidence: 0.85,
  },
  {
    id: "crypto.sha1",
    pattern: /createHash\s*\(\s*['"]sha1['"]\s*\)|hashlib\.sha1\s*\(|MessageDigest\.getInstance\s*\(\s*['"]SHA-?1/i,
    severity: "P1",
    rootCause:
      "SHA-1 is collision-vulnerable (SHAttered) and deprecated for signatures / certificates.",
    recommendedFix:
      "Switch to SHA-256 or SHA-512 for any security-sensitive hash use.",
    confidence: 0.8,
  },
  {
    id: "crypto.math-random-security",
    pattern: /(?:token|secret|nonce|salt|session|reset(?:Code|Token)|otp|uuid)\s*[:=][^;\n]*Math\.random\s*\(/i,
    severity: "P0",
    rootCause:
      "Math.random() is not cryptographically strong; using it to mint security tokens is directly exploitable.",
    recommendedFix:
      "Use crypto.randomUUID() or crypto.randomBytes(n).toString('hex') for security-sensitive random values.",
    confidence: 0.9,
  },
  {
    id: "crypto.tls-reject-off",
    pattern: /rejectUnauthorized\s*:\s*false|NODE_TLS_REJECT_UNAUTHORIZED\s*=\s*['"]?0['"]?/,
    severity: "P0",
    rootCause:
      "Disabling TLS certificate verification defeats the point of TLS — MITM on the wire goes undetected.",
    recommendedFix:
      "Keep rejectUnauthorized at its default of true. Pin a CA bundle if you're talking to a self-signed endpoint.",
    confidence: 0.95,
  },
  {
    id: "crypto.python-verify-off",
    pattern: /verify\s*=\s*False|requests\.[a-z]+\([^)]*verify\s*=\s*False/,
    severity: "P0",
    rootCause:
      "verify=False in requests / urllib disables TLS hostname and chain verification — strictly worse than plain HTTP.",
    recommendedFix:
      "Remove verify=False. Pin a custom CA bundle via verify='/path/to/ca.pem' if your target is self-signed.",
    confidence: 0.9,
  },
  {
    id: "crypto.go-insecure-skip-verify",
    pattern: /InsecureSkipVerify\s*:\s*true/,
    severity: "P0",
    rootCause:
      "tls.Config{InsecureSkipVerify: true} disables TLS certificate validation — MITM risk.",
    recommendedFix:
      "Remove the InsecureSkipVerify override. If interop requires it, load a trusted CA via tls.Config.RootCAs instead.",
    confidence: 0.95,
  },
  {
    id: "crypto.hardcoded-iv",
    pattern: /createCipheriv\s*\([^)]*['"][A-Fa-f0-9]{16,}['"]/,
    severity: "P1",
    rootCause:
      "Hardcoded IV to a cipher like AES-CBC / AES-GCM breaks semantic security — encrypting the same plaintext twice is detectable.",
    recommendedFix:
      "Generate a fresh IV with crypto.randomBytes(iv_len) per encryption and prepend to ciphertext.",
    confidence: 0.75,
  },
];

export async function runCryptoReview({ rootPath, files = null } = {}) {
  const resolvedRoot = path.resolve(String(rootPath || "."));
  const iterator =
    Array.isArray(files) && files.length > 0
      ? iterateExplicitFiles(resolvedRoot, files)
      : walkRepoFiles({ rootPath: resolvedRoot, extensions: CODE_EXTENSIONS });

  const findings = [];
  for await (const { fullPath, relativePath } of iterator) {
    let content;
    try {
      content = await fsp.readFile(fullPath, "utf-8");
    } catch {
      continue;
    }
    const lines = content.split(/\r?\n/);
    for (const rule of RULES) {
      const global = new RegExp(
        rule.pattern.source,
        rule.pattern.flags.includes("g") ? rule.pattern.flags : `${rule.pattern.flags}g`
      );
      let match;
      while ((match = global.exec(content)) !== null) {
        const lineIndex = content.slice(0, match.index).split(/\r?\n/).length;
        const evidence = (lines[lineIndex - 1] || "").trim().slice(0, 200);
        findings.push(
          createFinding({
            tool: "crypto-review",
            kind: rule.id,
            severity: rule.severity,
            file: relativePath,
            line: lineIndex,
            evidence,
            rootCause: rule.rootCause,
            recommendedFix: rule.recommendedFix,
            confidence: rule.confidence,
          })
        );
      }
    }
  }
  return findings;
}

async function* iterateExplicitFiles(resolvedRoot, files) {
  for (const file of files) {
    const trimmed = String(file || "").trim();
    if (!trimmed) {
      continue;
    }
    const fullPath = path.isAbsolute(trimmed)
      ? trimmed
      : path.join(resolvedRoot, trimmed);
    const relativePath = path
      .relative(resolvedRoot, fullPath)
      .replace(/\\/g, "/");
    yield { fullPath, relativePath };
  }
}

export { RULES as CRYPTO_RULES };
