import type { Kysely } from "kysely";

import type { Database } from "@/lib/db/schema";

/**
 * End this install's sessions of a user whose password arrived changed from
 * another member, and name them so their open streams can be closed once the
 * merge is committed. Call it before the row is overwritten.
 *
 * Sessions are local rows and only the hash replicates, so without this a
 * stolen cookie outlives the password change that was meant to end it.
 *
 * Compared against the stored hash rather than decided from the merge plan: the
 * panel the change was made on applies its own snapshot back, and by then its
 * rows already carry the new hash and the session it re-issued to the person
 * who made the change, which must survive.
 */
export async function revokeSessionsOnNewPassword(
  trx: Kysely<Database>,
  userId: string,
  incomingHash: string | null
): Promise<string[]> {
  const stored = await trx.selectFrom("users").select("password_hash").where("id", "=", userId).executeTakeFirst();
  if (!stored || stored.password_hash === incomingHash) return [];
  const rows = await trx.deleteFrom("sessions").where("user_id", "=", userId).returning("id").execute();
  return rows.map((row) => row.id);
}
