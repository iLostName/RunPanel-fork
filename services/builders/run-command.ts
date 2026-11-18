import fs from "fs";
import { buildEnv, getShellPath, isWindows } from "../env-utils";
import { runShell } from "./run-shell";

export interface RunCommandOpts {
  cwd: string;
  env?: Record<string, string>;
  timeout?: number;
  onLog: (line: string) => void;
  /** Ends the command and everything it started, the way a timeout does. */
  signal?: AbortSignal;
}

export function runCommand(command: string, opts: RunCommandOpts): Promise<void> {
  return new Promise((resolve, reject) => {
    const { cwd, env, timeout = 300_000, onLog, signal } = opts;

    // Node reports a missing working directory as ENOENT *on the executable*:
    // `spawn C:\Windows\system32\cmd.exe ENOENT`, which reads as "the shell is
    // missing" and sends you looking in entirely the wrong place. Check first
    // and say what is actually wrong.
    if (!fs.existsSync(cwd)) {
      reject(
        new Error(
          `Working directory does not exist: ${cwd}. ` +
            "The project has no source yet — configure a GitHub repository or upload a ZIP, then deploy."
        )
      );
      return;
    }

    const fullEnv = buildEnv(env);
    const shell = getShellPath();

    if (!fs.existsSync(shell)) {
      reject(new Error(`Shell not found at ${shell}`));
      return;
    }

    runShell(command, { shell, windows: isWindows, cwd, env: fullEnv, timeout, onLog, signal }).then(resolve, reject);
  });
}
