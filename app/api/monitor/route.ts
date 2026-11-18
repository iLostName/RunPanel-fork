import { NextResponse } from "next/server";
import { isDenied, requirePermission } from "@/lib/auth-guard";
import { getDb } from "@/lib/db";
import { processManager } from "@/services/process-manager";
import { containerStats, dockerSnapshot, type DockerSnapshot } from "@/services/docker/stats";
import { composeProjectName } from "@/services/docker/compose";
import { appContainerName, foreignOwner } from "@/services/docker/labels";
import { hostMetrics } from "@/services/host-metrics";
import { serviceDisplayName } from "@/lib/service-name";
import { appProcessInfo, stackProcessInfo } from "@/lib/docker-snapshot";
import { isReservedSlug } from "@/lib/project-slug";

const NO_CONTAINERS: DockerSnapshot = { rows: [], facts: new Map() };

/**
 * A Docker project, answered from the snapshot.
 *
 * The monitor page polls this route every 3 seconds, and asking each driver cost
 * a `docker inspect` per Docker project and a `docker compose ps` per stack on
 * every poll. Uptime is not in the stats stream, so an inspect is still needed;
 * `docker inspect` takes any number of names, so one spawn answers for all.
 */
function dockerProject(slug: string, { rows, facts }: DockerSnapshot) {
  const name = appContainerName(slug);
  const row = rows.find((candidate) => candidate.names.includes(name));
  // The driver answers the same for a name that belongs to something else.
  if (!row || foreignOwner(slug, row.labels, isReservedSlug(slug))) return { running: false };

  return appProcessInfo(facts.get(name), containerStats.get(name));
}

function composeProject(slug: string, { rows }: DockerSnapshot) {
  const stack = composeProjectName(slug);
  return stackProcessInfo(
    rows.filter((row) => row.composeProject === stack && !row.oneOff),
    containerStats.get
  );
}

export async function GET() {
  const denied = await requirePermission("monitor");
  if (isDenied(denied)) return denied;

  const db = await getDb();
  void containerStats.ensureStarted();

  const [server, projects, services] = await Promise.all([
    hostMetrics(),
    db
      .selectFrom("projects")
      .select(["id", "name", "slug", "runtime_type", "status", "port"])
      .orderBy("name")
      .execute(),
    db.selectFrom("services").selectAll().execute(),
  ]);

  const isActive = (p: (typeof projects)[number]) => p.status === "running" || p.status === "deploying";
  const names = [
    ...services.filter((s) => s.status === "running").map((s) => s.container_name),
    ...projects.filter((p) => isActive(p) && p.runtime_type === "docker").map((p) => appContainerName(p.slug)),
  ];
  // Nothing to ask on a panel that runs only native processes, which may well
  // be a machine with no Docker at all.
  const needsDocker = names.length > 0 || projects.some((p) => isActive(p) && p.runtime_type === "compose");
  const snapshot = needsDocker ? await dockerSnapshot(names) : NO_CONTAINERS;

  /** Resource usage for one service, whether or not it belongs to a project. */
  function enrich(s: (typeof services)[number]) {
    const stats = s.status === "running" ? containerStats.get(s.container_name) : null;
    const uptime = s.status === "running" ? snapshot.facts.get(s.container_name)?.uptime : undefined;

    return {
      id: s.id,
      name: serviceDisplayName(s),
      type: s.type,
      status: s.status,
      port: s.port,
      uptime,
      memory: stats?.memory,
      cpu: stats?.cpu,
    };
  }

  const projectStats = await Promise.all(
    projects.map(async (p) => {
      let processInfo = null;
      if (isActive(p)) {
        try {
          if (p.runtime_type === "docker") processInfo = dockerProject(p.slug, snapshot);
          else if (p.runtime_type === "compose") processInfo = composeProject(p.slug, snapshot);
          else processInfo = await processManager.status(p.slug, p.runtime_type);
        } catch {
          /* a driver that cannot answer is reported as no process info */
        }
      }

      const enrichedServices = services.filter((s) => s.project_id === p.id).map(enrich);

      return {
        id: p.id,
        name: p.name,
        slug: p.slug,
        runtimeType: p.runtime_type,
        status: p.status,
        port: p.port,
        process: processInfo,
        services: enrichedServices,
      };
    })
  );

  // Services with no project used to be filtered out of this query entirely, so
  // a standalone database had no CPU or memory row anywhere in the panel.
  const standaloneServices = services.filter((s) => !s.project_id).map(enrich);

  return NextResponse.json(
    { server, projects: projectStats, services: standaloneServices },
    { headers: { "Cache-Control": "no-store" } }
  );
}
