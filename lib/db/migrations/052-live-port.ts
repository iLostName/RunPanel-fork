import { Kysely } from "kysely";

/**
 * Where a project deployed without downtime is published on the host.
 *
 * Such a project runs, for the length of a switch, two containers that cannot
 * share a host port; each deploy publishes the new one on a loopback port of
 * its own (lib/zero-downtime.ts) and nginx is moved to it. This column is that
 * port for the container that is live: what nginx proxies to, what the uptime
 * check and the restarts use. NULL is every other project, published on its
 * own port as always.
 *
 * Nullable with no default, so it applies to a populated table on both
 * drivers. Checks before it adds, like every column migration here, so it can
 * run again on a store that already has it.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  const tables = await db.introspection.getTables();
  const existing = new Set(tables.find((t) => t.name === "projects")?.columns.map((c) => c.name) ?? []);
  if (!existing.has("live_port")) {
    await db.schema.alterTable("projects").addColumn("live_port", "integer").execute();
  }
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.alterTable("projects").dropColumn("live_port").execute();
}
