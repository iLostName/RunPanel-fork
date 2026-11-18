import { NextRequest, NextResponse } from "next/server";
import { isDenied, requireOwner } from "@/lib/auth-guard";
import { withAudit } from "@/lib/audit";
import { getDb } from "@/lib/db";
import { panelBaseUrl } from "@/lib/panel-url";
import {
  defaultStatusPageConfig,
  entryKey,
  normalizeEntries,
  statusPagePath,
  type StatusPageConfig,
} from "@/lib/status-page";
import { statusPageSchema } from "@/lib/validation";
import { clusterState, listMembers } from "@/services/cluster/state";
import { readStatusPageConfig, writeStatusPageConfig } from "@/services/status-page/store";
import { planFor, runningContract, type UptimeSkip } from "@/services/uptime/targets";

/**
 * The public status page's settings.
 *
 * The owner's, like the panel's preferences: whoever sets it decides what
 * anyone on the internet may read about the projects, under which name, and
 * whether search engines list it. The page itself is `app/(public)/status`.
 *
 * Beside the settings, the answer carries what the owner needs to choose
 * well: the page's address, whether the uptime check asks each project of
 * this server (one that is not asked shows "Nessun dato" on the page), and
 * which chosen projects no longer exist.
 */

const NO_STORE = { headers: { "Cache-Control": "no-store" } } as const;

async function describe(request: NextRequest, config: StatusPageConfig, saved: boolean) {
  const db = await getDb();
  const rows = await db
    .selectFrom("projects")
    .select(["id", "name", "status", "port", "builder_config", "access_mode", "access_allow", "access_port"])
    .execute();

  // Why a project is not asked, in the order the page decides its state
  // (`publicState`): stopped or in error first, since that is what the page
  // shows whatever the check would do — "Non risponde" — then the check's own
  // reasons, which leave it at "Nessun dato". A deploy is passing: no reason.
  const checks: Record<string, { active: boolean; skip: UptimeSkip | null }> = {};
  for (const row of rows) {
    const plan = planFor(row, row.status === "running" ? await runningContract(row.id) : null);
    const skip = row.status === "stopped" || row.status === "error" ? "not-running" : row.status === "deploying" ? null : plan.skip;
    checks[row.id] = { active: plan.target !== null, skip };
  }
  const known = new Set(rows.map((row) => row.id));
  const base = await panelBaseUrl(request);
  const path = statusPagePath(config.slug);

  return {
    ...config,
    /** False until the first save: the slug is a fresh proposal, not an address anyone has. */
    saved,
    path,
    url: base ? `${base.origin}${path}` : null,
    checks,
    missing: config.projects.filter((entry) => entry.server === null && !known.has(entry.projectId)).map((entry) => entry.projectId),
  };
}

export async function GET(request: NextRequest) {
  const denied = await requireOwner();
  if (isDenied(denied)) return denied;
  const stored = await readStatusPageConfig();
  return NextResponse.json(await describe(request, stored ?? defaultStatusPageConfig(), stored !== null), NO_STORE);
}

export async function PUT(request: NextRequest) {
  // Read first only to name the entry in the activity log — switching the page
  // on is the event worth finding again. The guard below still runs before
  // anything is done with it.
  let raw: unknown = undefined;
  try {
    raw = await request.json();
  } catch {
    /* answered below, once the guard has run */
  }
  const parsed = statusPageSchema.safeParse(raw);
  const wasOn = (await readStatusPageConfig())?.enabled ?? false;
  const turning = parsed.success && parsed.data.enabled !== undefined && parsed.data.enabled !== wasOn ? (parsed.data.enabled ? "on" : "off") : null;

  return withAudit(request, {
    category: "system",
    action: turning === "on" ? "status-page.enable" : turning === "off" ? "status-page.disable" : "status-page.update",
  }, async () => {
    const denied = await requireOwner();
    if (isDenied(denied)) return denied;
    if (raw === undefined) return NextResponse.json({ error: "Richiesta non valida" }, { status: 400 });
    if (!parsed.success) {
      return NextResponse.json({ error: parsed.error.issues[0]?.message ?? "Dati non validi", details: parsed.error.issues }, { status: 400 });
    }

    const current = (await readStatusPageConfig()) ?? defaultStatusPageConfig();
    const cluster = await clusterState();
    const projects = parsed.data.projects
      ? normalizeEntries(
          parsed.data.projects.map((entry) => ({ server: entry.server ?? null, projectId: entry.projectId, name: entry.name })),
          cluster?.selfId ?? null
        )
      : current.projects;

    // Naming this server by its id and by null is the same project twice.
    if (new Set(projects.map(entryKey)).size !== projects.length) {
      return NextResponse.json({ error: "Lo stesso progetto compare due volte" }, { status: 400 });
    }

    if (parsed.data.projects) {
      const localIds = projects.filter((entry) => entry.server === null).map((entry) => entry.projectId);
      const db = await getDb();
      const found = localIds.length
        ? new Set((await db.selectFrom("projects").select("id").where("id", "in", localIds).execute()).map((row) => row.id))
        : new Set<string>();
      const unknown = projects.find((entry) => entry.server === null && !found.has(entry.projectId));
      if (unknown) {
        return NextResponse.json({ error: `Il progetto «${unknown.name}» non esiste su questo server` }, { status: 400 });
      }
      // A project on another server is checked there, when the page is
      // built; here only that the server is one of the cluster.
      const members = new Set((cluster ? await listMembers() : []).map((member) => member.id));
      const stray = projects.find((entry) => entry.server !== null && !members.has(entry.server));
      if (stray) {
        return NextResponse.json({ error: `«${stray.name}» è su un server che non fa parte del cluster` }, { status: 400 });
      }
    }

    const next: StatusPageConfig = {
      enabled: parsed.data.enabled ?? current.enabled,
      slug: parsed.data.slug ?? current.slug,
      title: parsed.data.title ?? current.title,
      message: parsed.data.message ?? current.message,
      allowIndexing: parsed.data.allowIndexing ?? current.allowIndexing,
      projects,
    };
    await writeStatusPageConfig(next);
    return NextResponse.json(await describe(request, next, true), NO_STORE);
  });
}
