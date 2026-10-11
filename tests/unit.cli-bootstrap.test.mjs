import "./setup-env.mjs";
// The bin scripts check the runtime before they load the rest of the CLI (src/cli-bootstrap.js).
// When the CLI refuses to run (Windows with a libuv before 1.48.0, see
// unit.cli-runtime-floor.test.mjs), nothing a CLI module does as it loads may happen first. CI runs
// this file on Windows under Node.js 22.0.0 and under Node.js 20.19.0, whose libuv is really old.
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { parse } from "@babel/parser";

import { restrictProgramLookupToPath } from "../src/program-lookup.js";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const PACKAGE = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));
const BINS = [...new Set(Object.values(PACKAGE.bin))].sort();
const BOOTSTRAP = "src/cli-bootstrap.js";
const REFUSAL = /needs Node\.js 22 or later/g;
// The real libuv of this runtime, checked as if on Windows: false under Node.js 20.
const REAL_LIBUV_HONOURS_SETTING = restrictProgramLookupToPath({ platform: "win32", env: {} }).ok;

function staticImports(file) {
  const ast = parse(fs.readFileSync(path.join(ROOT, file), "utf8"), { sourceType: "module" });
  return ast.program.body
    .filter((node) => node.source && ["ImportDeclaration", "ExportNamedDeclaration", "ExportAllDeclaration"].includes(node.type))
    .map((node) => node.source.value);
}

// Every repository module that loads before the entry's code runs.
function staticGraph(entry) {
  const modules = new Set();
  const queue = [entry];
  while (queue.length > 0) {
    const file = queue.shift();
    if (modules.has(file)) continue;
    modules.add(file);
    for (const specifier of staticImports(file)) {
      if (specifier.startsWith("node:")) continue;
      assert.ok(specifier.startsWith("."), `${file} imports the package ${specifier} statically`);
      queue.push(path.posix.join(path.posix.dirname(file), specifier));
    }
  }
  return [...modules].sort();
}

// Paths, sizes and modification times of everything under dir.
function snapshot(dir) {
  const entries = [];
  const walk = (current) => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      const stat = fs.statSync(full);
      entries.push(`${path.relative(dir, full)}\t${entry.isDirectory() ? "dir" : stat.size}\t${stat.mtimeMs}`);
      if (entry.isDirectory()) walk(full);
    }
  };
  walk(dir);
  return entries.sort();
}

async function tempDir(t, prefix) {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), prefix));
  t.after(() => fsp.rm(dir, { recursive: true, force: true }));
  return dir;
}

// An --import module that makes the runtime report the given libuv version.
async function libuvPreload(t, version) {
  const dir = await tempDir(t, "sl-bootstrap-preload-");
  const file = path.join(dir, "libuv.mjs");
  await fsp.writeFile(file, `Object.defineProperty(process.versions, "uv", { value: ${JSON.stringify(version)} });\n`);
  return pathToFileURL(file).href;
}

// A repository with an uncommitted change, so a review that started would have work to do, and
// programs in its root that the Windows default lookup would find before PATH (copies of
// whoami.exe, which fail every call).
async function plantedWorkingDirectory(t) {
  const repo = await tempDir(t, "sl-bootstrap-cwd-");
  const git = (...args) => spawnSync("git", ["-C", repo, ...args], { cwd: os.tmpdir(), encoding: "utf8" });
  assert.equal(git("init", "-q").status, 0);
  await fsp.writeFile(path.join(repo, "README.md"), "x\n");
  assert.equal(git("add", "README.md").status, 0);
  assert.equal(git("-c", "user.name=t", "-c", "user.email=t@example.invalid", "commit", "-q", "-m", "x").status, 0);
  await fsp.appendFile(path.join(repo, "README.md"), "y\n");
  const whoami = path.join(process.env.SystemRoot || "C:\\Windows", "System32", "whoami.exe");
  for (const name of ["git.exe", "gh.exe"]) {
    await fsp.copyFile(whoami, path.join(repo, name));
  }
  return repo;
}

// The CLI's own default state locations, so everything it would create lands in the given home.
function childEnv(home) {
  const env = {
    ...process.env,
    HOME: home,
    USERPROFILE: home,
    APPDATA: path.join(home, "AppData", "Roaming"),
    LOCALAPPDATA: path.join(home, "AppData", "Local"),
    XDG_CONFIG_HOME: path.join(home, ".config"),
    NODE_ENV: "test",
    SENTINELAYER_CLI_TEST_MODE: "1",
    SENTINELAYER_CLI_TEST_BYPASS_NONCE: "e2e-bypass-nonce",
    SENTINELAYER_CLI_SKIP_AUTH: "1",
    SENTINELAYER_TOKEN: "api_token_e2e_test_session",
  };
  delete env.SENTINELAYER_CIRCUIT_STATE_DIR;
  delete env.SENTINELAYER_AUTH_AUDIT_BREAKER_STATE_FILE;
  delete env.NoDefaultCurrentDirectoryInExePath;
  return env;
}

