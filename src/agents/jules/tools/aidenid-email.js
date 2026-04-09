/**
 * AIdenID email tool for agent testing.
 *
 * Allows agents to provision ephemeral email addresses, read inbox,
 * and extract OTPs for E2E testing of authentication flows.
 */

import {
  provisionEmailIdentity,
  getLatestIdentityExtraction,
  resolveAidenIdCredentials,
  normalizeAidenIdApiUrl,
} from "../../../ai/aidenid.js";
import { readStoredSession } from "../../../auth/session-store.js";
import { fetchAidenIdCredentials } from "../../../auth/service.js";

/**
 * AIdenID email tool definition for agent dispatch.
 */
export const AIDENID_EMAIL_TOOL = {
  name: "AidenIdEmail",
  description:
    "Provision ephemeral test email addresses via AIdenID for E2E testing. " +
    "Operations: provision (create email), wait_for_otp (poll for OTP extraction), status (check identity).",
  parameters: {
    type: "object",
    properties: {
      operation: {
        type: "string",
        enum: ["provision", "wait_for_otp", "status"],
        description: "Operation to perform",
      },
      identity_id: {
        type: "string",
        description: "Identity ID (required for wait_for_otp and status)",
      },
      tags: {
        type: "string",
        description: "Comma-separated tags for provisioning (e.g., 'e2e,security-test')",
      },
      timeout_seconds: {
        type: "number",
        description: "Timeout for wait_for_otp in seconds (default: 30)",
      },
    },
    required: ["operation"],
  },
};

/**
 * Execute AIdenID email tool operation.
 *
 * @param {object} input - Tool input from agent
 * @param {object} [ctx] - Tool context
 * @returns {Promise<object>} Tool result
 */
export async function executeAidenIdEmailTool(input, ctx = {}) {
  const operation = String(input.operation || "").trim();

  let session = null;
  try {
    session = await readStoredSession();
  } catch {
    // no session
  }

  const makeFetcher = () => {
    if (!session || !session.token) return null;
    return () => fetchAidenIdCredentials({ apiUrl: session.apiUrl, token: session.token });
  };

  const credentials = await resolveAidenIdCredentials({
    env: process.env,
    requireAll: true,
    session,
    fetchCredentials: makeFetcher(),
  });

  const apiUrl = normalizeAidenIdApiUrl(process.env.AIDENID_API_URL || "https://api.aidenid.com");

  switch (operation) {
    case "provision": {
      const tags = String(input.tags || "e2e").split(",").map((t) => t.trim()).filter(Boolean);
      const result = await provisionEmailIdentity({
        apiUrl,
        apiKey: credentials.apiKey,
        orgId: credentials.orgId,
        projectId: credentials.projectId,
        idempotencyKey: `agent-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        payload: {
          tags,
          ttlHours: 24,
          receiveMode: "EDGE_ACCEPT",
          allowWebhooks: true,
          extractionTypes: ["otp", "link"],
        },
      });

      return {
        success: true,
        operation: "provision",
        identityId: result.response?.id || null,
        email: result.response?.emailAddress || null,
        status: result.response?.status || null,
        expiresAt: result.response?.expiresAt || null,
      };
    }

    case "wait_for_otp": {
      const identityId = String(input.identity_id || "").trim();
      if (!identityId) {
        return { success: false, error: "identity_id is required for wait_for_otp" };
      }

      const timeoutSeconds = Number(input.timeout_seconds) || 30;
      const intervalMs = 2000;
      const maxAttempts = Math.ceil((timeoutSeconds * 1000) / intervalMs);

      for (let attempt = 0; attempt < maxAttempts; attempt++) {
        const extraction = await getLatestIdentityExtraction({
          apiUrl,
          apiKey: credentials.apiKey,
          orgId: credentials.orgId,
          projectId: credentials.projectId,
          identityId,
        });

        const otp = extraction?.response?.otp;
        const confidence = extraction?.response?.confidence || 0;

        if (otp && confidence >= 0.7) {
          return {
            success: true,
            operation: "wait_for_otp",
            identityId,
            otp,
            confidence,
            source: extraction.response?.source || "unknown",
            attempts: attempt + 1,
          };
        }

        if (attempt < maxAttempts - 1) {
          await new Promise((r) => setTimeout(r, intervalMs));
        }
      }

      return {
        success: false,
        operation: "wait_for_otp",
        identityId,
        error: `OTP not received within ${timeoutSeconds}s`,
        attempts: maxAttempts,
      };
    }

    case "status": {
      const identityId = String(input.identity_id || "").trim();
      if (!identityId) {
        return { success: false, error: "identity_id is required for status" };
      }

      // Status check via extraction endpoint (lightweight)
      try {
        const extraction = await getLatestIdentityExtraction({
          apiUrl,
          apiKey: credentials.apiKey,
          orgId: credentials.orgId,
          projectId: credentials.projectId,
          identityId,
        });

        return {
          success: true,
          operation: "status",
          identityId,
          hasExtraction: Boolean(extraction?.response),
          otp: extraction?.response?.otp || null,
          confidence: extraction?.response?.confidence || 0,
        };
      } catch (err) {
        return { success: false, operation: "status", identityId, error: err.message };
      }
    }

    default:
      return { success: false, error: `Unknown operation: ${operation}. Use: provision, wait_for_otp, status` };
  }
}
