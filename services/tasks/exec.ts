import { spawn, type ChildProcess } from "child_process";
import { randomBytes } from "crypto";
import fs from "fs";
import { sanitizedProcessEnv } from "@/lib/env";
import {
  cmdScript,
  containerKillArgs,
  containerRunArgs,
  hostRunArgs,
  parsePidMarker,
  pidMarker,
  posixScript,
} from "@/lib/tasks-shell";
import { dockerTry, stripAnsi } from "../docker/cli";
import { dockerConfigEnv } from "../docker/registry";
import { buildEnv, getShellPath, isWindows } from "../env-utils";

/**
 * Running one command of a task, and being certain it ends.
 *
 * Neither function rejects: how a run ended is data, written down by the
 * runner. Both are stopped through `signal`, and the runner knows why it
 * aborted — a timeout or a person — so what comes back is only what the
 * process itself said: its exit code, or why it never had one. Neither starts
 * anything once the signal has fired: a run stopped while it was being set up
 * never reaches a process.
 *
 * Output arrives as lines with their newline, stderr tagged `[stderr] ` the
 * way a deploy log tags it. A line is cut at 16 KB: a command that prints a
 * megabyte of base64 with no newline must not hold it all, nor be re-scanned
 * on every chunk.
 *
 * The host side has its own spawner rather than `services/builders/run-shell.ts`,
 * for three things that one does not give: a structured exit code, a bounded
 * line buffer, and the OS-level backstop of `HOST_WRAPPER`. Its process
 * handling — its own group, TERM then KILL, `taskkill /T` on Windows, a drain
 * after the shell exits — is the same.
 */

export interface ExecOutcome {
  /** The process's own exit code; null when it was killed or never started. */
  exitCode: number | null;
  /** Why it did not run, or did not end by itself; null when it did. */
  error: string | null;
  /**
   * The command never started — the container refused the exec — so the run
   * is a skip, not a failure of the command. `error` says why.
   */
  notStarted?: boolean;
}

export interface ExecOptions {
  signal: AbortSignal;
  onOutput: (text: string) => void;
  /** The task's limit. The runner enforces it; this only sets the backstops past it. */
  limitSec: number;
}

/** Between TERM and KILL. */
const KILL_GRACE_MS = 5_000;
/** Past the runner's own limit: the backstops only matter when the panel is not there. */
export const BACKSTOP_SEC = 60;
/** How long stray output may keep the pipes open once the shell has exited. */
const DRAIN_MS = 3_000;
/** How long the `docker exec` client may take to notice that its process is gone. */
const CLIENT_GRACE_MS = 5_000;
const MAX_LINE = 16_384;

// --- What to stop when the panel itself goes away -------------------------------

/**
 * Every run's process, for the panel's exit.
 *
 * A host run is its own process group, and the panel's unit stops the panel
 * alone (`KillMode=process`), so a restart would leave it running with nobody
 * to enforce its limit. On an orderly exit — an update, `systemctl restart`,
 * a SIGTERM Next turns into `process.exit` — this ends them: TERM to each host
 * group, synchronously, and a detached `docker exec` of the kill script for
 * each container run, which carries on after the panel is gone. A crash skips
 * this, and the backstops above are what is left.
 */
type Stopper = () => void;
const exitRef = globalThis as typeof globalThis & {
  __runpanelTaskStoppers?: Map<string, Stopper>;
  __runpanelTaskExitHook?: boolean;
};
const stoppers = (exitRef.__runpanelTaskStoppers ??= new Map<string, Stopper>());
if (!exitRef.__runpanelTaskExitHook) {
  exitRef.__runpanelTaskExitHook = true;
  process.once("exit", () => {
    for (const stop of stoppers.values()) {
      try {
        stop();
      } catch {
        /* the panel is leaving: nothing left to report to */
      }
    }
  });
}

function lineSplitter(onLine: (line: string) => void): { push: (chunk: string) => void; flush: () => void } {
  let buffer = "";
  return {
    push(chunk) {
      buffer += chunk;
      // `\r` too: a progress bar is a line per refresh, not one endless line.
      const parts = buffer.split(/\r\n|\r|\n/);
      buffer = parts.pop() ?? "";
      for (const part of parts) onLine(part);
      while (buffer.length > MAX_LINE) {
        onLine(buffer.slice(0, MAX_LINE));
        buffer = buffer.slice(MAX_LINE);
      }
    },
    flush() {
      if (buffer) onLine(buffer);
      buffer = "";
    },
  };
}

