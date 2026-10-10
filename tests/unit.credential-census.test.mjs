import "./setup-env.mjs";
// The census of src/. The guarantee is by construction: a token lives only inside
// src/auth/credential-destinations.js, and credentialedRequest is the only code that sends it
// (tests/unit.credential-token-sources.test.mjs shows code elsewhere cannot read it). This census
// is defence in depth around that: every site in src/ that builds an Authorization-style header,
// puts a token in a URL, reads a stored token, calls one of the module's narrow accessors, or
// writes a trust-source variable into process.env, or fills a template from the environment, is
// listed here with the reason it is allowed.
// A new one fails this test until it is moved behind credentialedRequest or reviewed here.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SANCTIONED = "src/auth/credential-destinations.js"; // the one place that holds and attaches a credential

// [rule, pattern]: each match outside the sanctioned module must be reviewed below.
const PATTERNS = [
  ["authorization-header", /["'`]?\b(?:proxy-)?authorization\b["'`]?\s*:\s*[`"']\s*Bearer/i],
  ["bearer-template", /\bBearer\s*\$\{/],
  ["bearer-concat", /["'`]Bearer\s*["'`]\s*\+/],
  ["headers-set", /\.(?:set|append)\(\s*["'`](?:proxy-)?authorization["'`]/i],
  ["api-key-header", /["'`]x-api-key["'`]\s*:/i],
  ["token-in-url", /[?&](?:access_|auth_)?token=\$\{/],
  ["raw-token-read", /\b(?:session|auth|authSession|stored|storedSession|active|activeSession|resolvedSession|credential)\??\.token\b/],
  ["export-accessor", /\bexportCredentialToken\(/],
  ["hmac-accessor", /\bcredentialHmac\(/],
  ["admission-mint", /\badmissionCredential\(/],
  ["stored-session-read", /\breadStoredSession\(/],
  ["trust-env-write", /process\.env(?:\.|\[\s*["'`])(?:SENTINELAYER_API_URL|SENTI_POCKET_URL|HOME|USERPROFILE|SENTINELAYER_TOKEN|SENTINELAYER_API_TOKEN)(?:["'`]\s*\])?\s*(?:=(?!=)|\?\?=|\|\|=)/],
  ["env-replace", /\bprocess\.env\s*=(?!=)|Object\.assign\(\s*process\.env\b/],
  // provider keys come from userConfigValues (environment, global config), never the merged config
  ["workspace-provider-key", /resolveConfiguredApiKey\([^)]*\.resolved\b|\.resolved\.(?:openai|anthropic|google)ApiKey\b/],
  // an expander that fills $NAME / ${NAME} from the environment must restrict the names it fills
  ["env-template", /\.replace(?:All)?\(\s*\/\\\$|new RegExp\(\s*["'`]\\\\\$/],
];

// Reviewed sites: [file, rule, a fragment of the line, why it is allowed].
const REVIEWED = [
  // other services' own keys, sent to their own endpoints (never the user's SentinelLayer token)
  ["src/ai/aidenid.js", "authorization-header", "Bearer ${String(apiKey", "the AIdenID API key, sent to the AIdenID API"],
  ["src/ai/aidenid.js", "bearer-template", "Bearer ${String(apiKey", "the AIdenID API key, sent to the AIdenID API"],
  ["src/ai/client.js", "authorization-header", "Bearer ${apiKey}", "a model provider's own key, sent to that provider's fixed URL"],
  ["src/ai/client.js", "bearer-template", "Bearer ${apiKey}", "a model provider's own key, sent to that provider's fixed URL"],
  ["src/ai/client.js", "api-key-header", "\"x-api-key\": apiKey", "a model provider's own key, sent to that provider's fixed URL"],
  ["src/memory/retrieval.js", "authorization-header", "authorization: `Bearer ${apiKey}`", "the memory service's own key (SENTINELAYER_MEMORY_API_KEY)"],
  ["src/memory/retrieval.js", "bearer-template", "authorization: `Bearer ${apiKey}`", "the memory service's own key (SENTINELAYER_MEMORY_API_KEY)"],
  ["src/session/recall/embedder.js", "authorization-header", "authorization: `Bearer ${apiKey}`", "an embedding service's own key"],
  ["src/session/recall/embedder.js", "bearer-template", "authorization: `Bearer ${apiKey}`", "an embedding service's own key"],
  // not credentials
  ["src/mcp/cli-command-tools.js", "bearer-template", "Bearer ${REDACTION_MARKER}", "redacts command output; not a header"],
  ["src/swarm/pentest.js", "authorization-header", "Bearer expired.jwt.token", "a fixed synthetic pentest probe value"],
  ["src/swarm/pentest.js", "authorization-header", "Bearer standard-user-token", "a fixed synthetic pentest probe value"],
  // the auth service reads its own stored records to mint credentials from them
  ["src/auth/service.js", "raw-token-read", "!session || !session.token || !session.tokenExpiresAt", "rotation: whether the stored record can be rotated"],
  ["src/auth/service.js", "raw-token-read", "userCredential(session.token", "rotation: minting the stored token's credential"],
  ["src/auth/service.js", "raw-token-read", "userCredential(active.token", "resolution: minting the stored token's credential"],
  ["src/auth/service.js", "raw-token-read", "stored.tokenId && stored.token", "logout: whether the stored record can be revoked"],
  ["src/auth/service.js", "raw-token-read", "userCredential(stored.token", "logout: minting the stored token's credential"],
  ["src/auth/service.js", "stored-session-read", "readStoredSession({ homeDir })", "the auth service reads its own store"],
  ["src/session/admission.js", "raw-token-read", "String(stored.token || \"\").startsWith(\"sladm_\")", "the admission store checks the format of its own record"],
  ["src/session/admission.js", "raw-token-read", "token: claimed.credential.token", "the admission store records the agent credential the API issued at claim"],
  ["src/auth/session-store.js", "stored-session-read", "export async function readStoredSession", "the store's own definition"],
  // the narrow accessors
  ["src/auth/admission-scope.js", "admission-mint", "admissionCredential(credential)", "the admission scope binds an agent's admission to the API that issued it"],
  ["src/session/invitations.js", "hmac-accessor", "credentialHmac(credential", "the session-mutation CSRF proof; the token stays inside the module"],
  // the one non-HTTP export of the user's token: the operator command `sl scan setup-secrets`
  // writes it to a GitHub Actions secret through gh (or SENTINELAYER_SECRET_SINK_FILE in tests).
  // It is blocked from the MCP bridge.
  ["src/commands/scan.js", "export-accessor", "exportCredentialToken(session.credential", "the operator setup-secrets export to gh"],
  // the one environment template: alert channel settings in the user's own config, filled only from
  // SLACK_WEBHOOK_URL, TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID or SENTINELAYER_ALERT_*; anything else is refused
  ["src/daemon/watchdog.js", "env-template", "replace(/\\$\\{([^}]*)\\}/g, (_, name) =>", "alert channel templates fill only alert settings"],
];

function sourceFiles(dir = path.join(ROOT, "src")) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(full);
    return entry.name.endsWith(".js") ? [full] : [];
  });
}

/** Every rule match in a set of files (the sanctioned module and comments excepted). */
export function census(files) {
  const sites = [];
  for (const { file, text } of files) {
    if (file === SANCTIONED) continue;
    text.split("\n").forEach((line, index) => {
      const code = line.trim();
      if (code.startsWith("//") || code.startsWith("*") || code.startsWith("/*")) return;
      for (const [rule, re] of PATTERNS) {
        if (re.test(line)) sites.push({ file, line: index + 1, rule, text: code });
      }
    });
  }
  return sites;
}

const reviewedFor = (site) =>
  REVIEWED.find(([file, rule, fragment]) => file === site.file && rule === site.rule && site.text.includes(fragment));
const unreviewed = (sites) => sites.filter((site) => !reviewedFor(site)).map((s) => `${s.file}:${s.line} [${s.rule}] ${s.text}`);

const srcFiles = () =>
  sourceFiles().map((full) => ({ file: path.relative(ROOT, full).split(path.sep).join("/"), text: fs.readFileSync(full, "utf8") }));

test("every site in src/ that could handle a token outside credentialedRequest is reviewed", () => {
  const sites = census(srcFiles());
  assert.deepEqual(unreviewed(sites), [], "move it behind credentialedRequest, or review it here");
  const stale = REVIEWED.filter(([file, rule, fragment]) =>
    !sites.some((s) => s.file === file && s.rule === rule && s.text.includes(fragment)),
  ).map(([file, rule, fragment]) => `${file} [${rule}] ${fragment}`);
  assert.deepEqual(stale, [], "a reviewed site that no longer exists");
});

test("the census fails on new sites: headers, URLs, token reads, accessors, trust-source writes and env templates", () => {
  const planted = [
    ...srcFiles(),
    {
      file: "src/session/new-feature.js",
      text: [
        "  headers: { Authorization: `Bearer ${session.token}` },",
        'req.headers.set("authorization", "Bearer " + auth.token);',
        "fetch(`${base}/x?token=${value}`);",
        "const secret = exportCredentialToken(auth.credential, { purpose: \"github-actions-secret\" });",
        "const forged = admissionCredential({ token, apiUrl });",
        "const stored = await readStoredSession();",
        "process.env.SENTINELAYER_API_URL = config.apiUrl;",
        'process.env["SENTI_POCKET_URL"] ??= other;',
        "process.env.HOME = dir;",
        "Object.assign(process.env, overrides);",
        "const key = resolveConfiguredApiKey(provider, config.resolved);",
        "const url = value.replace(/\\$\\{([A-Z0-9_]+)\\}/g, (_, key) => env[key]);",
        'const pattern = new RegExp("\\\\$\\\\{(\\\\w+)\\\\}", "g");',
      ].join("\n"),
    },
  ];
  assert.deepEqual(
    unreviewed(census(planted)).map((entry) => entry.replace(/^src\/session\/new-feature\.js:(\d+) \[([a-z-]+)\].*$/, "$1 $2")),
    [
      "1 authorization-header",
      "1 bearer-template",
      "1 raw-token-read",
      "2 bearer-concat",
      "2 headers-set",
      "2 raw-token-read",
      "3 token-in-url",
      "4 export-accessor",
      "5 admission-mint",
      "6 stored-session-read",
      "7 trust-env-write",
      "8 trust-env-write",
      "9 trust-env-write",
      "10 env-replace",
      "11 workspace-provider-key",
      "12 env-template",
      "13 env-template",
    ],
  );
});
