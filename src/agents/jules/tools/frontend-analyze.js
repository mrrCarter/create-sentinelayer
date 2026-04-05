import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { glob as globTool } from "./glob.js";
import { grep as grepTool } from "./grep.js";
import { fileRead } from "./file-read.js";

/**
 * FrontendAnalyze — 24 deterministic operations for the Jules Tanaka persona.
 * Each operation runs regex + file-system analysis. No LLM calls.
 * Saves Jules 3-5 tool calls per audit lens by bundling common frontend patterns.
 */

const OPERATIONS = new Set([
  "detect_framework", "find_components", "find_routes", "find_hooks",
  "find_providers", "find_security_sinks", "count_state_hooks",
  "check_bundle_config", "check_security_headers", "find_env_exposure",
  "find_missing_cleanup", "find_stale_closures", "check_accessibility",
  "check_mobile_responsive", "find_test_coverage", "scope_graph",
  "check_error_boundaries", "audit_npm_deps", "check_image_optimization",
  "check_font_loading", "find_third_party_scripts", "check_service_workers",
  "check_realtime_connections", "check_css_health",
]);

/**
 * @param {{ operation: string, path?: string, format?: string }} input
 * @returns {object} Structured JSON result per operation.
 */
export function frontendAnalyze(input) {
  if (!input.operation || !OPERATIONS.has(input.operation)) {
    throw new FrontendAnalyzeError(
      `Unknown operation: ${input.operation}. Valid: ${[...OPERATIONS].join(", ")}`,
    );
  }
  const rootPath = input.path ? path.resolve(input.path) : process.cwd();
  if (!fs.existsSync(rootPath)) {
    throw new FrontendAnalyzeError(`Path not found: ${rootPath}`);
  }
  return DISPATCH[input.operation](rootPath);
}

// ── Operations ───────────────────────────────────────────────────────

const DISPATCH = {
  detect_framework: detectFramework,
  find_components: findComponents,
  find_routes: findRoutes,
  find_hooks: findHooks,
  find_providers: findProviders,
  find_security_sinks: findSecuritySinks,
  count_state_hooks: countStateHooks,
  check_bundle_config: checkBundleConfig,
  check_security_headers: checkSecurityHeaders,
  find_env_exposure: findEnvExposure,
  find_missing_cleanup: findMissingCleanup,
  find_stale_closures: findStaleClosures,
  check_accessibility: checkAccessibility,
  check_mobile_responsive: checkMobileResponsive,
  find_test_coverage: findTestCoverage,
  scope_graph: scopeGraph,
  check_error_boundaries: checkErrorBoundaries,
  audit_npm_deps: auditNpmDeps,
  check_image_optimization: checkImageOptimization,
  check_font_loading: checkFontLoading,
  find_third_party_scripts: findThirdPartyScripts,
  check_service_workers: checkServiceWorkers,
  check_realtime_connections: checkRealtimeConnections,
  check_css_health: checkCssHealth,
};

function detectFramework(rootPath) {
  const pkg = readPackageJson(rootPath);
  const deps = { ...pkg.dependencies, ...pkg.devDependencies };
  const framework = detectFromDeps(deps);
  const files = safeGlob("*.{tsx,jsx,vue,svelte,ts,js}", rootPath);
  const testFiles = safeGlob("*.{test,spec}.{tsx,jsx,ts,js,mjs}", rootPath);
  return {
    framework: framework.name,
    version: deps[framework.pkg] || null,
    router: detectRouter(rootPath, deps),
    typescript: !!deps.typescript,
    stateManagement: detectState(deps),
    styling: detectStyling(deps, rootPath),
    testing: {
      unit: detectTestRunner(deps),
      e2e: detectE2eRunner(deps),
      component: deps["@testing-library/react"] ? "testing-library" : null,
    },
    packageManager: detectPackageManager(rootPath),
    linting: detectLinters(deps),
    entryPoints: detectEntryPoints(rootPath, framework.name),
    componentCount: files.filenames.filter(f => /\.(tsx|jsx|vue|svelte)$/.test(f)).length,
    hookCount: countCustomHooks(rootPath),
    providerCount: countProviders(rootPath),
    totalFrontendLoc: estimateFrontendLoc(rootPath),
  };
}

