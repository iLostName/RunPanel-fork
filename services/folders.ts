import type { Kysely } from "kysely";
import type { FolderMergePlan } from "@/lib/cluster-directory";
import type { Database } from "@/lib/db";

/**
 * The two rules every folder write shares, kept in one place so the folder
 * routes and the two PATCH handlers that file things cannot drift.
 */

/**
 * Another folder already carrying this name, ignoring case and padding.
 *
 * Compared through `lower()` rather than a unique index on the column: an
 * index would let "Clienti" and "clienti" coexist, and two folders that read
 * as the same one is the confusion the check exists to prevent.
 */
export async function findFolderByName(
  db: Kysely<Database>,
  name: string,
  exceptId?: string
): Promise<{ id: string } | undefined> {
  let query = db
    .selectFrom("folders")
    .select("id")
    .where((eb) => eb(eb.fn("lower", ["name"]), "=", name.trim().toLowerCase()));
  if (exceptId) query = query.where("id", "!=", exceptId);
  return query.executeTakeFirst();
}

/**
 * Whether `folderId` names a folder. `null` — the root — always does.
 *
 * Asked before a project or service is filed there, because SQLite enforces
 * the foreign key only with the pragma on and Postgres reports the violation
 * as a 500: a move to a folder that is not there is a 404, not a crash.
 */
export async function folderExists(db: Kysely<Database>, folderId: string | null): Promise<boolean> {
  if (folderId === null) return true;
  const row = await db.selectFrom("folders").select("id").where("id", "=", folderId).executeTakeFirst();
  return row !== undefined;
}

/**
 * Fold what another member said about folders into this store, in one
 * transaction. A folder deleted elsewhere empties onto the root here too: its
 * columns are cleared first, as the delete route does, rather than left to
 * `on delete set null`. Repeating a plan changes nothing.
 */
export async function applyFolderPlan(
  db: Kysely<Database>,
  plan: Pick<FolderMergePlan, "upsert" | "remove" | "tombstones">,
  now: string
): Promise<void> {
  await db.transaction().execute(async (trx) => {
    for (const f of plan.upsert) {
      await trx
        .insertInto("folders")
        .values(f)
        .onConflict((oc) => oc.column("id").doUpdateSet({ name: f.name, updated_at: f.updated_at }))
        .execute();
    }
    if (plan.remove.length > 0) {
      await trx.updateTable("projects").set({ folder_id: null, updated_at: now }).where("folder_id", "in", plan.remove).execute();
      await trx.updateTable("services").set({ folder_id: null, updated_at: now }).where("folder_id", "in", plan.remove).execute();
      await trx.deleteFrom("folders").where("id", "in", plan.remove).execute();
    }
    for (const t of plan.tombstones) {
      await trx
        .insertInto("cluster_tombstones")
        .values({ kind: "folder", id: t.id, deleted_at: t.deleted_at })
        .onConflict((oc) => oc.columns(["kind", "id"]).doUpdateSet({ deleted_at: t.deleted_at }))
        .execute();
    }
  });
}
