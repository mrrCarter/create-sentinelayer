import process from "node:process";

// Windows looks up a program named without a path in the working directory before PATH. The CLI
// runs git, gh, python, npm and other tools by name, often from inside a repository, so it turns
// that lookup off with NoDefaultCurrentDirectoryInExePath. Node.js spawns through libuv, which
// honours that variable from libuv 1.48.0 (Node.js 22); an older libuv ignores it. On such a
// runtime the CLI does not run at all on Windows, rather than run with the lookup on.
export const MIN_WINDOWS_LIBUV = Object.freeze([1, 48, 0]);

function parseVersion(value) {
  const parts = String(value || "").split(".");
  if (parts.length < 2 || parts.length > 3) {
    return null;
  }
  const numbers = parts.map((part) => (/^\d+$/.test(part) ? Number(part) : NaN));
  return numbers.every(Number.isInteger) ? [...numbers, 0].slice(0, 3) : null;
}

function atLeast(version, minimum) {
  for (let index = 0; index < minimum.length; index += 1) {
    if (version[index] !== minimum[index]) {
      return version[index] > minimum[index];
    }
  }
  return true;
}

/**
 * Turn off working-directory program lookup for this process and the children that inherit its
 * environment. Returns { ok: false, message } instead when this is Windows and the runtime would
 * ignore the setting.
 */
export function restrictProgramLookupToPath({
  platform = process.platform,
  libuv = process.versions.uv,
  nodeVersion = process.version,
  env = process.env,
} = {}) {
  if (platform !== "win32") {
    return { ok: true };
  }
  const version = parseVersion(libuv);
  if (!version || !atLeast(version, MIN_WINDOWS_LIBUV)) {
    return {
      ok: false,
      message:
        `On Windows, sentinelayer-cli needs Node.js 22 or later (libuv ${MIN_WINDOWS_LIBUV.join(".")} or later). ` +
        `This is Node.js ${nodeVersion} with libuv ${libuv || "unknown"}, which looks up programs in the current ` +
        "directory before PATH. Upgrade Node.js and run the command again.",
    };
  }
  env.NoDefaultCurrentDirectoryInExePath = "1";
  return { ok: true };
}
