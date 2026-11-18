import { createReporter } from "../harness.mjs";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

/**
 * `next build` must never open the configured store.
 *
 * The build renders every page once, and the pages reach the store while doing
 * it. On a server that build runs next to the live panel (the self-update
 * builds the new version while the old one serves), so opening the real store
 * migrated the live database: when the update then failed and rolled the code
 * back, the old version could no longer boot, because Kysely refuses a recorded
 * migration it has no file for. During the build the store is an in-memory
 * SQLite instead (lib/db/index.ts, `isBuildPhase`).
 *
 * Each case runs in a child process: standalone suites share this process, and
 * the store is cached on globalThis and configured from the environment.
 */
export const meta = { name: "build-store-unit", needsDocker: false, drivers: [], standalone: true };

const CHILD = (repoRoot) => `
import { registerHooks } from "node:module";
import { existsSync } from "node:fs";
import { pathToFileURL, fileURLToPath } from "node:url";
import { join } from "node:path";
const root = ${JSON.stringify(repoRoot)};
const fileUrl = (...parts) => pathToFileURL(join(...parts)).href;
// "./x" is x.ts or x/index.ts, as the bundler resolves it.
const tsTarget = (base) => [base + ".ts", base + "/index.ts"].find((url) => existsSync(fileURLToPath(url)));
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier.startsWith("@/")) return nextResolve(tsTarget(fileUrl(root, specifier.slice(2))) ?? specifier, context);
    const extensionless = specifier.startsWith(".") && !/\\.[a-z]+$/i.test(specifier);
    if (extensionless && context.parentURL?.endsWith(".ts")) {
      const target = tsTarget(new URL(specifier, context.parentURL).href);
      if (target) return nextResolve(target, context);
    }
    return nextResolve(specifier, context);
  },
});
const { getDb } = await import(fileUrl(root, "lib", "db", "index.ts"));
const db = await getDb();
const migrations = await db.selectFrom("kysely_migration").select("name").execute();
const projects = await db.selectFrom("projects").select("id").execute();
process.stdout.write("RESULT " + JSON.stringify({ migrations: migrations.length, projects: projects.length }) + "\\n");
await db.destroy();
`;

function runChild(repoRoot, env) {
  const clean = { ...process.env };
  for (const key of Object.keys(clean)) {
    if (key.startsWith("RUNPANEL_") || key === "DATABASE_URL" || key === "NEXT_PHASE") delete clean[key];
  }
  try {
    const out = execFileSync(process.execPath, ["--input-type=module", "-e", CHILD(repoRoot)], {
      cwd: repoRoot,
      env: { ...clean, ...env },
      encoding: "utf8",
      timeout: 60_000,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const line = out.split("\n").find((l) => l.startsWith("RESULT "));
    return line ? { ok: true, ...JSON.parse(line.slice(7)) } : { ok: false, error: `no result in: ${out.slice(-400)}` };
  } catch (err) {
    return { ok: false, error: String(err.stderr || err.message).slice(-600) };
  }
}

export async function run({ repoRoot }) {
  const r = createReporter("build-store-unit");
  const dirs = [];
  const fresh = () => {
    const dir = mkdtempSync(join(tmpdir(), "rp-build-store-"));
    dirs.push(dir);
    return dir;
  };
  const storeFiles = (dir) => ["runpanel.db", "runpanel.db-wal", "runpanel.db-shm"].filter((f) => existsSync(join(dir, f)));
  const BUILD = { NEXT_PHASE: "phase-production-build" };

  try {
    // --- the control: outside a build the configured store is the one opened --
    {
      const dir = fresh();
      const res = runChild(repoRoot, { RUNPANEL_DATA_DIR: dir });
      r.check("outside a build, the SQLite store is opened in the data directory", res.ok && storeFiles(dir).includes("runpanel.db"), res.error ?? storeFiles(dir).join(","));
    }

    // --- during a build: an empty, migrated store that lives in memory -------
    {
      const dir = fresh();
      const res = runChild(repoRoot, { ...BUILD, RUNPANEL_DATA_DIR: dir });
      r.check("during a build, queries work on a migrated store", res.ok && res.migrations > 0, res.error ?? JSON.stringify(res));
      r.check("during a build, the store is empty", res.ok && res.projects === 0, res.error ?? JSON.stringify(res));
      r.check("during a build, no store file is written to the data directory", storeFiles(dir).length === 0, storeFiles(dir).join(","));
    }

    // --- a Postgres install is not reached by its build either ---------------
    {
      const dir = fresh();
      // Port 9 (discard) on loopback: refused at once if anything tried to connect.
      const res = runChild(repoRoot, {
        ...BUILD,
        RUNPANEL_DATA_DIR: dir,
        RUNPANEL_DB_DRIVER: "postgres",
        RUNPANEL_DATABASE_URL: "postgresql://runpanel:x@127.0.0.1:9/runpanel",
      });
      r.check("during a build, a Postgres configuration is never connected to", res.ok && res.migrations > 0, res.error ?? JSON.stringify(res));
    }
  } finally {
    for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  }

  return r.result();
}
