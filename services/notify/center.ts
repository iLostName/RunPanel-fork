import { EventEmitter } from "events";
import { getDb, nowIso } from "@/lib/db";
import { generateId } from "@/lib/utils";
import { eventMeta } from "@/lib/notify-events";
import type { NotifyEvent, NotifyMessage } from "./messages";

/**
 * The panel's own copy of every notification: what the bell shows.
 *
 * Written for every event, whatever the channels are set to — the centre is
 * where the panel keeps its record, the channels are where it shouts. Each row
 * carries who may read it, worked out once here when the event happens:
 *
 *  - about a project or a service: whoever can see that project or service,
 *    decided when the list is read, so a grant given or taken later applies;
 *  - about the machine or the panel: the holders of the panel permission for
 *    the page that would show the same thing (`lib/notify-events.ts`);
 *  - about a project or a service that cannot be found: the owner alone,
 *    since nothing says who else was meant to know about it.
 *
 * This half is the writing side, and only needs the store: it is imported by
 * the deploy pipeline and the status sweep through `notify()`. Reading, with
 * the visibility rules, is `inbox.ts`.
 */

export interface Subject {
  scope: "project" | "service" | null;
  scopeId: string | null;
  /** For a notification with no scope: the panel permission that sees it. Null with no scope: the owner only. */
  permission: string | null;
  href: string | null;
}

export type CenterEvent =
  | { type: "created"; id: string; scope: string | null; scopeId: string | null; permission: string | null }
  | { type: "read"; userId: string };

/** Kept for this long, then removed; and never more than this many. */
export const RETENTION_DAYS = 30;
export const MAX_NOTIFICATIONS = 5000;

const globalRef = globalThis as typeof globalThis & {
  __runpanelCenterEvents?: EventEmitter;
  __runpanelCenterPurgedAt?: number;
};

const emitter = () => {
  if (!globalRef.__runpanelCenterEvents) {
    const created = new EventEmitter();
    // One listener per open tab, across every signed-in account.
    created.setMaxListeners(500);
    globalRef.__runpanelCenterEvents = created;
  }
  return globalRef.__runpanelCenterEvents;
};

/** What the notification streams listen to. In-process, like every other bus in the panel. */
export const centerEvents = {
  emit(event: CenterEvent): void {
    emitter().emit("center", event);
  },
  subscribe(listener: (event: CenterEvent) => void): () => void {
    emitter().on("center", listener);
    return () => {
      emitter().off("center", listener);
    };
  },
};

const project = (id: string): Subject => ({ scope: "project", scopeId: id, permission: null, href: `/projects/${id}` });
const service = (id: string): Subject => ({ scope: "service", scopeId: id, permission: null, href: `/services/${id}` });

/**
 * What an event is about.
 *
 * Read from the fields themselves rather than from a table per key, so an event
 * added later finds its subject without an edit here: `projectId` or
 * `serviceId` when the caller knows them, otherwise a project's `slug` or a
 * service's `container`, which are both unique.
 */
export async function resolveSubject(event: NotifyEvent): Promise<Subject> {
  const fields = event as unknown as Record<string, unknown>;
  const meta = eventMeta(event.key);
  const db = await getDb();

  const projectBy = async (column: "id" | "slug" | "name", value: string) => {
    const rows = await db.selectFrom("projects").select("id").where(column, "=", value).limit(2).execute();
    return rows.length === 1 ? rows[0].id : null;
  };
  const serviceBy = async (column: "id" | "container_name" | "name" | "display_name", value: string) => {
    const rows = await db.selectFrom("services").select("id").where(column, "=", value).limit(2).execute();
    return rows.length === 1 ? rows[0].id : null;
  };

  let about = false;
  if (typeof fields.projectId === "string") {
    about = true;
    const id = await projectBy("id", fields.projectId);
    if (id) return project(id);
  }
  if (typeof fields.serviceId === "string") {
    about = true;
    const id = await serviceBy("id", fields.serviceId);
    if (id) return service(id);
  }

  if (event.key === "restart.scheduled") {
    about = true;
    // Names are not unique; one that matches a single row is good enough when
    // the caller did not say which one it meant.
    const id = event.kind === "project"
      ? event.id ?? (await projectBy("name", event.name))
      : event.id ?? (await serviceBy("display_name", event.name)) ?? (await serviceBy("name", event.name));
    if (id) return event.kind === "project" ? project(id) : service(id);
  }

  if (typeof fields.slug === "string") {
    about = true;
    const id = await projectBy("slug", fields.slug);
    if (id) return project(id);
  }
  if (typeof fields.container === "string") {
    about = true;
    const id = await serviceBy("container_name", fields.container);
    if (id) return service(id);
  }

  if (about) return { scope: null, scopeId: null, permission: null, href: meta.href };
  return { scope: null, scopeId: null, permission: meta.permission, href: meta.href };
}

/** File one notification. Never throws: the centre is a record, never a reason for the event to fail. */
export async function recordNotification(key: string, message: NotifyMessage, subject: Subject): Promise<string | null> {
  try {
    const db = await getDb();
    const id = generateId();
    const now = nowIso();
    await db
      .insertInto("notifications")
      .values({
        id,
        event: key,
        level: message.level,
        title: message.title.slice(0, 300),
        body: message.body,
        href: subject.href,
        scope: subject.scope,
        scope_id: subject.scopeId,
        permission: subject.permission,
        repeats: 0,
        created_at: now,
        last_at: now,
      })
      .execute();
    centerEvents.emit({ type: "created", id, scope: subject.scope, scopeId: subject.scopeId, permission: subject.permission });
    void purgeOldNotifications();
    return id;
  } catch (err) {
    console.error("[notify] Notifica non salvata nel pannello:", err instanceof Error ? err.message : err);
    return null;
  }
}

/**
 * The same thing happened again while it was being held back: counted on the
 * notification that announced it, which stays read if it was. It would be
 * noise to bring it back as new every time a crash-looping project falls; the
 * next message after the quiet period does that.
 */
export async function noteRepeat(id: string): Promise<void> {
  try {
    const db = await getDb();
    await db
      .updateTable("notifications")
      .set((eb) => ({ repeats: eb("repeats", "+", 1), last_at: nowIso() }))
      .where("id", "=", id)
      .execute();
  } catch {
    /* a lost count is not worth a log line */
  }
}

/**
 * Remove what is older than the retention, and the oldest beyond the cap.
 *
 * On the write path, at most once an hour, rather than on a timer: it is the
 * only thing that makes the table grow, and a panel that writes nothing has
 * nothing to tidy. Read marks go with their notification (`ON DELETE CASCADE`).
 */
export async function purgeOldNotifications(now = Date.now()): Promise<void> {
  if (globalRef.__runpanelCenterPurgedAt && now - globalRef.__runpanelCenterPurgedAt < 3_600_000) return;
  globalRef.__runpanelCenterPurgedAt = now;
  try {
    const db = await getDb();
    await db
      .deleteFrom("notifications")
      .where("created_at", "<", new Date(now - RETENTION_DAYS * 86_400_000).toISOString())
      .execute();
    const beyond = await db
      .selectFrom("notifications")
      .select("created_at")
      .orderBy("created_at", "desc")
      .limit(1)
      .offset(MAX_NOTIFICATIONS)
      .executeTakeFirst();
    if (beyond) await db.deleteFrom("notifications").where("created_at", "<=", beyond.created_at).execute();
  } catch (err) {
    console.error("[notify] Pulizia delle notifiche vecchie non riuscita:", err instanceof Error ? err.message : err);
  }
}
