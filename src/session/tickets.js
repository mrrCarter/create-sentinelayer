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
  if (!session?.token || !session?.apiUrl) throw new Error("Not authenticated for this session.");
  return { token: session.token, apiUrl: normalizeString(session.apiUrl).replace(/\/+$/, "") };
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

export async function listTickets(
  sessionId,
  { targetPath = process.cwd(), available = false, resolveAuthSession = resolveActiveAuthSession, requestRead = requestJson } = {}
) {
  const { token, apiUrl } = await auth(targetPath, resolveAuthSession);
  const body = await requestRead(ticketsUrl(apiUrl, sessionId), { method: "GET", headers: { Authorization: `Bearer ${token}` } });
  const items = Array.isArray(body?.items) ? body.items : [];
  // Available = claimable by someone now: open, or working with an expired lease.
  // Never blocked work: the MVP has no dependencies, and blocked is never available.
  const filtered = available
    ? items.filter((t) => t.status === "open" || (t.status === "working" && t.lease && !t.lease.live))
    : items;
  return { items: filtered, cursor: body?.cursor ?? null, count: filtered.length };
}

export async function ticketEvents(
  sessionId,
  { after = 0, targetPath = process.cwd(), resolveAuthSession = resolveActiveAuthSession, requestRead = requestJson } = {}
) {
  const { token, apiUrl } = await auth(targetPath, resolveAuthSession);
  return requestRead(`${ticketsUrl(apiUrl, sessionId, "/events")}?after=${encodeURIComponent(String(after))}`, {
    method: "GET",
    headers: { Authorization: `Bearer ${token}` },
  });
}

async function mutate(url, { token, key, operation, body, requestMutation }) {
  return requestMutation(url, {
    method: "POST",
    operationName: `session.ticket_${operation}`,
    idempotencyKey: key,
    headers: { Authorization: `Bearer ${token}`, "Idempotency-Key": key },
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
  const { token, apiUrl } = await auth(targetPath, resolveAuthSession);
  const { key } = await operationKey(statePath, "claim", String(expectedVersion ?? "any"));
  const response = await mutate(ticketsUrl(apiUrl, sessionId, `/${encodeURIComponent(ticketId)}/claim`), {
    token, key, operation: "claim", requestMutation,
    body: expectedVersion == null ? {} : { expectedVersion: Number(expectedVersion) },
  });
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
  const { token, apiUrl } = await auth(targetPath, resolveAuthSession);
  const { key } = await operationKey(statePath, "renew", `${held.leaseId}:${held.fence}:${held.ticketVersion}`);
  const response = await mutate(ticketsUrl(apiUrl, sessionId, `/${encodeURIComponent(ticketId)}/lease/renew`), {
    token, key, operation: "renew", requestMutation, body: { leaseId: held.leaseId, fence: held.fence },
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
  const { token, apiUrl } = await auth(targetPath, resolveAuthSession);
  const { key } = await operationKey(statePath, "release", `${held.leaseId}:${held.fence}:${held.ticketVersion}`);
  const response = await mutate(ticketsUrl(apiUrl, sessionId, `/${encodeURIComponent(ticketId)}/lease/release`), {
    token, key, operation: "release", requestMutation,
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
  const { token, apiUrl } = await auth(targetPath, resolveAuthSession);
  const { key } = await operationKey(statePath, "submit", `${held.leaseId}:${held.fence}:${held.ticketVersion}`);
  const response = await mutate(ticketsUrl(apiUrl, sessionId, `/${encodeURIComponent(ticketId)}/submit`), {
    token, key, operation: "submit", requestMutation,
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
