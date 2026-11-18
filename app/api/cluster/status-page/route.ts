import { NextRequest, NextResponse } from "next/server";
import { isDenied, requireMember } from "@/lib/auth-guard";
import { MAX_PAGE_PROJECTS, type PublicProjectStatus } from "@/lib/status-page";
import { localProjectStatuses } from "@/services/status-page/snapshot";

const ID = /^[A-Za-z0-9_-]{1,64}$/;

/**
 * The public status of some projects of this server, for the panel whose
 * status page shows them (`services/status-page/remote.ts`).
 *
 * Another panel only, with no user: a request forwarded for an account
 * through `/api/nodes` is refused by the guard, so nobody reads through here
 * the figures of a project they were not given. The answer is the same
 * cut-down status the page itself is built from — no names, no ports, no
 * causes — keyed by the ids asked for, `null` for one this server does not
 * have. `tz` is the page's `getTimezoneOffset()`, so the days of the bars line
 * up with those of the projects of the asking panel.
 */
export async function GET(request: NextRequest) {
  const denied = await requireMember({ role: "panel" });
  if (isDenied(denied)) return denied;

  const ids = [...new Set((request.nextUrl.searchParams.get("ids") ?? "").split(","))]
    .filter((id) => ID.test(id))
    .slice(0, MAX_PAGE_PROJECTS);
  const rawTz = Number.parseInt(request.nextUrl.searchParams.get("tz") ?? "0", 10);
  const tz = Number.isFinite(rawTz) && Math.abs(rawTz) <= 14 * 60 ? rawTz : 0;

  const statuses = await localProjectStatuses(ids, Date.now(), tz);
  const projects: Record<string, PublicProjectStatus | null> = {};
  for (const id of ids) {
    const status = statuses.get(id);
    projects[id] = status && status !== "missing" ? status : null;
  }
  return NextResponse.json({ projects }, { headers: { "Cache-Control": "no-store" } });
}
