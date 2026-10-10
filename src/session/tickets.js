// tickets.js — the room's shared backlog from the CLI: list, claim, renew, release,
// submit, and the ticket event feed (API "Ticket Lease Contract (T2)").
//
// Credentials: every call resolves auth with resolveActiveAuthSession. Inside an
// admitted agent's command (the runCli choke point), that is the agent's admission
// credential and never the human token, so a ticket is claimed AS the agent.
//
// Lease state: a claim's { leaseId, fence, version, expiresAt } is kept per
// (session, ticket, identity) in a local file. Only a MISSING file means "no lease
// held here"; an unreadable one refuses, never reads as absent.
//
// Lost responses: a write's Idempotency-Key is stored BEFORE the request is sent. If
// the response is lost, re-running the same command reuses that key, and the server
// replays the original result instead of performing the operation again.

import { randomUUID } from "node:crypto";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";

import { checkedTransport, credentialFor, isAuthenticated } from "../auth/credential-destinations.js";
import { requestJson, requestJsonMutation } from "../auth/http.js";
import { resolveActiveAuthSession } from "../auth/service.js";

function normalizeString(value) {
  return String(value ?? "").trim();
}

function segment(value, label) {
  const text = normalizeString(value).toLowerCase();
  if (!/^[a-z0-9][a-z0-9._:-]{0,63}$/.test(text)) throw new Error(`${label} is not a valid identifier.`);
  return text.replace(/:/g, "%3a");
}

export function ticketLeasePath(sessionId, ticketId, identity, { homeDir } = {}) {
  return path.join(
    homeDir || os.homedir(),
    ".sentinelayer",
    "agents",
    segment(identity, "identity"),
    "tickets",
    segment(sessionId, "sessionId"),
    `${segment(ticketId, "ticketId")}.json`
  );
}

async function readState(filePath) {
  let raw;
  try {
    raw = await fsp.readFile(filePath, "utf8");
  } catch (error) {
    if (error && error.code === "ENOENT") return null;
    throw new Error(`The local ticket lease state at ${filePath} is unreadable; refusing to guess.`);
  }
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("not an object");
    return parsed;
  } catch {
    throw new Error(`The local ticket lease state at ${filePath} is unreadable; refusing to guess.`);
  }
}

async function writeState(filePath, state) {
  await fsp.mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
  const tmp = `${filePath}.${randomUUID()}.tmp`;
  await fsp.writeFile(tmp, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600, flag: "wx" });
  await fsp.rename(tmp, filePath);
}

async function auth(targetPath, resolveAuthSession) {
  const session = await resolveAuthSession({ cwd: targetPath, env: process.env, autoRotate: false });
  if (!isAuthenticated(session) || !session?.apiUrl) throw new Error("Not authenticated for this session.");
  return { credential: await credentialFor(session), apiUrl: normalizeString(session.apiUrl).replace(/\/+$/, "") };
}

function ticketsUrl(apiUrl, sessionId, suffix = "") {
  return `${apiUrl}/api/v1/sessions/${encodeURIComponent(sessionId)}/tickets${suffix}`;
}

/** The Idempotency-Key for this logical write: reused until its response is stored. */
async function operationKey(statePath, operation, fingerprint) {
  const state = (await readState(statePath)) || {};
  const pending = state.pending;
  if (pending && pending.operation === operation && pending.fingerprint === fingerprint && pending.key) {
    return { key: pending.key, state };
  }
  const key = `${operation}-${randomUUID()}`;
  const next = { ...state, pending: { operation, fingerprint, key } };
  await writeState(statePath, next);
  return { key, state: next };
}

function leaseState(response) {
  return {
    version: 1,
    leaseId: response.lease.leaseId,
    fence: response.lease.fence,
    ticketVersion: response.version,
    expiresAt: response.lease.expiresAt,
  };
}

const SNAPSHOT_PAGE = 200;
const SNAPSHOT_MAX_PAGES = 50;

function malformedSnapshot(reason) {
  return new Error(`The ticket snapshot is malformed (${reason}); refusing a partial list.`);
}

/**
 * One snapshot page, validated before anything in it is believed. The snapshot is keyset by
 * ticket id: ids on a page are STRICTLY ascending and above the previous continuation (so
 * none repeats), and the continuation is exactly the LAST id returned -- a token that jumps
 * ahead would silently skip every ticket in between. Anything else is not a complete list.
 */
