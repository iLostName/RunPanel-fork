import { Kysely } from "kysely";

/**
 * Backup archives encrypted with a password — see services/backup/keyring.ts
 * and archive-crypto.ts.
 *
 * `backup_keys`: every password this panel has encrypted archives with.
 *   id          the key id, written in clear into each archive's header so the
 *               panel knows which password opens it
 *   secret      the password, encrypted with the panel key (purpose
 *               `backup-password`) like every other credential in the store
 *   created_at  when it was set; the header carries it too, so a person on
 *               another server knows which password to type
 *   retired_at  NULL for the one new archives use, set when it is replaced or
 *               encryption is turned off
 * Rows are never deleted: an archive sealed with a replaced password has to
 * stay restorable here for as long as it exists, wherever it is stored.
 *
 * `backup_runs.encryption_key_id`: the key that sealed the run's archive, NULL
 * for an archive in clear — every one before this migration. No foreign key:
 * like `ref_id` on artifacts, the row describes a file that outlives anything
 * it points at.
 *
 * Every step checks first, so the migration can run again over a store that
 * already has it.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .createTable("backup_keys")
    .ifNotExists()
    .addColumn("id", "text", (col) => col.primaryKey())
    .addColumn("secret", "text", (col) => col.notNull())
    .addColumn("created_at", "text", (col) => col.notNull())
    .addColumn("retired_at", "text")
    .execute();

  const tables = await db.introspection.getTables();
  const runColumns = new Set(tables.find((t) => t.name === "backup_runs")?.columns.map((c) => c.name) ?? []);
  if (!runColumns.has("encryption_key_id")) {
    await db.schema.alterTable("backup_runs").addColumn("encryption_key_id", "text").execute();
  }
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.alterTable("backup_runs").dropColumn("encryption_key_id").execute();
  await db.schema.dropTable("backup_keys").ifExists().execute();
}
