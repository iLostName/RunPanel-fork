/**
 * A production RunPanel for the browser tests, and for the README screenshots.
 *
 * `next start` on the last build, on a data directory made for the run and
 * deleted after it, so nothing a test does can reach the panel the developer
 * uses every day, and no run starts from what the previous one left. The setup
 * token is pinned, as in tests/harness.mjs, so the first-run screen can be
 * filled in; the schedulers are off, so no timer sweeps Docker or starts a
 * backup underneath a test.
 *
 * Plain Node and nothing else: Playwright loads this file for the global setup,
 * and scripts/readme-screenshots.mjs imports it directly (Node strips the
 * types), so no `import.meta`, no `__dirname` and no import of another `.ts`.
 */
import { spawn, execFileSync, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const SETUP_TOKEN = "e2e-setup-token";

export interface PanelServer {
  /** For the browser: `localhost`, the origin a service worker accepts over plain http. */
  base: string;
  port: number;
  dataDir: string;
  log(): string;
  stop(): Promise<void>;
}

function portIsFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const probe = createServer();
    probe.once("error", () => resolve(false));
    probe.listen(port, () => probe.close(() => resolve(true)));
  });
}

/** The first free port from `from`: another checkout may be running its own panel on the machine. */
async function freePort(from: number): Promise<number> {
  for (let port = from; port < from + 100; port++) {
    if (await portIsFree(port)) return port;
  }
  throw new Error(`No free port between ${from} and ${from + 99}`);
}

function exited(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise((resolve) => child.once("exit", () => resolve()));
}

/** The server and whatever it started: `next start` runs the app in a child of its own. */
function killTree(child: ChildProcess): void {
  if (child.pid === undefined) return;
  try {
    if (process.platform === "win32") {
      execFileSync("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore" });
    } else {
      process.kill(-child.pid, "SIGKILL");
    }
  } catch {
    /* already gone */
  }
}

export async function startPanel({
  root,
  port: from = Number(process.env.RUNPANEL_E2E_PORT) || 5600,
  env = {},
}: {
  /** The checkout whose build is started. */
  root: string;
  port?: number;
  env?: Record<string, string>;
}): Promise<PanelServer> {
  if (!existsSync(join(root, ".next", "BUILD_ID"))) {
    throw new Error("No production build: run `bun run build` first.");
  }

  const port = await freePort(from);
  const dataDir = mkdtempSync(join(tmpdir(), "runpanel-e2e-"));

  // The developer's own panel settings stay out: a RUNPANEL_* in the shell
  // (a data directory, a Postgres URL) would point this run at real data.
  const inherited = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !key.startsWith("RUNPANEL_") && key !== "DATABASE_URL")
  );

  const child = spawn(process.execPath, [join(root, "node_modules", "next", "dist", "bin", "next"), "start", "-p", String(port)], {
    cwd: root,
    env: {
      ...inherited,
      NODE_ENV: "production",
      RUNPANEL_DATA_DIR: dataDir,
      RUNPANEL_DB_DRIVER: "sqlite",
      RUNPANEL_SETUP_TOKEN: SETUP_TOKEN,
      RUNPANEL_DISABLE_SCHEDULERS: "1",
      ...env,
    },
    stdio: ["ignore", "pipe", "pipe"],
    // Its own process group, so stopping it reaches the app server it forks.
    detached: process.platform !== "win32",
  });

  let log = "";
  child.stdout?.on("data", (chunk) => (log += chunk.toString()));
  child.stderr?.on("data", (chunk) => (log += chunk.toString()));

  const stop = async () => {
    killTree(child);
    await exited(child);
    // SQLite may hold its files for a moment after the process is gone on Windows.
    for (let attempt = 0; attempt < 10; attempt++) {
      try {
        rmSync(dataDir, { recursive: true, force: true });
        return;
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 300));
      }
    }
  };

  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) break;
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/auth/check`);
      if (res.ok) {
        return { base: `http://localhost:${port}`, port, dataDir, log: () => log, stop };
      }
    } catch {
      /* not listening yet */
    }
    await new Promise((resolve) => setTimeout(resolve, 300));
  }

  await stop();
  throw new Error(`The panel did not start on port ${port}.\n${log.slice(-3000)}`);
}