function validatedSnapshotPage(body, { first, afterId }) {
  if (!body || typeof body !== "object" || Array.isArray(body)) throw malformedSnapshot("a page is not an object");
  if (!Array.isArray(body.items)) throw malformedSnapshot("a page has no items list");
  if (typeof body.hasMore !== "boolean") throw malformedSnapshot("a page does not say whether there is more");
  if (first && !(Number.isSafeInteger(body.cursor) && body.cursor >= 0)) {
    throw malformedSnapshot("the first page has no room cursor to follow events from");
  }
  let previous = afterId;
  for (const item of body.items) {
    const id = item && typeof item === "object" ? item.id : null;
    if (typeof id !== "string" || !id) throw malformedSnapshot("a ticket has no id");
    if (previous && !(id > previous)) throw malformedSnapshot("ticket ids are not in ascending order");
    previous = id;
  }
  if (body.hasMore) {
    if (!body.items.length) throw malformedSnapshot("an empty page claims there is more");
    const next = body.nextAfterId;
    if (typeof next !== "string" || !next) throw malformedSnapshot("there is more but no way to continue");
    if (next !== previous) throw malformedSnapshot("the continuation is not the last ticket returned");
  }
  return body;
}

/**
 * The room's COMPLETE backlog, from GET /tickets/snapshot paged to the end. The board read
 * (GET /tickets) is a bounded, newest-first page: filtering it for "available" could miss
 * claimable work beyond the page. `cursor` is the FIRST page's room cursor, taken with that
 * page; `sl session ticket events --after <cursor>` continues from exactly there. A snapshot
 * that cannot be completed is refused, never returned partial.
 */
export async function listTickets(
  sessionId,
  {
    targetPath = process.cwd(),
    available = false,
    resolveAuthSession = resolveActiveAuthSession,
    requestRead = requestJson,
    pageSize = SNAPSHOT_PAGE,
    maxPages = SNAPSHOT_MAX_PAGES,
  } = {}
) {
  const { credential, apiUrl } = await auth(targetPath, resolveAuthSession);
  const items = [];
  let cursor = null;
  let afterId = null;
  let complete = false;
  for (let page = 0; page < maxPages && !complete; page += 1) {
    const query = new URLSearchParams({ limit: String(pageSize) });
    if (afterId) query.set("afterId", afterId);
    const body = validatedSnapshotPage(
      await checkedTransport(requestRead)(`${ticketsUrl(apiUrl, sessionId, "/snapshot")}?${query}`, {
        method: "GET",
        credential,
      }),
      { first: page === 0, afterId },
    );
    if (page === 0) cursor = body.cursor; // ONLY the first page's cursor is the baseline
    items.push(...body.items);
    if (!body.hasMore) complete = true;
    else afterId = body.nextAfterId;
  }
  if (!complete) {
    throw new Error(`The room has more than ${maxPages * pageSize} tickets; refusing a partial list.`);
  }
  // Newest first for people; the snapshot itself is in id order.
  items.sort((a, b) => String(b.createdAt || "").localeCompare(String(a.createdAt || "")) || String(a.id).localeCompare(String(b.id)));
  // Available = claimable by someone now: open, or working with an expired lease.
  // Never blocked work: the MVP has no dependencies, and blocked is never available.
  const filtered = available
    ? items.filter((t) => t.status === "open" || (t.status === "working" && t.lease && !t.lease.live))
    : items;
  return { items: filtered, cursor, count: filtered.length, complete: true };
}

export async function ticketEvents(
  sessionId,
  { after = 0, targetPath = process.cwd(), resolveAuthSession = resolveActiveAuthSession, requestRead = requestJson } = {}
) {
  const { credential, apiUrl } = await auth(targetPath, resolveAuthSession);
  return checkedTransport(requestRead)(`${ticketsUrl(apiUrl, sessionId, "/events")}?after=${encodeURIComponent(String(after))}`, {
    method: "GET",
    credential,
  });
}

async function mutate(url, { credential, key, operation, body, requestMutation }) {
  return checkedTransport(requestMutation)(url, {
    method: "POST",
    operationName: `session.ticket_${operation}`,
    idempotencyKey: key,
    credential,
    headers: { "Idempotency-Key": key },
    body,
  });
}

