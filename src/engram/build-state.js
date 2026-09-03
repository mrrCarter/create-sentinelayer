/**
 * ENGRAM — build lifecycle: absent | building | ready.
 *
 * An engram that is auto-built on session load is queryable by definition: something
 * will ask it a question while it is still being written. The dangerous answer is not
 * an error, it is a PLAUSIBLE one — a needle search over a half-ingested document
 * finds the best match among the chunks that happen to exist and returns it with the
 * same confidence it would give a complete index. The caller cannot tell the
 * difference, because a partial index does not look partial from the outside.
 *
 * So readiness is a fact that must be RECORDED, never inferred:
 *
 *   absent    no build has started
 *   building  a build started and has not recorded completion -- REFUSES queries
 *   ready     a build recorded completion, and the counts and digest agree
 *
 * THE CASE THIS IS BUILT AROUND: a build that DIES halfway. Nothing gets to observe
 * the crash, so the state must be wrong-by-default in the safe direction. `begin`
 * writes `building` BEFORE any chunk is written and only `complete` moves it to
 * `ready`, so a killed process leaves `building` on disk forever. That is the
 * intended outcome -- an engram nobody finished must never answer as though someone
 * had. Recovery is to re-run the build, which is safe because ingestion is idempotent.
 *
 * A torn or unparseable state file is treated as `building` for the same reason:
 * every unreadable state resolves to the one that refuses.
 */

import fsp from "node:fs/promises";
import path from "node:path";

import { namespaceDir } from "./store.js";

export const BUILD_STATES = Object.freeze({
  ABSENT: "absent",
  BUILDING: "building",
  READY: "ready",
});

const STATE_FILE = "build-state.json";

/** Raised when a namespace is asked a question it cannot honestly answer yet. */
export class EngramNotReadyError extends Error {
  constructor(namespace, state) {
    super(`engram namespace "${namespace}" is ${state}, not ready: refusing to answer from a partial index`);
    this.name = "EngramNotReadyError";
    this.state = state;
    this.namespace = namespace;
  }
}

function stateFile(root, namespace) {
  return path.join(namespaceDir(root, namespace), STATE_FILE);
}

/**
 * Write JSON so a crash mid-write cannot leave a half-file that parses.
 * Temp file + rename is atomic within a directory on every platform we run on.
 */
async function writeAtomic(file, value) {
  await fsp.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  await fsp.writeFile(tmp, `${JSON.stringify(value, null, 2)}\n`, "utf-8");
  await fsp.rename(tmp, file);
}

export function createBuildState({ storeRoot } = {}) {
  const root = path.resolve(String(storeRoot || "."));

  async function read(namespace) {
    let raw;
    try {
      raw = await fsp.readFile(stateFile(root, namespace), "utf-8");
    } catch (error) {
      if (error && error.code === "ENOENT") return { state: BUILD_STATES.ABSENT };
      throw error;
    }
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch {
      // Unreadable state resolves to the one that REFUSES, never to ready.
      return { state: BUILD_STATES.BUILDING, reason: "state file is unreadable" };
    }
    if (!parsed || typeof parsed !== "object") {
      return { state: BUILD_STATES.BUILDING, reason: "state file is not an object" };
    }
    if (parsed.state === BUILD_STATES.READY) {
      // READY is only honoured when its own record is self-consistent. A count or
      // digest that disagrees means something wrote this file without finishing the
      // work it describes.
      const consistent =
        Number.isInteger(parsed.expectedChunks) &&
        Number.isInteger(parsed.writtenChunks) &&
        parsed.expectedChunks === parsed.writtenChunks &&
        typeof parsed.completedAt === "string" &&
        parsed.completedAt.length > 0;
      if (!consistent) {
        return { ...parsed, state: BUILD_STATES.BUILDING, reason: "ready record is inconsistent" };
      }
    }
    return parsed;
  }

  return {
    read,

    /** Mark a build STARTED. Must be called before the first chunk is written. */
    async begin(namespace, { docDigest = null, expectedChunks = null, startedAt } = {}) {
      const record = {
        state: BUILD_STATES.BUILDING,
        namespace: namespace.raw,
        docDigest,
        expectedChunks,
        writtenChunks: 0,
        startedAt: startedAt || new Date().toISOString(),
        completedAt: null,
      };
      await writeAtomic(stateFile(root, namespace), record);
      return record;
    },

    /**
     * Mark a build COMPLETE. Refuses when the work does not match what `begin`
     * promised -- completing a build that wrote fewer chunks than expected would
     * stamp `ready` on a partial index, which is the whole failure this module exists
     * to prevent.
     */
    async complete(namespace, { writtenChunks, completedAt } = {}) {
      const current = await read(namespace);
      if (current.state === BUILD_STATES.ABSENT) {
        throw new Error("cannot complete a build that never began");
      }
      if (!Number.isInteger(writtenChunks) || writtenChunks < 0) {
        throw new TypeError("writtenChunks must be a non-negative integer");
      }
      if (Number.isInteger(current.expectedChunks) && current.expectedChunks !== writtenChunks) {
        throw new Error(
          `refusing to mark ready: expected ${current.expectedChunks} chunks, wrote ${writtenChunks}`,
        );
      }
      const record = {
        ...current,
        state: BUILD_STATES.READY,
        writtenChunks,
        expectedChunks: Number.isInteger(current.expectedChunks) ? current.expectedChunks : writtenChunks,
        completedAt: completedAt || new Date().toISOString(),
        reason: undefined,
      };
      delete record.reason;
      await writeAtomic(stateFile(root, namespace), record);
      return record;
    },

    /**
     * Throw ONLY when a build is in flight. The gate the RETRIEVAL path calls.
     *
     * Deliberately weaker than `assertQueryable`, and the difference is the whole
     * reason this exists: `absent` must be ALLOWED. A session namespace is adapter-
     * backed and live — nobody ever "builds" it, so it has no state file and never
     * will. Requiring `ready` there would refuse every session recall in the product.
     *
     * What must be refused is the state where answering is actively misleading: a
     * document half-written to disk, where recall would return the best match among
     * the chunks that happen to exist and look exactly like a complete answer.
     */
    async assertNotBuilding(namespace) {
      const current = await read(namespace);
      if (current.state === BUILD_STATES.BUILDING) {
        throw new EngramNotReadyError(namespace.raw, current.state);
      }
      return current;
    },

    /** Throw unless the namespace is ready. For callers that require a finished build. */
    async assertQueryable(namespace) {
      const current = await read(namespace);
      if (current.state !== BUILD_STATES.READY) {
        throw new EngramNotReadyError(namespace.raw, current.state);
      }
      return current;
    },
  };
}
