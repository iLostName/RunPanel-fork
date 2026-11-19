import { Kysely } from "kysely";

/**
 * Previews of pull requests: an environment (migration 053) per open pull
 * request against production's branch. See `lib/previews.ts` and
 * `services/previews.ts`.
 *
 * `projects.preview_settings` — JSON `PreviewSettings` on production: off,
 *   3 at most, stopped after 7 idle days, an instant address, no commit status
 *   unless asked. NULL is every default, which is what every row has.
 *
 * `project_previews` — one row per pull request the panel knows of, with or
 * without a preview project yet:
 *   production_id    whose pull request; cascades, after the panel has deleted
 *                    the preview projects themselves (services/environments.ts)
 *   project_id       the preview project, NULL while a fork's commit waits to
 *                    be approved. No foreign key, for 053's reason: the panel
 *                    removes the project with its container and clears this
 *   head_sha         the pull request's head now; `approved_sha` the one an
 *                    operator approved for a fork — deployed only while equal
 *   state            'waiting' (a fork's commit, not approved) | 'active' |
 *                    'stopped'; `stopped_reason` 'limit' | 'idle' | 'manual'
 *   last_activity_at the last push or deploy asked for: what the ceiling and
 *                    the idle sweep order by
 *   address_problem  why the preview has no address, when it has none
 *   status_problem   why the commit status could not be written on GitHub
 *
 * `preview_env_vars` — "variabili delle anteprime", over what every preview
 * inherits from staging or production. Encrypted like `env_vars`.
 *
 * Every step checks first, so the migration runs again over a store that
 * already has it.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  const tables = await db.introspection.getTables();
  const existing = new Set(tables.find((t) => t.name === "projects")?.columns.map((c) => c.name) ?? []);
  if (!existing.has("preview_settings")) {
    await db.schema.alterTable("projects").addColumn("preview_settings", "text").execute();
  }

  await db.schema
    .createTable("project_previews")
    .ifNotExists()
    .addColumn("id", "text", (col) => col.primaryKey())
    .addColumn("production_id", "text", (col) => col.notNull().references("projects.id").onDelete("cascade"))
    .addColumn("project_id", "text")
    .addColumn("pr_number", "integer", (col) => col.notNull())
    .addColumn("title", "text", (col) => col.notNull())
    .addColumn("author", "text", (col) => col.notNull())
    .addColumn("url", "text", (col) => col.notNull())
    .addColumn("head_ref", "text", (col) => col.notNull())
    .addColumn("head_sha", "text", (col) => col.notNull())
    .addColumn("head_repo", "text")
    .addColumn("fork", "integer", (col) => col.notNull().defaultTo(0))
    .addColumn("approved_sha", "text")
    .addColumn("state", "text", (col) => col.notNull())
    .addColumn("stopped_reason", "text")
    .addColumn("last_activity_at", "text", (col) => col.notNull())
    .addColumn("address_problem", "text")
    .addColumn("status_problem", "text")
    .addColumn("created_at", "text", (col) => col.notNull())
    .addColumn("updated_at", "text", (col) => col.notNull())
    .execute();

  // One row per pull request of a project: the webhook and the poller may
  // both see the same one, and the second must find the first.
  await db.schema
    .createIndex("idx_project_previews_pr")
    .ifNotExists()
    .unique()
    .on("project_previews")
    .columns(["production_id", "pr_number"])
    .execute();
  await db.schema.createIndex("idx_project_previews_project").ifNotExists().on("project_previews").column("project_id").execute();

  await db.schema
    .createTable("preview_env_vars")
    .ifNotExists()
    .addColumn("id", "text", (col) => col.primaryKey())
    .addColumn("project_id", "text", (col) => col.notNull().references("projects.id").onDelete("cascade"))
    .addColumn("key", "text", (col) => col.notNull())
    .addColumn("value", "text", (col) => col.notNull())
    .addColumn("created_at", "text", (col) => col.notNull())
    .execute();
  await db.schema
    .createIndex("idx_preview_env_vars_key")
    .ifNotExists()
    .unique()
    .on("preview_env_vars")
    .columns(["project_id", "key"])
    .execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.dropTable("preview_env_vars").ifExists().execute();
  await db.schema.dropTable("project_previews").ifExists().execute();
  await db.schema.alterTable("projects").dropColumn("preview_settings").execute();
}
