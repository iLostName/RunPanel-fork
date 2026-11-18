import { NextRequest, NextResponse } from "next/server";
import { isDenied, requireProject } from "@/lib/auth-guard";
import { getDb } from "@/lib/db";
import { DOWN_AFTER, UP_AFTER, UPTIME_INTERVAL_MS, UPTIME_TIMEOUT_MS } from "@/lib/uptime-math";
import { planFor, runningContract } from "@/services/uptime/targets";
import { uptimeSummary } from "@/services/uptime/summary";
import { checkerInfo } from "@/services/uptime/checker";
import { HDR_MEMBER } from "@/lib/cluster-sign";
import { panelBaseUrl } from "@/lib/panel-url";
import { statusPagePath } from "@/lib/status-page";
import { readStatusPageConfig } from "@/services/status-page/store";

type Params = { params: Promise<{ projectId: string }> };

/**
 * Whether the app answers, and how it has been answering: the uptime card.
 *
 * `watch` says what is asked and, when nothing is, why — the check turned off,
 * no port to ask, the project not running — so the card can say it in words
 * instead of showing an empty chart. `tz` is the browser's
 * `getTimezoneOffset()`, so the thirty bars of the strip are the reader's days
 * rather than the server's. `publicPage` is the public status page the
 * project appears on, if any.
 */
export async function GET(request: NextRequest, { params }: Params) {
  const { projectId } = await params;
  const denied = await requireProject(projectId, "view");
  if (isDenied(denied)) return denied;

  const db = await getDb();
  const project = await db
    .selectFrom("projects")
    .select(["id", "name", "status", "port", "builder_config", "access_mode", "access_allow", "access_port"])
    .where("id", "=", projectId)
    .executeTakeFirst();
  if (!project) return NextResponse.json({ error: "Progetto non trovato" }, { status: 404 });

  const rawTz = Number.parseInt(request.nextUrl.searchParams.get("tz") ?? "0", 10);
  const tz = Number.isFinite(rawTz) && Math.abs(rawTz) <= 14 * 60 ? rawTz : 0;

  const plan = planFor(project, await runningContract(project.id));
  const now = Date.now();
  const [summary, page] = await Promise.all([uptimeSummary(project.id, now, tz), readStatusPageConfig()]);

  // On this server's public status page, under the name the owner chose: the
  // card links to it. Only while the page is on — a link to a page that is off
  // opens "Pagina non trovata" — and only with an address the reader can use:
  // through another panel of the cluster, the request's own host is this
  // server as that panel reaches it, not as a browser would.
  const entry = page?.enabled ? page.projects.find((e) => e.server === null && e.projectId === project.id) : undefined;
  let publicPage: { name: string; path: string; url: string | null } | null = null;
  if (page && entry) {
    const base = await panelBaseUrl(request.headers.get(HDR_MEMBER) ? undefined : request);
    const path = statusPagePath(page.slug);
    publicPage = { name: entry.name, path, url: base ? `${base.origin}${path}` : null };
  }

  return NextResponse.json(
    {
      // The clock every duration on the card is measured against.
      now,
      publicPage,
      watch: {
        active: plan.target !== null,
        skip: plan.skip,
        path: plan.path,
        port: plan.port,
        expectStatus: plan.expectStatus,
        intervalMs: UPTIME_INTERVAL_MS,
        timeoutMs: UPTIME_TIMEOUT_MS,
        downAfter: DOWN_AFTER,
        upAfter: UP_AFTER,
        checking: checkerInfo().checking,
      },
      ...summary,
    },
    { headers: { "Cache-Control": "no-store" } }
  );
}
