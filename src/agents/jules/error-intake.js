import { listErrorQueue } from "../../daemon/error-worker.js";
import { JULES_DEFINITION } from "./config/definition.js";
import { routeErrorToPersona } from "./pulse.js";

/**
 * Jules Tanaka — Error Intake
 * Poll error queue, route by persona, scope from stack traces.
 */
export async function pollFrontendErrors({ targetPath, statuses, limit = 10 }) {
  const qr = await listErrorQueue({ targetPath, statuses: statuses || ["QUEUED"], limit });
  const items = qr.items || [];
  const fe = [];
  const ot = [];
  for (const i of items) {
    const p = routeErrorToPersona(i);
    if (p === "frontend") fe.push({ ...i, routedPersona: p });
    else ot.push({ ...i, routedPersona: p });
  }
  return { items, frontendItems: fe, otherItems: ot };
}

export function scopeFromError(workItem) {
  const pr = [];
  const se = [];
  const te = [];
  if (workItem.stackTrace) {
    const regex = /(?:at\s+.*?\()?([^\s(]+\.(tsx|jsx|ts|js|vue|svelte)):(\d+)/g;
    let m;
    while ((m = regex.exec(workItem.stackTrace)) !== null) {
      if (/\.(tsx|jsx|vue|svelte)$/.test(m[1])) {
        pr.push({ path: m[1], line: parseInt(m[3]), reason: "stack_trace" });
      }
    }
  }
  if (pr.length === 0) {
    for (const p of JULES_DEFINITION.defaultScope.primaryPatterns) pr.push({ path: p, reason: "default_scope" });
  }
  for (const p of JULES_DEFINITION.defaultScope.secondaryPatterns) se.push({ path: p, reason: "default_secondary" });
  for (const p of JULES_DEFINITION.defaultScope.tertiaryPatterns) te.push({ path: p, reason: "default_tertiary" });
  return { primary: pr, secondary: se, tertiary: te };
}

export function summarizeError(w) {
  const parts = [];
  parts.push("Error: " + (w.errorCode || "UNKNOWN") + " at " + (w.endpoint || "unknown"));
  parts.push("Severity: " + (w.severity || "P2"));
  if (w.message) parts.push("Message: " + w.message.slice(0, 300));
  if (w.occurrenceCount > 1) parts.push("Occurrences: " + w.occurrenceCount);
  if (w.stackTrace) parts.push("Stack:\n" + w.stackTrace.split("\n").slice(0, 5).join("\n"));
  return parts.join("\n");
}
