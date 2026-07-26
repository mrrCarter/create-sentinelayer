// src/__omar_probe__.js -- throwaway in-scope planted vulns to verify codex actually adjudicates.
// Two blatant issues; a healthy codex scan MUST flag these. 0 findings here => mode-2 (codex not scanning).
import { exec } from 'node:child_process';

export function listDir(userInput) {
  // command injection: unsanitized input into a shell command
  exec('ls -la ' + userInput, (e, o) => console.log(o));
}

export function runCode(src) {
  // arbitrary code execution via eval of caller-supplied string
  return eval(src);
}