function findComponents(rootPath) {
  const files = safeGlob("*.{tsx,jsx,vue,svelte}", rootPath);
  return {
    components: files.filenames.map(f => ({
      path: f,
      name: path.basename(f, path.extname(f)),
      type: path.extname(f).slice(1),
    })),
    count: files.numFiles,
  };
}

function findRoutes(rootPath) {
  const routes = [];
  // Next.js App Router
  for (const dir of ["src/app", "app"]) {
    const pages = safeGlob("**/page.{tsx,jsx,ts,js}", path.join(rootPath, dir));
    pages.filenames.forEach(f => routes.push({ path: `/${path.dirname(f)}`, file: path.join(dir, f), type: "next-app" }));
  }
  // Next.js Pages Router
  for (const dir of ["src/pages", "pages"]) {
    const pages = safeGlob("**/*.{tsx,jsx,ts,js}", path.join(rootPath, dir));
    pages.filenames.filter(f => !f.startsWith("api/") && !f.startsWith("_")).forEach(f =>
      routes.push({ path: `/${f.replace(/\.(tsx|jsx|ts|js)$/, "").replace(/\/index$/, "")}`, file: path.join(dir, f), type: "next-pages" }),
    );
  }
  // Generic index files
  if (routes.length === 0) {
    for (const entry of ["src/index.tsx", "src/index.jsx", "src/main.tsx", "src/main.jsx", "index.html"]) {
      if (fs.existsSync(path.join(rootPath, entry))) routes.push({ path: "/", file: entry, type: "spa" });
    }
  }
  return { routes, count: routes.length };
}

function findHooks(rootPath) {
  const result = safeGrep("export\\s+(default\\s+)?function\\s+use[A-Z]", rootPath, "*.{ts,tsx,js,jsx}");
  const hooks = result.content.split("\n").filter(Boolean).map(line => {
    const match = line.match(/^(.+?):(\d+):.*function\s+(use\w+)/);
    return match ? { file: match[1], line: parseInt(match[2]), name: match[3] } : null;
  }).filter(Boolean);
  return { hooks, count: hooks.length };
}

function findProviders(rootPath) {
  const result = safeGrep("createContext|React\\.createContext|<\\w+Provider", rootPath, "*.{tsx,jsx,ts,js}");
  const providers = result.content.split("\n").filter(Boolean).map(line => {
    const match = line.match(/^(.+?):(\d+):(.*)/);
    return match ? { file: match[1], line: parseInt(match[2]), snippet: match[3].trim().slice(0, 100) } : null;
  }).filter(Boolean);
  return { providers, count: providers.length };
}

function findSecuritySinks(rootPath) {
  const patterns = [
    { type: "dangerouslySetInnerHTML", pattern: "dangerouslySetInnerHTML", severity: "P1" },
    { type: "innerHTML", pattern: "\\.innerHTML\\s*=", severity: "P1" },
    { type: "v-html", pattern: "v-html", severity: "P1" },
    { type: "eval", pattern: "\\beval\\s*\\(", severity: "P0" },
    { type: "document.write", pattern: "document\\.write\\s*\\(", severity: "P1" },
    { type: "srcdoc", pattern: "srcdoc\\s*=", severity: "P2" },
    { type: "javascript_url", pattern: 'href\\s*=\\s*["\']javascript:', severity: "P0" },
    { type: "svg_script", pattern: "<script[^>]*>", severity: "P1" },
  ];
  const sinks = [];
  for (const { type, pattern, severity } of patterns) {
    const result = safeGrep(pattern, rootPath, "*.{tsx,jsx,vue,svelte,ts,js,html}");
    result.content.split("\n").filter(Boolean).forEach(line => {
      const match = line.match(/^(.+?):(\d+):/);
      if (match) sinks.push({ type, file: match[1], line: parseInt(match[2]), severity });
    });
  }
  const counts = { P0: 0, P1: 0, P2: 0 };
  sinks.forEach(s => counts[s.severity]++);
  return { sinks, totalSinks: sinks.length, ...counts };
}

