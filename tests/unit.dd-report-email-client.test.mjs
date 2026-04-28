import test from "node:test";
import assert from "node:assert/strict";

import {
  buildReportEmailIdempotencyKey,
  normalizeReportEmail,
  redactDdEmailError,
  sendDdReportEmail,
} from "../src/review/dd-report-email-client.js";

test("dd report email client: normalizes recipient and deterministic idempotency key", () => {
  assert.equal(normalizeReportEmail(" investor@example.com "), "investor@example.com");
  assert.equal(normalizeReportEmail("not-an-email"), "");

  const keyA = buildReportEmailIdempotencyKey({ runId: "run-1", to: "Investor@Example.com" });
  const keyB = buildReportEmailIdempotencyKey({ runId: "run-1", to: "investor@example.com" });
  assert.equal(keyA, keyB);
  assert.match(keyA, /^sl-cli-dd-email-[a-f0-9]{32}$/);
});

test("dd report email client: posts authenticated email request with idempotency", async () => {
  const calls = [];
  const result = await sendDdReportEmail({
    runId: "investor-dd-123",
    to: "investor@example.com",
    cwd: "/repo",
    env: {},
    resolveAuthSession: async (input) => {
      assert.equal(input.cwd, "/repo");
      assert.equal(input.autoRotate, false);
      return { apiUrl: "https://api.example.test/", token: "tok_test" };
    },
    requestJsonImpl: async (url, options) => {
      calls.push({ url, options });
      return {
        sent: true,
        run_id: "investor-dd-123",
        to: "investor@example.com",
        message_id: "msg-123",
        replay: false,
      };
    },
  });

  assert.equal(result.queued, true);
  assert.equal(result.messageId, "msg-123");
  assert.equal(calls.length, 1);
  assert.equal(
    calls[0].url,
    "https://api.example.test/api/v1/runs/investor-dd-123/send-report-email",
  );
  assert.equal(calls[0].options.method, "POST");
  assert.equal(calls[0].options.headers.Authorization, "Bearer tok_test");
  assert.deepEqual(calls[0].options.body, { to: "investor@example.com" });
  assert.equal(calls[0].options.idempotencyKey, result.idempotencyKey);
  assert.match(result.idempotencyKey, /^sl-cli-dd-email-[a-f0-9]{32}$/);
});

test("dd report email client: rejects invalid input before network", async () => {
  let called = false;
  const result = await sendDdReportEmail({
    runId: "investor-dd-123",
    to: "bad-recipient",
    resolveAuthSession: async () => ({ apiUrl: "https://api.example.test", token: "tok" }),
    requestJsonImpl: async () => {
      called = true;
    },
  });

  assert.equal(result.queued, false);
  assert.equal(result.code, "DD_EMAIL_INVALID_RECIPIENT");
  assert.equal(called, false);
});

test("dd report email client: reports missing auth without throwing", async () => {
  const result = await sendDdReportEmail({
    runId: "investor-dd-123",
    to: "investor@example.com",
    resolveAuthSession: async () => null,
  });

  assert.equal(result.queued, false);
  assert.equal(result.code, "DD_EMAIL_AUTH_REQUIRED");
});

test("dd report email client: redacts sensitive error text", async () => {
  const redacted = redactDdEmailError(
    "failed Bearer secret-token-123 at C:\\Users\\carther\\project api_key=sk_live_secret",
  );
  assert.equal(redacted.includes("secret-token-123"), false);
  assert.equal(redacted.includes("C:\\Users\\carther"), false);
  assert.equal(redacted.includes("sk_live_secret"), false);
  assert.match(redacted, /Bearer \[REDACTED\]/);

  const err = new Error("failed Bearer secret-token-123 at C:\\Users\\carther\\project");
  err.code = "RUN_NOT_FOUND";
  err.status = 404;
  const result = await sendDdReportEmail({
    runId: "investor-dd-123",
    to: "investor@example.com",
    resolveAuthSession: async () => ({ apiUrl: "https://api.example.test", token: "tok" }),
    requestJsonImpl: async () => {
      throw err;
    },
  });

  assert.equal(result.queued, false);
  assert.equal(result.code, "RUN_NOT_FOUND");
  assert.equal(result.status, 404);
  assert.equal(result.error.includes("secret-token-123"), false);
  assert.equal(result.error.includes("C:\\Users\\carther"), false);
});
