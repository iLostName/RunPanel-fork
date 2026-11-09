import { Kysely } from "kysely";

/**
 * What a panel last saw of another server, for the Overview.
 *
 * A server that does not answer cannot say what it holds, so without a copy
 * its projects would drop out of their folders until it came back. One row per
 * account, server and list: `rows` is a JSON array holding only what a card
 * needs (`lastSeenRows` in lib/overview-groups.ts). Per account because that is
 * what the server answered for that account, permissions applied.
 *
 * A convenience, not a record: where a project is filed stays in `folder_id`
 * on the server that holds it. Never replicated. Both foreign keys cascade, so
 * a deleted account or a revoked server takes its rows with it.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .createTable("cluster_last_seen")
    .addColumn("user_id", "text", (col) => col.notNull().references("users.id").onDelete("cascade"))
    .addColumn("member_id", "text", (col) => col.notNull().references("cluster_members.id").onDelete("cascade"))
    .addColumn("kind", "text", (col) => col.notNull())
    .addColumn("rows", "text", (col) => col.notNull())
    .addColumn("updated_at", "text", (col) => col.notNull())
    .addPrimaryKeyConstraint("pk_cluster_last_seen", ["user_id", "member_id", "kind"])
    .execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.dropTable("cluster_last_seen").ifExists().execute();
}
