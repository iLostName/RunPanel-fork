import { spawn, type ChildProcess } from "child_process";

/**
 * Run one shell line and be certain it ends.
 *
 * Separate from `run-command.ts` and free of project imports so that
 * `run-shell-unit` can load it directly and test it against real processes:
 * everything below is about how processes actually die, which a mock would only
 * restate.
 */

export interface RunShellOpts {
  shell: string;
  windows: boolean;
  cwd: string;
  env: NodeJS.ProcessEnv;
  timeout: number;
  onLog: (line: string) => void;
  /** Aborting ends the command the same way a timeout does. */
  signal?: AbortSignal;
  /** How long a process gets between the polite signal and the certain one. */
  killGraceMs?: number;
  /** How long stray output may keep the pipes open once the shell has exited. */
  drainMs?: number;
}

const DEFAULT_KILL_GRACE_MS = 5_000;
const DEFAULT_DRAIN_MS = 3_000;

/**
 * Signal the shell and everything it started.
 *
 * Signalling only the shell is what used to leave a deploy `deploying` forever:
 * in `npm ci && npm run build` the shell forks, so killing it orphans the build,
 * which keeps stdout open, and `close` never fires. On POSIX the child leads its
 * own process group (`detached`), so a negative pid reaches all of it. Windows
 * has no groups: `taskkill /T` walks the tree instead.
 */
function killTree(proc: ChildProcess, windows: boolean, signal: NodeJS.Signals): void {
  if (proc.pid === undefined) return;
  if (windows) {
    const killer = spawn("taskkill", ["/pid", String(proc.pid), "/T", "/F"], {
      stdio: "ignore",
      windowsHide: true,
    });
    killer.on("error", () => proc.kill());
    return;
  }
  try {
    process.kill(-proc.pid, signal);
  } catch {
    /* the group is already gone */
  }
}

export function runShell(command: string, opts: RunShellOpts): Promise<void> {
  const { shell, windows, cwd, env, timeout, onLog, signal } = opts;
  const killGraceMs = opts.killGraceMs ?? DEFAULT_KILL_GRACE_MS;
  const drainMs = opts.drainMs ?? DEFAULT_DRAIN_MS;

  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error(`Command "${command}" interrotto`));
      return;
    }

    const proc = windows
      ? // `/s` with one outer pair of quotes makes cmd strip exactly that pair
        // and leave the rest as written. Without it, a line that begins with a
        // quote loses its first and its LAST quote, wherever that one is.
        //
        // Verbatim, because otherwise Node quotes the arguments for a C runtime
        // that cmd.exe is not, and every quote inside comes out as \": a command
        // like `node -e "require('fs')…"` exits 0 having done nothing.
        spawn(shell, ["/d", "/s", "/c", `"${command}"`], {
          cwd,
          env,
          stdio: ["ignore", "pipe", "pipe"],
          windowsHide: true,
          windowsVerbatimArguments: true,
        })
      : spawn(shell, ["-c", command], {
          cwd,
          env,
          stdio: ["ignore", "pipe", "pipe"],
          detached: true,
        });

    let settled = false;
    let interrupted: Error | null = null;
    let lastLine = "";
    const timers = new Set<NodeJS.Timeout>();

    const after = (ms: number, run: () => void) => {
      const timer = setTimeout(run, ms);
      timers.add(timer);
      return timer;
    };

    const settle = (error: Error | null) => {
      if (settled) return;
      settled = true;
      for (const timer of timers) clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      if (lastLine.trim()) onLog(lastLine);
      // A straggler may still hold the pipes, and these handles would stay open
      // for as long as it lives.
      proc.stdout?.destroy();
      proc.stderr?.destroy();
      if (error) reject(error);
      else resolve();
    };

    const interrupt = (error: Error) => {
      if (interrupted || settled) return;
      interrupted = error;
      killTree(proc, windows, "SIGTERM");
      after(killGraceMs, () => killTree(proc, windows, "SIGKILL"));
      // The last resort. Something that survives SIGKILL is in uninterruptible
      // sleep, and the deploy still has to end.
      after(killGraceMs + drainMs, () => settle(error));
    };

    function onAbort() {
      interrupt(new Error(`Command "${command}" interrotto`));
    }

    signal?.addEventListener("abort", onAbort, { once: true });

    const limit = after(timeout, () => {
      // Named as a timeout on purpose: reported as `exited with code null` it
      // sends the reader looking for a crash that never happened.
      interrupt(
        new Error(
          `Command "${command}" interrotto dopo ${Math.round(timeout / 1000)}s (timeout del build)`
        )
      );
    });

    proc.stdout?.on("data", (data: Buffer) => {
      const text = lastLine + data.toString();
      const lines = text.split("\n");
      lastLine = lines.pop() || "";
      for (const line of lines) {
        if (line.trim()) onLog(line);
      }
    });

    proc.stderr?.on("data", (data: Buffer) => {
      const lines = data.toString().split("\n");
      for (const line of lines) {
        if (line.trim()) onLog(`[stderr] ${line}`);
      }
    });

    const outcome = (code: number | null): Error | null => {
      if (interrupted) return interrupted;
      return code === 0 ? null : new Error(`Command "${command}" exited with code ${code}`);
    };

    // `close` is the normal ending, because it means all the output arrived.
    proc.on("close", (code) => settle(outcome(code)));

    // Waiting for `close` alone can be forever: a daemon started by the command
    // inherits stdout and outlives the shell. The verdict is the shell's, so
    // give the pipes a moment and then take it.
    //
    // Not once interrupted: the shell goes at the first signal, usually long
    // before what it started, and settling here would cancel the SIGKILL still
    // on its way to whatever ignored that signal.
    proc.on("exit", (code) => {
      clearTimeout(limit);
      after(drainMs, () => {
        if (!interrupted) settle(outcome(code));
      });
    });

    proc.on("error", (err) => {
      settle(new Error(`Failed to run "${command}": ${err.message}`));
    });
  });
}
