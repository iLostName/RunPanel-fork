import { Kysely } from "kysely";

/**
 * A name that only redirects to another of the same project: `www.esempio.it`
 * to `esempio.it`, or the reverse.
 *
 * A row of its own rather than a flag on the other name, so it has what every
 * name has — its own certificate and status, its own DNS check, the same
 * uniqueness and the same conflict handling — and nothing new has to learn
 * about it but the renderer.
 *
 * No foreign key: SQLite cannot drop a column that has one, which would leave
 * `down` unable to undo this. The route that deletes a name deletes its twins
 * first, and the renderer leaves out a twin whose name is gone.
 *
 * Checks before it adds, like every column migration here, so it can run
 * again on a store that already has the column.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  const tables = await db.introspection.getTables();
  const existing = new Set(tables.find((t) => t.name === "project_hosts")?.columns.map((c) => c.name) ?? []);
  if (!existing.has("redirect_to")) {
    await db.schema.alterTable("project_hosts").addColumn("redirect_to", "text").execute();
  }
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.alterTable("project_hosts").dropColumn("redirect_to").execute();
}
