import { Kysely } from "kysely";

/**
 * Tokens an AI assistant or a script signs in with, instead of a cookie.
 *
 * Each belongs to a user and acts with that user's grants, never more; `access`
 * can only narrow it further, to reads. Only the SHA-256 of the token is
 * stored, like sessions; `hint` is its last four characters, so the list can
 * tell two tokens apart without holding either.
 *
 * Kept apart from `sessions` on purpose: a session ends after a week and when
 * the password changes, a token lives until its own expiry or until it is
 * revoked, and the two are listed and revoked in different places.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .createTable("api_tokens")
    .addColumn("id", "text", (col) => col.primaryKey())
    .addColumn("user_id", "text", (col) => col.notNull().references("users.id").onDelete("cascade"))
    .addColumn("name", "text", (col) => col.notNull())
    .addColumn("token_hash", "text", (col) => col.notNull().unique())
    .addColumn("hint", "text", (col) => col.notNull())
    .addColumn("access", "text", (col) => col.notNull())
    .addColumn("created_at", "text", (col) => col.notNull())
    .addColumn("last_used_at", "text")
    .addColumn("expires_at", "text")
    .execute();

  await db.schema.createIndex("idx_api_tokens_user").on("api_tokens").column("user_id").execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.dropTable("api_tokens").ifExists().execute();
}
