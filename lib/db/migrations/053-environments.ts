import { Kysely } from "kysely";

/**
 * Environments: a project can have siblings that run the same code from
 * another branch — a staging copy now, the previews of pull requests next
 * (migration 054). See `lib/environments.ts` and `services/environments.ts`.
 *
 * `projects.environment_of`
 *   the production project this one is an environment of; NULL for every
 *   ordinary project, which is what every row before this migration is.
 *   Deliberately no foreign key: a cascade would delete the sibling's row and
 *   leave its container, image and folder on the host with nothing pointing
 *   at them, and "restrict" would turn a production delete into a 500. The
 *   panel deletes the environments itself, with their resources, before it
 *   lets production go (services/project-delete.ts), and a sibling whose
 *   production is somehow gone reads as an ordinary project.
 *
 * `projects.environment`
 *   'staging' | 'preview'; NULL with `environment_of`.
 *
 * Permissions follow production's (lib/principal.ts reads the parent), which
 * is why the parent's id is a column rather than a row in a side table: every
 * access check already selects from `projects`.
 *
 * Nullable with no default, so both columns apply to a populated table on
 * both drivers. Checks before it adds, so it runs again over a store that
 * already has them.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  const tables = await db.introspection.getTables();
  const existing = new Set(tables.find((t) => t.name === "projects")?.columns.map((c) => c.name) ?? []);
  if (!existing.has("environment_of")) {
    await db.schema.alterTable("projects").addColumn("environment_of", "text").execute();
  }
  if (!existing.has("environment")) {
    await db.schema.alterTable("projects").addColumn("environment", "text").execute();
  }
  // "Which environments has this project" is asked by every project page, and
  // by every delete.
  await db.schema.createIndex("idx_projects_environment_of").ifNotExists().on("projects").column("environment_of").execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.dropIndex("idx_projects_environment_of").ifExists().execute();
  await db.schema.alterTable("projects").dropColumn("environment").execute();
  await db.schema.alterTable("projects").dropColumn("environment_of").execute();
}
