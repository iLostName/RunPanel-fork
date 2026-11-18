import { Kysely } from "kysely";

/**
 * Credentials typed into a repository URL, from before the form dropped them.
 *
 * `gitClone` has never used them, so all they did in the row was reach the deploy
 * log and anyone with read access to the project. Rewritten here rather than
 * hidden on the way out, so no new reader can forget about them. Deploy logs
 * already written keep what they printed.
 *
 * Its own copy of the rule, because a migration has to keep doing what it did the
 * day it was written, and only http(s): the user of an ssh address is not a
 * secret, and removing it breaks the address.
 */
const HTTP_CREDENTIALS = /^(https?:\/\/)[^/?#]*@/i;

export async function up(db: Kysely<unknown>): Promise<void> {
  const store = db as unknown as Kysely<{ projects: { id: string; source_url: string | null } }>;
  const rows = await store
    .selectFrom("projects")
    .select(["id", "source_url"])
    .where("source_url", "like", "%@%")
    .execute();

  for (const row of rows) {
    if (row.source_url === null || !HTTP_CREDENTIALS.test(row.source_url)) continue;
    await store
      .updateTable("projects")
      .set({ source_url: row.source_url.replace(HTTP_CREDENTIALS, "$1") })
      .where("id", "=", row.id)
      .execute();
  }
}

/** Nothing to put back: the point was to stop keeping them. */
export async function down(): Promise<void> {}