function countStateHooks(rootPath) {
  const result = safeGrep("useState\\s*[<(]", rootPath, "*.{tsx,jsx}");
  const fileCounts = {};
  result.content.split("\n").filter(Boolean).forEach(line => {
    const match = line.match(/^(.+?):\d+:/);
    if (match) fileCounts[match[1]] = (fileCounts[match[1]] || 0) + 1;
  });
  const components = Object.entries(fileCounts)
    .map(([file, count]) => ({
      file,
      useStateCount: count,
      risk: count <= 5 ? "normal" : count <= 10 ? "scrutiny" : count <= 15 ? "refactor" : "god_component",
    }))
    .sort((a, b) => b.useStateCount - a.useStateCount);
  return {
    components,
    godComponents: components.filter(c => c.risk === "god_component"),
    refactorCandidates: components.filter(c => c.risk === "refactor" || c.risk === "god_component"),
  };
}

function checkBundleConfig(rootPath) {
  const configs = {};
  for (const name of ["next.config.js", "next.config.mjs", "next.config.ts", "vite.config.ts", "vite.config.js", "webpack.config.js"]) {
    const fp = path.join(rootPath, name);
    if (fs.existsSync(fp)) {
      try { configs[name] = fs.readFileSync(fp, "utf-8").slice(0, 2000); } catch { /* skip */ }
    }
  }
  return { configs: Object.keys(configs), details: configs };
}

function checkSecurityHeaders(rootPath) {
  const findings = [];
  // Check middleware/headers config
  for (const file of ["middleware.ts", "middleware.js", "src/middleware.ts", "src/middleware.js", "next.config.js", "next.config.mjs"]) {
    const fp = path.join(rootPath, file);
    if (!fs.existsSync(fp)) continue;
    const content = safeReadFile(fp);
    if (!content) continue;
    const headers = ["Content-Security-Policy", "X-Frame-Options", "X-Content-Type-Options", "Strict-Transport-Security", "Referrer-Policy"];
    for (const h of headers) {
      if (!content.includes(h) && !content.toLowerCase().includes(h.toLowerCase())) {
        findings.push({ header: h, file, present: false, severity: h === "Content-Security-Policy" ? "P1" : "P2" });
      }
    }
  }
  return { findings, checkedFiles: findings.length > 0 ? [...new Set(findings.map(f => f.file))] : [] };
}

function findEnvExposure(rootPath) {
  const prefixes = ["NEXT_PUBLIC_", "VITE_", "REACT_APP_", "NUXT_PUBLIC_"];
  const findings = [];
  for (const prefix of prefixes) {
    const result = safeGrep(`${prefix}\\w+`, rootPath, "*.{tsx,jsx,ts,js,vue,svelte}");
    result.content.split("\n").filter(Boolean).forEach(line => {
      const match = line.match(new RegExp(`^(.+?):(\\d+):.*?(${prefix}\\w+)`));
      if (match) {
        const varName = match[3];
        const isSensitive = /KEY|SECRET|TOKEN|PASSWORD|CREDENTIAL/i.test(varName);
        findings.push({
          file: match[1], line: parseInt(match[2]), variable: varName,
          severity: isSensitive ? "P1" : "P3", sensitive: isSensitive,
        });
      }
    });
  }
  return { findings, sensitiveCount: findings.filter(f => f.sensitive).length, totalCount: findings.length };
}

function findMissingCleanup(rootPath) {
  // Find useEffect without return statement (simplified heuristic)
  const result = safeGrep("useEffect\\s*\\(", rootPath, "*.{tsx,jsx,ts,js}");
  const effectFiles = [...new Set(result.content.split("\n").filter(Boolean).map(l => l.match(/^(.+?):/)?.[1]).filter(Boolean))];
  const findings = [];
  for (const file of effectFiles.slice(0, 50)) {
    const content = safeReadFile(path.resolve(rootPath, file));
    if (!content) continue;
    const effectBlocks = content.match(/useEffect\s*\(\s*\(\s*\)\s*=>\s*\{[^}]{0,500}\}/g) || [];
    for (const block of effectBlocks) {
      if (!block.includes("return") && (block.includes("setInterval") || block.includes("addEventListener") || block.includes("subscribe") || block.includes("setTimeout"))) {
        findings.push({ file, severity: "P2", pattern: "useEffect with subscription/timer but no cleanup return" });
      }
    }
  }
  return { findings, count: findings.length };
}

