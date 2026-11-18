import { NextRequest, NextResponse } from "next/server";
import { isDenied, requirePermission } from "@/lib/auth-guard";
import { queryAudit } from "@/lib/audit";
import { auditCursorFrom, auditFiltersFrom } from "./filters";

/**
 * A page of the activity log. Holding `audit.view` opens the page; which
 * entries come back is decided one by one (lib/audit-filter.ts).
 */
export async function GET(request: NextRequest) {
  const denied = await requirePermission("audit.view");
  if (isDenied(denied)) return denied;

  const sp = request.nextUrl.searchParams;
  const limit = Math.min(200, Math.max(1, Number.parseInt(sp.get("limit") ?? "50", 10) || 50));

  const result = await queryAudit(denied.principal, {
    ...auditFiltersFrom(sp),
    before: auditCursorFrom(sp),
    limit,
  });
  return NextResponse.json(result, { headers: { "Cache-Control": "no-store" } });
}
