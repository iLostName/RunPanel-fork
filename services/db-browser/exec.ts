import { spawn } from "child_process";
import { sanitizedProcessEnv } from "@/lib/env";

/**
 * One call to an engine client inside its container, bounded three ways.
 *
 * `docker()` in `services/docker/cli.ts` is `execFile`: no stdin, and a reply
 * over its buffer is an error that says ENOBUFS. The browser needs stdin (the
 * MySQL script, the Redis payload) and needs to tell "too big to show" apart
 * from "failed", so it has this instead:
 *
 *  - a time limit, after which the docker client is killed. The engine has a
 *    shorter one of its own for the statement (`statement_timeout`,
 *    `max_execution_time`, `maxTimeMS`), so the request normally ends with the
 *    engine's own message; this one is for an engine that does not answer.
 *  - a cap on what is read from stdout. Past it the client is killed and the
 *    call reports `overflow`: the panel never holds more than the cap.
 *  - a few calls at a time per service, so that a stuck table and an
 *    impatient finger cannot pile up `docker exec` processes on the host.
 *
 * The values in `env` reach the docker process's own environment and nothing
 * else: `execArgs()` has already put only their names on the command line.
 * Nothing here logs, on purpose — what passes through is the owner's data.
 */

export interface EngineRun {
  stdout: Buffer;
  stderr: string;
  code: number | null;
  timedOut: boolean;
  overflow: boolean;
  elapsedMs: number;
}

export interface EngineRunOptions {
  env: Record<string, string>;
  /** Written to stdin, which is then closed. */
  input?: Buffer | string;
  timeoutMs: number;
  maxBytes: number;
}

const STDERR_KEEP = 16 * 1024;

export function runInContainer(args: string[], { env, input, timeoutMs, maxBytes }: EngineRunOptions): Promise<EngineRun> {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const child = spawn("docker", args, {
      stdio: [input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
      windowsHide: true,
      env: { ...sanitizedProcessEnv(), ...env },
    });

    const chunks: Buffer[] = [];
    let bytes = 0;
    let stderr = "";
    let timedOut = false;
    let overflow = false;

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, timeoutMs);
    timer.unref?.();

    child.stdout?.on("data", (chunk: Buffer) => {
      if (overflow) return;
      if (bytes + chunk.length > maxBytes) {
        overflow = true;
        child.kill("SIGKILL");
        return;
      }
      chunks.push(chunk);
      bytes += chunk.length;
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      if (stderr.length < STDERR_KEEP) stderr += chunk.toString("utf8").slice(0, STDERR_KEEP - stderr.length);
    });

    child.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ stdout: Buffer.concat(chunks), stderr, code, timedOut, overflow, elapsedMs: Date.now() - started });
    });

    if (input !== undefined && child.stdin) {
      // A client that exits before reading all of it closes the pipe: its exit
      // code and stderr say why, and an EPIPE here would only hide that.
      child.stdin.on("error", () => {});
      child.stdin.end(input);
    }
  });
}

/** Refused rather than queued: the page says so and the person tries again. */
export class BrowseBusyError extends Error {
  constructor() {
    super("Ci sono già altre letture in corso su questo database: riprova tra un momento.");
    this.name = "BrowseBusyError";
  }
}

const MAX_PER_SERVICE = 3;

/** On `globalThis` like the console sessions, so a dev reload does not reset the count. */
const globalRef = globalThis as typeof globalThis & { __runpanelBrowseSlots?: Map<string, number> };
const slots = (globalRef.__runpanelBrowseSlots ??= new Map<string, number>());

export async function withBrowseSlot<T>(serviceId: string, run: () => Promise<T>): Promise<T> {
  const used = slots.get(serviceId) ?? 0;
  if (used >= MAX_PER_SERVICE) throw new BrowseBusyError();
  slots.set(serviceId, used + 1);
  try {
    return await run();
  } finally {
    const left = (slots.get(serviceId) ?? 1) - 1;
    if (left > 0) slots.set(serviceId, left);
    else slots.delete(serviceId);
  }
}
