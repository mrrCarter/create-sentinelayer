import "./setup-env.mjs";
// The CLI entry freezes the process trust context. After that, a change to process.env (by the
// CLI itself, or anything it loads) does not move where a credential may go. Its own test file:
// freezing is process-wide.
import test from "node:test";
import assert from "node:assert/strict";

import {
  CredentialDestinationRefused,
  credentialedRequest,
  freezeProcessTrustContext,
  resolveTrustContext,
  userCredential,
} from "../src/auth/credential-destinations.js";
import { resolveApiUrl } from "../src/auth/service.js";

test("once frozen, the process trust context ignores later changes to process.env", async () => {
  process.env.SENTINELAYER_API_URL = "https://api.trusted.example";
  delete process.env.SENTI_POCKET_URL;
  const frozen = await freezeProcessTrustContext();
  assert.equal(frozen.apiOrigin, "https://api.trusted.example");

  // a later write, as `sl init` used to make from a workspace config
  process.env.SENTINELAYER_API_URL = "https://api.workspace.example";
  process.env.SENTI_POCKET_URL = "https://pocket.workspace.example";

  assert.equal((await resolveTrustContext()).apiOrigin, "https://api.trusted.example");
  assert.equal((await resolveTrustContext({ env: process.env })).gatewayOrigin, "", "no gateway was configured at start");
  assert.equal(await resolveApiUrl({ env: process.env }), "https://api.trusted.example");
  const credential = await userCredential("t", { env: process.env });
  assert.equal(credential.origin, "https://api.trusted.example");
  await assert.rejects(credentialedRequest(credential, "https://api.workspace.example/x"), CredentialDestinationRefused);
  assert.equal(await freezeProcessTrustContext(), frozen, "frozen once");

  // an explicitly injected environment (tests, the MCP bridge's child env) is still resolved on its own
  assert.equal((await resolveTrustContext({ env: { SENTINELAYER_API_URL: "https://api.other.example" } })).apiOrigin, "https://api.other.example");
});
