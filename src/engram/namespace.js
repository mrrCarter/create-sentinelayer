/**
 * ENGRAM §2 — namespaces (the tenancy boundary) + fail-closed authorization.
 *
 * A `scope` selects a NAMESPACE, formatted `<kind>:<id>` (e.g. `session:abc`,
 * `project:web`, `org:acme`, `agent:codex`, or generic `ns:notes`). The kind
 * prefix routes the store to a backend (session kind -> the SL session
 * adapter; everything else -> the generic append-log). The engine itself
 * knows NOTHING about kinds — that lives in the store adapter map — which is
 * what makes the whole thing detachable/sellable.
 *
 * Authorization is FAIL-CLOSED: an action is denied unless the injected
 * consent explicitly allows the caller's required scope. P0 ships a
 * permissive-LOCAL consent (the local principal is trusted; guests/unknown
 * are denied) behind the same seam the hosted AIdenID/UserAgentGrant path
 * (§2.1) will implement.
 */

export class AccessDeniedError extends Error {
  constructor(message) {
    super(message);
    this.name = "AccessDeniedError";
    this.status = 403;
    this.code = "access_denied";
  }
}

/** Action -> required OAuth-style scope (aligns with the hosted scope set). */
export const ACTION_SCOPES = Object.freeze({
  write: "memory:write",
  read: "memory:read",
  summarize: "memory:read",
});

const NAMESPACE_ID_RE = /^[A-Za-z0-9._:-]{1,128}$/;
const NAMESPACE_KIND_RE = /^[a-z][a-z0-9_-]{0,31}$/;

/**
 * Parse + validate a namespace scope.
 * @param {string} scope
 * @returns {{kind: string, id: string, raw: string}}
 */
export function parseNamespace(scope) {
  const raw = String(scope ?? "").trim();
  if (!raw) throw new Error("namespace scope is required.");
  const colon = raw.indexOf(":");
  const kind = colon > 0 ? raw.slice(0, colon) : "ns";
  const id = colon > 0 ? raw.slice(colon + 1) : raw;
  if (!NAMESPACE_KIND_RE.test(kind)) throw new Error(`invalid namespace kind '${kind}'.`);
  if (!NAMESPACE_ID_RE.test(id)) throw new Error("invalid namespace id.");
  if (id.includes("..") || id.includes("/") || id.includes("\\")) {
    throw new Error("namespace id must not contain path-traversal segments.");
  }
  return { kind, id, raw: `${kind}:${id}` };
}

/**
 * Create a LOCAL consent policy (P0). Fail-closed by construction: a caller
 * with no identity, or a guest (unless explicitly allowed), is denied.
 * @param {object} [options]
 * @param {boolean} [options.allowGuests=false]
 * @returns {{allows: (caller:object, namespace:object, scope:string)=>boolean}}
 */
export function createLocalConsent({ allowGuests = false } = {}) {
  return {
    allows(caller, _namespace, _scope) {
      if (!caller || !caller.id) return false; // no identity -> deny
      if (caller.kind === "guest" && !allowGuests) return false; // guests denied by default
      return true;
    },
  };
}

/**
 * Fail-closed authorization. Throws AccessDeniedError (403) unless the
 * consent explicitly allows the caller's required scope on the namespace.
 * @returns {{ok: true, scope: string}}
 */
export function authorize(caller, namespace, action, { consent } = {}) {
  const scope = ACTION_SCOPES[action];
  if (!scope) throw new Error(`unknown action '${action}'.`);
  const allowed =
    consent && typeof consent.allows === "function" ? Boolean(consent.allows(caller, namespace, scope)) : false;
  if (!allowed) {
    throw new AccessDeniedError(
      `caller '${caller?.id || "anonymous"}' lacks '${scope}' on namespace '${namespace?.raw || namespace}'.`,
    );
  }
  return { ok: true, scope };
}
