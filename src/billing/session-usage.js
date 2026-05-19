import process from "node:process";

import { createAgentEvent } from "../events/schema.js";
import { createSession } from "../session/store.js";
import { appendToStream } from "../session/stream.js";
import { buildLedgerEntry } from "./ledger-entry.js";

const SESSION_USAGE_EVENT = "session_usage";

function normalizeString(value) {
  return String(value || "").trim();
}

async function appendUsageEvent(sessionId, envelope, { targetPath, syncRemote }) {
  return appendToStream(sessionId, envelope, {
    targetPath,
    syncRemote,
  });
}

export async function recordSessionUsage(
  sessionId,
  params = {},
  {
    targetPath = process.cwd(),
    // Billing events originate in the CLI and must reach the API for server-side
    // ledger/quota projection; this intentionally defaults to remote sync.
    syncRemote = true,
    ensureLocalSession = true,
    append = appendUsageEvent,
  } = {},
) {
  const normalizedSessionId = normalizeString(sessionId);
  if (!normalizedSessionId) throw new Error("sessionId is required.");
  const entry = buildLedgerEntry({
    ...params,
    sessionId: normalizedSessionId,
  });
  const envelope = createAgentEvent({
    event: SESSION_USAGE_EVENT,
    sessionId: normalizedSessionId,
    agentId: entry.agentId,
    agentModel: entry.model,
    payload: {
      ...entry,
      costUsd: entry.providerCostUsd ?? 0,
      usage: {
        totalTokens: entry.totalTokens,
        inputTokens: entry.inputTokens,
        outputTokens: entry.outputTokens,
        costUsd: entry.providerCostUsd ?? 0,
        providerCostUsd: entry.providerCostUsd,
        customerCostUsd: entry.customerCostUsd,
      },
    },
    ts: entry.createdAt,
  });

  try {
    await append(normalizedSessionId, envelope, { targetPath, syncRemote });
  } catch (error) {
    if (!ensureLocalSession || !/was not found/i.test(error?.message || "")) {
      throw error;
    }
    await createSession({
      sessionId: normalizedSessionId,
      targetPath,
      title: `Billing usage ${normalizedSessionId}`,
      createdAt: entry.createdAt,
      lastInteractionAt: entry.createdAt,
    });
    await append(normalizedSessionId, envelope, { targetPath, syncRemote });
  }

  return {
    ok: true,
    event: SESSION_USAGE_EVENT,
    ledgerEntry: entry,
  };
}
