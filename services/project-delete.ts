import fs from "fs";
import path from "path";
import { config } from "@/lib/config";
import { getDb, nowIso } from "@/lib/db";
import type { ProjectsTable } from "@/lib/db/schema";
import { deleteGrantsFor } from "@/lib/users";
import { closeGate } from "./access-gate";
import { cancelDeploy, clearQueuedDeploy } from "./deploy-queue";
import { disconnectFromNetwork, removeProjectNetwork } from "./docker-network";
import { removeProjectImages } from "./docker/images";
import { containerMounts, listOwnedVolumes, removeProjectVolumes, removeVolumes } from "./docker/volumes";
import { removeEnvFile } from "./env-file";
import { removePm2Artifacts } from "./process-drivers/pm2-driver";
import { forgetRun } from "./process-drivers/run-log";
import { processLogHub } from "./process-logs";
import { processManager } from "./process-manager";
import { applyLogPath } from "./project-mounts";
import { busyMessage, tryLock } from "./project-lock";
import { removeProjectReleases } from "./project-releases";
import { moveLogPath } from "./project-repo";
import { applyProxy, forgetCertificate } from "./proxy";
import { removeService } from "./service-provisioner";

/**
 * Taking a project off the machine: its process, images, folders, network,
 * addresses and row — and its databases, or not, as asked.
 *
 * Out of the route so the environments can use it too (services/environments.ts):
 * a staging copy or a preview is deleted exactly like any project, which is
 * what guarantees it never touches production — everything here is found by
 * the project's own id or its own slug, matched whole.
 *
 * What happens to its services is the caller's call. `deleteServices: false`
 * detaches them: they live on as standalone services, container and data
 * untouched, filed in the folder the project was in. `true` takes them down
 * with the project, volumes included.
 */

const CANCEL_WAIT_MS = 15_000;

export type DeleteOutcome =
  | { ok: true; volumesRemoved: string[]; servicesKept: number }
  | { ok: false; status: 409; error: string };

export async function deleteProject(project: ProjectsTable, opts: { deleteServices: boolean }): Promise<DeleteOutcome> {
  const db = await getDb();
  const projectId = project.id;
  const { slug } = project;

  // A deploy that went on running would put back a container, an image and a
  // row-less checkout right after they are taken away.
  const deploy = cancelDeploy(projectId);
  if (deploy) {
    await Promise.race([deploy, new Promise((resolve) => setTimeout(resolve, CANCEL_WAIT_MS))]);
  }

  const release = tryLock(projectId, "stop");
  if (!release) return { ok: false, status: 409, error: busyMessage(projectId) };

  try {
    // Drop any follow-up deploy and stop following this project's logs before
    // taking anything apart, so nothing tries to redeploy what we are deleting.
    clearQueuedDeploy(projectId);
    processLogHub.detachAll(projectId);

    // A gate left open would keep holding the public port for a project that no
    // longer exists, and the next thing to claim it would fail to bind for no
    // visible reason.
    await closeGate("project", projectId);

    try {
      // `remove`, not `stop`: a stopped container still references its image, so
      // stopping here would leave both the container and the image on disk.
      await processManager.remove(slug, project.runtime_type);
    } catch { /* ignore */ }

    // Remove every image RunPanel built for this project, not just the one tag
    // the old code knew about — each deploy produces its own immutable tag.
    await removeProjectImages(slug);

    const services = await db
      .selectFrom("services")
      .select(["id", "container_name"])
      .where("project_id", "=", projectId)
      .execute();

    let volumesRemoved: string[] = [];
    let servicesKept = 0;

    if (opts.deleteServices) {
      // Stop and remove every service container linked to this project. The
      // volumes are not passed here: `removeProjectVolumes` below takes them all
      // by label, which is both scoped and complete.
      for (const svc of services) {
        try {
          await removeService(svc.container_name);
        } catch { /* ignore */ }
      }

      // Deleting the services deletes their storage too. Previously the
      // containers went and the named volumes stayed on disk forever, invisible
      // and ready to silently reattach to a future service with the same name.
      volumesRemoved = await removeProjectVolumes(slug);
    } else {
      // Detach, the same way the services PATCH does it: off the project's
      // network, injection off (there is no app left to inject into), and into
      // the project's folder so it stays where it was on the Overview. Written
      // before the project row goes, because `services.project_id` cascades on
      // delete and would otherwise take these rows with it. The volumes stay
      // labelled with this project's slug; `removeService` finds them through
      // the container's mounts when the standalone service is deleted later.
      const inUse = new Set<string>();
      for (const svc of services) {
        for (const mount of await containerMounts(svc.container_name)) {
          if (mount.name) inUse.add(mount.name);
        }
        await disconnectFromNetwork(svc.container_name, slug);
      }
      if (services.length > 0) {
        await db
          .updateTable("services")
          .set({ project_id: null, inject_env: 0, folder_id: project.folder_id, updated_at: nowIso() })
          .where("project_id", "=", projectId)
          .execute();
      }
      servicesKept = services.length;

      // A volume of this project that no surviving service mounts belongs to a
      // service deleted "without data", kept for one recreated under the same
      // name in this project. That name includes the slug, so with the project
      // gone nothing can ever be recreated onto it: it would sit on the host
      // forever, labelled with a project no screen shows. Removed here, and only
      // here — the kept services' volumes are exactly the ones excluded.
      const orphaned = (await listOwnedVolumes({ project: slug }))
        .map((v) => v.name)
        .filter((name) => !inUse.has(name));
      volumesRemoved = await removeVolumes(orphaned);
    }

    // Delete project source.
    //
    // Asynchronously, because this tree contains `node_modules`: the synchronous
    // version walked a hundred thousand files with the event loop stopped, so
    // deleting one project froze the whole panel — every other tab, every poll,
    // every running deploy's log stream — for as long as it took.
    const repoDir = path.join(config.reposDir, slug);
    await fs.promises.rm(repoDir, { recursive: true, force: true });
    // And every version folder of a native project, which only links to it.
    await removeProjectReleases(slug);

    // Delete generated PM2 files, including the 0600 sidecar holding the
    // project's environment and the process logs, plus the marker saying when the
    // last run began.
    removePm2Artifacts(slug);
    forgetRun(slug);
    removeEnvFile(slug);
    fs.rmSync(moveLogPath(projectId), { force: true });
    fs.rmSync(applyLogPath(projectId), { force: true });

    try {
      await removeProjectNetwork(slug);
    } catch { /* ignore */ }

    // Read before the delete cascades them away: nginx still has their blocks.
    const hostnames = (
      await db.selectFrom("project_hosts").select("hostname").where("project_id", "=", projectId).execute()
    ).map((row) => row.hostname);

    // Child rows go with the parent: the schema declares ON DELETE CASCADE on
    // deployments, env_vars, services, webhook_deliveries and project_hosts, so
    // a single delete is enough — no hand-rolled ordering to get wrong.
    await db.deleteFrom("projects").where("id", "=", projectId).execute();
    await deleteGrantsFor("project", projectId);

    if (hostnames.length > 0) {
      void applyProxy().then(() => hostnames.forEach(forgetCertificate));
    }

    return { ok: true, volumesRemoved, servicesKept };
  } finally {
    release();
  }
}
