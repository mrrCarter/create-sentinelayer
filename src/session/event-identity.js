function keyString(value) {
  return String(value || "").trim();
}

function timestampKey(...values) {
  for (const value of values) {
    const normalized = keyString(value);
    if (!normalized) continue;
    const epoch = Date.parse(normalized);
    if (Number.isFinite(epoch)) {
      return new Date(epoch).toISOString();
    }
    return normalized;
  }
  return "";
}

function stableJsonValue(value) {
  if (Array.isArray(value)) {
    return value.map((item) => stableJsonValue(item));
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([, entryValue]) => entryValue !== undefined)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, entryValue]) => [key, stableJsonValue(entryValue)])
    );
  }
  return value;
}

function stableStringify(value) {
  return JSON.stringify(stableJsonValue(value));
}

export function sessionEventIdentityKeys(event = {}) {
  if (!event || typeof event !== "object") return [];
  const keys = [];
  const id = keyString(event.id);
  if (id) {
    keys.push(`id:${id}`);
  }
  if (typeof event.cursor === "string" && event.cursor.trim()) {
    keys.push(`cursor:${event.cursor.trim()}`);
  }
  if (typeof event.eventId === "string" && event.eventId.trim()) {
    keys.push(`event:${event.eventId.trim()}`);
  }
  if (typeof event.idempotencyToken === "string" && event.idempotencyToken.trim()) {
    keys.push(`idempotency:${event.idempotencyToken.trim()}`);
  }
  const payload = event.payload && typeof event.payload === "object" ? event.payload : {};
  const messageId = typeof payload.messageId === "string" ? payload.messageId.trim() : "";
  if (messageId) {
    keys.push(`message:${messageId}`);
  }
  const timestamp = timestampKey(event.ts, event.timestamp, event.at);
  const hasPayloadSignal = Object.keys(payload).length > 0;
  const hasFingerprintSignal =
    id || messageId || keyString(event.eventId) || keyString(event.idempotencyToken) ||
    keyString(event.agent?.id || event.agentId) || timestamp || hasPayloadSignal;
  if (hasFingerprintSignal) {
    try {
      keys.push(`fingerprint:${stableStringify({
        event: event.event || event.type || "",
        id,
        eventId: keyString(event.eventId),
        idempotencyToken: keyString(event.idempotencyToken),
        agent: event.agent?.id || event.agentId || "",
        payload,
        ts: timestamp,
      })}`);
    } catch {
      // Best-effort duplicate suppression only.
    }
  }
  const message = keyString(payload.message || payload.text || payload.body);
  if (message) {
    try {
      keys.push(`content:${stableStringify({
        event: keyString(event.event || event.type),
        agent: keyString(event.agent?.id || event.agentId || payload.agentId || payload.authorId),
        payload: {
          channel: keyString(payload.channel),
          clientKind: keyString(payload.clientKind),
          message,
          source: keyString(payload.source),
          to: payload.to || payload.recipient || payload.mentions || null,
        },
        ts: timestampKey(event.ts, event.timestamp, event.at),
      })}`);
    } catch {
      // Best-effort duplicate suppression only.
    }
  }
  return keys;
}

export function sessionEventHasKnownIdentity(event = {}, knownKeys = new Set()) {
  const keys = sessionEventIdentityKeys(event);
  return keys.length > 0 && keys.some((key) => knownKeys.has(key));
}

export function addSessionEventIdentityKeys(knownKeys, event = {}) {
  for (const key of sessionEventIdentityKeys(event)) {
    knownKeys.add(key);
  }
}

export function dedupeSessionEvents(events = []) {
  const normalizedEvents = Array.isArray(events) ? events : [];
  const deduped = [];
  const indexByKey = new Map();

  for (const event of normalizedEvents) {
    const keys = sessionEventIdentityKeys(event);
    const existingIndexes = keys
      .map((key) => indexByKey.get(key))
      .filter((index) => Number.isInteger(index) && index >= 0);
    const existingIndex = existingIndexes.length > 0 ? Math.min(...existingIndexes) : -1;

    if (existingIndex >= 0) {
      deduped[existingIndex] = event;
      for (const key of keys) {
        indexByKey.set(key, existingIndex);
      }
      continue;
    }

    const nextIndex = deduped.length;
    deduped.push(event);
    for (const key of keys) {
      indexByKey.set(key, nextIndex);
    }
  }

  return deduped;
}
