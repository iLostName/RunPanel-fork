import { createReporter } from "../harness.mjs";
import { pathToFileURL } from "node:url";
import { join } from "node:path";

/**
 * Proposing a free host port for a new database, and refusing a taken one.
 *
 * A database created on a port another service already published made Docker
 * fail halfway, in its own words. Standalone: lib/ports.ts has no imports.
 */
export const meta = { name: "ports-unit", needsDocker: false, drivers: [], standalone: true };

export async function run({ repoRoot }) {
  const r = createReporter("ports-unit");
  const { firstFreePort, portsInUse } = await import(pathToFileURL(join(repoRoot, "lib", "ports.ts")).href);

  r.check("the default port when it is free", firstFreePort(5432, new Set()) === 5432);
  r.check("the next one when it is taken", firstFreePort(5432, new Set([5432])) === 5433);
  r.check("past a run of taken ports", firstFreePort(5432, new Set([5432, 5433, 5434])) === 5435);
  r.check("wraps below when the top is full", firstFreePort(65535, new Set([65535])) === 1024);
  r.check("an invalid base starts from 1024", firstFreePort(0, new Set()) === 1024 && firstFreePort(70000, new Set()) === 1024);

  const used = portsInUse([{ port: 5432 }, { port: null }, { port: 3000, access_port: 41234 }, {}]);
  r.check("public and loopback ports are both in use", used.has(5432) && used.has(3000) && used.has(41234));
  r.check("rows without a port add nothing", used.size === 3);

  return r.result();
}