function findStaleClosures(rootPath) {
  const result = safeGrep("useEffect\\s*\\([^)]*,\\s*\\[\\s*\\]\\s*\\)", rootPath, "*.{tsx,jsx,ts,js}");
  const findings = result.content.split("\n").filter(Boolean).map(line => {
    const match = line.match(/^(.+?):(\d+):/);
    return match ? { file: match[1], line: parseInt(match[2]), severity: "P2", pattern: "useEffect with empty deps — potential stale closure" } : null;
  }).filter(Boolean);
  return { findings, count: findings.length };
}

function checkAccessibility(rootPath) {
  const checks = [
    { pattern: "<img[^>]*(?!alt)[^>]*>", desc: "img without alt attribute", severity: "P2" },
    { pattern: "<button[^>]*>[^<]*<\\/button>", desc: "button — verify has accessible label", severity: "P3" },
    { pattern: 'role="button"', desc: "div/span with role=button — verify keyboard reachability", severity: "P2" },
    { pattern: "tabIndex\\s*=\\s*{?-1", desc: "tabIndex=-1 removes from tab order", severity: "P3" },
    { pattern: "aria-hidden=\"true\"", desc: "aria-hidden — verify not hiding interactive content", severity: "P3" },
  ];
  const findings = [];
  for (const { pattern, desc, severity } of checks) {
    const result = safeGrep(pattern, rootPath, "*.{tsx,jsx,vue,svelte,html}");
    findings.push({ check: desc, matchCount: result.numMatches, severity, files: result.filenames.slice(0, 5) });
  }
  // Check for skip navigation link
  const skipLink = safeGrep("skip.*(nav|content|main)", rootPath, "*.{tsx,jsx,vue,svelte,html}");
  findings.push({ check: "skip navigation link present", matchCount: skipLink.numMatches, severity: skipLink.numMatches > 0 ? "pass" : "P3", files: skipLink.filenames.slice(0, 3) });
  return { findings, totalChecks: findings.length };
}

function checkMobileResponsive(rootPath) {
  const findings = [];
  // Viewport meta
  const viewport = safeGrep('name="viewport"', rootPath, "*.{html,tsx,jsx}");
  findings.push({ check: "viewport meta tag", present: viewport.numMatches > 0, severity: viewport.numMatches > 0 ? "pass" : "P1" });
  // Media queries
  const mediaQueries = safeGrep("@media", rootPath, "*.{css,scss,less,tsx,jsx}");
  findings.push({ check: "media queries present", count: mediaQueries.numMatches, severity: mediaQueries.numMatches > 0 ? "pass" : "P2" });
  // Tailwind responsive prefixes
  const tailwind = safeGrep("\\b(sm|md|lg|xl|2xl):", rootPath, "*.{tsx,jsx,vue,svelte,html}");
  findings.push({ check: "tailwind responsive prefixes", count: tailwind.numMatches, severity: "info" });
  return { findings };
}

function findTestCoverage(rootPath) {
  const components = safeGlob("*.{tsx,jsx,vue,svelte}", rootPath);
  const tests = safeGlob("*.{test,spec}.{tsx,jsx,ts,js,mjs}", rootPath);
  const storyFiles = safeGlob("*.stories.{tsx,jsx,ts,js}", rootPath);
  const componentNames = new Set(components.filenames.map(f => path.basename(f, path.extname(f))));
  const testedNames = new Set(tests.filenames.map(f => path.basename(f).replace(/\.(test|spec)\.\w+$/, "")));
  const untested = [...componentNames].filter(n => !testedNames.has(n));
  return {
    componentCount: components.numFiles,
    testCount: tests.numFiles,
    storyCount: storyFiles.numFiles,
    coverageRatio: components.numFiles > 0 ? ((testedNames.size / componentNames.size) * 100).toFixed(1) + "%" : "N/A",
    untestedComponents: untested.slice(0, 20),
    untestedCount: untested.length,
  };
}

