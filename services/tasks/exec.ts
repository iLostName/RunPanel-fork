import { spawn } from "child_process";
import { randomBytes } from "crypto";
import { sanitizedProcessEnv } from "@/lib/env";
import { exitCodeFromShellError } from "@/lib/tasks-rules";
import { containerKillArgs, containerRunArgs, parsePidMarker, pidMarker } from "@/lib/tasks-shell";
import { runCommand } from "../builders/run-command";
import { dockerTry, stripAnsi } from "../docker/cli";
import { dockerConfigEnv } from "../docker/registry";
import { joinScript } from "../deploy-steps";

/**
 * Running one command of a task, and being certain it ends.
 *
 * Neither function rejects: how a run ended is data, written down by the
 * runner. Both are stopped through `signal`, and the runner knows why it
 * aborted — a timeout or a person — so what comes back is only what the
 * process itself said: its exit code, or why it never had one.
 *
 * Output arrives as text with its newlines, stderr lines tagged `[stderr] `
 * the way a deploy log tags them, so the history can colour them.
 */

export interface ExecOutcome {
  /** The process's own exit code; null when it was killed or never started. */
  exitCode: number | null;
  /** Why it did not run, or did not end by itself; null when it did. */
  error: string | null;
}

export interface ExecOptions {
  signal: AbortSignal;
  onOutput: (text: string) => void;
  /** The task's limit. The runner enforces it; this only sets the backstops past it. */
  limitSec: number;
}

/** Between TERM and KILL, inside the container. */
const KILL_GRACE_SEC = 5;
/**
 * The in-container `timeout`, past the runner's own limit: it only matters
 * when the panel is not there to enforce that one.
 */
const BACKSTOP_SEC = 60;
/** How long the `docker exec` client may take to notice that its process is gone. */
const CLIENT_GRACE_MS = 5_000;

/** Lines out of chunks, `\r` included: a progress bar is a line per refresh, not one endless line. */
function lineSplitter(onLine: (line: string) => void): { push: (chunk: string) => void; flush: () => void } {
  let buffer = "";
  return {
    push(chunk) {
      buffer += chunk;
      const parts = buffer.split(/\r\n|\r|\n/);
      buffer = parts.pop() ?? "";
      for (const part of parts) onLine(part);
      // A command that never prints a newline still has its output kept.
      if (buffer.length > 16_384) {
        onLine(buffer);
        buffer = "";
      }
    },
    flush() {
      if (buffer) onLine(buffer);
      buffer = "";
    },
  };
}

/**
 * `docker exec` into a running container.
 *
 * The first line on stderr is the wrapper's: the pid of the command inside
 * the container (`lib/tasks-shell.ts`). A stop runs the kill script against
 * that pid, then waits for the client to notice; a client that does not is
 * killed. A stop that arrives before the pid waits a little for it rather
 * than leave the command running with nothing to aim at.
 */
export function execInContainer(container: string, command: string, opts: ExecOptions): Promise<ExecOutcome> {
  return new Promise((resolve) => {
    const marker = pidMarker(randomBytes(8).toString("hex"));
    const child = spawn("docker", containerRunArgs(container, joinScript(command), marker, opts.limitSec + BACKSTOP_SEC), {
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
      // The same base every docker call gets: none of the panel's own secrets.
      env: { ...sanitizedProcessEnv(), ...(dockerConfigEnv() ?? {}) },
    });

    let pid: number | null = null;
    let stopping = false;
    let killing = false;
    let settled = false;
    let stderrTail = "";
    const timers = new Set<NodeJS.Timeout>();
    const later = (ms: number, run: () => void) => {
      if (settled) return;
      const timer = setTimeout(run, ms);
      timers.add(timer);
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
      void dockerTry(containerKillArgs(container, pid, KILL_GRACE_SEC), { timeout: (KILL_GRACE_SEC + 25) * 1000 }).finally(() =>
        later(CLIENT_GRACE_MS, killClient)
      );
    };

    const stdout = lineSplitter((line) => opts.onOutput(`${stripAnsi(line)}\n`));
    const stderr = lineSplitter((line) => {
      // Not necessarily the very first line — the docker client may warn about
      // its own configuration before the exec starts — but only once, and only
      // with this run's nonce, which nothing inside the container can read.
      if (pid === null) {
        const found = parsePidMarker(line, marker);
        if (found !== null) {
          pid = found;
          if (stopping) killInside();
          return;
        }
      }
      const clean = stripAnsi(line);
      stderrTail = `${stderrTail}${clean}\n`.slice(-2_000);
      opts.onOutput(`[stderr] ${clean}\n`);
    });

    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => stdout.push(chunk));
    child.stderr?.on("data", (chunk: string) => stderr.push(chunk));

    const onAbort = () => {
      if (stopping) return;
      stopping = true;
      if (pid !== null) killInside();
      // No pid yet: the client is still starting the exec. Give the marker a
      // moment, then end the client — and the last resort, whatever happened.
      else later(CLIENT_GRACE_MS, () => (pid === null ? killClient() : killInside()));
      later((KILL_GRACE_SEC + 40) * 1000, killClient);
    };
    if (opts.signal.aborted) onAbort();
    else opts.signal.addEventListener("abort", onAbort, { once: true });

    const finish = (outcome: ExecOutcome) => {
      if (settled) return;
      settled = true;
      for (const timer of timers) clearTimeout(timer);
      opts.signal.removeEventListener("abort", onAbort);
      stdout.flush();
      stderr.flush();
      resolve(outcome);
    };

    child.on("error", (err) => {
      finish({ exitCode: null, error: `Docker non si è avviato: ${err.message}` });
    });

    child.on("close", (code) => {
      if (code === null) {
        finish({ exitCode: null, error: stopping ? null : "Il comando è stato terminato da un segnale" });
        return;
      }
      // `docker exec` answers 126/127 itself when the image has no shell — a
      // distroless image, say — and the stderr line it prints is about OCI.
      if ((code === 126 || code === 127) && /"sh"[^\n]*(executable file not found|no such file)/i.test(stderrTail)) {
        finish({ exitCode: code, error: "Nel container non c'è una shell (sh): i comandi pianificati non possono girarci" });
        return;
      }
      finish({ exitCode: code, error: null });
    });
  });
}

/**
 * On the host, in the project's directory: the one-time commands' machinery
 * (`runCommand` → `run-shell.ts`), which already kills the whole process tree
 * and survives a command that forks a daemon holding its pipes open.
 *
 * Its own timeout is set past the task's, as a backstop: the runner's timer is
 * the one meant to fire, and says so in words.
 */
export async function execOnHost(
  target: { cwd: string; env: Record<string, string> },
  command: string,
  opts: ExecOptions
): Promise<ExecOutcome> {
  const script = joinScript(command);
  try {
    await runCommand(script, {
      cwd: target.cwd,
      env: target.env,
      timeout: (opts.limitSec + BACKSTOP_SEC) * 1000,
      onLog: (line) => opts.onOutput(`${stripAnsi(line)}\n`),
      signal: opts.signal,
    });
    return { exitCode: 0, error: null };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const code = exitCodeFromShellError(message);
    if (code !== null) return { exitCode: code, error: null };
    if (opts.signal.aborted) return { exitCode: null, error: null };
    // The message names the command; the history already shows it, and a
    // second copy of a long script in one line helps nobody.
    return { exitCode: null, error: message.replace(/"[\s\S]*"/, "").replace(/\s+/g, " ").trim() || "Il comando non è partito" };
  }
}
