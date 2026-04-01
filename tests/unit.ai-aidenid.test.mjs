import test from "node:test";
import assert from "node:assert/strict";

import {
  buildProvisionEmailPayload,
  normalizeAidenIdApiUrl,
  provisionEmailIdentity,
  resolveAidenIdCredentials,
} from "../src/ai/aidenid.js";

test("Unit AIdenID helper: payload normalization is deterministic", () => {
  const payload = buildProvisionEmailPayload({
    aliasTemplate: "  security-scan  ",
    ttlHours: "36",
    tags: " nightly,security,nightly ",
    domainPoolId: " pool_123 ",
    receiveMode: "EDGE_ACCEPT",
    allowWebhooks: false,
    extractionTypes: "otp,link,otp",
  });

  assert.deepEqual(payload, {
    aliasTemplate: "security-scan",
    ttlHours: 36,
    tags: ["nightly", "security"],
    domainPoolId: "pool_123",
    policy: {
      receiveMode: "EDGE_ACCEPT",
      allowWebhooks: false,
      extractionTypes: ["otp", "link"],
    },
  });

  const defaultPayload = buildProvisionEmailPayload({});
  assert.equal(defaultPayload.ttlHours, 24);
  assert.deepEqual(defaultPayload.tags, []);
  assert.deepEqual(defaultPayload.policy.extractionTypes, ["otp", "link"]);
});

test("Unit AIdenID helper: credential resolution validates required env", () => {
  const resolved = resolveAidenIdCredentials({
    env: {
      AIDENID_API_KEY: "k_test",
      AIDENID_ORG_ID: "org_1",
      AIDENID_PROJECT_ID: "proj_1",
    },
  });
  assert.equal(resolved.missing.length, 0);
  assert.equal(resolved.apiKey, "k_test");

  const partial = resolveAidenIdCredentials({
    env: {
      AIDENID_API_KEY: "",
      AIDENID_ORG_ID: "org_1",
      AIDENID_PROJECT_ID: "",
    },
    requireAll: false,
  });
  assert.deepEqual(partial.missing.sort(), ["AIDENID_API_KEY", "AIDENID_PROJECT_ID"]);

  assert.throws(
    () =>
      resolveAidenIdCredentials({
        env: {},
        requireAll: true,
      }),
    /Missing AIdenID credentials/
  );

  assert.equal(normalizeAidenIdApiUrl("https://api.aidenid.com/"), "https://api.aidenid.com");
});

test("Unit AIdenID helper: execute request sends scoped headers and parses response", async () => {
  const requests = [];
  const fetchImpl = async (url, init) => {
    requests.push({ url, init });
    return {
      ok: true,
      status: 200,
      async json() {
        return {
          id: "id_123",
          emailAddress: "scan@aidenid.com",
          status: "ACTIVE",
        };
      },
    };
  };

  const execution = await provisionEmailIdentity({
    apiUrl: "https://api.aidenid.com",
    apiKey: "k_test",
    orgId: "org_123",
    projectId: "proj_123",
    idempotencyKey: "idem-123",
    payload: {
      aliasTemplate: null,
      ttlHours: 24,
      tags: [],
      domainPoolId: null,
      policy: {
        receiveMode: "EDGE_ACCEPT",
        allowWebhooks: true,
        extractionTypes: ["otp", "link"],
      },
    },
    fetchImpl,
  });

  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, "https://api.aidenid.com/v1/identities");
  assert.equal(requests[0].init.method, "POST");
  assert.equal(requests[0].init.headers["Authorization"], "Bearer k_test");
  assert.equal(requests[0].init.headers["X-Org-Id"], "org_123");
  assert.equal(requests[0].init.headers["X-Project-Id"], "proj_123");
  assert.equal(requests[0].init.headers["Idempotency-Key"], "idem-123");
  assert.equal(execution.response.id, "id_123");

  await assert.rejects(
    () =>
      provisionEmailIdentity({
        apiUrl: "https://api.aidenid.com",
        apiKey: "k_test",
        orgId: "org_123",
        projectId: "proj_123",
        idempotencyKey: "idem-123",
        payload: {},
        fetchImpl: async () => ({
          ok: false,
          status: 403,
          async json() {
            return { error: { code: "forbidden" } };
          },
        }),
      }),
    /status 403/
  );
});
