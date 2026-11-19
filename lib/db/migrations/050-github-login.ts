import { Kysely } from "kysely";

/**
 * Signing in with GitHub — see lib/github-login.ts and docs/en/users.md.
 *
 *   user_github          the GitHub account a user may sign in with: at most
 *                        one per user, and one user per GitHub account.
 *     github_id          GitHub's numeric user id, as decimal text. The match
 *                        is made on this and nothing else: a login can be
 *                        renamed and then registered by someone else, an
 *                        email can be changed, the id cannot.
 *     github_login       the name as last seen, for showing only
 *     last_used_at       the last sign-in that went through it
 *
 *   github_login_states  a sign-in between leaving for GitHub and coming back,
 *                        ten minutes at most, spent by the first return.
 *     state_hash         SHA-256 of the `state` that travels in the URL
 *     binding_hash       SHA-256 of the value kept in the browser's httpOnly
 *                        cookie: the return has to come back to the browser
 *                        that left
 *     intent             login | link | invite
 *     user_id            the signed-in user a link is for
 *     sealed             the PKCE verifier, and an invitation's token, sealed
 *                        with the panel key (purpose `github-login-flow`)
 *     redirect_uri       the callback named to GitHub, which the exchange of
 *                        the code has to repeat exactly
 *     next_path          where a sign-in goes afterwards, already checked to be
 *                        a path of the panel
 *
 *   login_challenges.via `github` when the step waiting for the code began
 *                        with GitHub rather than a password; NULL otherwise,
 *                        as every row before this migration.
 *
 * Tables of their own rather than columns on `users`, for the reason 035 gives:
 * `users` is the row the cluster replicates, and these stay on the panel they
 * were made on, like the OAuth App whose callback names this panel. Every row
 * goes with its account. Every step checks first, so the migration can run
 * again over a store that already has it.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .createTable("user_github")
    .ifNotExists()
    .addColumn("user_id", "text", (col) => col.primaryKey().references("users.id").onDelete("cascade"))
    .addColumn("github_id", "text", (col) => col.notNull().unique())
    .addColumn("github_login", "text", (col) => col.notNull())
    .addColumn("linked_at", "text", (col) => col.notNull())
    .addColumn("last_used_at", "text")
    .execute();

  await db.schema
    .createTable("github_login_states")
    .ifNotExists()
    .addColumn("id", "text", (col) => col.primaryKey())
    .addColumn("state_hash", "text", (col) => col.notNull().unique())
    .addColumn("binding_hash", "text", (col) => col.notNull())
    .addColumn("intent", "text", (col) => col.notNull())
    .addColumn("user_id", "text", (col) => col.references("users.id").onDelete("cascade"))
    .addColumn("sealed", "text", (col) => col.notNull())
    .addColumn("redirect_uri", "text", (col) => col.notNull())
    .addColumn("next_path", "text")
    .addColumn("created_at", "text", (col) => col.notNull())
    .addColumn("expires_at", "text", (col) => col.notNull())
    .execute();
  await db.schema
    .createIndex("idx_github_login_states_expires")
    .ifNotExists()
    .on("github_login_states")
    .column("expires_at")
    .execute();

  const tables = await db.introspection.getTables();
  const challengeColumns = new Set(tables.find((t) => t.name === "login_challenges")?.columns.map((c) => c.name) ?? []);
  if (!challengeColumns.has("via")) {
    await db.schema.alterTable("login_challenges").addColumn("via", "text").execute();
  }
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.alterTable("login_challenges").dropColumn("via").execute();
  await db.schema.dropTable("github_login_states").ifExists().execute();
  await db.schema.dropTable("user_github").ifExists().execute();
}