export async function claimTicket(
  sessionId,
  ticketId,
  {
    identity,
    expectedVersion = null,
    targetPath = process.cwd(),
    homeDir,
    resolveAuthSession = resolveActiveAuthSession,
    requestMutation = requestJsonMutation,
  } = {}
) {
  const statePath = ticketLeasePath(sessionId, ticketId, identity, { homeDir });
  const { credential, apiUrl } = await auth(targetPath, resolveAuthSession);
  const { key } = await operationKey(statePath, "claim", String(expectedVersion ?? "any"));
  const response = await mutate(ticketsUrl(apiUrl, sessionId, `/${encodeURIComponent(ticketId)}/claim`), {
    credential, key, operation: "claim", requestMutation,
    body: expectedVersion == null ? {} : { expectedVersion: Number(expectedVersion) },
  });
  // The lease is recorded here only if the server says it is held by the identity that
  // asked: an agent by its own id, a person as a human. Anything else is not this lease.
  const holder = response?.ticket?.lease;
  const heldByIdentity =
    identity === "human" ? holder?.holderKind === "human" : holder?.holderKind === "agent" && holder?.holder === identity;
  if (!heldByIdentity) {
    throw new Error(
      `The server recorded this lease for ${holder?.holderKind || "nobody"} "${holder?.holder || ""}", not for "${identity}". ` +
        "Nothing was recorded locally; release it from the web if it is not yours."
    );
  }
  await writeState(statePath, leaseState(response));
  return response;
}

async function heldLease(statePath) {
  const state = await readState(statePath);
  if (!state || !state.leaseId) {
    throw new Error("This identity holds no lease on that ticket here. Claim it first.");
  }
  return state;
}

export async function renewTicketLease(
  sessionId,
  ticketId,
  { identity, targetPath = process.cwd(), homeDir, resolveAuthSession = resolveActiveAuthSession, requestMutation = requestJsonMutation } = {}
) {
  const statePath = ticketLeasePath(sessionId, ticketId, identity, { homeDir });
  const held = await heldLease(statePath);
  const { credential, apiUrl } = await auth(targetPath, resolveAuthSession);
  const { key } = await operationKey(statePath, "renew", `${held.leaseId}:${held.fence}:${held.ticketVersion}`);
  const response = await mutate(ticketsUrl(apiUrl, sessionId, `/${encodeURIComponent(ticketId)}/lease/renew`), {
    credential, key, operation: "renew", requestMutation, body: { leaseId: held.leaseId, fence: held.fence },
  });
  await writeState(statePath, leaseState(response));
  return response;
}

export async function releaseTicketLease(
  sessionId,
  ticketId,
  { identity, reason = null, targetPath = process.cwd(), homeDir, resolveAuthSession = resolveActiveAuthSession, requestMutation = requestJsonMutation } = {}
) {
  const statePath = ticketLeasePath(sessionId, ticketId, identity, { homeDir });
  const held = await heldLease(statePath);
  const { credential, apiUrl } = await auth(targetPath, resolveAuthSession);
  const { key } = await operationKey(statePath, "release", `${held.leaseId}:${held.fence}:${held.ticketVersion}`);
  const response = await mutate(ticketsUrl(apiUrl, sessionId, `/${encodeURIComponent(ticketId)}/lease/release`), {
    credential, key, operation: "release", requestMutation,
    body: { leaseId: held.leaseId, fence: held.fence, expectedVersion: held.ticketVersion, ...(reason ? { reason } : {}) },
  });
  await fsp.rm(statePath, { force: true });
  return response;
}

export async function submitTicket(
  sessionId,
  ticketId,
  {
    identity,
    implementationSha = null,
    evidence = [],
    targetPath = process.cwd(),
    homeDir,
    resolveAuthSession = resolveActiveAuthSession,
    requestMutation = requestJsonMutation,
  } = {}
) {
  const statePath = ticketLeasePath(sessionId, ticketId, identity, { homeDir });
  const held = await heldLease(statePath);
  const { credential, apiUrl } = await auth(targetPath, resolveAuthSession);
  const { key } = await operationKey(statePath, "submit", `${held.leaseId}:${held.fence}:${held.ticketVersion}`);
  const response = await mutate(ticketsUrl(apiUrl, sessionId, `/${encodeURIComponent(ticketId)}/submit`), {
    credential, key, operation: "submit", requestMutation,
    body: {
      leaseId: held.leaseId,
      fence: held.fence,
      expectedVersion: held.ticketVersion,
      ...(implementationSha ? { implementationSha } : {}),
      evidence,
    },
  });
  await fsp.rm(statePath, { force: true });
  return response;
}