function scopeGraph(rootPath) {
  const components = safeGlob("*.{tsx,jsx,vue,svelte}", rootPath);
  const configs = safeGlob("*.config.{js,ts,mjs}", rootPath);
  const styles = safeGlob("*.{css,scss,less,module.css}", rootPath);
  const tests = safeGlob("*.{test,spec}.{tsx,jsx,ts,js,mjs}", rootPath);
  return {
    components: components.numFiles,
    configs: configs.filenames,
    styles: styles.numFiles,
    tests: tests.numFiles,
    totalFrontendFiles: components.numFiles + configs.numFiles + styles.numFiles,
  };
}

function checkErrorBoundaries(rootPath) {
  const errorFiles = safeGrep("error\\.(tsx|jsx|ts|js)$", rootPath, "*.{tsx,jsx,ts,js}");
  const errorBoundaryClass = safeGrep("ErrorBoundary|componentDidCatch|getDerivedStateFromError", rootPath, "*.{tsx,jsx,ts,js}");
  const routes = findRoutes(rootPath);
  return {
    errorBoundaryFiles: errorFiles.numMatches + errorBoundaryClass.numMatches,
    routeCount: routes.count,
    coverage: routes.count > 0 ? `${Math.min(errorFiles.numMatches + errorBoundaryClass.numMatches, routes.count)}/${routes.count}` : "N/A",
    severity: (errorFiles.numMatches + errorBoundaryClass.numMatches) === 0 && routes.count > 0 ? "P2" : "pass",
  };
}

function auditNpmDeps(rootPath) {
  try {
    const output = execFileSync("npm", ["audit", "--json", "--production"], {
      cwd: rootPath, encoding: "utf-8", timeout: 30000, stdio: ["pipe", "pipe", "pipe"],
    });
    const audit = JSON.parse(output);
    return {
      vulnerabilities: audit.metadata?.vulnerabilities || {},
      totalDeps: audit.metadata?.dependencies || 0,
      advisories: Object.values(audit.vulnerabilities || {}).slice(0, 10).map(v => ({
        name: v.name, severity: v.severity, range: v.range, fixAvailable: v.fixAvailable,
      })),
    };
  } catch (err) {
    try {
      const parsed = JSON.parse(err.stdout || "{}");
      return { vulnerabilities: parsed.metadata?.vulnerabilities || {}, totalDeps: parsed.metadata?.dependencies || 0, error: null };
    } catch {
      return { vulnerabilities: {}, totalDeps: 0, error: "npm audit failed" };
    }
  }
}

function checkImageOptimization(rootPath) {
  const rawImg = safeGrep("<img\\s", rootPath, "*.{tsx,jsx,vue,svelte,html}");
  const nextImage = safeGrep("from ['\"]next/image['\"]|<Image\\s", rootPath, "*.{tsx,jsx}");
  const missingDimensions = safeGrep("<img[^>]*(?!(width|height))[^>]*\\/?>", rootPath, "*.{tsx,jsx,vue,html}");
  return {
    rawImgTags: rawImg.numMatches,
    nextImageUsage: nextImage.numMatches,
    missingDimensions: missingDimensions.numMatches,
    severity: rawImg.numMatches > 0 && nextImage.numMatches === 0 ? "P2" : "pass",
  };
}

function checkFontLoading(rootPath) {
  const fontDisplay = safeGrep("font-display", rootPath, "*.{css,scss,tsx,jsx}");
  const preloadFont = safeGrep('rel="preload".*as="font"', rootPath, "*.{tsx,jsx,html}");
  const googleFonts = safeGrep("fonts\\.googleapis\\.com", rootPath, "*.{tsx,jsx,html,css}");
  return {
    fontDisplayUsage: fontDisplay.numMatches,
    preloadedFonts: preloadFont.numMatches,
    googleFontsUsage: googleFonts.numMatches,
    severity: fontDisplay.numMatches === 0 && googleFonts.numMatches > 0 ? "P2" : "pass",
  };
}

