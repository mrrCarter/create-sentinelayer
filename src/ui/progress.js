import process from "node:process";

import pc from "picocolors";

function clampPercent(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return 0;
  }
  return Math.max(0, Math.min(100, Math.round(parsed)));
}

function sanitizeNotificationText(value) {
  return String(value || "")
    .replace(/[\u0000-\u001f\u007f]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function createProgressReporter(options = {}) {
  const stdout = options.stdout || process.stdout;
  const stderr = options.stderr || process.stderr;
  const quiet = Boolean(options.quiet);
  const isCi = options.isCi === undefined ? Boolean(process.env.CI) : Boolean(options.isCi);
  const oscEnabled =
    !quiet && !isCi && Boolean(stdout && typeof stdout.write === "function" && stdout.isTTY);
  const bellEnabled = !quiet && Boolean(stderr && typeof stderr.write === "function" && stderr.isTTY);
  let started = false;
  let lastPercent = null;

  function writeStderrLine(text) {
    if (quiet || !stderr || typeof stderr.write !== "function") {
      return;
    }
    stderr.write(`${text}\n`);
  }

  function emitOscProgress(percent) {
    if (!oscEnabled) {
      return;
    }
    stdout.write(`\u001B]9;4;1;${percent}\u0007`);
  }

  function emitOscNotification(message) {
    if (!oscEnabled) {
      return;
    }
    const normalized = sanitizeNotificationText(message);
    if (!normalized) {
      return;
    }
    stdout.write(`\u001B]9;${normalized}\u0007`);
  }

  function emitBell() {
    if (!bellEnabled) {
      return;
    }
    stderr.write("\u0007");
  }

  function update(percent, message) {
    const safePercent = clampPercent(percent);
    const safeMessage = String(message || "").trim();

    if (lastPercent === safePercent && !safeMessage) {
      return;
    }
    lastPercent = safePercent;
    started = true;
    emitOscProgress(safePercent);
    writeStderrLine(pc.gray(`[progress ${safePercent}%] ${safeMessage}`.trim()));
  }

  function start(message = "starting") {
    if (started) {
      return;
    }
    update(0, message);
  }

  function complete(message = "completed") {
    update(100, message);
    emitOscNotification(`Sentinelayer: ${message}`);
  }

  function fail(message = "failed") {
    writeStderrLine(pc.red(`[error] ${String(message || "failed").trim()}`));
    emitBell();
    emitOscNotification(`Sentinelayer failed: ${message}`);
  }

  return {
    start,
    update,
    complete,
    fail,
  };
}
