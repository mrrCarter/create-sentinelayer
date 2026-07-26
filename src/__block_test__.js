// __block_test__.js -- throwaway to verify the fences-mirror gate BLOCKS app-vulns.
// A general app-sec persona should rate these P0/P1 (blocking). Delete after the run.
import { exec } from 'node:child_process';

export function run(userInput) {
  // command injection: unsanitized input into a shell command
  exec('cat ' + userInput);
}

export function evalIt(code) {
  // arbitrary code execution
  return eval(code);
}