function findThirdPartyScripts(rootPath) {
  const patterns = [
    { name: "Google Analytics", pattern: "gtag|googletagmanager|ga\\(" },
    { name: "Segment", pattern: "analytics\\.identify|analytics\\.track|segment\\.com" },
    { name: "Sentry", pattern: "sentry\\.io|@sentry/" },
    { name: "Intercom", pattern: "intercom|Intercom\\(" },
    { name: "Hotjar", pattern: "hotjar" },
    { name: "Mixpanel", pattern: "mixpanel" },
    { name: "LaunchDarkly", pattern: "launchdarkly" },
    { name: "Datadog RUM", pattern: "datadoghq|dd-rum" },
  ];
  const found = [];
  for (const { name, pattern } of patterns) {
    const result = safeGrep(pattern, rootPath, "*.{tsx,jsx,ts,js,html}");
    if (result.numMatches > 0) found.push({ name, files: result.filenames.slice(0, 3), matches: result.numMatches });
  }
  return { scripts: found, count: found.length };
}

function checkServiceWorkers(rootPath) {
  const swFiles = safeGlob("**/service-worker*.{js,ts}", rootPath);
  const swRegister = safeGrep("serviceWorker\\.register|navigator\\.serviceWorker", rootPath, "*.{tsx,jsx,ts,js}");
  return {
    serviceWorkerFiles: swFiles.filenames,
    registrationPoints: swRegister.numMatches,
    present: swFiles.numFiles > 0 || swRegister.numMatches > 0,
  };
}

function checkRealtimeConnections(rootPath) {
  const ws = safeGrep("new WebSocket|WebSocket\\(", rootPath, "*.{tsx,jsx,ts,js}");
  const sse = safeGrep("new EventSource|EventSource\\(", rootPath, "*.{tsx,jsx,ts,js}");
  const socketIo = safeGrep("socket\\.io|io\\(", rootPath, "*.{tsx,jsx,ts,js}");
  return {
    webSockets: ws.numMatches, serverSentEvents: sse.numMatches, socketIo: socketIo.numMatches,
    total: ws.numMatches + sse.numMatches + socketIo.numMatches,
  };
}

function checkCssHealth(rootPath) {
  const important = safeGrep("!important", rootPath, "*.{css,scss,less}");
  const tailwindConfig = fs.existsSync(path.join(rootPath, "tailwind.config.js")) || fs.existsSync(path.join(rootPath, "tailwind.config.ts"));
  const darkMode = safeGrep("dark:|prefers-color-scheme:\\s*dark", rootPath, "*.{css,scss,tsx,jsx,html}");
  return {
    importantCount: important.numMatches,
    tailwindConfigured: tailwindConfig,
    darkModeSupport: darkMode.numMatches > 0,
    severity: important.numMatches > 20 ? "P2" : "pass",
  };
}

// ── Helpers ──────────────────────────────────────────────────────────

function readPackageJson(rootPath) {
  try { return JSON.parse(fs.readFileSync(path.join(rootPath, "package.json"), "utf-8")); }
  catch { return { dependencies: {}, devDependencies: {}, scripts: {} }; }
}

function detectFromDeps(deps) {
  if (deps.next) return { name: "next.js", pkg: "next" };
  if (deps.nuxt) return { name: "nuxt", pkg: "nuxt" };
  if (deps["@sveltejs/kit"]) return { name: "sveltekit", pkg: "@sveltejs/kit" };
  if (deps.svelte) return { name: "svelte", pkg: "svelte" };
  if (deps.vue) return { name: "vue", pkg: "vue" };
  if (deps["@angular/core"]) return { name: "angular", pkg: "@angular/core" };
  if (deps.remix || deps["@remix-run/react"]) return { name: "remix", pkg: "@remix-run/react" };
  if (deps.gatsby) return { name: "gatsby", pkg: "gatsby" };
  if (deps.react) return { name: "react", pkg: "react" };
  return { name: "unknown", pkg: null };
}

