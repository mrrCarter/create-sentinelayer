import test from "node:test";
import assert from "node:assert/strict";

import {
  buildChildIdentityPayload,
  buildProvisionEmailPayload,
  createChildIdentity,
  getLatestIdentityExtraction,
  getIdentityLineage,
  listIdentityEvents,
  normalizeAidenIdApiUrl,
  provisionEmailIdentity,
  revokeIdentityChildren,
  revokeIdentity,
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

  const childPayload = buildChildIdentityPayload({
    aliasTemplate: " child-a ",
    ttlHours: "12",
    tags: "lineage,agent",
    receiveMode: "EDGE_ACCEPT",
    extractionTypes: "otp",
    eventBudget: "42",
  });
  assert.equal(childPayload.aliasTemplate, "child-a");
  assert.equal(childPayload.ttlHours, 12);
  assert.equal(childPayload.eventBudget, 42);
  assert.deepEqual(childPayload.policy.extractionTypes, ["otp"]);
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

test("Unit AIdenID helper: revoke request sends scoped headers and parses response", async () => {
  const requests = [];
  const fetchImpl = async (url, init) => {
    requests.push({ url, init });
    return {
      ok: true,
      status: 200,
      async json() {
        return {
          id: "id_123",
          status: "REVOKED",
          revokedAt: "2026-05-01T00:00:00.000Z",
        };
      },
    };
  };

  const execution = await revokeIdentity({
    apiUrl: "https://api.aidenid.com",
    apiKey: "k_test",
    orgId: "org_123",
    projectId: "proj_123",
    idempotencyKey: "idem-456",
    identityId: "id_123",
    fetchImpl,
  });

  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, "https://api.aidenid.com/v1/identities/id_123/revoke");
  assert.equal(requests[0].init.method, "POST");
  assert.equal(requests[0].init.headers["Authorization"], "Bearer k_test");
  assert.equal(execution.response.status, "REVOKED");

  await assert.rejects(
    () =>
      revokeIdentity({
        apiUrl: "https://api.aidenid.com",
        apiKey: "k_test",
        orgId: "org_123",
        projectId: "proj_123",
        idempotencyKey: "idem-456",
        identityId: "id_123",
        fetchImpl: async () => ({
          ok: false,
          status: 409,
          async json() {
            return { error: { code: "conflict" } };
          },
        }),
      }),
    /status 409/
  );
});

test("Unit AIdenID helper: events request sends scoped headers and normalizes payload", async () => {
  const requests = [];
  const fetchImpl = async (url, init) => {
    requests.push({ url, init });
    return {
      ok: true,
      status: 200,
      async json() {
        return {
          events: [
            { eventId: "evt_1", eventType: "email.received", receivedAt: "2026-05-01T00:00:00.000Z" },
          ],
          nextCursor: "cursor_2",
        };
      },
    };
  };

  const execution = await listIdentityEvents({
    apiUrl: "https://api.aidenid.com",
    apiKey: "k_test",
    orgId: "org_123",
    projectId: "proj_123",
    identityId: "id_123",
    cursor: "cursor_1",
    limit: 25,
    fetchImpl,
  });

  assert.equal(requests.length, 1);
  assert.match(requests[0].url, /\/v1\/identities\/id_123\/events\?/);
  assert.match(requests[0].url, /limit=25/);
  assert.match(requests[0].url, /cursor=cursor_1/);
  assert.equal(requests[0].init.method, "GET");
  assert.equal(requests[0].init.headers["Authorization"], "Bearer k_test");
  assert.equal(execution.events.length, 1);
  assert.equal(execution.nextCursor, "cursor_2");

  await assert.rejects(
    () =>
      listIdentityEvents({
        apiUrl: "https://api.aidenid.com",
        apiKey: "k_test",
        orgId: "org_123",
        projectId: "proj_123",
        identityId: "id_123",
        fetchImpl: async () => ({
          ok: false,
          status: 500,
          async json() {
            return { error: { code: "internal" } };
          },
        }),
      }),
    /status 500/
  );
});

test("Unit AIdenID helper: latest extraction request parses extraction and supports not-found", async () => {
  const requests = [];
  const fetchImpl = async (url, init) => {
    requests.push({ url, init });
    return {
      ok: true,
      status: 200,
      async json() {
        return {
          extraction: {
            otp: "123456",
            primaryActionUrl: "https://example.com/verify",
            confidence: 0.95,
            source: "RULES",
          },
        };
      },
    };
  };

  const execution = await getLatestIdentityExtraction({
    apiUrl: "https://api.aidenid.com",
    apiKey: "k_test",
    orgId: "org_123",
    projectId: "proj_123",
    identityId: "id_123",
    fetchImpl,
  });

  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, "https://api.aidenid.com/v1/identities/id_123/latest-extraction");
  assert.equal(requests[0].init.method, "GET");
  assert.equal(execution.extraction.otp, "123456");
  assert.equal(execution.extraction.primaryActionUrl, "https://example.com/verify");
  assert.equal(execution.extraction.source, "RULES");
  assert.equal(execution.notFound, false);

  const notFound = await getLatestIdentityExtraction({
    apiUrl: "https://api.aidenid.com",
    apiKey: "k_test",
    orgId: "org_123",
    projectId: "proj_123",
    identityId: "id_123",
    fetchImpl: async () => ({
      ok: false,
      status: 404,
      async json() {
        return { error: { code: "not_found" } };
      },
    }),
  });
  assert.equal(notFound.notFound, true);
  assert.equal(notFound.extraction.otp, null);

  await assert.rejects(
    () =>
      getLatestIdentityExtraction({
        apiUrl: "https://api.aidenid.com",
        apiKey: "k_test",
        orgId: "org_123",
        projectId: "proj_123",
        identityId: "id_123",
        fetchImpl: async () => ({
          ok: false,
          status: 429,
          async json() {
            return { error: { code: "rate_limited" } };
          },
        }),
      }),
    /status 429/
  );
});

