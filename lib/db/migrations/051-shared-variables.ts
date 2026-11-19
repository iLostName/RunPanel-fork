import { Kysely } from "kysely";

/**
 * Shared variables: named groups of encrypted variables, attached to any
 * number of projects. See `lib/env-refs.ts` and `services/env-groups.ts`.
 *
 * `env_groups`
 *   name         how a reference finds the group: `${{ shared.<name>.KEY }}`.
 *                Unique on this server, and held to what a reference can
 *                spell (`GROUP_NAME_PATTERN`)
 *   description  one line for the list, optional
 *   created_by   who made it, for the record; no foreign key, the account may go
 *
 * `env_group_vars` — one row per variable, like `env_vars`:
 *   value        AES-256-GCM ciphertext under the panel's key
 *
 * `project_env_groups` — which groups a project receives, in which order:
 *   position     0 first; a later group wins over an earlier one where both
 *                set a name, and the project's own variables win over all of
 *                them (the database links still win over everything)
 *
 * Groups belong to one server, like its projects: a project on a linked server
 * receives that server's groups, and nothing here is replicated.
 *
 * Every step checks first, so the migration runs again over a store that
 * already has it.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .createTable("env_groups")
    .ifNotExists()
    .addColumn("id", "text", (col) => col.primaryKey())
    .addColumn("name", "text", (col) => col.notNull())
    .addColumn("description", "text")
    .addColumn("created_by", "text")
    .addColumn("created_at", "text", (col) => col.notNull())
    .addColumn("updated_at", "text", (col) => col.notNull())
    .execute();

  await db.schema.createIndex("idx_env_groups_name").ifNotExists().unique().on("env_groups").column("name").execute();

  await db.schema
    .createTable("env_group_vars")
    .ifNotExists()
    .addColumn("id", "text", (col) => col.primaryKey())
    .addColumn("group_id", "text", (col) => col.notNull().references("env_groups.id").onDelete("cascade"))
    .addColumn("key", "text", (col) => col.notNull())
    .addColumn("value", "text", (col) => col.notNull())
    .addColumn("created_at", "text", (col) => col.notNull())
    .execute();

  await db.schema
    .createIndex("idx_env_group_vars_key")
    .ifNotExists()
    .unique()
    .on("env_group_vars")
    .columns(["group_id", "key"])
    .execute();

  await db.schema
    .createTable("project_env_groups")
    .ifNotExists()
    .addColumn("project_id", "text", (col) => col.notNull().references("projects.id").onDelete("cascade"))
    .addColumn("group_id", "text", (col) => col.notNull().references("env_groups.id").onDelete("cascade"))
    .addColumn("position", "integer", (col) => col.notNull())
    .addColumn("created_at", "text", (col) => col.notNull())
    .addPrimaryKeyConstraint("pk_project_env_groups", ["project_id", "group_id"])
    .execute();

  // "Which projects use this group" is asked from the group's page and before
  // every change to it; the primary key only serves the project's side.
  await db.schema
    .createIndex("idx_project_env_groups_group")
    .ifNotExists()
    .on("project_env_groups")
    .column("group_id")
    .execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.dropTable("project_env_groups").ifExists().execute();
  await db.schema.dropTable("env_group_vars").ifExists().execute();
  await db.schema.dropTable("env_groups").ifExists().execute();
}
