import { Kysely } from "kysely";

/**
 * A password in front of a name: nginx's `auth_basic`, asked by the browser
 * before anything reaches the app. Both null, or both set.
 *
 * Only the hash is stored (`$6$`, see `services/proxy/password.ts`), and it is
 * what the htpasswd file beside the name's block is written from on every apply.
 *
 * Born as `027-host-password`, renumbered when upstream took 027–029 for its own
 * migrations. A store that ran it under the old name has the columns already:
 * `forgetRenamedMigrations` drops the old row so Kysely's order check passes,
 * and this runs again as a no-op — hence every step checks before it adds.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  const tables = await db.introspection.getTables();
  const existing = new Set(tables.find((t) => t.name === "project_hosts")?.columns.map((c) => c.name) ?? []);

  if (!existing.has("auth_user")) {
    await db.schema.alterTable("project_hosts").addColumn("auth_user", "text").execute();
  }
  if (!existing.has("auth_hash")) {
    await db.schema.alterTable("project_hosts").addColumn("auth_hash", "text").execute();
  }
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.alterTable("project_hosts").dropColumn("auth_hash").execute();
  await db.schema.alterTable("project_hosts").dropColumn("auth_user").execute();
}
