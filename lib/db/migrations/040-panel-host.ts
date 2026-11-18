import { Kysely } from "kysely";

/**
 * The panel's own name over HTTPS: `pannello.esempio.it` in front of the
 * panel's port, through the same nginx and certbot as the projects' names.
 *
 * A table of its own rather than a row of `project_hosts`, which belongs to a
 * project and is joined to one everywhere it is read; and rather than a JSON
 * setting, because the certificate's background request and every apply write
 * single columns of it while the owner may be turning it off — a whole value
 * read and written back could bring a deleted name back to life.
 *
 * At most one row: the routes refuse a second name. The columns mean what they
 * mean in `project_hosts`; the one of its own:
 *
 *   previous_public_url  what Impostazioni › Pannello › Indirizzo pubblico held
 *                        before the owner adopted this name, so turning it off
 *                        puts that back. Null: never adopted. '': adopted over
 *                        an empty setting.
 *
 * No domain column: whether the name is on a domain of the panel — and so on
 * Cloudflare — is read at use time, so removing or linking a domain needs
 * nothing kept in step here.
 *
 * Checks first, like every migration here, so it can run again over a store
 * that already has it.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .createTable("panel_hosts")
    .ifNotExists()
    .addColumn("id", "text", (col) => col.primaryKey())
    .addColumn("hostname", "text", (col) => col.notNull().unique())
    .addColumn("check_token", "text", (col) => col.notNull())
    .addColumn("status", "text", (col) => col.notNull())
    .addColumn("last_error", "text")
    .addColumn("apply_error", "text")
    .addColumn("cert_expires_at", "text")
    .addColumn("previous_public_url", "text")
    .addColumn("created_at", "text", (col) => col.notNull())
    .addColumn("updated_at", "text", (col) => col.notNull())
    .execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.dropTable("panel_hosts").ifExists().execute();
}
