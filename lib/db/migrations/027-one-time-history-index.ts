import { Kysely } from "kysely";

/**
 * The history list orders by `finished_at`, and 016 indexed `created_at`.
 *
 * Nothing filtered or sorted on that index, so every write paid for it and the
 * list still sorted the project's whole history. `(project_id, finished_at)`
 * hands the rows over already in order, and the page limit stops the walk.
 * `status` stays out of it: an index that leads with it would give one ordered
 * run per status, and the list wants `done` and `failed` as a single one.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema.dropIndex("idx_one_time_project_created").ifExists().execute();
  await db.schema
    .createIndex("idx_one_time_project_finished")
    .on("one_time_commands")
    .columns(["project_id", "finished_at"])
    .execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.dropIndex("idx_one_time_project_finished").ifExists().execute();
  await db.schema
    .createIndex("idx_one_time_project_created")
    .on("one_time_commands")
    .columns(["project_id", "created_at"])
    .execute();
}
