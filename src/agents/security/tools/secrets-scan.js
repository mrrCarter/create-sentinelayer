// secrets-scan — filesystem scan for credentials (#A13).
//
// Mirrors the highest-confidence rules from gitleaks / trufflehog so the
// tool can run without external binaries. When gitleaks is installed it
// shadows this, but the zero-dep fallback keeps persona dispatch honest
// on stripped-down runners.

import fsp from "node:fs/promises";
import path from "node:path";

import { createFinding, walkRepoFiles } from "./base.js";

const DEFAULT_EXTENSIONS = new Set([
  ".js",
  ".jsx",
  ".ts",
  ".tsx",
  ".mjs",
  ".cjs",
  ".py",
  ".go",
  ".rb",
  ".rs",
  ".java",
  ".kt",
  ".yaml",
  ".yml",
  ".json",
  ".toml",
  ".env",
  ".env.local",
  ".env.production",
  ".sh",
  ".bash",
  // Extensionless files like id_rsa / id_ed25519 / .pem with no extension
  // frequently contain secrets; let the walker yield them too.
  "",
  ".pem",
  ".key",
  ".crt",
]);

// Each rule captures (a) regex to detect the secret, (b) entropy floor (to
// filter placeholder values like "X"*40), (c) severity and description.
const RULES = [
  {
    id: "secret.aws-access-key",
    pattern: /\bAKIA[0-9A-Z]{16}\b/,
    severity: "P0",
    minEntropy: 3.0,
    description:
      "AWS Access Key ID committed to the repo — rotate and revoke immediately.",
  },
  {
    id: "secret.aws-secret-access-key",
    pattern: /aws_secret_access_key\s*[:=]\s*['"]?[A-Za-z0-9/+=]{40}['"]?/i,
    severity: "P0",
    minEntropy: 4.0,
    description: "AWS secret access key assignment with 40-char token shape.",
  },
  {
    id: "secret.github-token",
    pattern: /\bgh[ps]_[A-Za-z0-9]{36}\b/,
    severity: "P0",
    minEntropy: 3.5,
    description: "GitHub personal / PAT token committed to the repo.",
  },
  {
    id: "secret.slack-token",
    pattern: /\bxox[aboprs]-[A-Za-z0-9-]{10,}\b/,
    severity: "P0",
    minEntropy: 3.5,
    description: "Slack token (bot/app/workflow) — revoke via Slack admin.",
  },
  {
    id: "secret.openai-api-key",
    pattern: /\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}\b/,
    severity: "P0",
    minEntropy: 3.0,
    description:
      "OpenAI API key committed to the repo — revoke in the OpenAI dashboard.",
  },
  {
    id: "secret.anthropic-api-key",
    pattern: /\bsk-ant-[A-Za-z0-9_-]{20,}\b/,
    severity: "P0",
    minEntropy: 3.0,
    description: "Anthropic API key committed to the repo.",
  },
  {
    id: "secret.stripe-secret-key",
    pattern: /\bsk_(?:live|test)_[A-Za-z0-9]{24,}\b/,
    severity: "P0",
    minEntropy: 3.5,
    description:
      "Stripe secret key committed. Test keys still expose test-mode customers.",
  },
  {
    id: "secret.private-key-block",
    pattern: /-----BEGIN (?:RSA |DSA |EC |OPENSSH |PGP )?PRIVATE KEY-----/,
    severity: "P0",
    minEntropy: 0, // PEM block is unambiguous without entropy check
    description:
      "Private key block embedded in source — rotate and remove from history.",
  },
  {
    id: "secret.generic-hardcoded",
    pattern: /(?:api[_-]?key|secret|token|password|passwd)\s*[:=]\s*['"][A-Za-z0-9_\-]{16,}['"]/i,
    severity: "P1",
    minEntropy: 3.2,
    description:
      "High-entropy hardcoded credential assigned to a security-sounding identifier.",
  },
];

function shannonEntropy(str) {
  const text = String(str || "");
  if (!text) {
    return 0;
  }
  const freq = new Map();
  for (const ch of text) {
    freq.set(ch, (freq.get(ch) || 0) + 1);
  }
  const len = text.length;
  let entropy = 0;
  for (const count of freq.values()) {
    const p = count / len;
    entropy -= p * Math.log2(p);
  }
  return entropy;
}

function extractToken(match) {
  // Pull the first contiguous token-ish substring from the match so we can
  // measure entropy on the actual secret instead of surrounding assignment
  // boilerplate.
  const text = String(match || "");
  const token = text.match(/[A-Za-z0-9_\-./+=]{10,}/);
  return token ? token[0] : text;
}

export async function runSecretsScan({ rootPath, files = null } = {}) {
  const resolvedRoot = path.resolve(String(rootPath || "."));
  const iterator =
    Array.isArray(files) && files.length > 0
      ? iterateExplicitFiles(resolvedRoot, files)
      : walkRepoFiles({ rootPath: resolvedRoot, extensions: DEFAULT_EXTENSIONS });

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
      const global = new RegExp(rule.pattern.source, rule.pattern.flags.includes("g") ? rule.pattern.flags : `${rule.pattern.flags}g`);
      let match;
      while ((match = global.exec(content)) !== null) {
        const token = extractToken(match[0]);
        const entropy = shannonEntropy(token);
        if (rule.minEntropy > 0 && entropy < rule.minEntropy) {
          continue;
        }
        const lineIndex = content.slice(0, match.index).split(/\r?\n/).length;
        const evidence = (lines[lineIndex - 1] || "").trim().slice(0, 200);
        findings.push(
          createFinding({
            tool: "secrets-scan",
            kind: rule.id,
            severity: rule.severity,
            file: relativePath,
            line: lineIndex,
            evidence: redactEvidence(evidence, token),
            rootCause: rule.description,
            recommendedFix:
              "Revoke the credential at the provider, rotate to a new secret, and store it in your secret manager (never in source).",
            confidence: Math.max(0.7, Math.min(1, entropy / 5)),
          })
        );
      }
    }
  }
  return findings;
}

function redactEvidence(line, token) {
  if (!token || token.length < 12) {
    return line;
  }
  // Show first 6 + "..." so reviewers can recognize the key family without
  // re-exposing the full secret in logs.
  const redacted = `${token.slice(0, 6)}...${token.slice(-2)}`;
  return line.replace(token, redacted);
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

export { RULES as SECRETS_RULES };
