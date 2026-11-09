import { isDenied, requireUser } from "@/lib/auth-guard";
import { folderAccess } from "@/lib/authz";
import { mergeByMember } from "@/lib/cluster-merge";
import { getDb } from "@/lib/db";
import { rememberedFolders } from "@/lib/overview-groups";
import { json } from "@/services/cluster/aggregate";
import { fanOut, memberStatuses } from "@/services/cluster/fanout";
import { isDown, lastSeenFiled } from "@/services/cluster/last-seen";

/**
 * GET /api/folders of every server, each row tagged with its server. A folder
 * is replicated, so the same row comes back once per server and the page keeps
 * one. A folder deleted here is left out even where another server still lists
 * it: the delete has not reached that server yet, it will, and it wins over
 * whatever that server did to the folder meanwhile.
 *
 * A folder this account sees only for what a server now down holds is listed
 * from this panel's own copy, so the last known cards stay in it.
 */
export async function GET() {
  const denied = await requireUser();
  if (isDenied(denied)) return denied;

  const db = await getDb();
  const results = await fanOut<Array<{ id: string; updated_at: string }>>("/api/folders", { userId: denied.session.user.id });
  const [stored, tombstones, lastSeen] = await Promise.all([
    db.selectFrom("folders").selectAll().execute(),
    db.selectFrom("cluster_tombstones").select("id").where("kind", "=", "folder").execute(),
    lastSeenFiled(denied, results.filter((r) => !r.member.self && isDown(r)).map((r) => r.member)),
  ]);

  const deleted = new Set(tombstones.map((t) => t.id));
  const items = mergeByMember(results.map((r) => ({ member: r.member, items: r.data }))).filter((f) => !deleted.has(f.id));
  const self = results.find((r) => r.member.self)?.member;
  const remembered = self
    ? rememberedFolders(stored.filter((f) => !deleted.has(f.id)), items, lastSeen).map((f) => ({
        ...f,
        permission: folderAccess(denied.principal, f.id),
        memberId: self.id,
        memberName: self.name,
      }))
    : [];
  return json({ items: [...items, ...remembered], members: memberStatuses(results) });
}
