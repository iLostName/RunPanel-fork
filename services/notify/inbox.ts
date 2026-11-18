import { sql, type ExpressionBuilder, type SqlBool } from "kysely";
import { getDb, nowIso, type Database } from "@/lib/db";
import {
  GLOBAL_PERMISSIONS,
  hasPermission,
  projectAccess,
  serviceAccess,
  type GlobalPermission,
  type Principal,
} from "@/lib/authz";
import { projectRef, serviceRef, visibleProjectIds, visibleServiceIds } from "@/lib/principal";
import { NOTIFY_GROUPS } from "@/lib/notify-events";
import { centerEvents } from "./center";

/**
 * The notification centre as one user sees it.
 *
 * Visibility is decided at read time from the row's subject, with the same
 * functions every other list uses (`lib/authz.ts`), so a grant changed after
 * the fact applies to old notifications too: nobody learns from the bell that
 * a project they were never given crashed last week.
 *
 * Read state is per user. "Segna tutte come lette" moves a mark — everything
 * created up to now is read — instead of writing a row per notification; a row
 * in `notification_reads` covers one read after the mark.
 */

export interface InboxItem {
  id: string;
  event: string;
  level: "ok" | "warn" | "danger" | "info";
  title: string;
  /** The catalogue's HTML dialect; rendered by `components/notifications/NotifyBody`. */
  body: string;
  href: string | null;
  createdAt: string;
  lastAt: string;
  repeats: number;
  read: boolean;
}

export interface InboxQuery {
  limit: number;
  /** The `nextBefore` of the previous page. */
  before?: string | null;
  unreadOnly?: boolean;
  /** One level, or `problems` for warnings and errors together. */
  level?: "problems" | "ok" | "warn" | "danger" | "info" | null;
  /** A group id from `NOTIFY_GROUPS`. */
  group?: string | null;
}

interface Visibility {
  projects: Set<string> | "all";
  services: Set<string> | "all";
  permissions: GlobalPermission[];
}

/** Null for the owner, who sees everything, including what nobody else may. */
async function visibilityOf(principal: Principal): Promise<Visibility | null> {
  if (principal.isOwner) return null;
  return {
    projects: await visibleProjectIds(principal),
    services: await visibleServiceIds(principal),
    permissions: GLOBAL_PERMISSIONS.filter((permission) => hasPermission(principal, permission)),
  };
}

type NotificationsEb = ExpressionBuilder<Database, "notifications">;

/** The rows this user may see, as a WHERE. Null when they may see none at all. */
function visibleWhere(eb: NotificationsEb, visibility: Visibility) {
  const any = [];
  if (visibility.projects === "all") any.push(eb("notifications.scope", "=", "project"));
  else if (visibility.projects.size > 0) {
    any.push(eb.and([eb("notifications.scope", "=", "project"), eb("notifications.scope_id", "in", [...visibility.projects])]));
  }
  if (visibility.services === "all") any.push(eb("notifications.scope", "=", "service"));
  else if (visibility.services.size > 0) {
    any.push(eb.and([eb("notifications.scope", "=", "service"), eb("notifications.scope_id", "in", [...visibility.services])]));
  }
  if (visibility.permissions.length > 0) {
    any.push(eb.and([eb("notifications.scope", "is", null), eb("notifications.permission", "in", visibility.permissions)]));
  }
  return any.length > 0 ? eb.or(any) : null;
}

/**
 * A condition nothing satisfies, as SQL rather than a bound `false`: SQLite
 * cannot bind a boolean. Only reached if `seesNothing` was skipped.
 */
function never() {
  return sql<SqlBool>`1 = 0`;
}

function seesNothing(visibility: Visibility | null): boolean {
  if (!visibility) return false;
  const none = (set: Set<string> | "all") => set !== "all" && set.size === 0;
  return none(visibility.projects) && none(visibility.services) && visibility.permissions.length === 0;
}

async function readMark(userId: string): Promise<string> {
  const db = await getDb();
  const row = await db.selectFrom("notification_read_marks").select("read_before").where("user_id", "=", userId).executeTakeFirst();
  // The empty string sorts before every ISO timestamp: nothing is read yet.
  return row?.read_before ?? "";
}

function unreadWhere(eb: NotificationsEb, userId: string, mark: string) {
  return eb.and([
    eb("notifications.created_at", ">", mark),
    eb.not(
      eb.exists(
        eb
          .selectFrom("notification_reads")
          .select("notification_reads.user_id")
          .whereRef("notification_reads.notification_id", "=", "notifications.id")
          .where("notification_reads.user_id", "=", userId)
      )
    ),
  ]);
}

function levelsFor(level: InboxQuery["level"]): string[] | null {
  if (!level) return null;
  return level === "problems" ? ["warn", "danger"] : [level];
}

function eventsOf(group: string | null | undefined): string[] | null {
  if (!group) return null;
  const found = NOTIFY_GROUPS.find((candidate) => candidate.id === group);
  return found ? found.events.map((event) => event.key) : [];
}

/** `createdAt|id`, so two notifications filed in the same millisecond still page apart. */
function parseCursor(raw: string | null | undefined): { at: string; id: string } | null {
  if (!raw) return null;
  const at = raw.slice(0, raw.lastIndexOf("|"));
  const id = raw.slice(raw.lastIndexOf("|") + 1);
  return at && id ? { at, id } : null;
}

