import os from "os";
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { isDenied, requirePermission, requireProject, requireService } from "@/lib/auth-guard";
import { METRIC_RANGES, type MetricField } from "@/lib/metrics-math";
import { readHistory } from "@/services/metrics/store";
import { activeAlerts } from "@/services/metrics/alerts";
import { collectorInfo } from "@/services/metrics/collector";
import { diskUsage } from "@/services/host-metrics";

/**
 * The history behind a chart: one subject, one range, every series it has.
 *
 * The guard follows the subject. The host is what the Monitor shows, so it
 * takes the same permission; a project or a service is visible to whoever may
 * see it, which is what lets a project page draw its own charts for an
 * account that has no business on the Monitor.
 *
 * Answered in columns (`t` and one array per series) rather than as a list of
 * points: a day is three hundred of them and the chart reads the arrays as
 * they come.
 */

const querySchema = z.object({
  scope: z.enum(["host", "project", "service"], { message: "scope deve essere host, project o service" }),
  id: z.string().min(1).max(64).optional(),
  range: z.enum(METRIC_RANGES, { message: "range deve essere 1h, 24h o 7d" }).default("1h"),
});

const FIELDS: Record<"host" | "project" | "service", MetricField[]> = {
  host: ["cpu", "mem", "mem_pct", "disk", "disk_pct", "net_rx", "net_tx"],
  project: ["cpu", "mem", "mem_pct", "net_rx", "net_tx"],
  service: ["cpu", "mem", "mem_pct", "net_rx", "net_tx"],
};

export async function GET(request: NextRequest) {
  const sp = request.nextUrl.searchParams;
  const parsed = querySchema.safeParse({
    scope: sp.get("scope") ?? undefined,
    id: sp.get("id") ?? undefined,
    range: sp.get("range") ?? undefined,
  });
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues[0]?.message ?? "Richiesta non valida", details: parsed.error.issues },
      { status: 400 }
    );
  }
  const { scope, range } = parsed.data;

  if (scope === "host") {
    const denied = await requirePermission("monitor");
    if (isDenied(denied)) return denied;
  } else {
    if (!parsed.data.id) {
      return NextResponse.json({ error: "Manca l'id del progetto o del database" }, { status: 400 });
    }
    const denied =
      scope === "project"
        ? await requireProject(parsed.data.id, "view")
        : await requireService(parsed.data.id, "view");
    if (isDenied(denied)) return denied;
  }

  const id = scope === "host" ? "host" : parsed.data.id!;
  const now = Date.now();
  const history = await readHistory(scope, id, range, now, FIELDS[scope]);
  // What the percentages are percentages of, for the labels: "412 MB, il 5% della RAM".
  const disk = scope === "host" ? await diskUsage().catch(() => null) : null;

  return NextResponse.json(
    {
      scope,
      id,
      range,
      ...history,
      context: {
        cores: Math.max(1, os.cpus().length),
        memTotal: os.totalmem(),
        diskTotal: disk?.total || null,
      },
      alerts: scope === "service" ? {} : activeAlerts(scope, id),
      sampling: collectorInfo(),
    },
    { headers: { "Cache-Control": "no-store" } }
  );
}
