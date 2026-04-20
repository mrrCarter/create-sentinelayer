// backpressure-check — flag queue / worker patterns without backpressure or DLQ (#A18).
//
// When a consumer can outrun its queue the system degrades silently (memory
// balloons, latency spikes, and eventual OOM). We look for queue consumers
// and flag those missing:
//   - a bounded concurrency / queue size (backpressure)
//   - a dead-letter queue / DLQ signal for poison messages
//   - explicit retry limits

import fsp from "node:fs/promises";
import path from "node:path";

import { createFinding, findLineMatches, getLineContent, toPosix, walkRepoFiles } from "./base.js";

const CODE_EXTENSIONS = new Set([
  ".js",
  ".jsx",
  ".ts",
  ".tsx",
  ".mjs",
  ".cjs",
  ".py",
  ".go",
]);

const QUEUE_CONSUMER_PATTERNS = [
  /bull(?:mq)?\.\w+|new\s+Queue\s*\(/,
  /kafka\w*\.consumer\s*\(/,
  /sqs\w*\.receiveMessage\s*\(/,
  /rabbit\w*\.consume\s*\(/,
  /redis\w*\.subscribe\s*\(/,
  /celery\.task\s*\(/,
  /@task\s*\(/,
  /@app\.task\s*\(/,
  /\b(?:worker|consumer|processor)\s*=\s*(?:new\s+)?\w+/,
];

const BACKPRESSURE_SIGNALS = [
  /concurrency\s*[:=]\s*\d+/,
  /maxConcurrent/i,
  /prefetch[_-]?count/i,
  /max_queue_size|maxQueueSize/,
  /rate[_-]?limit/i,
  /drop[_-]?on[_-]?full/i,
  /visibility[_-]?timeout/i,
];

const DLQ_SIGNALS = [
  /dead[_-]?letter|DLQ/i,
  /retry[_-]?policy|max[_-]?retries|retry_limit/i,
  /poison[_-]?pill|poison[_-]?message/i,
];

export async function runBackpressureCheck({ rootPath, files = null } = {}) {
  const resolvedRoot = path.resolve(String(rootPath || "."));
  const iterator =
    Array.isArray(files) && files.length > 0
      ? iterateExplicitFiles(resolvedRoot, files)
      : walkRepoFiles({ rootPath: resolvedRoot, extensions: CODE_EXTENSIONS });

  const findings = [];
  for await (const { fullPath, relativePath } of iterator) {
    let content;
    try {
      content = await fsp.readFile(fullPath, "utf-8");
    } catch {
      continue;
    }
    const consumerMatch = QUEUE_CONSUMER_PATTERNS.find((p) => p.test(content));
    if (!consumerMatch) {
      continue;
    }
    const hasBackpressure = BACKPRESSURE_SIGNALS.some((p) => p.test(content));
    const hasDlq = DLQ_SIGNALS.some((p) => p.test(content));

    const line = findLineMatches(content, consumerMatch)[0]?.line || 1;
    if (!hasBackpressure) {
      findings.push(
        createFinding({
          tool: "backpressure-check",
          kind: "reliability.no-backpressure",
          severity: "P1",
          file: toPosix(relativePath),
          line,
          evidence: getLineContent(content, line),
          rootCause:
            "Queue consumer declared without a concurrency limit, prefetch count, or queue-full handling. A faster producer will balloon the in-memory queue or downstream pool.",
          recommendedFix:
            "Bound concurrency: BullMQ `concurrency` option, Kafka `max.poll.records`, SQS `MaxNumberOfMessages`, Celery `worker_prefetch_multiplier`. Pair with a 1-2 second visibility timeout.",
          confidence: 0.55,
        })
      );
    }
    if (!hasDlq) {
      findings.push(
        createFinding({
          tool: "backpressure-check",
          kind: "reliability.no-dlq",
          severity: "P1",
          file: toPosix(relativePath),
          line,
          evidence: getLineContent(content, line),
          rootCause:
            "No dead-letter queue / retry-limit / poison-pill handling. A bad message will loop forever until the worker is manually killed.",
          recommendedFix:
            "Configure a DLQ with max-receive-count (SQS), delivery-limit (Bull), or max_retries (Celery). Alert on DLQ depth > 0 so operators see poison messages.",
          confidence: 0.6,
        })
      );
    }
  }
  return findings;
}

async function* iterateExplicitFiles(resolvedRoot, files) {
  for (const file of files) {
    const trimmed = String(file || "").trim();
    if (!trimmed) {
      continue;
    }
    const fullPath = path.isAbsolute(trimmed)
      ? trimmed
      : path.join(resolvedRoot, trimmed);
    const relativePath = path
      .relative(resolvedRoot, fullPath)
      .replace(/\\/g, "/");
    yield { fullPath, relativePath };
  }
}
