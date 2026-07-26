// omar codex-adjudication probe -- PLANTED command injection to confirm codex actually
// scans the diff (a real finding here => codex adjudicates; 0/0 => source:none mode-2 phantom).
import { exec } from 'node:child_process';

export function listDir(userInput) {
  // INTENTIONAL VULN (command injection): unsanitized user input flows into a shell command
  exec('ls -la ' + userInput, (err, stdout) => {
    console.log(stdout);
  });
}
