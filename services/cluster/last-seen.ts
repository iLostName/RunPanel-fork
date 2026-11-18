import { projectAccess, serviceAccess } from "@/lib/authz";
import type { AuthContext } from "@/lib/auth-guard";
import { mergeByMember, type Aggregated, type Located } from "@/lib/cluster-merge";
import { getDb, nowIso } from "@/lib/db";
import { lastSeenRows, type LastSeenKind } from "@/lib/overview-groups";
import { fanOut, memberStatuses, type FanOutResult } from "./fanout";

/**
 * The aggregated projects and services, plus what this panel last saw of the
 * servers that did not answer, so the Overview can keep those rows in their
 * folders and mark them unreachable. Best effort from end to end: a copy that
 * cannot be read or written never costs the page its list.
 */

/** A 403 is an answer: the account may not see that server's rows, so it gets no copy of them either. */
export const isDown = (r: FanOutResult<unknown>) => !r.ok && (r.status === null || r.status >= 500);

type Row = Record<string, unknown> & { id: string; folder_id: string | null };

/** Access may have changed since the copy was taken, and grants are replicated: ask again here. */
function stillVisible(kind: LastSeenKind, ctx: AuthContext, row: Row): boolean {
  const ref = { id: row.id, folderId: row.folder_id };
  const access = kind === "projects" ? projectAccess(ctx.principal, ref) : serviceAccess(ctx.principal, { ...ref, project: null });
  return access.level !== null;
}

async function storedRows(userId: string, memberId: string, kind: LastSeenKind): Promise<string | undefined> {
  const db = await getDb();
  const stored = await db
    .selectFrom("cluster_last_seen")
    .select("rows")
    .where("user_id", "=", userId)
    .where("member_id", "=", memberId)
    .where("kind", "=", kind)
    .executeTakeFirst();
  return stored?.rows;
}

/** Written only when something a card shows really changed, so a poll is one read. */
async function remember(userId: string, memberId: string, kind: LastSeenKind, data: unknown): Promise<void> {
  const rows = JSON.stringify(lastSeenRows(kind, data));
  if ((await storedRows(userId, memberId, kind)) === rows) return;
  const db = await getDb();
  const updated_at = nowIso();
  await db
    .insertInto("cluster_last_seen")
    .values({ user_id: userId, member_id: memberId, kind, rows, updated_at })
    .onConflict((oc) => oc.columns(["user_id", "member_id", "kind"]).doUpdateSet({ rows, updated_at }))
    .execute();
}

async function recall(ctx: AuthContext, member: { id: string; name: string }, kind: LastSeenKind): Promise<Array<Located<Row>>> {
  const stored = await storedRows(ctx.session.user.id, member.id, kind);
  if (!stored) return [];
  const rows = JSON.parse(stored) as Row[];
  return rows.filter((row) => stillVisible(kind, ctx, row)).map((row) => ({ ...row, memberId: member.id, memberName: member.name }));
}

/**
 * What the given servers had filed when last seen, as far as this account may
 * still see it: the rows that keep a folder listed once they stop answering.
 */
export async function lastSeenFiled(ctx: AuthContext, members: Array<{ id: string; name: string }>): Promise<Row[]> {
  const rows = await Promise.all(
    members.flatMap((member) => (["projects", "services"] as const).map((kind) => recall(ctx, member, kind).catch(() => [])))
  );
  return rows.flat();
}

export async function aggregateWithLastSeen<T>(kind: LastSeenKind, ctx: AuthContext): Promise<Aggregated<T>> {
  const userId = ctx.session.user.id;
  const results = await fanOut<T[]>(`/api/${kind}`, { userId });
  const offline = await Promise.all(
    results
      .filter((r) => !r.member.self)
      .map(async (r) => {
        try {
          if (r.ok) await remember(userId, r.member.id, kind, r.data);
          else if (isDown(r)) return await recall(ctx, r.member, kind);
        } catch {
          /* the copy is a convenience: the list goes out without it */
        }
        return [];
      })
  );
  return {
    items: mergeByMember(results.map((r) => ({ member: r.member, items: r.ok ? r.data : [] }))),
    members: memberStatuses(results),
    offline: offline.flat() as unknown as Located<T>[],
  };
}
