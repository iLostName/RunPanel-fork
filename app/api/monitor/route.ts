import { NextResponse } from "next/server";
import { isDenied, requirePermission } from "@/lib/auth-guard";
import { getDb } from "@/lib/db";
import { processManager } from "@/services/process-manager";
import { containerStats, dockerSnapshot, type DockerSnapshot } from "@/services/docker/stats";
import { isDockerAvailable } from "@/services/docker/cli";
import { composeProjectName } from "@/services/docker/compose";
import { LABEL_MANAGED, appContainerName, foreignOwner, type ContainerRow } from "@/services/docker/labels";
import { hostMetrics } from "@/services/host-metrics";
import { serviceDisplayName } from "@/lib/service-name";
import { appProcessInfo, stackProcessInfo } from "@/lib/docker-snapshot";
import { isReservedSlug } from "@/lib/project-slug";

const NO_CONTAINERS: DockerSnapshot = { rows: [], facts: new Map() };

/** Stamped by compose on every container of a stack: the service it runs. */
const COMPOSE_SERVICE = "com.docker.compose.service";

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

function stackRows(slug: string, { rows }: DockerSnapshot): ContainerRow[] {
  const stack = composeProjectName(slug);
  return rows.filter((row) => row.composeProject === stack && !row.oneOff);
}

function composeProject(slug: string, snapshot: DockerSnapshot) {
  return stackProcessInfo(stackRows(slug, snapshot), containerStats.get);
}

/**
 * Each container of a stack on its own row: a stack of five that uses 2 GB
 * says nothing about which of the five to look at.
 */
function stackContainers(slug: string, snapshot: DockerSnapshot) {
  return stackRows(slug, snapshot).map((row) => {
    const name = row.names[0] ?? "";
    const stats = row.state === "running" ? containerStats.get(name) : null;
    return {
      name,
      service: row.labels[COMPOSE_SERVICE] ?? name,
      state: row.state,
      cpu: stats?.cpu,
      memory: stats?.memory,
    };
  });
}

/**
 * Containers on this host that are not the panel's: started by hand, by
 * another tool, by a compose file the panel never saw. Shown so the Monitor
 * accounts for the whole machine — a Monitor that adds up to 40% of the RAM on
 * a host at 95% leaves the operator guessing where the rest went.
 *
 * Not the panel's means: no ownership label, no `runpanel-` name and no stack
 * of a project. A leftover of a deleted project carries the label and is the
 * cleanup's business, not an "other" container.
 */
function otherContainers(snapshot: DockerSnapshot, known: ReadonlySet<string>, stacks: ReadonlySet<string>) {
  return snapshot.rows
    .filter((row) => {
      if (row.labels[LABEL_MANAGED]) return false;
      if (row.composeProject && (stacks.has(row.composeProject) || row.composeProject.startsWith("runpanel-"))) return false;
      return !row.names.some((name) => known.has(name) || name.startsWith("runpanel-"));
    })
    .map((row) => {
      const name = row.names[0] ?? "";
      const stats = row.state === "running" ? containerStats.get(name) : null;
      return {
        name,
        state: row.state,
        stack: row.composeProject || null,
        cpu: stats?.cpu,
        memory: stats?.memory,
      };
    });
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
  // Nothing of the panel's to ask about on a host that runs only native
  // processes — but its Docker may still run containers of its own, and the
  // Monitor lists those too. `isDockerAvailable` is cached, so a machine with
  // no Docker at all pays one failed call every thirty seconds, not one per poll.
  const needsDocker = names.length > 0 || projects.some((p) => isActive(p) && p.runtime_type === "compose");
  const snapshot = needsDocker || (await isDockerAvailable()) ? await dockerSnapshot(names) : NO_CONTAINERS;

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
        // Compose only, and only while it is up: a stopped stack has no usage to split.
        ...(p.runtime_type === "compose" && isActive(p) ? { containers: stackContainers(p.slug, snapshot) } : {}),
      };
    })
  );

  // Services with no project used to be filtered out of this query entirely, so
  // a standalone database had no CPU or memory row anywhere in the panel.
  const standaloneServices = services.filter((s) => !s.project_id).map(enrich);

  const known = new Set([...services.map((s) => s.container_name), ...projects.map((p) => appContainerName(p.slug))]);
  const stacks = new Set(projects.map((p) => composeProjectName(p.slug)));

  return NextResponse.json(
    {
      server,
      projects: projectStats,
      services: standaloneServices,
      others: otherContainers(snapshot, known, stacks),
    },
    { headers: { "Cache-Control": "no-store" } }
  );
}
