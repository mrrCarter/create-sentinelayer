// Child-process fault injection only; inherited by the read-only context worker.
import fs from "node:fs/promises";
const originalReaddir = fs.readdir;
const originalReadFile = fs.readFile;
fs.readdir = async function (target, ...args) {
  if (String(target) === process.env.SL_TEST_SLOW_CONTEXT_PATH) {
    await new Promise((resolve) => setTimeout(resolve, 10_000));
  }
  return originalReaddir.call(this, target, ...args);
};
fs.readFile = async function (target, ...args) {
  if (String(target) === process.env.SL_TEST_SLOW_CACHE_PATH) {
    await new Promise((resolve) => setTimeout(resolve, 10_000));
  }
  return originalReadFile.call(this, target, ...args);
};
