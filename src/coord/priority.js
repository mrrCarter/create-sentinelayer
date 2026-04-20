// Persona priority ladder used by the LOCK/ACK/RELEASE handshake (#A9, spec §5.6).
//
// Lower index = higher priority. Architects hold the pen on shape decisions;
// database / auth come next because they gate everything downstream; UI / docs
// are at the tail because they are the easiest to redo if preempted.
//
// The ladder is closed: an unknown agent id sorts *below* every known persona
// (priorityIndex returns PERSONA_PRIORITY.length) so stray callers cannot
// accidentally preempt a real persona.

export const PERSONA_PRIORITY = Object.freeze([
  "architect",
  "database",
  "auth",
  "backend",
  "frontend",
  "ui",
  "payments",
  "email",
  "integrations",
  "security",
  "test",
  "devops",
  "docs",
]);

function normalizeAgent(agent) {
  return String(agent || "").trim().toLowerCase();
}

export function priorityIndex(agent) {
  const normalized = normalizeAgent(agent);
  if (!normalized) {
    return PERSONA_PRIORITY.length;
  }
  const idx = PERSONA_PRIORITY.indexOf(normalized);
  return idx === -1 ? PERSONA_PRIORITY.length : idx;
}

// Returns true if `candidate` strictly outranks `incumbent` — i.e. candidate
// may preempt incumbent's lock. Equal priorities never preempt (incumbent wins
// ties to keep the system idempotent under retries).
export function outranks(candidate, incumbent) {
  return priorityIndex(candidate) < priorityIndex(incumbent);
}

// Given an iterable of agent ids, return the one with the lowest priority —
// the deadlock-break "victim". Ties resolve by sort order so the choice is
// deterministic across hosts.
export function lowestPriorityAgent(agents) {
  const list = Array.from(agents || []).map(normalizeAgent).filter(Boolean);
  if (list.length === 0) {
    return null;
  }
  return list.slice().sort((left, right) => {
    const diff = priorityIndex(right) - priorityIndex(left);
    if (diff !== 0) {
      return diff;
    }
    return left < right ? -1 : left > right ? 1 : 0;
  })[0];
}
