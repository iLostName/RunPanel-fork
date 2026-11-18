import { targetNames } from "./audit";
import { canSeeEntry, type AuditCategory, type AuditScope } from "./audit-filter";
import type { Principal } from "./authz";
import { getDb } from "./db";
import { visibleFolderIds, visibleProjectIds, visibleServiceIds } from "./principal";

/**
 * The activity log for a download: every entry matching the filters that the
 * reader may see, newest first, a page at a time so a long log never sits in
 * memory whole.
 *
 * Not `queryAudit` in a loop. That one pages by time alone, which is right for
 * a list read by eye and wrong for a file meant to be complete: two entries
 * written in the same millisecond, either side of a page boundary, and the
 * second is never returned. Here the cursor is (time, id).
 */

export interface AuditExportFilters {
  userId?: string;
  category?: AuditCategory;
  action?: string;
  scope?: AuditScope;
  scopeId?: string;
  from?: string;
  to?: string;
}

export interface AuditExportRow {
  id: string;
  at: string;
  userId: string | null;
  email: string | null;
  category: string;
  action: string;
  scope: string | null;
  scopeId: string | null;
  scopeName: string | null;
  detail: string | null;
  ip: string | null;
}

/** The most a file holds; past it, the period has to be narrowed. */
export const AUDIT_EXPORT_MAX_ROWS = 100_000;
const PAGE = 1000;

export async function* exportAudit(
  principal: Principal,
  filters: AuditExportFilters,
  max = AUDIT_EXPORT_MAX_ROWS
): AsyncGenerator<AuditExportRow[]> {
  const db = await getDb();
  const visible = principal.isOwner
    ? null
    : {
        projects: await visibleProjectIds(principal),
        services: await visibleServiceIds(principal),
        folders: await visibleFolderIds(principal),
      };

  let cursor: { at: string; id: string } | null = null;
  let emitted = 0;
  while (emitted < max) {
    let query = db
      .selectFrom("audit_log")
      .leftJoin("users", "users.id", "audit_log.user_id")
      .select([
        "audit_log.id",
        "audit_log.at",
        "audit_log.user_id",
        "users.email",
        "audit_log.category",
        "audit_log.action",
        "audit_log.scope",
        "audit_log.scope_id",
        "audit_log.detail",
        "audit_log.ip",
      ])
      .orderBy("audit_log.at", "desc")
      .orderBy("audit_log.id", "desc")
      .limit(PAGE);
    if (filters.userId) query = query.where("audit_log.user_id", "=", filters.userId);
    if (filters.category) query = query.where("audit_log.category", "=", filters.category);
    if (filters.action) query = query.where("audit_log.action", "=", filters.action);
    if (filters.scope) query = query.where("audit_log.scope", "=", filters.scope);
    if (filters.scopeId) query = query.where("audit_log.scope_id", "=", filters.scopeId);
    if (filters.from) query = query.where("audit_log.at", ">=", filters.from);
    if (filters.to) query = query.where("audit_log.at", "<=", filters.to);
    if (cursor) {
      const { at, id } = cursor;
      query = query.where((eb) => eb.or([eb("audit_log.at", "<", at), eb.and([eb("audit_log.at", "=", at), eb("audit_log.id", "<", id)])]));
    }

    const rows = await query.execute();
    if (rows.length === 0) return;
    cursor = { at: rows[rows.length - 1].at, id: rows[rows.length - 1].id };

    const shown = rows
      .filter((row) => !visible || canSeeEntry(principal, { category: row.category, scope: row.scope, scopeId: row.scope_id }, visible))
      .slice(0, max - emitted)
      .map((row) => ({
        id: row.id,
        at: row.at,
        userId: row.user_id,
        email: row.email ?? null,
        category: row.category,
        action: row.action,
        scope: row.scope,
        scopeId: row.scope_id,
        scopeName: null as string | null,
        detail: row.detail,
        ip: row.ip,
      }));
    if (shown.length > 0) {
      const names = await targetNames(shown);
      for (const row of shown) row.scopeName = row.scope && row.scopeId ? names.get(`${row.scope}:${row.scopeId}`) ?? null : null;
      emitted += shown.length;
      yield shown;
    }
    if (rows.length < PAGE) return;
  }
}
