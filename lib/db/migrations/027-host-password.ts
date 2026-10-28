import { Kysely } from "kysely";

/**
 * A password in front of a name: nginx's `auth_basic`, asked by the browser
 * before anything reaches the app. Both null, or both set.
 *
 * Only the hash is stored (`$6$`, see `services/proxy/password.ts`), and it is
 * what the htpasswd file beside the name's block is written from on every apply.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema.alterTable("project_hosts").addColumn("auth_user", "text").execute();
  await db.schema.alterTable("project_hosts").addColumn("auth_hash", "text").execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.alterTable("project_hosts").dropColumn("auth_hash").execute();
  await db.schema.alterTable("project_hosts").dropColumn("auth_user").execute();
}