function wire(child: ChildProcess, opts: ExecOptions, onStderrLine?: (line: string) => boolean) {
  const stdout = lineSplitter((line) => opts.onOutput(`${stripAnsi(line)}\n`));
  const stderr = lineSplitter((line) => {
    if (onStderrLine?.(line)) return;
    opts.onOutput(`[stderr] ${stripAnsi(line)}\n`);
  });
  child.stdout?.setEncoding("utf8");
  child.stderr?.setEncoding("utf8");
  child.stdout?.on("data", (chunk: string) => stdout.push(chunk));
  child.stderr?.on("data", (chunk: string) => stderr.push(chunk));
  return () => {
    stdout.flush();
    stderr.flush();
  };
}

// --- In a container ------------------------------------------------------------------

/**
 * `docker exec` into a running container.
 *
 * The wrapper's marker on stderr is the pid of the command inside the
 * container (`lib/tasks-shell.ts`). A stop runs the kill script against that
 * pid, then waits for the client to notice; a client that does not is killed.
 * A stop that arrives before the pid waits a little for it rather than leave
 * the command running with nothing to aim at.
 *
 * A client that ends without the marker never started the command: the
 * container was paused by a backup, restarting, or gone since it was looked
 * up. That is a skip — the daemon's own words are the reason — except when
 * the image has no shell at all, which will never work and is a failure.
 */
export function execInContainer(container: string, command: string, opts: ExecOptions): Promise<ExecOutcome> {
  if (opts.signal.aborted) return Promise.resolve({ exitCode: null, error: null });

  return new Promise((resolve) => {
    const marker = pidMarker(randomBytes(8).toString("hex"));
    const child = spawn("docker", containerRunArgs(container, posixScript(command), marker, opts.limitSec + BACKSTOP_SEC), {
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
      // The same base every docker call gets: none of the panel's own secrets.
      env: { ...sanitizedProcessEnv(), ...(dockerConfigEnv() ?? {}) },
    });
    const key = randomBytes(6).toString("hex");

    let pid: number | null = null;
    let stopping = false;
    let killing = false;
    let settled = false;
    let stderrHead = "";
    const timers = new Set<NodeJS.Timeout>();
    const later = (ms: number, run: () => void) => {
      if (settled) return;
      timers.add(setTimeout(run, ms));
    };

    const killClient = () => {
      try {
        child.kill("SIGKILL");
      } catch {
        /* already gone */
      }
    };

    const killInside = () => {
      if (killing || pid === null) return;
      killing = true;
      void dockerTry(containerKillArgs(container, pid, KILL_GRACE_MS / 1000), { timeout: KILL_GRACE_MS + 25_000 }).finally(() =>
        later(CLIENT_GRACE_MS, killClient)
      );
    };

    stoppers.set(key, () => {
      if (pid === null) return;
      spawn("docker", containerKillArgs(container, pid, KILL_GRACE_MS / 1000), {
        detached: true,
        stdio: "ignore",
        windowsHide: true,
        env: { ...sanitizedProcessEnv(), ...(dockerConfigEnv() ?? {}) },
      }).unref();
    });

    const flush = wire(child, opts, (line) => {
      // Not necessarily the very first line — the docker client may warn about
      // its own configuration before the exec starts — but only once, and
      // only with this run's nonce, which nothing inside the container can read.
      if (pid === null) {
        const found = parsePidMarker(line, marker);
        if (found !== null) {
          pid = found;
          if (stopping) killInside();
          return true;
        }
        if (stderrHead.length < 2_000) stderrHead += `${stripAnsi(line)}\n`;
      }
      return false;
    });

    const onAbort = () => {
      if (stopping) return;
      stopping = true;
      if (pid !== null) killInside();
      // No pid yet: the client is still starting the exec. Give the marker a
      // moment, then end the client — and the last resort, whatever happened.
      else later(CLIENT_GRACE_MS, () => (pid === null ? killClient() : killInside()));
      later(KILL_GRACE_MS + 40_000, killClient);
    };
    opts.signal.addEventListener("abort", onAbort, { once: true });

    const finish = (outcome: ExecOutcome) => {
      if (settled) return;
      settled = true;
      for (const timer of timers) clearTimeout(timer);
      opts.signal.removeEventListener("abort", onAbort);
      stoppers.delete(key);
      flush();
      resolve(outcome);
    };

    child.on("error", (err) => finish({ exitCode: null, error: `Docker non si è avviato: ${err.message}` }));

    child.on("close", (code) => {
      if (pid === null && !stopping) {
        const said = stderrHead.trim().split("\n").find(Boolean)?.trim() ?? "";
        if (/"sh"[^\n]*(executable file not found|no such file)/i.test(stderrHead)) {
          finish({ exitCode: code, error: "Nel container non c'è una shell (sh): i comandi pianificati non possono girarci" });
          return;
        }
        finish({
          exitCode: null,
          error: said ? `il container non ha accettato il comando (${said.slice(0, 300)})` : "il container non ha accettato il comando",
          notStarted: true,
        });
        return;
      }
      if (code === null) {
        finish({ exitCode: null, error: stopping ? null : "Il comando è stato terminato da un segnale" });
        return;
      }
      finish({ exitCode: code, error: null });
    });
  });
}

