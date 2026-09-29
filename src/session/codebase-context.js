import fs from "node:fs/promises";
import path from "node:path";
import { isMainThread, parentPort, Worker, workerData } from "node:worker_threads";

const CACHE_LIMIT_BYTES = 2 * 1024 * 1024;
const CACHE_TIMEOUT_MS = 750;

// Session creation is not an ingest command. Never recursively walk the cwd:
// it can be a home directory, a monorepo, or a slow network filesystem.
// The worker owns only a read; it cannot write metadata after its deadline.
if (!isMainThread && workerData?.kind === "session-context-cache") {
  let context = {};
  try {
    const cachePath = path.join(workerData.targetPath, ".sentinelayer", "CODEBASE_INGEST.json");
    const stat = await fs.stat(cachePath);
    if (stat.isFile() && stat.size <= CACHE_LIMIT_BYTES) {
      const raw = await fs.readFile(cachePath);
      if (raw.byteLength <= CACHE_LIMIT_BYTES) {
        const parsed = JSON.parse(raw.toString("utf8"));
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) context = parsed;
      }
    }
  } catch {
    // Missing, malformed, unreadable or oversized optional context is absent.
  }
  parentPort.postMessage(context);
}

export async function readSessionCodebaseContext(targetPath, { timeoutMs = CACHE_TIMEOUT_MS } = {}) {
  let worker;
  let timer;
  try {
    worker = new Worker(new URL("./codebase-context.js", import.meta.url), {
      workerData: { kind: "session-context-cache", targetPath },
      resourceLimits: { maxOldGenerationSizeMb: 32 },
      stdout: true,
      stderr: true,
    });
    worker.stdout.resume();
    worker.stderr.resume();
    return await new Promise((resolve) => {
      timer = setTimeout(() => resolve({}), timeoutMs);
      worker.once("message", resolve);
      worker.once("error", () => resolve({}));
      worker.once("exit", () => resolve({}));
    });
  } catch {
    return {};
  } finally {
    clearTimeout(timer);
    // Await actual worker termination, not merely a race against its promise.
    if (worker) await worker.terminate();
  }
}