function runBin(bin, args, { nodeArgs = [], cwd, home }) {
  return spawnSync(process.execPath, [...nodeArgs, path.join(ROOT, bin), ...args], {
    cwd,
    env: childEnv(home),
    encoding: "utf8",
    timeout: 120_000,
  });
}

test("each bin script loads only the runtime check before the rest of the CLI", () => {
  const binFiles = fs
    .readdirSync(path.join(ROOT, "bin"))
    .filter((name) => name.endsWith(".js"))
    .map((name) => `bin/${name}`)
    .sort();
  assert.deepEqual(BINS, binFiles, "every bin script is a package.json bin entry, and every entry is checked");
  for (const bin of BINS) {
    const source = fs.readFileSync(path.join(ROOT, bin), "utf8");
    // A Windows checkout may have CRLF line endings; .gitattributes keeps the committed files LF.
    assert.equal(source.split("\n", 1)[0].replace(/\r$/, ""), "#!/usr/bin/env node", `${bin} keeps its shebang line`);
    const eol = spawnSync("git", ["check-attr", "eol", "--", bin], { cwd: ROOT, encoding: "utf8" });
    assert.equal(eol.stdout.trim(), `${bin}: eol: lf`, `${bin} is checked out and packed with LF line endings`);
    assert.deepEqual(staticImports(bin), ["../src/cli-bootstrap.js"], `${bin} imports only the bootstrap statically`);
    assert.deepEqual(
      staticGraph(bin),
      [bin, BOOTSTRAP, "src/program-lookup.js"].sort(),
      `${bin}: the modules loaded before the runtime check`,
    );
  }
});

for (const bin of BINS) {
  test(`${bin} refuses a Windows libuv below 1.48.0 before loading the CLI`, async (t) => {
    if (process.platform !== "win32") {
      t.skip("the runtime floor is Windows behaviour");
      return;
    }
    // Under Node.js 20 this is the real libuv. Under a newer runtime, report an old one.
    const nodeArgs = REAL_LIBUV_HONOURS_SETTING ? ["--import", await libuvPreload(t, "1.46.0")] : [];
    const cases = [
      { name: "empty working directory", cwd: await tempDir(t, "sl-bootstrap-cwd-"), args: ["--version"] },
      { name: "repository with planted programs", cwd: await plantedWorkingDirectory(t), args: ["review", "--diff", "--json"] },
    ];
    for (const { name, cwd, args } of cases) {
      const home = await tempDir(t, "sl-bootstrap-home-");
      const before = snapshot(cwd);
      const result = runBin(bin, args, { nodeArgs, cwd, home });
      assert.equal(result.status, 1, `${name}: ${result.stderr || result.stdout}`);
      assert.equal((result.stderr.match(REFUSAL) || []).length, 1, `${name}: the refusal, once: ${result.stderr}`);
      assert.equal(result.stdout, "", `${name}: no command output`);
      assert.deepEqual(fs.readdirSync(home), [], `${name}: nothing was created in the home directory`);
      assert.deepEqual(snapshot(cwd), before, `${name}: nothing changed in the working directory`);
    }
  });
}

test("src/legacy-cli.js is a module only: run directly, it starts no command", async (t) => {
  const nodeArgs = restrictProgramLookupToPath({ env: {} }).ok ? [] : ["--import", await libuvPreload(t, "1.48.0")];
  const cwd = await tempDir(t, "sl-bootstrap-cwd-");
  const home = await tempDir(t, "sl-bootstrap-home-");
  const result = runBin("src/legacy-cli.js", ["--version"], { nodeArgs, cwd, home });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "", "no command ran");
});

test("each bin script runs --version once the runtime check passes", async (t) => {
  // Under Node.js 20 on Windows no real runtime passes; report the floor libuv so the check passes.
  const nodeArgs = restrictProgramLookupToPath({ env: {} }).ok ? [] : ["--import", await libuvPreload(t, "1.48.0")];
  for (const bin of BINS) {
    const cwd = await tempDir(t, "sl-bootstrap-cwd-");
    const home = await tempDir(t, "sl-bootstrap-home-");
    const result = runBin(bin, ["--version"], { nodeArgs, cwd, home });
    assert.equal(result.status, 0, `${bin}: ${result.stderr || result.stdout}`);
    assert.equal(result.stdout.trim(), PACKAGE.version, bin);
  }
});
