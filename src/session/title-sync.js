import process from "node:process";

import { SentinelayerApiError, requestJsonMutation } from "../auth/http.js";
import { resolveActiveAuthSession } from "../auth/service.js";
import { recordSessionRemoteTitleSync } from "./store.js";

const DEFAULT_TITLE_SYNC_TIMEOUT_MS = 2_000;
const DEFAULT_TITLE_SYNC_RETRY_DELAY_MS = 200;

function normalizeString(value) {
  return String(value || "").trim();
}

function remoteSessionSyncDisabled(env = process.env) {
  return String(env.SENTINELAYER_SKIP_REMOTE_SYNC || "").trim() === "1";
}

function normalizeFailureReason(error) {
  if (error instanceof SentinelayerApiError) {
    return error.code || `api_${error.status || "error"}`;
  }
  return normalizeString(error?.message) || "sync_failed";
}

function isTerminalTitleSyncError(error) {
  return (
    error instanceof SentinelayerApiError &&
    (error.status === 422 || error.code === "INVALID_SESSION_TITLE")
  );
}

export async function pushSessionTitleToApi(
  sessionId,
  title,
  {
    targetPath,
    env = process.env,
    timeoutMs = DEFAULT_TITLE_SYNC_TIMEOUT_MS,
    maxRetries = 1,
    retryDelayMs = DEFAULT_TITLE_SYNC_RETRY_DELAY_MS,
    resolveAuthSession = resolveActiveAuthSession,
    requestMutation = requestJsonMutation,
    recordRemoteTitleSync = recordSessionRemoteTitleSync,
  } = {},
) {
  const normalizedSessionId = normalizeString(sessionId);
  const normalizedTitle = normalizeString(title);
  if (!normalizedSessionId || !normalizedTitle) {
    return { synced: false, reason: "invalid_input" };
  }
  if (remoteSessionSyncDisabled(env)) {
    return { synced: false, reason: "remote_sync_disabled" };
  }

  await recordRemoteTitleSync(normalizedSessionId, {
    targetPath,
    title: normalizedTitle,
    pending: true,
    failureReason: "pending",
  }).catch(() => null);

  try {
    const session = await resolveAuthSession({
      cwd: targetPath,
      env,
      autoRotate: true,
    });
    if (!session?.token || !session?.apiUrl) {
      await recordRemoteTitleSync(normalizedSessionId, {
        targetPath,
        title: normalizedTitle,
        pending: true,
        failureReason: "not_authenticated",
      }).catch(() => null);
      return { synced: false, reason: "not_authenticated" };
    }
    const apiUrl = String(session.apiUrl).replace(/\/+$/, "");
    const result = await requestMutation(
      `${apiUrl}/api/v1/sessions/${encodeURIComponent(normalizedSessionId)}/title`,
      {
        method: "POST",
        operationName: "session.set_title",
        headers: { Authorization: `Bearer ${session.token}` },
        body: { title: normalizedTitle },
        timeoutMs,
        maxRetries,
        retryDelayMs,
      },
    );
    await recordRemoteTitleSync(normalizedSessionId, {
      targetPath,
      title: normalizedTitle,
      pending: false,
    }).catch(() => null);
    return { synced: true, status: result?.status || 200 };
  } catch (error) {
    const reason = normalizeFailureReason(error);
    const terminal = isTerminalTitleSyncError(error);
    await recordRemoteTitleSync(normalizedSessionId, {
      targetPath,
      title: normalizedTitle,
      pending: !terminal,
      failureReason: reason,
    }).catch(() => null);
    return { synced: false, reason, terminal };
  }
}
