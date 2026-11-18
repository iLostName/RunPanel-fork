import { NextRequest, NextResponse } from "next/server";
import { isDenied, requireProject } from "@/lib/auth-guard";
import { getDb } from "@/lib/db";
import { DOWN_AFTER, UP_AFTER, UPTIME_INTERVAL_MS, UPTIME_TIMEOUT_MS } from "@/lib/uptime-math";
import { planFor, runningContract } from "@/services/uptime/targets";
import { uptimeSummary } from "@/services/uptime/summary";
import { checkerInfo } from "@/services/uptime/checker";

type Params = { params: Promise<{ projectId: string }> };

/**
 * Whether the app answers, and how it has been answering: the uptime card.
 *
 * `watch` says what is asked and, when nothing is, why — the check turned off,
 * no port to ask, the project not running — so the card can say it in words
 * instead of showing an empty chart. `tz` is the browser's
 * `getTimezoneOffset()`, so the thirty bars of the strip are the reader's days
 * rather than the server's.
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
  const summary = await uptimeSummary(project.id, Date.now(), tz);

  return NextResponse.json(
    {
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
