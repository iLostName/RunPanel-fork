import { canonicalFolders, mergeFolders, type FolderSet } from "@/lib/cluster-directory";
import { sha256Hex } from "@/lib/cluster-sign";
import { getDb, nowIso } from "@/lib/db";
import { applyFolderPlan } from "@/services/folders";
import { clusterState } from "./state";

/**
 * The folders of the Overview as this install holds them, and how another
 * member's copy is folded in. The merge rules are in lib/cluster-directory.ts,
 * which also says why folders travel apart from the directory.
 */

export async function localFolderSet(): Promise<FolderSet> {
  const db = await getDb();
  const [folders, tombstones] = await Promise.all([
    db.selectFrom("folders").select(["id", "name", "created_at", "updated_at"]).execute(),
    db.selectFrom("cluster_tombstones").select(["id", "deleted_at"]).where("kind", "=", "folder").execute(),
  ]);
  return { folders, tombstones };
}

export async function foldersHash(set?: FolderSet): Promise<string> {
  return sha256Hex(canonicalFolders(set ?? (await localFolderSet())));
}

/** Fold another member's copy into ours and return where both now stand. */
export async function applyFolderSet(remote: FolderSet): Promise<FolderSet> {
  const plan = mergeFolders(await localFolderSet(), remote);
  await applyFolderPlan(await getDb(), plan, nowIso());
  return plan.result;
}

/**
 * Note that a folder was deleted here, so no other copy brings it back: the
 * merge lets it win whatever the dates, so the stamp only decides when it is
 * pruned. Nothing to note in solo mode.
 */
export async function folderTombstone(id: string): Promise<void> {
  if (!(await clusterState())) return;
  const db = await getDb();
  const deleted_at = nowIso();
  await db
    .insertInto("cluster_tombstones")
    .values({ kind: "folder", id, deleted_at })
    .onConflict((oc) => oc.columns(["kind", "id"]).doUpdateSet({ deleted_at }))
    .execute();
}
