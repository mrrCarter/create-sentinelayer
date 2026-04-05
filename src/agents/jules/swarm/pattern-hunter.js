import { JulesSubAgent } from "./sub-agent.js";

const HUNTER_PROMPTS = {
  xss: `You are an XSS PatternHunter working for Jules Tanaka.
Search the codebase for Cross-Site Scripting vulnerabilities:
- dangerouslySetInnerHTML with user-controlled input
- innerHTML assignments
- v-html directives (Vue)
- dynamic code execution (the eval function) with user input
- document write injection
- javascript: URLs in href
- template literal injection in HTML contexts

Use Grep and FrontendAnalyze('find_security_sinks') to find all matches.
For each match, determine if the input is user-controlled or sanitized.
Return findings as JSON array: [{ "file", "line", "type", "severity", "userControlled", "sanitized", "evidence" }]`,

  state: `You are a State Management PatternHunter working for Jules Tanaka.
Search for React state anti-patterns:
- Components with 16+ useState calls (god components)
- useEffect with empty deps that references state (stale closures)
- useEffect without cleanup return (subscription/timer leaks)
- State updates in loops (N re-renders)
- Object/array in useEffect dependency array (new reference each render)
- Derived state stored in useState (should be computed)

Use Grep and FrontendAnalyze('count_state_hooks', 'find_missing_cleanup', 'find_stale_closures').
Return findings as JSON array: [{ "file", "line", "type", "severity", "pattern", "evidence" }]`,

  hydration: `You are a Hydration Safety PatternHunter working for Jules Tanaka.
Search for SSR/CSR hydration mismatch risks:
- window/document/localStorage access during initial render (outside useEffect)
- Date.now() or Math.random() in render path (non-deterministic)
- suppressHydrationWarning without justification
- useLayoutEffect in server components
- Dynamic imports crossing server/client boundaries
- Locale/theme/auth state that can differ server vs client

Use Grep to find these patterns in .tsx/.jsx files.
Return findings as JSON array: [{ "file", "line", "type", "severity", "pattern", "evidence" }]`,

  a11y: `You are an Accessibility PatternHunter working for Jules Tanaka.
Search for WCAG AA accessibility violations:
- Images without alt text
- Form inputs without labels (no <label> or aria-label)
- Buttons/links without accessible text
- Missing keyboard handlers on interactive divs (onClick without onKeyDown)
- tabIndex=-1 removing elements from tab order
- Missing focus management in modals/drawers
- Poor color contrast indicators (hardcoded light gray text)
- Missing skip navigation link
- aria-hidden on interactive elements

Use Grep and FrontendAnalyze('check_accessibility').
Return findings as JSON array: [{ "file", "line", "type", "severity", "wcag", "userImpact", "evidence" }]`,

  perf: `You are a Performance PatternHunter working for Jules Tanaka.
Search for frontend performance anti-patterns:
- Large bundle imports (moment, lodash full import, d3 full import)
- Images without explicit dimensions (CLS risk)
- Fonts without font-display strategy
- Third-party scripts on critical render path
- Missing React.memo on list item components
- Inline arrow functions in map() JSX
- Large lists without virtualization
- Blocking script tags without async/defer

Use Grep, FrontendAnalyze('check_image_optimization', 'check_font_loading', 'find_third_party_scripts').
Return findings as JSON array: [{ "file", "line", "type", "severity", "impact", "evidence" }]`,

  security: `You are a Frontend Security PatternHunter working for Jules Tanaka.
Search for frontend-specific security issues:
- API keys in NEXT_PUBLIC_/VITE_/REACT_APP_ env vars (especially _KEY, _SECRET, _TOKEN)
- Missing Content-Security-Policy headers
- Missing X-Frame-Options / frame-ancestors
- CORS * wildcard on sensitive endpoints
- Tokens stored in localStorage (vs httpOnly cookies)
- Missing CSRF protection on state-changing forms
- Source maps enabled in production build config

Use Grep, FrontendAnalyze('find_env_exposure', 'check_security_headers').
Return findings as JSON array: [{ "file", "line", "type", "severity", "cwe", "evidence" }]`,
};

/**
 * Create a PatternHunter sub-agent for a specific issue class.
 *
 * @param {object} config
 * @param {"xss"|"state"|"hydration"|"a11y"|"perf"|"security"} config.huntType
 * @param {string} config.rootPath - Codebase root to search
 * @param {object} config.budget
 * @param {object} config.blackboard
 * @param {object} [config.provider]
 * @param {AbortController} [config.parentAbort]
 * @param {function} [config.onEvent]
 */
export function createPatternHunter(config) {
  const prompt = HUNTER_PROMPTS[config.huntType];
  if (!prompt) {
    throw new Error(`Unknown hunt type: ${config.huntType}. Valid: ${Object.keys(HUNTER_PROMPTS).join(", ")}`);
  }

  return new JulesSubAgent({
    id: `hunter-${config.huntType}-${Date.now()}`,
    role: `PatternHunter-${config.huntType}`,
    systemPrompt: prompt,
    allowedTools: ["Grep", "Glob", "FrontendAnalyze", "FileRead"],
    scope: { patterns: [config.huntType], rootPath: config.rootPath },
    budget: config.budget || {
      maxCostUsd: 0.3,
      maxOutputTokens: 2000,
      maxRuntimeMs: 60000,
      maxToolCalls: 20,
    },
    blackboard: config.blackboard,
    maxTurns: 5,
    provider: config.provider,
    parentAbort: config.parentAbort,
    onEvent: config.onEvent,
  });
}

export const HUNT_TYPES = Object.keys(HUNTER_PROMPTS);
