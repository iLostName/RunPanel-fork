/**
 * Choosing a host port nobody else on this panel already publishes.
 *
 * A database created on a port another service or project already used made
 * Docker refuse the container halfway through, with Docker's own words as the
 * error. The form now proposes a free one, and the route refuses a taken one
 * with the free one in the sentence.
 *
 * Zero imports: the unit suite loads this file directly.
 */

/** The first port at or above `base` that is not in `used`, within the valid range. */
export function firstFreePort(base: number, used: ReadonlySet<number>): number {
  const start = Number.isInteger(base) && base >= 1 && base <= 65535 ? base : 1024;
  for (let port = start; port <= 65535; port++) {
    if (!used.has(port)) return port;
  }
  for (let port = 1024; port < start; port++) {
    if (!used.has(port)) return port;
  }
  return start;
}

/**
 * Every port a list of rows claims, ignoring rows without one. `live_port` is
 * where a project deployed without downtime is published (lib/zero-downtime.ts).
 */
export function portsInUse(
  rows: ReadonlyArray<{ port?: number | null; access_port?: number | null; live_port?: number | null }>
): Set<number> {
  const used = new Set<number>();
  for (const row of rows) {
    if (typeof row.port === "number" && row.port > 0) used.add(row.port);
    if (typeof row.access_port === "number" && row.access_port > 0) used.add(row.access_port);
    if (typeof row.live_port === "number" && row.live_port > 0) used.add(row.live_port);
  }
  return used;
}
