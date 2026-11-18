import { Kysely } from "kysely";

/**
 * Notifications: where they go, and the panel's own copy of them.
 *
 * `notification_channels` replaces the single Telegram bot that lived in
 * `settings`. A channel has a kind (email, Telegram, Discord, Slack, ntfy, a
 * webhook), the events it receives as a JSON map of key → on/off, how bad they
 * have to be, its plain settings as JSON, and its secrets as one encrypted JSON
 * blob — never readable from the screen. The outcome of its last delivery is
 * kept on the row, so the list can say "ultimo invio non riuscito: …" without a
 * log to read.
 *
 * The old bot is not moved here. Moving it means decrypting the token, and a
 * migration that needs the panel's key is a migration that cannot run on the
 * day the key is the thing that is wrong. `services/notify/channels.ts` imports
 * it the first time the channels are read, once.
 *
 * `notifications` is what the bell shows. Each row says who may see it: a
 * project or a service (`scope`, `scope_id`) — whoever can see that — or, for
 * the machine and the panel, a panel permission. Read state is per user: a row
 * per notification read one by one, and a mark per user for "everything up to
 * here", which is what "Segna tutte come lette" writes instead of a row per
 * notification.
 *
 * Every step checks before it creates, so a store that already has these
 * tables — the migration renumbered at a merge, as 030 and 031 were — runs it
 * again as a no-op.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .createTable("notification_channels")
    .ifNotExists()
    .addColumn("id", "text", (col) => col.primaryKey())
    .addColumn("name", "text", (col) => col.notNull())
    .addColumn("kind", "text", (col) => col.notNull())
    .addColumn("enabled", "integer", (col) => col.notNull().defaultTo(1))
    .addColumn("events", "text", (col) => col.notNull())
    .addColumn("filter", "text", (col) => col.notNull().defaultTo("all"))
    .addColumn("config", "text", (col) => col.notNull())
    .addColumn("secrets", "text")
    .addColumn("last_ok_at", "text")
    .addColumn("last_error", "text")
    .addColumn("last_error_at", "text")
    .addColumn("created_at", "text", (col) => col.notNull())
    .addColumn("updated_at", "text", (col) => col.notNull())
    .execute();

  await db.schema
    .createTable("notifications")
    .ifNotExists()
    .addColumn("id", "text", (col) => col.primaryKey())
    .addColumn("event", "text", (col) => col.notNull())
    .addColumn("level", "text", (col) => col.notNull())
    .addColumn("title", "text", (col) => col.notNull())
    .addColumn("body", "text", (col) => col.notNull())
    .addColumn("href", "text")
    .addColumn("scope", "text")
    .addColumn("scope_id", "text")
    .addColumn("permission", "text")
    .addColumn("repeats", "integer", (col) => col.notNull().defaultTo(0))
    .addColumn("created_at", "text", (col) => col.notNull())
    .addColumn("last_at", "text", (col) => col.notNull())
    .execute();

  await db.schema.createIndex("idx_notifications_created").ifNotExists().on("notifications").column("created_at").execute();
  await db.schema
    .createIndex("idx_notifications_scope")
    .ifNotExists()
    .on("notifications")
    .columns(["scope", "scope_id"])
    .execute();

  await db.schema
    .createTable("notification_reads")
    .ifNotExists()
    .addColumn("notification_id", "text", (col) => col.notNull().references("notifications.id").onDelete("cascade"))
    .addColumn("user_id", "text", (col) => col.notNull().references("users.id").onDelete("cascade"))
    .addColumn("read_at", "text", (col) => col.notNull())
    .addPrimaryKeyConstraint("pk_notification_reads", ["notification_id", "user_id"])
    .execute();

  await db.schema.createIndex("idx_notification_reads_user").ifNotExists().on("notification_reads").column("user_id").execute();

  await db.schema
    .createTable("notification_read_marks")
    .ifNotExists()
    .addColumn("user_id", "text", (col) => col.primaryKey().references("users.id").onDelete("cascade"))
    .addColumn("read_before", "text", (col) => col.notNull())
    .execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.dropTable("notification_read_marks").ifExists().execute();
  await db.schema.dropTable("notification_reads").ifExists().execute();
  await db.schema.dropTable("notifications").ifExists().execute();
  await db.schema.dropTable("notification_channels").ifExists().execute();
}
