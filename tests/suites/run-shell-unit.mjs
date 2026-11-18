import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { createReporter } from "../harness.mjs";

/**
 * How a build command ends, against real processes.
 *
 * What matters here cannot be mocked: a shell that forks, a child that keeps the
 * pipes open, and what cmd.exe does to quotes.
 */
export const meta = { name: "run-shell-unit", needsDocker: false, standalone: true };

const windows = process.platform === "win32";
const shell = windows ? process.env.ComSpec ?? "C:\\Windows\\System32\\cmd.exe" : "/bin/sh";
const node = JSON.stringify(process.execPath);

export async function run({ repoRoot }) {
  const r = createReporter("run-shell-unit");
  const { runShell } = await import(
    pathToFileURL(join(repoRoot, "services", "builders", "run-shell.ts")).href
  );
  const dir = mkdtempSync(join(tmpdir(), "run-shell-"));

  const exec = async (command, opts = {}) => {
    const lines = [];
    const started = Date.now();
    let error = null;
    try {
      await runShell(command, {
        shell,
        windows,
        cwd: dir,
        env: process.env,
        timeout: 20_000,
        killGraceMs: 500,
        drainMs: 500,
        onLog: (line) => lines.push(line),
        ...opts,
      });
    } catch (err) {
      error = err;
    }
    return { lines, error, ms: Date.now() - started };
  };

  try {
    const ok = await exec(`${node} -e "console.log('hello')"`);
    r.check("a command that starts with a quoted path runs", ok.error === null, ok.error?.message);
    r.check("and its output comes back", ok.lines.includes("hello"), ok.lines.join("|"));

    const failed = await exec(`${node} -e "process.exit(3)"`);
    r.check("an exit code is reported", /code 3/.test(failed.error?.message ?? ""), failed.error?.message);

    const hang = `${node} -e "setInterval(() => {}, 1000)"`;

    // `&&` is what makes the shell fork instead of exec: the case that used to
    // leave the child alive with stdout open, and the promise pending for ever.
    const timed = await exec(`${node} -e "0" && ${hang}`, { timeout: 800 });
    r.check("a timeout ends a command joined with &&", timed.error !== null);
    r.check("and says it was a timeout", /timeout/.test(timed.error?.message ?? ""), timed.error?.message);
    r.check("well before anything else would have", timed.ms < 6_000, `${timed.ms} ms`);

    const controller = new AbortController();
    setTimeout(() => controller.abort(), 300);
    const aborted = await exec(`${node} -e "0" && ${hang}`, { signal: controller.signal });
    r.check("an abort ends the command", /interrotto/.test(aborted.error?.message ?? ""), aborted.error?.message);
    r.check("promptly", aborted.ms < 6_000, `${aborted.ms} ms`);

    const already = new AbortController();
    already.abort();
    const never = await exec(hang, { signal: already.signal });
    r.check("an aborted deploy does not start the command", never.error !== null && never.ms < 1_000);

    // Starts a child that inherits stdout and outlives the shell. It lives for a
    // few seconds only, so a failed run of this suite leaves nothing behind.
    const daemon = join(dir, "daemon.cjs");
    writeFileSync(
      daemon,
      `require("child_process").spawn(process.execPath, ["-e", "setTimeout(() => {}, 8000)"], { stdio: "inherit", detached: true, cwd: require("os").tmpdir() }).unref();`
    );
    const left = await exec(`${node} ${JSON.stringify(daemon)}`);
    r.check("a daemon left behind does not fail the command", left.error === null, left.error?.message);
    r.check("and does not hold it open", left.ms < 5_000, `${left.ms} ms`);

    // The shell dies at the first signal and what it started ignores it. With the
    // defaults the drain is shorter than the grace, as it is here: settling on
    // the shell's exit would cancel the SIGKILL. POSIX only, as signals are.
    if (!windows) {
      const pidFile = join(dir, "stubborn.pid");
      const stubborn = await exec(
        `sh -c 'trap "" TERM; echo $$ > ${pidFile}; exec sleep 30' && true`,
        { timeout: 300, killGraceMs: 1_200, drainMs: 200 }
      );
      const pid = Number(readFileSync(pidFile, "utf8"));
      // A zombie answers signal 0 too: nothing reaps it where this runs as PID 1.
      const isZombie = () => {
        try {
          return readFileSync(`/proc/${pid}/stat`, "utf8").split(") ").at(-1).startsWith("Z");
        } catch {
          return false;
        }
      };
      let alive = !isZombie();
      if (alive) {
        try {
          process.kill(pid, 0);
        } catch {
          alive = false;
        }
      }
      if (alive) process.kill(pid, "SIGKILL");
      r.check("what ignored the signal is killed anyway", !alive && Boolean(stubborn.error), String(pid));
    } else {
      r.note("POSIX only: the SIGKILL of a child that ignores SIGTERM was not run");
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }

  return r.result();
}
