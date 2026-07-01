const SESSION_CONTROL_EVENT_TYPES = new Set([
  "file_lock",
  "file_unlock",
  "file_lock_expired",
  "listener_stop",
  "session_coaching",
  "session_listen_catchup",
  "session_listen_error",
  "session_reaction",
]);

const QUIET_SESSION_ACTION_TYPES = new Set([
  "ack",
  "dislike",
  "disregard",
  "like",
  "view",
]);

function normalizeString(value) {
  return String(value || "").trim();
}

function eventType(event = {}) {
  return normalizeString(event?.event || event?.type).toLowerCase();
}

function payloadSource(event = {}) {
  const payload = event?.payload && typeof event.payload === "object" && !Array.isArray(event.payload)
    ? event.payload
    : {};
  return normalizeString(payload.source).toLowerCase();
}

export function isSessionListenerLifecycleEvent(event = {}) {
  const type = eventType(event);
  if (type.startsWith("session_listener_")) return true;
  return payloadSource(event) === "session_listen";
}

export function isSessionControlEvent(event = {}) {
  const type = eventType(event);
  const payload = event?.payload && typeof event.payload === "object" && !Array.isArray(event.payload)
    ? event.payload
    : {};
  const actionType = normalizeString(payload.actionType || payload.action_type || payload.reaction).toLowerCase();
  return (
    isSessionListenerLifecycleEvent(event) ||
    (type === "session_action" && QUIET_SESSION_ACTION_TYPES.has(actionType)) ||
    type.startsWith("session_listen_") ||
    SESSION_CONTROL_EVENT_TYPES.has(type)
  );
}

export function filterSessionMaterialEvents(events = []) {
  return (Array.isArray(events) ? events : []).filter((event) => !isSessionControlEvent(event));
}