test("Unit AIdenID helper: create child request sends payload and parses response", async () => {
  const requests = [];
  const fetchImpl = async (url, init) => {
    requests.push({ url, init });
    return {
      ok: true,
      status: 200,
      async json() {
        return {
          id: "id_child_1",
          parentIdentityId: "id_parent_1",
          emailAddress: "child@aidenid.com",
          status: "ACTIVE",
        };
      },
    };
  };

  const execution = await createChildIdentity({
    apiUrl: "https://api.aidenid.com",
    apiKey: "k_test",
    orgId: "org_123",
    projectId: "proj_123",
    parentIdentityId: "id_parent_1",
    idempotencyKey: "idem-child-1",
    payload: { ttlHours: 12, eventBudget: 5 },
    fetchImpl,
  });
  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, "https://api.aidenid.com/v1/identities/id_parent_1/children");
  assert.equal(requests[0].init.method, "POST");
  assert.equal(execution.response.parentIdentityId, "id_parent_1");

  await assert.rejects(
    () =>
      createChildIdentity({
        apiUrl: "https://api.aidenid.com",
        apiKey: "k_test",
        orgId: "org_123",
        projectId: "proj_123",
        parentIdentityId: "id_parent_1",
        idempotencyKey: "idem-child-1",
        payload: {},
        fetchImpl: async () => ({
          ok: false,
          status: 409,
          async json() {
            return { error: { code: "delegation_ttl_violation" } };
          },
        }),
      }),
    /status 409/
  );
});

test("Unit AIdenID helper: lineage and revoke-children routes parse expected payloads", async () => {
  const lineageRequests = [];
  const lineage = await getIdentityLineage({
    apiUrl: "https://api.aidenid.com",
    apiKey: "k_test",
    orgId: "org_123",
    projectId: "proj_123",
    identityId: "id_parent_1",
    fetchImpl: async (url, init) => {
      lineageRequests.push({ url, init });
      return {
        ok: true,
        status: 200,
        async json() {
          return {
            rootIdentityId: "id_parent_1",
            nodes: [
              { identityId: "id_parent_1", emailAddress: "p@aidenid.com", status: "ACTIVE", depth: 0 },
              { identityId: "id_child_1", emailAddress: "c@aidenid.com", status: "ACTIVE", depth: 1 },
            ],
            edges: [{ parentIdentityId: "id_parent_1", childIdentityId: "id_child_1" }],
          };
        },
      };
    },
  });
  assert.equal(lineageRequests.length, 1);
  assert.equal(lineageRequests[0].url, "https://api.aidenid.com/v1/identities/id_parent_1/lineage");
  assert.equal(lineage.nodes.length, 2);
  assert.equal(lineage.edges.length, 1);

  const revokeRequests = [];
  const revoked = await revokeIdentityChildren({
    apiUrl: "https://api.aidenid.com",
    apiKey: "k_test",
    orgId: "org_123",
    projectId: "proj_123",
    identityId: "id_parent_1",
    idempotencyKey: "idem-revoke-children",
    fetchImpl: async (url, init) => {
      revokeRequests.push({ url, init });
      return {
        ok: true,
        status: 200,
        async json() {
          return {
            parentIdentityId: "id_parent_1",
            revokedCount: 2,
            revokedIdentityIds: ["id_child_1", "id_child_2"],
          };
        },
      };
    },
  });
  assert.equal(revokeRequests.length, 1);
  assert.equal(
    revokeRequests[0].url,
    "https://api.aidenid.com/v1/identities/id_parent_1/revoke-children"
  );
  assert.equal(revoked.revokedCount, 2);
  assert.deepEqual(revoked.revokedIdentityIds, ["id_child_1", "id_child_2"]);

  await assert.rejects(
    () =>
      revokeIdentityChildren({
        apiUrl: "https://api.aidenid.com",
        apiKey: "k_test",
        orgId: "org_123",
        projectId: "proj_123",
        identityId: "id_parent_1",
        idempotencyKey: "idem-revoke-children",
        fetchImpl: async () => ({
          ok: false,
          status: 500,
          async json() {
            return { error: { code: "internal" } };
          },
        }),
      }),
    /status 500/
  );
});