// --- On the host ---------------------------------------------------------------------

/** Signal a run and everything it started: its process group on POSIX, `taskkill /T` on Windows. */
function killHostTree(child: ChildProcess, signal: NodeJS.Signals): void {
  if (child.pid === undefined) return;
  if (isWindows) {
    const killer = spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
    killer.on("error", () => child.kill());
    return;
  }
  try {
    process.kill(-child.pid, signal);
  } catch {
    /* the group is already gone */
  }
}

/**
 * On the host, in the project's directory, with the project's variables on
 * top of the panel's sanitised environment (`buildEnv`: none of RunPanel's own
 * secrets, and the PATH repaired the way every child process gets it).
 */
export function execOnHost(
  target: { cwd: string; env: Record<string, string> },
  command: string,
  opts: ExecOptions
): Promise<ExecOutcome> {
  if (opts.signal.aborted) return Promise.resolve({ exitCode: null, error: null });
  // Checked here rather than left to spawn, which reports a missing cwd as
  // ENOENT on the shell — pointing at entirely the wrong thing.
  if (!fs.existsSync(target.cwd)) {
    return Promise.resolve({ exitCode: null, error: `La cartella del progetto non esiste più: ${target.cwd}` });
  }
  const shell = getShellPath();
  if (!fs.existsSync(shell)) return Promise.resolve({ exitCode: null, error: `Shell non trovata: ${shell}` });

  return new Promise((resolve) => {
    const env = buildEnv(target.env);
    const child = isWindows
      ? // `/s` with one outer pair of quotes, verbatim: see run-shell.ts for
        // what cmd.exe does to quotes otherwise.
        spawn(shell, ["/d", "/s", "/c", `"${cmdScript(command)}"`], {
          cwd: target.cwd,
          env,
          stdio: ["ignore", "pipe", "pipe"],
          windowsHide: true,
          windowsVerbatimArguments: true,
        })
      : spawn(shell, hostRunArgs(shell, posixScript(command), opts.limitSec + BACKSTOP_SEC), {
          cwd: target.cwd,
          env,
          stdio: ["ignore", "pipe", "pipe"],
          detached: true,
        });
    const key = randomBytes(6).toString("hex");
    stoppers.set(key, () => killHostTree(child, "SIGTERM"));

    let settled = false;
    let interrupted = false;
    const timers = new Set<NodeJS.Timeout>();
    const later = (ms: number, run: () => void) => {
      if (settled) return;
      timers.add(setTimeout(run, ms));
    };
    const flush = wire(child, opts);

    const finish = (outcome: ExecOutcome) => {
      if (settled) return;
      settled = true;
      for (const timer of timers) clearTimeout(timer);
      opts.signal.removeEventListener("abort", onAbort);
      stoppers.delete(key);
      flush();
      // A straggler may still hold the pipes, and these handles would stay
      // open for as long as it lives.
      child.stdout?.destroy();
      child.stderr?.destroy();
      resolve(outcome);
    };

    function onAbort() {
      if (interrupted || settled) return;
      interrupted = true;
      killHostTree(child, "SIGTERM");
      later(KILL_GRACE_MS, () => killHostTree(child, "SIGKILL"));
      // The last resort: something that survives SIGKILL is in uninterruptible
      // sleep, and the run still has to end.
      later(KILL_GRACE_MS + DRAIN_MS, () => finish({ exitCode: null, error: null }));
    }
    opts.signal.addEventListener("abort", onAbort, { once: true });

    // `close` is the normal ending: all the output arrived.
    child.on("close", (code) => finish({ exitCode: interrupted ? null : code, error: null }));
    // Waiting for `close` alone can be forever: a daemon started by the command
    // inherits stdout and outlives the shell. The verdict is the shell's, so
    // give the pipes a moment and then take it — but not once interrupted, or
    // the SIGKILL still on its way would be cancelled.
    child.on("exit", (code) => later(DRAIN_MS, () => !interrupted && finish({ exitCode: code, error: null })));
    child.on("error", (err) => finish({ exitCode: null, error: `Il comando non è partito: ${err.message}` }));
  });
}
