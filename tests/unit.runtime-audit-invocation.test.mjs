import "./setup-env.mjs";
// The local Lighthouse fallback takes a URL the repository can choose (package.json homepage,
// vercel.json, .env files). It runs without a shell, so nothing in the URL is expanded or run, and
// with credentials removed from npx's environment.
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { __frontendAnalyzeForTests } from "../src/agents/jules/tools/frontend-analyze.js";
import { __runtimeAuditForTests } from "../src/agents/jules/tools/runtime-audit.js";

const { lighthouseInvocation, detectDeployedUrl } = __runtimeAuditForTests;
const HOMEPAGE = "https://203.0.113.10/%OPENAI_API_KEY%/$SENTINELAYER_TOKEN/$(echo%20x)&echo%20y|z;w";
const ENV = { ...process.env, SENTINELAYER_TOKEN: "audit-user-token-0000", OPENAI_API_KEY: "audit-provider-key-0000" };

test("the repository's URL reaches Lighthouse as one literal argument, with no shell and no credentials", async () => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "sl-runtime-audit-"));
  try {
    await fsp.writeFile(path.join(root, "package.json"), JSON.stringify({ homepage: HOMEPAGE }));
    const url = new URL(detectDeployedUrl({ path: root }).primary).toString();
    assert.ok(url.includes("%OPENAI_API_KEY%") && url.includes("$SENTINELAYER_TOKEN"), "the URL keeps its text");

    for (const platform of ["linux", "darwin", "win32"]) {
      const invocation = lighthouseInvocation(url, path.join(root, "out.json"), {
        platform,
        execPath: process.execPath,
        exists: () => true,
        env: ENV,
      });
      assert.equal("shell" in invocation.options, false, `${platform}: no shell`);
      assert.equal(invocation.args.filter((arg) => arg === url).length, 1, `${platform}: the URL is one argument`);
      assert.equal(invocation.options.env.SENTINELAYER_TOKEN, undefined);
      assert.equal(invocation.options.env.OPENAI_API_KEY, undefined);
      assert.equal(invocation.file, platform === "win32" ? process.execPath : "npx");
    }
    assert.equal(
      lighthouseInvocation(url, "out.json", { platform: "win32", exists: () => false, env: ENV }),
      null,
      "without npm's npx script next to Node.js, Lighthouse does not run locally",
    );

    // Run the Windows-shaped invocation with a recorder in place of npm's npx script.
    const stub = path.join(root, "record.cjs");
    const seen = path.join(root, "seen.json");
    await fsp.writeFile(
      stub,
      "require('fs').writeFileSync(process.env.RECORD_TO, JSON.stringify({ argv: process.argv.slice(2), token: process.env.SENTINELAYER_TOKEN || null, key: process.env.OPENAI_API_KEY || null }));\n",
    );
    const invocation = lighthouseInvocation(url, path.join(root, "out.json"), {
      platform: "win32",
      execPath: process.execPath,
      exists: () => true,
      env: { ...ENV, RECORD_TO: seen },
    });
    execFileSync(invocation.file, [stub, ...invocation.args.slice(1)], invocation.options);
    const recorded = JSON.parse(await fsp.readFile(seen, "utf8"));
    assert.equal(recorded.argv[2], url, "received exactly as given");
    assert.equal(recorded.argv.length, 9, "no argument was split or joined");
    assert.deepEqual([recorded.token, recorded.key], [null, null]);
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
});

test("npm audit runs in the repository without credentials in its environment", () => {
  const invocation = __frontendAnalyzeForTests.npmAuditInvocation("/repo", ENV);
  assert.equal("shell" in invocation.options, false);
  assert.equal(invocation.options.cwd, "/repo");
  assert.equal(invocation.options.env.SENTINELAYER_TOKEN, undefined);
  assert.equal(invocation.options.env.OPENAI_API_KEY, undefined);
  assert.equal(invocation.options.env.PATH ?? invocation.options.env.Path, process.env.PATH ?? process.env.Path, "the rest is kept");
});
