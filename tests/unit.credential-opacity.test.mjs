import "./setup-env.mjs";
// A credential is opaque: code outside src/auth/credential-destinations.js cannot read its token,
// so it cannot put it in a header, a URL, a body or a cookie. Each way a token used to be carried
// is tried here against a real loopback, and the token never arrives. The module's narrow
// accessors, its trust contexts and its request primitives are checked too.
import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { inspect } from "node:util";

import {
  CredentialDestinationRefused,
  admissionCredential,
  checkedTransport,
  credentialHmac,
  credentialedRequest,
  exportCredentialToken,
  gatewayCredential,
  resolveTrustContext,
  userCredential,
} from "../src/auth/credential-destinations.js";
import { requestJson } from "../src/auth/http.js";
import { resolveActiveAuthSession } from "../src/auth/service.js";
import { writeStoredSession } from "../src/auth/session-store.js";
import { bearerOf } from "./credential-probe.mjs";

const SECRET = "opaque-token-0000";

async function startServer() {
  const requests = [];
  const server = createServer(async (req, res) => {
    let body = "";
    for await (const chunk of req) body += chunk;
    requests.push({ url: req.url, headers: { ...req.headers }, body });
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end("{}");
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return {
    url: `http://127.0.0.1:${server.address().port}`,
    requests,
    carried: (secret) => requests.some((r) => JSON.stringify(r).includes(secret)),
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

test("an auth result and its credential expose no token, however code reaches for it", async () => {
  const configured = await startServer();
  const other = await startServer();
  const home = await fsp.mkdtemp(path.join(os.tmpdir(), "sl-opacity-"));
  try {
    const env = { SENTINELAYER_API_URL: configured.url };
    await writeStoredSession({ apiUrl: configured.url, token: SECRET, tokenExpiresAt: new Date(Date.now() + 30 * 86400_000).toISOString() }, { homeDir: home });
    const session = await resolveActiveAuthSession({ env, homeDir: home, cwd: home, autoRotate: false });
    const auth = session;
    const resolved = session;
    const credential = session.credential;
    assert.equal(await bearerOf(credential), SECRET, "the credential does carry the token");

    // the six ways a token used to leave: each now has nothing to carry
    const { token } = session;
    const plants = [
      ["a destructured header", { headers: { "X-Session-Token": String(token) } }],
      ["a joined credential token", { headers: { Authorization: ["Bearer", session.credential.token].join(" ") } }],
      ["a query string", { url: `${other.url}/x?access_token=${credential.token}` }],
      ["a JSON body", { method: "POST", body: JSON.stringify({ token: auth["token"], credential }) }],
      ["a cookie", { headers: { Cookie: `sl=${resolved.token}` } }],
      ["a header swapped in for a presence check", { headers: { "X-Token": String(session.token) } }],
    ];
    for (const [, { url = `${other.url}/x`, ...init }] of plants) {
      await fetch(url, init);
    }
    assert.equal(other.requests.length, plants.length);
    assert.equal(other.carried(SECRET), false, "the token reached the other origin");

    // and no reflection finds it
    for (const view of [
      JSON.stringify(session),
      JSON.stringify(credential),
      inspect(session, { showHidden: true, depth: 5 }),
      inspect(credential, { showHidden: true, depth: 5 }),
      Object.getOwnPropertyNames(credential).join(" "),
      JSON.stringify(Object.getOwnPropertyDescriptors(credential)),
      JSON.stringify(structuredClone(credential)),
    ]) {
      assert.equal(view.includes(SECRET), false, view);
    }
  } finally {
    await configured.close();
    await other.close();
    await fsp.rm(home, { recursive: true, force: true });
  }
});

test("the narrow accessors give a proof, or the token for the one reviewed export, and nothing else", async () => {
  const env = { SENTINELAYER_API_URL: "https://api.example.test" };
  const credential = await userCredential(SECRET, { env, source: "session" });
  assert.match(credentialHmac(credential, "message"), /^[0-9a-f]{64}$/);
  assert.equal(credentialHmac(credential, "message").includes(SECRET), false);
  assert.equal(exportCredentialToken(credential, { purpose: "github-actions-secret" }), SECRET);
  assert.throws(() => exportCredentialToken(credential, { purpose: "anything-else" }), TypeError);
  const agent = admissionCredential({ token: "sladm_x", apiUrl: "https://api.example.test" });
  assert.throws(() => exportCredentialToken(agent, { purpose: "github-actions-secret" }), TypeError);
  assert.throws(() => credentialHmac({ origin: "https://api.example.test" }, "m"), TypeError);
});

test("only a trust context this module built can bind a credential", async () => {
  await assert.rejects(userCredential(SECRET, { context: { apiOrigin: "http://127.0.0.1:1", gatewayOrigin: "" } }), TypeError);
  const context = await resolveTrustContext({ env: { SENTINELAYER_API_URL: "https://api.example.test" } });
  assert.equal((await userCredential(SECRET, { context })).origin, "https://api.example.test");
});

test("an agent's admission credential is never re-bound to the pocket gateway", async () => {
  const env = { SENTINELAYER_API_URL: "https://api.example.test", SENTI_POCKET_URL: "https://pocket.example.test" };
  const agent = admissionCredential({ token: "sladm_x", apiUrl: "https://api.example.test" });
  await assert.rejects(gatewayCredential(agent, { env }), CredentialDestinationRefused);
  const person = await userCredential(SECRET, { env, source: "session" });
  assert.equal((await gatewayCredential(person, { env })).origin, "https://pocket.example.test");
});

test("the URL that is checked is the URL that is sent", async () => {
  const configured = await startServer();
  const other = await startServer();
  try {
    const credential = await userCredential(SECRET, { env: { SENTINELAYER_API_URL: configured.url } });
    const shifting = () => {
      let reads = 0;
      return { toString: () => (reads++ === 0 ? `${configured.url}/x` : `${other.url}/x`) };
    };
    await credentialedRequest(credential, shifting());
    let sentTo = null;
    await checkedTransport(async (url) => {
      sentTo = url;
      return {};
    })(shifting(), { credential });
    assert.equal(sentTo, `${configured.url}/x`);
    assert.equal(other.requests.length, 0, "the other origin received nothing");
    assert.equal(configured.requests.length, 1);
  } finally {
    await configured.close();
    await other.close();
  }
});

test("without a credential the API client attaches no token, and refuses one built by hand", async () => {
  const server = await startServer();
  try {
    await requestJson(`${server.url}/x`, { maxRetries: 0 });
    assert.equal(server.requests[0].headers.authorization, undefined);
    for (const headers of [{ Authorization: `Bearer ${SECRET}` }, { authorization: SECRET }, { "Proxy-Authorization": SECRET }]) {
      await assert.rejects(requestJson(`${server.url}/x`, { headers, maxRetries: 0 }), TypeError);
    }
    assert.equal(server.requests.length, 1);
    assert.equal(server.carried(SECRET), false);
  } finally {
    await server.close();
  }
});

test("the README says where the token goes, that POCKET_GATEWAY_URL is not read, where init writes its project token, and where alerts go", async () => {
  const readme = await fsp.readFile(new URL("../README.md", import.meta.url), "utf8");
  assert.match(readme, /`POCKET_GATEWAY_URL` is no longer read\./);
  assert.match(readme, /A project `\.sentinelayer\.yml` chooses neither the API nor the token/);
  assert.match(readme, /lockfile and, only when you pass `--inject-secret` \(or set `injectSecret` in the interview\), a GitHub Actions secret on this directory's own git remote, after `gh` confirms you can write to it\. `OPENAI_API_KEY` from your environment is set there only with `--inject-openai-key`\./);
  assert.ok(
    readme.includes(
      "The MCP bridge now enforces the human-approval requirement on CLI tools; they are unavailable over MCP until approval is supported. Senti session tools are unaffected.",
    ),
    "the README states the bridge change",
  );
  assert.match(readme, /Watchdog alert channels \(`alerts\.channels`\) also come from the global config only/);
  assert.match(readme, /`sl scan setup-secrets` writes it to a GitHub Actions secret with the `gh` CLI/);
});

test("the init flow's client also refuses a hand-built Authorization header", async () => {
  const { __legacyCredentialFlowForTests: legacy } = await import("../src/legacy-cli.js");
  const server = await startServer();
  try {
    await assert.rejects(legacy.requestJson(`${server.url}/x`, { headers: { Authorization: `Bearer ${SECRET}` } }), TypeError);
    assert.equal(server.requests.length, 0);
  } finally {
    await server.close();
  }
});
