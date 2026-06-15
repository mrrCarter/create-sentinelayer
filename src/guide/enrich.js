/**
 * Optional LLM enrichment for the deterministic decomposition.
 *
 * The heuristic in generator.js produces one ticket per phase. This layer asks
 * a model to split each phase into concrete, independently-mergeable per-PR
 * tickets with sharper acceptance criteria. It is:
 *  - opt-in (the caller passes a client),
 *  - capped (bounded phases × tickets, so cost is bounded),
 *  - fail-safe (any phase that errors or returns junk keeps its heuristic
 *    ticket — enrichment never throws and never drops work).
 */

export const DEFAULT_ENRICH_LIMITS = Object.freeze({
  maxPhases: 12,
  maxTicketsPerPhase: 4,
});

function clampInt(value, fallback, min, max) {
  const n = Math.floor(Number(value));
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, n));
}

export function buildEnrichPrompt(phase, maxTickets) {
  const fields = phase?.fields || {};
  const lines = [
    `Phase: ${String(phase?.title || "").trim()}`,
    fields.objective ? `Objective: ${fields.objective}` : "",
    fields.files ? `Files: ${fields.files}` : "",
    fields.tests ? `Tests: ${fields.tests}` : "",
    Array.isArray(phase?.tasks) && phase.tasks.length
      ? `Tasks:\n${phase.tasks.map((task) => `- ${task}`).join("\n")}`
      : "",
  ]
    .filter(Boolean)
    .join("\n");

  return `You are splitting ONE software build phase into concrete, independently-mergeable pull requests.
Return ONLY a JSON array (no prose, no markdown fences) of 1 to ${maxTickets} objects. Each object:
{"title": "imperative summary, <= 80 chars", "summary": "one sentence", "acceptance_criteria": ["short testable bullet", "..."]}
Rules: keep each PR small and shippable on its own; order them by dependency; 2-4 acceptance criteria each; no commentary.

${lines}`;
}

/** Pull a JSON array out of a model response, tolerating code fences / prose. */
export function extractJsonArray(text) {
  const raw = String(text || "").trim();
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const body = (fenced ? fenced[1] : raw).trim();
  const start = body.indexOf("[");
  const end = body.lastIndexOf("]");
  if (start === -1 || end === -1 || end <= start) return null;
  try {
    const parsed = JSON.parse(body.slice(start, end + 1));
    return Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function normalizeSubTickets(parsed, maxTickets) {
  if (!Array.isArray(parsed)) return null;
  const out = [];
  for (const item of parsed.slice(0, maxTickets)) {
    const title = String(item?.title || "").trim();
    if (!title) continue;
    const summary = String(item?.summary || "").trim();
    const acceptanceCriteria = Array.isArray(item?.acceptance_criteria)
      ? item.acceptance_criteria
          .map((value) => String(value || "").trim())
          .filter(Boolean)
          .slice(0, 6)
      : [];
    out.push({ title: title.slice(0, 120), summary, acceptanceCriteria });
  }
  return out.length ? out : null;
}

/** Enrich a single phase → array of {title, summary, acceptanceCriteria} or null. */
export async function enrichPhase({ phase, client, provider, model, apiKey, env, maxTicketsPerPhase }) {
  if (!client || typeof client.invoke !== "function") return null;
  const cap = clampInt(maxTicketsPerPhase, DEFAULT_ENRICH_LIMITS.maxTicketsPerPhase, 1, 10);
  try {
    const result = await client.invoke({
      provider,
      model,
      prompt: buildEnrichPrompt(phase, cap),
      apiKey,
      env,
      stream: false,
    });
    return normalizeSubTickets(extractJsonArray(result?.text), cap);
  } catch {
    return null;
  }
}

function subTicketDescription({ summary, acceptanceCriteria, dependencyLine }) {
  const acBlock = acceptanceCriteria.length
    ? acceptanceCriteria.map((item, index) => `${index + 1}. ${item}`).join("\n")
    : "1. Phase outcomes are verified by deterministic checks.";
  return [
    `Dependencies: ${dependencyLine}`,
    "",
    summary ? `${summary}\n` : "",
    "Acceptance criteria:",
    acBlock,
  ]
    .filter((line) => line !== "")
    .join("\n");
}

/**
 * Produce an enriched ticket list from a generated guide. Each enriched phase
 * expands into per-PR sub-tickets; phases beyond the cap, or that fail, keep
 * their original heuristic ticket. Returns { tickets, enrichedPhases }.
 */
export async function enrichGuideTickets({ guide, client, provider, model, apiKey, env, limits } = {}) {
  const phases = Array.isArray(guide?.phases) ? guide.phases : [];
  const baseTickets = Array.isArray(guide?.tickets) ? guide.tickets : [];
  const maxPhases = clampInt(limits?.maxPhases, DEFAULT_ENRICH_LIMITS.maxPhases, 1, 50);
  const maxTicketsPerPhase = clampInt(
    limits?.maxTicketsPerPhase,
    DEFAULT_ENRICH_LIMITS.maxTicketsPerPhase,
    1,
    10,
  );

  const tickets = [];
  let enrichedPhases = 0;

  for (let index = 0; index < phases.length; index += 1) {
    const phase = phases[index];
    const baseTicket = baseTickets[index];
    const subTickets =
      index < maxPhases
        ? await enrichPhase({ phase, client, provider, model, apiKey, env, maxTicketsPerPhase })
        : null;

    if (!subTickets) {
      if (baseTicket) tickets.push(baseTicket);
      continue;
    }

    enrichedPhases += 1;
    const issueNumber = index + 1;
    const phaseDeps = baseTicket?.dependencies || phase?.dependencies || [];
    const baseLabels = baseTicket?.labels || ["sentinelayer", "build-guide", `phase-${issueNumber}`];

    subTickets.forEach((sub, subIndex) => {
      const dependencies =
        subIndex === 0 ? phaseDeps : [tickets[tickets.length - 1].title];
      const dependencyLine = dependencies.length > 0 ? dependencies.join(", ") : "none (entry phase)";
      tickets.push({
        id: `phase-${issueNumber}.${subIndex + 1}`,
        phase_id: baseTicket?.phase_id || phase?.phaseId || "",
        title: sub.title,
        estimate_hours: baseTicket?.estimate_hours || { min: 4, max: 8 },
        dependencies,
        dependency_ids: subIndex === 0 ? baseTicket?.dependency_ids || [] : [],
        labels: [...baseLabels, "pr"],
        description: subTicketDescription({
          summary: sub.summary,
          acceptanceCriteria: sub.acceptanceCriteria,
          dependencyLine,
        }),
      });
    });
  }

  return { tickets, enrichedPhases };
}
