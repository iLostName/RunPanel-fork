import { AUDIT_CATEGORIES, type AuditCategory, type AuditScope } from "@/lib/audit-filter";
import type { AuditExportFilters } from "@/lib/audit-export";

/**
 * The filters of the activity log, read from a query string once for the page
 * of entries (`/api/audit`) and for the export (`/api/audit/export`): the file
 * a person downloads holds exactly what the list showed them.
 */

const SCOPES: readonly AuditScope[] = ["project", "service", "folder", "user", "permission"];
const isIso = (v: string | null): v is string => v !== null && !Number.isNaN(Date.parse(v));

export type AuditFilters = AuditExportFilters;

export function auditFiltersFrom(sp: URLSearchParams): AuditFilters {
  const category = sp.get("category");
  const scope = sp.get("scope");
  return {
    userId: sp.get("userId")?.slice(0, 64) || undefined,
    category: category && (AUDIT_CATEGORIES as readonly string[]).includes(category) ? (category as AuditCategory) : undefined,
    action: sp.get("action")?.slice(0, 64) || undefined,
    scope: scope && (SCOPES as readonly string[]).includes(scope) ? (scope as AuditScope) : undefined,
    scopeId: sp.get("scopeId")?.slice(0, 64) || undefined,
    from: isIso(sp.get("from")) ? new Date(sp.get("from")!).toISOString() : undefined,
    to: isIso(sp.get("to")) ? new Date(sp.get("to")!).toISOString() : undefined,
  };
}

/** The paging cursor of `/api/audit`: the time of the last entry shown. */
export function auditCursorFrom(sp: URLSearchParams): string | undefined {
  return isIso(sp.get("before")) ? sp.get("before")! : undefined;
}
