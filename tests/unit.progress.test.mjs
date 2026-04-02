import test from "node:test";
import assert from "node:assert/strict";

import { createProgressReporter } from "../src/ui/progress.js";

function makeStream({ isTTY = true } = {}) {
  const writes = [];
  return {
    isTTY,
    writes,
    write(chunk) {
      writes.push(String(chunk));
      return true;
    },
  };
}

test("Unit: progress reporter emits stderr progress lines and OSC progress updates", () => {
  const stdout = makeStream({ isTTY: true });
  const stderr = makeStream({ isTTY: true });
  const reporter = createProgressReporter({
    stdout,
    stderr,
    quiet: false,
    isCi: false,
  });

  reporter.start("starting");
  reporter.update(50, "halfway");
  reporter.complete("done");

  const stderrText = stderr.writes.join("");
  const stdoutText = stdout.writes.join("");
  assert.match(stderrText, /\[progress 0%\] starting/);
  assert.match(stderrText, /\[progress 50%\] halfway/);
  assert.match(stderrText, /\[progress 100%\] done/);
  assert.match(stdoutText, /\u001B\]9;4;1;0\u0007/);
  assert.match(stdoutText, /\u001B\]9;4;1;50\u0007/);
  assert.match(stdoutText, /\u001B\]9;4;1;100\u0007/);
  assert.match(stdoutText, /\u001B\]9;Sentinelayer: done\u0007/);
});

test("Unit: progress reporter quiet mode suppresses progress and notifications", () => {
  const stdout = makeStream({ isTTY: true });
  const stderr = makeStream({ isTTY: true });
  const reporter = createProgressReporter({
    stdout,
    stderr,
    quiet: true,
    isCi: false,
  });

  reporter.start("starting");
  reporter.update(30, "work");
  reporter.complete("done");
  reporter.fail("failed");

  assert.equal(stdout.writes.length, 0);
  assert.equal(stderr.writes.length, 0);
});

test("Unit: progress reporter fail emits error line and bell on tty stderr", () => {
  const stdout = makeStream({ isTTY: true });
  const stderr = makeStream({ isTTY: true });
  const reporter = createProgressReporter({
    stdout,
    stderr,
    quiet: false,
    isCi: false,
  });

  reporter.fail("operation failed");

  const stderrText = stderr.writes.join("");
  const stdoutText = stdout.writes.join("");
  assert.match(stderrText, /\[error\] operation failed/);
  assert.match(stderrText, /\u0007/);
  assert.match(stdoutText, /\u001B\]9;Sentinelayer failed: operation failed\u0007/);
});