export async function listInbox(principal: Principal, query: InboxQuery): Promise<{ items: InboxItem[]; unread: number; nextBefore: string | null }> {
  const visibility = await visibilityOf(principal);
  if (seesNothing(visibility)) return { items: [], unread: 0, nextBefore: null };

  const db = await getDb();
  const userId = principal.userId;
  const mark = await readMark(userId);
  const levels = levelsFor(query.level);
  const events = eventsOf(query.group);
  if (events && events.length === 0) return { items: [], unread: await unreadCount(principal), nextBefore: null };
  const cursor = parseCursor(query.before);

  let select = db
    .selectFrom("notifications")
    .select([
      "notifications.id",
      "notifications.event",
      "notifications.level",
      "notifications.title",
      "notifications.body",
      "notifications.href",
      "notifications.created_at",
      "notifications.last_at",
      "notifications.repeats",
    ])
    .orderBy("notifications.created_at", "desc")
    .orderBy("notifications.id", "desc")
    .limit(query.limit + 1);

  if (visibility) select = select.where((eb) => visibleWhere(eb, visibility) ?? never());
  if (query.unreadOnly) select = select.where((eb) => unreadWhere(eb, userId, mark));
  if (levels) select = select.where("notifications.level", "in", levels);
  if (events) select = select.where("notifications.event", "in", events);
  if (cursor) {
    select = select.where((eb) =>
      eb.or([
        eb("notifications.created_at", "<", cursor.at),
        eb.and([eb("notifications.created_at", "=", cursor.at), eb("notifications.id", "<", cursor.id)]),
      ])
    );
  }

  const rows = await select.execute();
  const page = rows.slice(0, query.limit);
  const readIds = new Set(
    page.length === 0
      ? []
      : (
          await db
            .selectFrom("notification_reads")
            .select("notification_id")
            .where("user_id", "=", userId)
            .where("notification_id", "in", page.map((row) => row.id))
            .execute()
        ).map((row) => row.notification_id)
  );
  const items: InboxItem[] = page.map((row) => ({
    id: row.id,
    event: row.event,
    level: (["ok", "warn", "danger", "info"].includes(row.level) ? row.level : "info") as InboxItem["level"],
    title: row.title,
    body: row.body,
    href: row.href,
    createdAt: row.created_at,
    lastAt: row.last_at,
    repeats: row.repeats,
    read: row.created_at <= mark || readIds.has(row.id),
  }));
  const last = page[page.length - 1];
  return {
    items,
    unread: await unreadCount(principal, visibility),
    nextBefore: rows.length > query.limit && last ? `${last.created_at}|${last.id}` : null,
  };
}

export async function unreadCount(principal: Principal, known?: Visibility | null): Promise<number> {
  const visibility = known === undefined ? await visibilityOf(principal) : known;
  if (seesNothing(visibility)) return 0;
  const db = await getDb();
  const mark = await readMark(principal.userId);
  let query = db
    .selectFrom("notifications")
    .select((eb) => eb.fn.countAll<number>().as("count"))
    .where((eb) => unreadWhere(eb, principal.userId, mark));
  if (visibility) query = query.where((eb) => visibleWhere(eb, visibility) ?? never());
  const row = await query.executeTakeFirst();
  return Number(row?.count ?? 0);
}

/** Mark some as read. Ids that do not exist are ignored; ones this user cannot see change nothing they can see. */
export async function markRead(principal: Principal, ids: readonly string[]): Promise<void> {
  const db = await getDb();
  const existing = await db.selectFrom("notifications").select("id").where("id", "in", [...new Set(ids)]).execute();
  if (existing.length === 0) return;
  const now = nowIso();
  await db
    .insertInto("notification_reads")
    .values(existing.map((row) => ({ notification_id: row.id, user_id: principal.userId, read_at: now })))
    .onConflict((oc) => oc.columns(["notification_id", "user_id"]).doUpdateSet({ read_at: now }))
    .execute();
  centerEvents.emit({ type: "read", userId: principal.userId });
}

/** Everything up to now is read; the single reads it makes redundant are dropped. */
export async function markAllRead(principal: Principal): Promise<void> {
  const db = await getDb();
  const now = nowIso();
  await db
    .insertInto("notification_read_marks")
    .values({ user_id: principal.userId, read_before: now })
    .onConflict((oc) => oc.column("user_id").doUpdateSet({ read_before: now }))
    .execute();
  await db.deleteFrom("notification_reads").where("user_id", "=", principal.userId).where("read_at", "<=", now).execute();
  centerEvents.emit({ type: "read", userId: principal.userId });
}

/** For the live stream: whether a notification that was just filed is one this user may see. */
export async function canSee(
  principal: Principal,
  row: { scope: string | null; scopeId: string | null; permission: string | null }
): Promise<boolean> {
  if (principal.isOwner) return true;
  if (row.scope === "project" && row.scopeId) {
    const ref = await projectRef(row.scopeId);
    return ref !== null && projectAccess(principal, ref).level !== null;
  }
  if (row.scope === "service" && row.scopeId) {
    const ref = await serviceRef(row.scopeId);
    return ref !== null && serviceAccess(principal, ref).level !== null;
  }
  if (row.scope === null && row.permission && (GLOBAL_PERMISSIONS as readonly string[]).includes(row.permission)) {
    return hasPermission(principal, row.permission as GlobalPermission);
  }
  return false;
}
