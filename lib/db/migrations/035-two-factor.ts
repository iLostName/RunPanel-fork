import { Kysely } from "kysely";

/**
 * Two-step sign-in: a TOTP seed per account, its recovery codes, the devices
 * that may skip the code for a while, and the half-finished sign-ins waiting
 * for one.
 *
 * Four tables rather than columns on `users`, on purpose. `users` is the row
 * the cluster replicates (lib/cluster-directory.ts): a seed in it would travel
 * to every member, and a member running an older release would merge it away.
 * These stay on the panel they were made on — see docs/en/users.md.
 *
 *   user_two_factor     the seed, encrypted with the panel key (purpose
 *                       `totp`); `enabled_at` null while the setup waits for
 *                       its first code; `last_used_step` is the replay guard.
 *   user_recovery_codes scrypt hashes, single use (`used_at`).
 *   trusted_devices     "ricorda questo dispositivo": the SHA-256 of a cookie,
 *                       bound to one account, with its own expiry.
 *   login_challenges    a password that was right, waiting for the code: the
 *                       SHA-256 of a short-lived token, and the tries left.
 *
 * Every step is `ifNotExists`, so running it twice is harmless; every row goes
 * with its account.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .createTable("user_two_factor")
    .ifNotExists()
    .addColumn("user_id", "text", (col) => col.primaryKey().references("users.id").onDelete("cascade"))
    .addColumn("secret_enc", "text", (col) => col.notNull())
    .addColumn("enabled_at", "text")
    .addColumn("last_used_step", "integer")
    .addColumn("created_at", "text", (col) => col.notNull())
    .execute();

  await db.schema
    .createTable("user_recovery_codes")
    .ifNotExists()
    .addColumn("id", "text", (col) => col.primaryKey())
    .addColumn("user_id", "text", (col) => col.notNull().references("users.id").onDelete("cascade"))
    .addColumn("code_hash", "text", (col) => col.notNull())
    .addColumn("used_at", "text")
    .addColumn("created_at", "text", (col) => col.notNull())
    .execute();
  await db.schema.createIndex("idx_recovery_codes_user").ifNotExists().on("user_recovery_codes").column("user_id").execute();

  await db.schema
    .createTable("trusted_devices")
    .ifNotExists()
    .addColumn("id", "text", (col) => col.primaryKey())
    .addColumn("user_id", "text", (col) => col.notNull().references("users.id").onDelete("cascade"))
    .addColumn("token_hash", "text", (col) => col.notNull().unique())
    .addColumn("user_agent", "text")
    .addColumn("ip", "text")
    .addColumn("created_at", "text", (col) => col.notNull())
    .addColumn("last_used_at", "text")
    .addColumn("expires_at", "text", (col) => col.notNull())
    .execute();
  await db.schema.createIndex("idx_trusted_devices_user").ifNotExists().on("trusted_devices").column("user_id").execute();

  await db.schema
    .createTable("login_challenges")
    .ifNotExists()
    .addColumn("id", "text", (col) => col.primaryKey())
    .addColumn("user_id", "text", (col) => col.notNull().references("users.id").onDelete("cascade"))
    .addColumn("token_hash", "text", (col) => col.notNull().unique())
    .addColumn("attempts", "integer", (col) => col.notNull().defaultTo(0))
    .addColumn("created_at", "text", (col) => col.notNull())
    .addColumn("expires_at", "text", (col) => col.notNull())
    .execute();
  await db.schema.createIndex("idx_login_challenges_expires").ifNotExists().on("login_challenges").column("expires_at").execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.dropTable("login_challenges").ifExists().execute();
  await db.schema.dropTable("trusted_devices").ifExists().execute();
  await db.schema.dropTable("user_recovery_codes").ifExists().execute();
  await db.schema.dropTable("user_two_factor").ifExists().execute();
}
