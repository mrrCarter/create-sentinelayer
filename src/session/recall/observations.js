/** SentinelLayer session-event adapter for the pure observation core. */

import { filterSessionMaterialEvents } from "../control-events.js";
import { buildEventObservations } from "./observation-core.js";

/**
 * Build immutable observations from raw session events, excluding operational
 * control rows unless the caller explicitly requests forensic inclusion.
 */
export function buildObservations(
  events = [],
  { sessionId = "", includeControlEvents = false } = {},
) {
  const source = Array.isArray(events) ? events : [];
  const material = includeControlEvents ? source : filterSessionMaterialEvents(source);
  const built = buildEventObservations(material, { sessionId });
  return {
    ...built,
    droppedControlEvents: source.length - material.length,
  };
}
