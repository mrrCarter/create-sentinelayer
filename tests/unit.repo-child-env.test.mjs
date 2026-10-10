import "./setup-env.mjs";
// The CLI runs a repository's own code in two places: its lint/typecheck/format/test scripts during
// review, and Python's ast module to parse its Python files. Running the scripts is the point;
// handing them this machine's credentials is not, and parsing must never import the repository's
// own modules.
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { __localReviewForTests } from "../src/review/local-review.js";
import { parseAstModuleSpecifiers } from "../src/daemon/ast-parser-layer.js";
import { parseFileCallgraph } from "../src/daemon/callgraph-overlay.js";

const SECRETS = {
  SENTINELAYER_TOKEN: "child-env-token-0000",
  SENTINELAYER_API_TOKEN: "child-env-api-token-0000",
  OPENAI_API_KEY: "child-env-openai-0000",
  ANTHROPIC_API_KEY: "child-env-anthropic-0000",
  GOOGLE_API_KEY: "child-env-google-0000",
  GH_TOKEN: "child-env-gh-0000",
  GITHUB_TOKEN: "child-env-github-0000",
  AWS_SECRET_ACCESS_KEY: "child-env-aws-0000",
  API_KEY: "child-env-bare-api-key-0000",
  ENCRYPTION_KEY: "child-env-encryption-key-0000",
  SENTRY_DSN: "child-env-sentry-dsn-0000",
  DB_PASS: "child-env-db-pass-0000",
  SMTP_PASSWORD: "child-env-smtp-password-0000",
  PGPASSWORD: "child-env-pgpassword-0000",
  MYSQL_PWD: "child-env-mysql-pwd-0000",
  SERVICE_CREDENTIALS: "child-env-credentials-0000",
  SQL_CONNECTION_STRING: "child-env-connection-string-0000",
  SSH_AUTH_SOCK: "child-env-ssh-agent-socket-0000",
  npm_config__auth: "child-env-npm-auth-0000",
  npm_config__authToken: "child-env-npm-authtoken-0000",
  "npm_config_//registry.example.invalid/:_authToken": "child-env-npm-registry-authtoken-0000",
};
// The scrub removes known and secret-looking names; it is a denylist, so other names pass through.
const KEPT = { SL_CHILD_ENV_ORDINARY: "child-env-ordinary-0000" };

test("a repository script run by review sees none of this machine's credentials", async () => {
  const repo = await fsp.mkdtemp(path.join(os.tmpdir(), "sl-child-env-"));
  const probes = { ...SECRETS, ...KEPT };
  const saved = Object.fromEntries(Object.keys(probes).map((name) => [name, process.env[name]]));
  Object.assign(process.env, probes);
  try {
    await fsp.writeFile(path.join(repo, "print-env.cjs"), "process.stdout.write(JSON.stringify(process.env));\n");
    const result = await __localReviewForTests.executeStaticCheck({
      check: { id: "print-env", label: "print env", command: process.execPath, args: ["print-env.cjs"], fileHint: "package.json" },
      targetPath: repo,
      runDir: path.join(repo, ".run"),
    });
    const printed = await fsp.readFile(path.join(repo, ".run", "checks", "print-env.stdout.log"), "utf8");
    const seen = JSON.parse(printed);
    for (const [name, value] of Object.entries(SECRETS)) {
      assert.equal(Object.hasOwn(seen, name), false, `${name} is not passed`);
      assert.equal(printed.includes(value), false, `${name}'s value is not passed`);
    }
    assert.ok(seen.PATH || seen.Path, "the rest of the environment is kept");
    assert.equal(seen.SL_CHILD_ENV_ORDINARY, KEPT.SL_CHILD_ENV_ORDINARY);
    assert.equal(seen.CI, "1");
    assert.ok(result, "the check ran");
  } finally {
    for (const [name, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    await fsp.rm(repo, { recursive: true, force: true });
  }
});

test("parsing a repository's Python never imports its modules or runs its programs", async (t) => {
  const hasPython = ["python3", "python"].some(
    (name) => spawnSync(name, ["--version"], { cwd: os.tmpdir(), windowsHide: true }).status === 0,
  );
  if (!hasPython) {
    t.skip("no Python on this machine");
    return;
  }
  const repo = await fsp.mkdtemp(path.join(os.tmpdir(), "sl-python-isolated-"));
  const marker = path.join(repo, "imported.marker");
  const cwd = process.cwd();
  const savedPythonPath = process.env.PYTHONPATH;
  const savedNoCwdSearch = process.env.NoDefaultCurrentDirectoryInExePath;
  try {
    const plant = `open(${JSON.stringify(marker)}, "a").write(__name__ + "\\n")\n`;
    await fsp.writeFile(path.join(repo, "ast.py"), plant);
    await fsp.writeFile(path.join(repo, "json.py"), plant);
    if (process.platform === "win32") {
      // Windows looks for a bare program name in the working directory before PATH. Plant programs
      // that fail every call (copies of whoami.exe), so running one, for the version check or the
      // parse, fails the parse. Some shells set NoDefaultCurrentDirectoryInExePath, which turns
      // that lookup off; test the default.
      delete process.env.NoDefaultCurrentDirectoryInExePath;
      const whoami = path.join(process.env.SystemRoot || "C:\\Windows", "System32", "whoami.exe");
      for (const name of ["python3.exe", "python.exe"]) {
        await fsp.copyFile(whoami, path.join(repo, name));
      }
    }
    const source = "import os\nfrom collections import OrderedDict\n\ndef main():\n    return os.getcwd()\n";
    await fsp.writeFile(path.join(repo, "main.py"), source);
    process.env.PYTHONPATH = repo;
    process.chdir(repo); // as when the CLI is started from inside the repository

    for (const absolutePath of [path.join(repo, "main.py"), "main.py"]) {
      const specifiers = await parseAstModuleSpecifiers({ absolutePath, content: source, language: "python" });
      const callgraph = await parseFileCallgraph({ absolutePath, content: source, language: "python" });
      assert.equal(specifiers.parserMode, "python_ast", specifiers.parseError);
      assert.deepEqual([...specifiers.specifiers].sort(), ["collections", "os"]);
      assert.equal(callgraph.parserMode, "python_ast", callgraph.parseError);
    }
    assert.equal(fs.existsSync(marker), false, "the repository's ast.py and json.py were never imported");
  } finally {
    process.chdir(cwd);
    if (savedPythonPath === undefined) delete process.env.PYTHONPATH;
    else process.env.PYTHONPATH = savedPythonPath;
    if (savedNoCwdSearch !== undefined) process.env.NoDefaultCurrentDirectoryInExePath = savedNoCwdSearch;
    await fsp.rm(repo, { recursive: true, force: true });
  }
});