function detectRouter(rootPath, deps) {
  if (fs.existsSync(path.join(rootPath, "src/app")) || fs.existsSync(path.join(rootPath, "app"))) return "app";
  if (fs.existsSync(path.join(rootPath, "src/pages")) || fs.existsSync(path.join(rootPath, "pages"))) return "pages";
  if (deps["react-router-dom"] || deps["react-router"]) return "react-router";
  if (deps["vue-router"]) return "vue-router";
  return null;
}

function detectState(deps) {
  if (deps.zustand) return "zustand";
  if (deps["@reduxjs/toolkit"] || deps.redux) return "redux";
  if (deps.jotai) return "jotai";
  if (deps.recoil) return "recoil";
  if (deps["@tanstack/react-query"]) return "tanstack-query";
  if (deps.swr) return "swr";
  if (deps.mobx) return "mobx";
  if (deps.valtio) return "valtio";
  return "context-only";
}

function detectStyling(deps, rootPath) {
  if (deps.tailwindcss || fs.existsSync(path.join(rootPath, "tailwind.config.js")) || fs.existsSync(path.join(rootPath, "tailwind.config.ts"))) return "tailwind";
  if (deps["styled-components"]) return "styled-components";
  if (deps["@emotion/react"]) return "emotion";
  if (deps["@chakra-ui/react"]) return "chakra";
  if (deps["@mui/material"]) return "mui";
  return "css";
}

function detectTestRunner(deps) {
  if (deps.vitest) return "vitest";
  if (deps.jest) return "jest";
  if (deps.mocha) return "mocha";
  return null;
}

function detectE2eRunner(deps) {
  if (deps.playwright || deps["@playwright/test"]) return "playwright";
  if (deps.cypress) return "cypress";
  return null;
}

function detectPackageManager(rootPath) {
  if (fs.existsSync(path.join(rootPath, "pnpm-lock.yaml"))) return "pnpm";
  if (fs.existsSync(path.join(rootPath, "yarn.lock"))) return "yarn";
  if (fs.existsSync(path.join(rootPath, "bun.lockb"))) return "bun";
  return "npm";
}

function detectLinters(deps) {
  const linters = [];
  if (deps.eslint) linters.push("eslint");
  if (deps.prettier) linters.push("prettier");
  if (deps.biome || deps["@biomejs/biome"]) linters.push("biome");
  return linters;
}

function detectEntryPoints(rootPath, framework) {
  const candidates = framework === "next.js"
    ? ["src/app/layout.tsx", "src/app/page.tsx", "app/layout.tsx", "app/page.tsx", "pages/_app.tsx", "pages/index.tsx"]
    : ["src/index.tsx", "src/index.jsx", "src/main.tsx", "src/main.jsx", "src/App.tsx", "src/App.jsx", "index.html"];
  return candidates.filter(c => fs.existsSync(path.join(rootPath, c)));
}

function countCustomHooks(rootPath) {
  const result = safeGrep("export\\s+(default\\s+)?function\\s+use[A-Z]", rootPath, "*.{ts,tsx,js,jsx}");
  return result.numMatches;
}

function countProviders(rootPath) {
  const result = safeGrep("createContext\\(", rootPath, "*.{ts,tsx,js,jsx}");
  return result.numMatches;
}

function estimateFrontendLoc(rootPath) {
  const files = safeGlob("*.{tsx,jsx,vue,svelte,css,scss}", rootPath);
  // Rough estimate: count files × average LOC
  return files.numFiles * 80;
}

function safeGlob(pattern, rootPath) {
  try { return globTool({ pattern, path: rootPath }); }
  catch { return { filenames: [], numFiles: 0, truncated: false }; }
}

function safeGrep(pattern, rootPath, globFilter) {
  try { return grepTool({ pattern, path: rootPath, glob: globFilter, output_mode: "content", head_limit: 100 }); }
  catch { return { content: "", numMatches: 0, numFiles: 0, filenames: [] }; }
}

function safeReadFile(filePath) {
  try { return fs.readFileSync(filePath, "utf-8"); }
  catch { return null; }
}

export class FrontendAnalyzeError extends Error {
  constructor(message) {
    super(message);
    this.name = "FrontendAnalyzeError";
  }
}
