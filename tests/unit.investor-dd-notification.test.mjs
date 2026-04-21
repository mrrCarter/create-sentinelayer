// Unit tests for the notification dispatch (#investor-dd-19).

import test from "node:test";
import assert from "node:assert/strict";

import { notifyRunCompleted } from "../src/review/investor-dd-notification.js";

const sampleRun = {
  runId: "investor-dd-123",
  artifactDir: "/tmp/investor-dd-123",
  summary: {
    totalFindings: 7,
    durationSeconds: 42.1,
    terminationReason: "ok",
  },
  findings: [{ id: "f1", severity: "P1" }],
};

test("email + dashboard happy path", async () => {
  const sent = [];
  const uploaded = [];
  const result = await notifyRunCompleted({
    run: sampleRun,
    notifyEmail: "ops@example.com",
    emailClient: {
      sendMarkdown: async (msg) => {
        sent.push(msg);
        return { id: "msg-1" };
      },
    },
    dashboardClient: {
      upload: async (card) => {
        uploaded.push(card);
        return { cardId: "card-1" };
      },
    },
  });

  assert.equal(result.email.id, "msg-1");
  assert.equal(result.dashboard.cardId, "card-1");
  assert.equal(sent[0].to, "ops@example.com");
  assert.ok(sent[0].subject.includes("investor-dd-123"));
  assert.ok(sent[0].markdown.includes("7"));
  assert.equal(uploaded[0].runId, "investor-dd-123");
});

test("email failure is non-fatal", async () => {
  const events = [];
  const result = await notifyRunCompleted({
    run: sampleRun,
    notifyEmail: "ops@example.com",
    emailClient: {
      sendMarkdown: async () => {
        throw new Error("resend-down");
      },
    },
    dashboardClient: {
      upload: async () => ({ cardId: "card-1" }),
    },
    onEvent: (e) => events.push(e),
  });
  assert.equal(result.email.error, "resend-down");
  assert.equal(result.dashboard.cardId, "card-1");
  assert.ok(events.some((e) => e.type === "notification_email_error"));
});

test("dashboard failure is non-fatal", async () => {
  const result = await notifyRunCompleted({
    run: sampleRun,
    notifyEmail: "ops@example.com",
    emailClient: {
      sendMarkdown: async () => ({ id: "msg-1" }),
    },
    dashboardClient: {
      upload: async () => {
        throw new Error("api-down");
      },
    },
  });
  assert.equal(result.email.id, "msg-1");
  assert.equal(result.dashboard.error, "api-down");
});

test("emailEnabled=false skips email", async () => {
  let called = false;
  const result = await notifyRunCompleted({
    run: sampleRun,
    notifyEmail: "ops@example.com",
    emailEnabled: false,
    emailClient: {
      sendMarkdown: async () => {
        called = true;
        return { id: "x" };
      },
    },
  });
  assert.equal(called, false);
  assert.equal(result.email, null);
});

test("dashboardEnabled=false skips dashboard", async () => {
  let called = false;
  const result = await notifyRunCompleted({
    run: sampleRun,
    dashboardEnabled: false,
    dashboardClient: {
      upload: async () => {
        called = true;
        return { cardId: "x" };
      },
    },
  });
  assert.equal(called, false);
  assert.equal(result.dashboard, null);
});

test("missing email client emits skipped event", async () => {
  const events = [];
  await notifyRunCompleted({
    run: sampleRun,
    notifyEmail: "ops@example.com",
    onEvent: (e) => events.push(e),
  });
  assert.ok(events.some((e) => e.type === "notification_email_skipped"));
});

test("rejects run without runId", async () => {
  await assert.rejects(() => notifyRunCompleted({ run: {} }), /runId/);
});
