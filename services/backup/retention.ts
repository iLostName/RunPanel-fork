import { getDb } from "@/lib/db";
import type { BackupRunsTable } from "@/lib/db/schema";
import { hasLimit, prunableCopies, ruleFor, type RetentionRule } from "@/lib/backup-copies";
import { loadCopies, removeCopy, syncRunArchive } from "./copies";
import { backupLogPath } from "./paths";
import { policyDestinations } from "./policy-destinations";
import { removeLogFile } from "../log-file";

/**
 * Keeping the archives a policy asked for and no more — on every destination,
 * each by its own rule.
 *
 * Two rules do most of the work here, and both exist because the obvious
 * implementation is dangerous:
 *
 *  - it runs **after** a successful run, never before one. Making room first
 *    means a full disk can delete a good archive to make space for a backup that
 *    then fails, and you are left with neither;
 *  - the newest copy on each destination is **never** collected, whatever the
 *    numbers say. `retention_days: 1` typed onto a weekly schedule would
 *    otherwise leave exactly zero backups, and it would look like it was
 *    working.
 *
 * What goes is a copy, not a run: a disk that keeps a week and a bucket that
 * keeps a year leave the older runs with their bucket copy alone. A run goes,
 * row and log, once no copy of it holds the archive any more. The selection is
 * pure, in lib/backup-copies.ts.
 */

export interface RetentionResult {
  /** Copies whose archive was removed. */
  copies: number;
  /** Runs removed with them, having no copy left. */
  runs: number;
}

export async function applyRetention(policyId: string | null): Promise<RetentionResult> {
  const none = { copies: 0, runs: 0 };
  if (!policyId) return none;

  const db = await getDb();
  const policy = await db
    .selectFrom("backup_policies")
    .selectAll()
    .where("id", "=", policyId)
    .executeTakeFirst();
  if (!policy) return none;

  const list = await policyDestinations(policy);
  const policyRule: RetentionRule = {
    count: policy.retention_count,
    days: policy.retention_days,
    bytes: policy.retention_bytes,
  };
  if (!hasLimit(policyRule) && !list.some((entry) => entry.retention && hasLimit(entry.retention))) return none;

  const runs = await db
    .selectFrom("backup_runs")
    .select(["id", "started_at"])
    .where("policy_id", "=", policyId)
    .where("pinned", "=", 0)
    .where("status", "in", ["success", "partial"])
    .execute();
  if (runs.length === 0) return none;

  const startedAt = new Map(runs.map((run) => [run.id, run.started_at]));
  const copies = await loadCopies(runs.map((run) => run.id));
  const held = [...copies.values()].flat().filter((copy) => copy.status === "done");

  const doomed = new Set(
    prunableCopies(
      held.map((copy) => ({
        id: copy.id,
        destinationId: copy.destination_id,
        bytes: copy.bytes,
        startedAt: startedAt.get(copy.run_id) as string,
      })),
      (destinationId) => ruleFor(destinationId, list, policyRule),
      Date.now()
    )
  );
  if (doomed.size === 0) return none;

  const result: RetentionResult = { copies: 0, runs: 0 };
  const touched = new Set<string>();
  for (const copy of held) {
    if (!doomed.has(copy.id)) continue;
    const removed = await removeCopy(copy);
    if (!removed.ok) {
      // An archive that will not delete is a reason to keep its row: losing
      // the row would leave the file with nothing that knows about it.
      console.error(`[backup] Impossibile rimuovere ${copy.ref} da «${copy.name}»:`, removed.error);
      continue;
    }
    result.copies++;
    touched.add(copy.run_id);
  }

  for (const runId of touched) {
    if (await forgetIfEmpty(runId)) result.runs++;
    else await syncRunArchive(runId);
  }
  return result;
}

/**
 * Remove a run once none of its copies holds the archive. One still being
 * sent keeps it: the archive is about to exist again.
 */
async function forgetIfEmpty(runId: string): Promise<boolean> {
  const left = (await loadCopies([runId])).get(runId) ?? [];
  if (left.some((copy) => copy.status !== "failed")) return false;
  const db = await getDb();
  await db.deleteFrom("backup_runs").where("id", "=", runId).execute();
  try {
    removeLogFile(backupLogPath(runId));
  } catch {
    /* an unparseable id has no log to remove */
  }
  return true;
}

export type { BackupRunsTable };
