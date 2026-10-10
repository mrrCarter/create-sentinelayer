import "./setup-env.mjs";
// The census of src/: every place that could put a token on the wire outside
// credentialedRequest (src/auth/credential-destinations.js) is listed here, with the reason it
// is allowed. A new Authorization/Bearer/x-api-key header, a token in a URL, or a new raw read
// of a resolved token fails this test until it is either moved behind credentialedRequest or
// reviewed into the list below.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SANCTIONED = "src/auth/credential-destinations.js"; // the one place that attaches a credential

// Ways to put a token on the wire.
const PATTERNS = [
  ["authorization-header", /["'`]?\b(?:proxy-)?authorization\b["'`]?\s*:\s*[`"']\s*Bearer/i],
  ["bearer-template", /\bBearer\s*\$\{/],
  ["bearer-concat", /["'`]Bearer\s*["'`]\s*\+/],
  ["headers-set", /\.(?:set|append)\(\s*["'`](?:proxy-)?authorization["'`]/i],
  ["api-key-header", /["'`]x-api-key["'`]\s*:/i],
  ["token-in-url", /[?&](?:access_|auth_)?token=\$\{/],
];
// A raw read of a resolved token (an auth result, a stored session).
const RAW_TOKEN_READ = /\b(?:session|auth|authSession|stored|storedSession|active|activeSession|resolvedSession)\??\.token\b/g;

// Reviewed sites that match PATTERNS: [file, pattern, a fragment of the line, why it is allowed].
const REVIEWED_SITES = [
  ["src/ai/aidenid.js", "authorization-header", "Bearer ${String(apiKey", "the AIdenID API key, sent to the AIdenID API; not the user's SentinelLayer token"],
  ["src/ai/aidenid.js", "bearer-template", "Bearer ${String(apiKey", "the AIdenID API key, sent to the AIdenID API; not the user's SentinelLayer token"],
  ["src/ai/client.js", "authorization-header", "Bearer ${apiKey}", "a model provider's own API key, sent to that provider's fixed URL"],
  ["src/ai/client.js", "bearer-template", "Bearer ${apiKey}", "a model provider's own API key, sent to that provider's fixed URL"],
  ["src/ai/client.js", "api-key-header", "\"x-api-key\": apiKey", "a model provider's own API key, sent to that provider's fixed URL"],
  ["src/mcp/cli-command-tools.js", "bearer-template", "Bearer ${REDACTION_MARKER}", "redacts command output; not a header"],
  ["src/memory/retrieval.js", "authorization-header", "authorization: `Bearer ${apiKey}`", "the memory service's own key (SENTINELAYER_MEMORY_API_KEY); the user's token goes through credentialedRequest"],
  ["src/memory/retrieval.js", "bearer-template", "authorization: `Bearer ${apiKey}`", "the memory service's own key (SENTINELAYER_MEMORY_API_KEY); the user's token goes through credentialedRequest"],
  ["src/session/recall/embedder.js", "authorization-header", "authorization: `Bearer ${apiKey}`", "an embedding service's own key; never the user's token"],
  ["src/session/recall/embedder.js", "bearer-template", "authorization: `Bearer ${apiKey}`", "an embedding service's own key; never the user's token"],
  ["src/swarm/pentest.js", "authorization-header", "Bearer expired.jwt.token", "a fixed synthetic value used as a pentest probe; not a credential"],
  ["src/swarm/pentest.js", "authorization-header", "Bearer standard-user-token", "a fixed synthetic value used as a pentest probe; not a credential"],
];

// Raw token reads per file, all reviewed: presence checks, minting a credential, and one export.
const REVIEWED_RAW_READS = {
  "src/agents/jules/tools/aidenid-email.js": [1, "presence check"],
  "src/agents/jules/tools/runtime-audit.js": [1, "presence check"],
  "src/ai/aidenid.js": [5, "presence checks"],
  "src/ai/proxy.js": [1, "presence check"],
  "src/auth/gate.js": [3, "whether a login exists (no request)"],
  "src/auth/service.js": [7, "presence checks, the auth result's own token field, and minting credentials from it"],
  "src/commands/ai/provision-governance.js": [1, "presence check"],
  // The one non-HTTP export of the user's token: the operator command `sl scan setup-secrets`
  // writes it to a GitHub Actions secret through the gh CLI. It is blocked from the MCP bridge.
  "src/commands/scan.js": [2, "presence check, and the operator setup-secrets export to gh"],
  "src/commands/session.js": [7, "presence checks"],
  "src/commands/watch.js": [1, "presence check"],
  "src/mcp/token-service.js": [1, "presence check"],
  "src/pocket/ring-owner.js": [1, "presence check"],
  "src/review/dd-report-email-client.js": [1, "presence check"],
  "src/session/admission-access.js": [1, "presence check"],
  "src/session/admission.js": [3, "presence checks and an admission token format check"],
  "src/session/checkpoints.js": [1, "presence check"],
  "src/session/file-locks.js": [1, "presence check"],
  "src/session/invitations.js": [1, "presence check"],
  "src/session/sync.js": [18, "presence checks"],
  "src/session/tickets.js": [1, "presence check"],
  "src/session/title-sync.js": [1, "presence check"],
  "src/telemetry/sync.js": [1, "presence check"],
};

function sourceFiles(dir = path.join(ROOT, "src")) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(full);
    return entry.name.endsWith(".js") ? [full] : [];
  });
}

/** The census of a set of files: every pattern match, and raw token reads per file. */
export function census(files) {
  const sites = [];
  const reads = {};
  for (const { file, text } of files) {
    if (file === SANCTIONED) continue;
    text.split("\n").forEach((line, index) => {
      for (const [pattern, re] of PATTERNS) {
        if (re.test(line)) sites.push({ file, line: index + 1, pattern, text: line.trim() });
      }
      const count = (line.match(RAW_TOKEN_READ) || []).length;
      if (count) reads[file] = (reads[file] || 0) + count;
    });
  }
  return { sites, reads };
}

const reviewedFor = (site) =>
  REVIEWED_SITES.find(([file, pattern, fragment]) => file === site.file && pattern === site.pattern && site.text.includes(fragment));

function unreviewed({ sites, reads }) {
  return {
    sites: sites.filter((site) => !reviewedFor(site)).map((s) => `${s.file}:${s.line} [${s.pattern}] ${s.text}`),
    reads: Object.entries(reads)
      .filter(([file, count]) => REVIEWED_RAW_READS[file]?.[0] !== count)
      .map(([file, count]) => `${file}: ${count} raw token read(s), reviewed ${REVIEWED_RAW_READS[file]?.[0] ?? 0}`),
  };
}

const srcFiles = () =>
  sourceFiles().map((full) => ({ file: path.relative(ROOT, full).split(path.sep).join("/"), text: fs.readFileSync(full, "utf8") }));

test("every place in src/ that could send a token outside credentialedRequest is reviewed", () => {
  const result = census(srcFiles());
  assert.deepEqual(unreviewed(result), { sites: [], reads: [] }, "move it behind credentialedRequest, or review it here");

  // and nothing reviewed is stale
  const stale = REVIEWED_SITES.filter(([file, pattern, fragment]) =>
    !result.sites.some((s) => s.file === file && s.pattern === pattern && s.text.includes(fragment)),
  ).map(([file, pattern, fragment]) => `${file} [${pattern}] ${fragment}`);
  const staleReads = Object.keys(REVIEWED_RAW_READS).filter((file) => !result.reads[file]);
  assert.deepEqual({ stale, staleReads }, { stale: [], staleReads: [] });
});

test("the census fails on a new site that attaches a token itself", () => {
  const planted = [
    ...srcFiles(),
    { file: "src/session/new-feature.js", text: "  headers: { Authorization: `Bearer ${session.token}` },\n" },
    { file: "src/session/other-feature.js", text: 'req.headers.set("authorization", "Bearer " + auth.token);\n' },
    { file: "src/session/sync.js", text: "fetch(`${base}/x?token=${session.token}`);\n" },
  ];
  const { sites, reads } = unreviewed(census(planted));
  assert.deepEqual(sites, [
    "src/session/new-feature.js:1 [authorization-header] headers: { Authorization: `Bearer ${session.token}` },",
    "src/session/new-feature.js:1 [bearer-template] headers: { Authorization: `Bearer ${session.token}` },",
    'src/session/other-feature.js:1 [bearer-concat] req.headers.set("authorization", "Bearer " + auth.token);',
    'src/session/other-feature.js:1 [headers-set] req.headers.set("authorization", "Bearer " + auth.token);',
    "src/session/sync.js:1 [token-in-url] fetch(`${base}/x?token=${session.token}`);",
  ]);
  assert.deepEqual(reads, [
    "src/session/sync.js: 19 raw token read(s), reviewed 18",
    "src/session/new-feature.js: 1 raw token read(s), reviewed 0",
    "src/session/other-feature.js: 1 raw token read(s), reviewed 0",
  ]);
});
