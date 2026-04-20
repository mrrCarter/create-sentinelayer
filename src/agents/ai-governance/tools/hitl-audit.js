// hitl-audit — advise when LLM output is acted on without human-in-the-loop (#A24).

import fsp from "node:fs/promises";
import path from "node:path";

import { createFinding, findLineMatches, getLineContent, toPosix, walkRepoFiles } from "./base.js";

const CODE_EXTENSIONS = new Set([".js", ".jsx", ".ts", ".tsx", ".mjs", ".cjs", ".py"]);

const LLM_CALL_PATTERNS = [
  /Messages\.create\s*\(/,
  /chat\.completions\.create\s*\(/,
  /generateContent\s*\(/,
  /createMultiProviderApiClient\s*\(/,
];

const ACTION_PATTERNS = [
  /exec(?:Sync)?\s*\(/,
  /spawn(?:Sync)?\s*\(/,
  /fs\.(?:unlink|unlinkSync|rm|rmSync|writeFile|writeFileSync|rename|renameSync)\s*\(/,
  /db\.(?:update|delete|drop|truncate|raw)\s*\(/,
  /fetch\s*\([^)]*method\s*:\s*['"](?:POST|PUT|DELETE|PATCH)['"]/,
];

const APPROVAL_SIGNALS = [
  /human[_-]?in[_-]?(?:the[_-]?)?loop|HITL/i,
  /await\s+(?:confirm|approval|operatorApprov|humanReview)/i,
  /requires?[_-]?approval|needs[_-]?approval/i,
  /await\s+prompts?\s*\(/,
];

export async function runHitlAudit({ rootPath, files = null } = {}) {
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
    const hasLlm = LLM_CALL_PATTERNS.some((p) => p.test(content));
    if (!hasLlm) continue;
    const hasAction = ACTION_PATTERNS.some((p) => p.test(content));
    if (!hasAction) continue;
    const hasApproval = APPROVAL_SIGNALS.some((p) => p.test(content));
    if (hasApproval) continue;
    const match = findLineMatches(content, ACTION_PATTERNS[0])[0] ||
      findLineMatches(content, ACTION_PATTERNS[1])[0] ||
      findLineMatches(content, ACTION_PATTERNS[2])[0];
    findings.push(
      createFinding({
        tool: "hitl-audit",
        kind: "ai-governance.no-hitl",
        severity: "P1",
        file: toPosix(relativePath),
        line: match?.line || 1,
        evidence: getLineContent(content, match?.line || 1),
        rootCause: "File calls an LLM then takes a destructive / mutating action with no human-in-the-loop confirmation. A jailbroken prompt becomes an arbitrary operation.",
        recommendedFix: "Gate high-impact actions on explicit operator approval (`await confirmWithOperator(plan)`), or run them inside a sandbox with narrow permissions and a review queue.",
        confidence: 0.5,
      })
    );
  }
  return findings;
}

async function* iterateExplicitFiles(resolvedRoot, files) {
  for (const file of files) {
    const trimmed = String(file || "").trim();
    if (!trimmed) continue;
    const fullPath = path.isAbsolute(trimmed) ? trimmed : path.join(resolvedRoot, trimmed);
    const relativePath = path.relative(resolvedRoot, fullPath).replace(/\\/g, "/");
    yield { fullPath, relativePath };
  }
}
