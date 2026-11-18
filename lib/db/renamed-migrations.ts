import type { Kysely } from "kysely";

/**
 * Names a migration used to run under, mapped to the name it runs under now.
 *
 * `027-host-password` and `028-api-tokens` were written on this fork while
 * upstream was writing its own 027–029. Kysely refuses to migrate at all when a
 * name it has recorded is missing from the list, or when a pending name sorts
 * before one it has already run, so a store that ran the old names would stop
 * the panel at boot.
 *
 * The fix has two halves: `forgetRenamedMigrations` drops the old rows before
 * migrating, and the renamed migrations (030, 031) are written to find their
 * work already done and leave it alone.
 */
export const RENAMED_MIGRATIONS: Readonly<Record<string, string>> = {
  "027-host-password": "030-host-password",
  "028-api-tokens": "031-api-tokens",
};

/** Kysely's own bookkeeping table, under its default name. */
const MIGRATION_TABLE = "kysely_migration";

type MigrationTable = { [MIGRATION_TABLE]: { name: string; timestamp: string } };

/**
 * Drops the bookkeeping rows of migrations that now run under another name.
 *
 * Only the row goes: the schema it describes stays, and the renamed migration
 * finds it in place. A fresh store has no migration table yet, so there is
 * nothing to forget. Returns how many rows were dropped.
 *
 * No relative imports, so the unit suite loads this file directly.
 */
export async function forgetRenamedMigrations<DB>(db: Kysely<DB>): Promise<number> {
  const oldNames = Object.keys(RENAMED_MIGRATIONS);
  if (oldNames.length === 0) return 0;

  const tables = await db.introspection.getTables({ withInternalKyselyTables: true });
  if (!tables.some((t) => t.name === MIGRATION_TABLE)) return 0;

  const store = db as unknown as Kysely<MigrationTable>;
  const result = await store.deleteFrom(MIGRATION_TABLE).where("name", "in", oldNames).executeTakeFirst();
  return Number(result.numDeletedRows ?? 0);
}
