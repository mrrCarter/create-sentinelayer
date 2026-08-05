/** Generic Memory-as-a-Service item adapter for the pure observation core. */

import { buildEventObservations } from "../session/recall/observation-core.js";
import { normalizeString } from "../session/recall/text.js";

export function buildObservationsFromItems(items = [], { namespace = "" } = {}) {
  const events = (Array.isArray(items) ? items : []).map((item) => ({
    stream: "sl_event",
    event: normalizeString(item?.kind) || "memory",
    eventId: normalizeString(item?.id) || undefined,
    idempotencyToken: normalizeString(item?.idempotencyToken) || undefined,
    agent: { id: normalizeString(item?.author || item?.agentId) || "writer" },
    payload: {
      message: normalizeString(item?.text),
      topics: item?.topics,
      files: item?.files,
      to: item?.mentions,
      __trust: item?.trust,
      __sealed: item?.sealed === true,
      __revoked: item?.revoked === true,
    },
    ts: normalizeString(item?.ts) || new Date().toISOString(),
    sequenceId: item?.sequenceId,
  }));

  const built = buildEventObservations(events, { sessionId: namespace });
  for (const observation of built.observations) {
    const payload = observation?.raw?.payload || {};
    if (payload.__trust) observation.trust = payload.__trust;
    observation.sealed = payload.__sealed === true;
    observation.revoked = payload.__revoked === true;
  }
  return built;
}
