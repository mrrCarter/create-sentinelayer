// eval-regression — advise when LLM use is present but no eval suite (#A24).

import fsp from "node:fs/promises";
import path from "node:path";

import { createFinding, toPosix, walkRepoFiles } from "./base.js";

const LLM_SIGNALS = [
  /openai|anthropic|gemini|bedrock/i,
  /Messages\.create|ChatCompletion|chat\.completions|generateContent/,
  /createMultiProviderApiClient/,
];

export async function runEvalRegression({ rootPath } = {}) {
  const resolvedRoot = path.resolve(String(rootPath || "."));
  let hasLlm = false;
  let hasEval = false;
  for await (const { fullPath, relativePath } of walkRepoFiles({
    rootPath: resolvedRoot,
    extensions: new Set([".js", ".ts", ".tsx", ".jsx", ".mjs", ".cjs", ".py", ".yaml", ".yml", ".json"]),
  })) {
    const rel = toPosix(relativePath);
    if (/(^|\/)(evals?|evaluations?)\//i.test(rel)) hasEval = true;
    if (/(^|\/)promptfoo\./i.test(rel) || /(^|\/)\.promptfoo\./.test(rel)) hasEval = true;
    try {
      const content = await fsp.readFile(fullPath, "utf-8");
      if (LLM_SIGNALS.some((p) => p.test(content))) hasLlm = true;
    } catch {
      /* skip */
    }
    if (hasLlm && hasEval) break;
  }
  if (!hasLlm || hasEval) return [];
  return [
    createFinding({
      tool: "eval-regression",
      kind: "ai-governance.no-eval-suite",
      severity: "P1",
      file: "",
      line: 0,
      evidence: "LLM usage detected (openai/anthropic/gemini) but no evals/ or promptfoo config",
      rootCause: "Without a regression eval suite, prompt edits and model upgrades silently change behavior in production.",
      recommendedFix: "Ship an evals/ directory with promptfoo / lm-evaluation-harness test cases. Run on every prompt change and model version bump.",
      confidence: 0.7,
    }),
  ];
}
