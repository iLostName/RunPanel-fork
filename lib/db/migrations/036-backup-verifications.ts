import { Kysely } from "kysely";

/**
 * The last integrity check of each backup archive.
 *
 * A table of its own rather than columns on `backup_runs`: one row per run,
 * written only by "Verifica integrità", and gone with the run (cascade). Adding
 * columns would have needed a column-exists probe per driver to stay
 * idempotent; `ifNotExists` on a table is the same statement on both.
 *
 * `status` is `ok` or `failed`. `detail` is the report as JSON — which member
 * failed and why — for the run page; `message` is the sentence a person reads.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .createTable("backup_verifications")
    .ifNotExists()
    .addColumn("run_id", "text", (col) => col.primaryKey().references("backup_runs.id").onDelete("cascade"))
    .addColumn("status", "text", (col) => col.notNull())
    .addColumn("message", "text", (col) => col.notNull())
    .addColumn("detail", "text")
    .addColumn("checked_at", "text", (col) => col.notNull())
    .execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.dropTable("backup_verifications").ifExists().execute();
}
