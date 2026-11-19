import { Kysely } from "kysely";

/**
 * Notifications on a person's own devices: one row per browser or installed
 * app that subscribed to Web Push — see services/notify/push-devices.ts.
 *
 *   user_id        whose it is; a push carries only what that account may see,
 *                  and the device goes with the account
 *   name           what the list calls it, editable: "iPhone di Marco"
 *   endpoint_hash  SHA-256 of the push endpoint, hex: unique, so one browser
 *                  is one device whatever account last claimed it, and how a
 *                  browser finds its own row without the panel keeping the
 *                  endpoint readable
 *   subscription   endpoint and keys as the browser gave them, encrypted with
 *                  the panel's key: the endpoint is a capability URL
 *   vapid_key      the panel's public key the browser subscribed with; when the
 *                  panel's keys had to be made again, older rows wait for
 *                  their browser to subscribe anew instead of being refused
 *   push_host      the push service's host, for the list ("Google", "Apple")
 *   origin         the panel address the browser subscribed from: who the
 *                  panel says it is to the push service when nothing better is
 *                  configured
 *   events, filter what it receives, as a notification channel has them
 *
 * The panel's own VAPID key pair lives in `settings`, sealed, and is made the
 * first time it is needed: nothing for a migration to do.
 *
 * Every step checks before it creates, so it runs again as a no-op.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .createTable("push_devices")
    .ifNotExists()
    .addColumn("id", "text", (col) => col.primaryKey())
    .addColumn("user_id", "text", (col) => col.notNull().references("users.id").onDelete("cascade"))
    .addColumn("name", "text", (col) => col.notNull())
    .addColumn("endpoint_hash", "text", (col) => col.notNull())
    .addColumn("subscription", "text", (col) => col.notNull())
    .addColumn("vapid_key", "text", (col) => col.notNull())
    .addColumn("push_host", "text", (col) => col.notNull())
    .addColumn("origin", "text")
    .addColumn("user_agent", "text")
    .addColumn("events", "text", (col) => col.notNull())
    .addColumn("filter", "text", (col) => col.notNull().defaultTo("all"))
    .addColumn("enabled", "integer", (col) => col.notNull().defaultTo(1))
    .addColumn("last_ok_at", "text")
    .addColumn("last_error", "text")
    .addColumn("last_error_at", "text")
    .addColumn("created_at", "text", (col) => col.notNull())
    .addColumn("updated_at", "text", (col) => col.notNull())
    .execute();

  await db.schema
    .createIndex("idx_push_devices_endpoint")
    .ifNotExists()
    .unique()
    .on("push_devices")
    .column("endpoint_hash")
    .execute();

  await db.schema.createIndex("idx_push_devices_user").ifNotExists().on("push_devices").column("user_id").execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.dropTable("push_devices").ifExists().execute();
}
