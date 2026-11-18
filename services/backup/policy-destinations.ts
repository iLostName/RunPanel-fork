import type { Kysely } from "kysely";
import { getDb } from "@/lib/db";
import type { Database } from "@/lib/db/schema";
import { generateId } from "@/lib/utils";
import { destinationListProblem, type ListProblem, type PolicyDestination, type RetentionRule } from "@/lib/backup-copies";
import { destinationFacts } from "./destinations";

/**
 * Where each policy writes, in order — the first is the primary, which
 * `backup_policies.destination_id` keeps naming (migration 045).
 *
 * A policy with no list reads as a list of its one primary column. Nothing
 * here writes a policy without one, but a store restored from before the
 * migration, or a row written by code that predates it, must still back up
 * to where it always did.
 */

type PolicyRow = { id: string; destination_id: string };

export async function loadPolicyDestinations(policies: readonly PolicyRow[]): Promise<Map<string, PolicyDestination[]>> {
  const out = new Map<string, PolicyDestination[]>();
  if (policies.length === 0) return out;
  const db = await getDb();
  const rows = await db
    .selectFrom("backup_policy_destinations")
    .selectAll()
    .where(
      "policy_id",
      "in",
      policies.map((policy) => policy.id)
    )
    .orderBy("position", "asc")
    .execute();

  for (const row of rows) {
    const entry: PolicyDestination = {
      destinationId: row.destination_id,
      retention:
        row.own_retention === 1
          ? { count: row.retention_count, days: row.retention_days, bytes: row.retention_bytes }
          : null,
    };
    const list = out.get(row.policy_id);
    if (list) list.push(entry);
    else out.set(row.policy_id, [entry]);
  }

  for (const policy of policies) {
    if (!out.has(policy.id)) out.set(policy.id, [{ destinationId: policy.destination_id, retention: null }]);
  }
  return out;
}

export async function policyDestinations(policy: PolicyRow): Promise<PolicyDestination[]> {
  return (await loadPolicyDestinations([policy])).get(policy.id) ?? [{ destinationId: policy.destination_id, retention: null }];
}

/** The destinations a run of this policy writes to, in order. */
export async function policyDestinationIds(policy: PolicyRow): Promise<string[]> {
  return (await policyDestinations(policy)).map((entry) => entry.destinationId);
}

/** A list as the API sent it, with every absent field said as null. */
export function normalizeDestinationList(
  list: readonly {
    destinationId: string;
    retention?: { count?: number | null; days?: number | null; bytes?: number | null } | null;
  }[]
): PolicyDestination[] {
  return list.map((entry) => ({
    destinationId: entry.destinationId,
    retention: entry.retention
      ? ({
          count: entry.retention.count ?? null,
          days: entry.retention.days ?? null,
          bytes: entry.retention.bytes ?? null,
        } satisfies RetentionRule)
      : null,
  }));
}

/** Why this list cannot be saved: a destination unknown, listed twice, or two writing to one place. */
export async function destinationListError(ids: readonly string[]): Promise<ListProblem | null> {
  const db = await getDb();
  const rows =
    ids.length > 0 ? await db.selectFrom("backup_destinations").selectAll().where("id", "in", [...ids]).execute() : [];
  return destinationListProblem(ids, destinationFacts(rows));
}

/**
 * Replace a policy's list, and its primary column with it, inside the
 * caller's transaction: a policy is never seen with half a list.
 */
export async function writePolicyDestinations(
  trx: Kysely<Database>,
  policyId: string,
  list: readonly PolicyDestination[],
  now: string
): Promise<void> {
  if (list.length === 0) throw new Error("Una pianificazione ha almeno una destinazione");
  await trx.deleteFrom("backup_policy_destinations").where("policy_id", "=", policyId).execute();
  await trx
    .insertInto("backup_policy_destinations")
    .values(
      list.map((entry, position) => ({
        id: generateId(),
        policy_id: policyId,
        destination_id: entry.destinationId,
        position,
        own_retention: entry.retention ? 1 : 0,
        retention_count: entry.retention?.count ?? null,
        retention_days: entry.retention?.days ?? null,
        retention_bytes: entry.retention?.bytes ?? null,
        created_at: now,
      }))
    )
    .execute();
  await trx.updateTable("backup_policies").set({ destination_id: list[0].destinationId }).where("id", "=", policyId).execute();
}
