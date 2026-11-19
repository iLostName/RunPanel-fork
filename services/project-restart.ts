import fs from "fs";
import { getDb, nowIso } from "@/lib/db";
import { config } from "@/lib/config";
import { relocatedArtifactDir, relocatedReleaseDir, relocatedStartCmd } from "@/lib/artifact-dir";
import { decrypt } from "@/lib/crypto";
import { parseContractJson } from "@/lib/deploy-contract";
import { envFileEntry } from "@/lib/releases";
import { activateRelease, clearCurrentRelease, releaseOfArtifact } from "./project-releases";
import { repairLinks } from "./releases-fs";
import { listenPort, readAccess } from "@/lib/access-columns";
import { processManager } from "./process-manager";
import { buildStartOpts } from "./start-opts";
import { injectLinkedServiceEnv } from "./service-injection";
import { composeContext } from "./docker/compose";
import { composeNetworkMode, planComposeNetwork } from "./compose-network";
import { projectEvents } from "./events";
import { checkLoopbackLeak, forgetLeak, syncGate } from "./access";
import { getRepoPath } from "./git-manager";
import { writeEnvFileInto } from "./env-file";
import { busyMessage, DEPLOYING_MESSAGE, tryLock } from "./project-lock";
import type { ProjectsTable } from "@/lib/db/schema";

export { DEPLOYING_MESSAGE };

/**
 * Start a project again from its last successful build.
 *
 * Extracted because there were two ways to reach it and only one of them was
 * right. `POST /control` replayed a deployment with nothing but `start_cmd`,
 * `cwd`, `env` and `port`, dropping the whole contract: a project deployed with
 * `network: host` came back on the project network, one with bind mounts came
 * back without them, and a `restartPolicy` of `no` came back as
 * `unless-stopped`. Pressing Restart quietly changed how the app ran.
 *
 * Restricting a port needs exactly this operation — the listener has to move —
 * so rather than add a second lossy copy, both go through here.
 *
 * Takes the project's lock, so a deploy cannot start in the middle of this and
 * have its claim overwritten by the status written at the end. A caller that
 * already holds the lock says so with `underLock`.
 */
/**
 * Whether the app is up, for an operation about to take it down and bring it back.
 *
 * `error` is what a failed deploy leaves, usually with the previous version still
 * serving, so the row alone cannot say. Taken for stopped, that app would go down
 * and stay down.
 */
export async function appIsUp(project: Pick<ProjectsTable, "slug" | "status" | "runtime_type">): Promise<boolean> {
  if (project.status === "running") return true;
  if (project.status !== "error") return false;
  return processManager.status(project.slug, project.runtime_type).then(
    (info) => info.running || info.partlyUp === true,
    () => false
  );
}

export async function restartFromLastDeployment(
  projectId: string,
  opts: { underLock?: boolean } = {}
): Promise<{ success: true } | { error: string }> {
  if (opts.underLock) return restart(projectId);

  const release = tryLock(projectId, "restart");
  if (!release) return { error: busyMessage(projectId) };
  try {
    return await restart(projectId);
  } finally {
    release();
  }
}

async function restart(projectId: string): Promise<{ success: true } | { error: string }> {
  const db = await getDb();

  const project = await db
    .selectFrom("projects")
    .selectAll()
    .where("id", "=", projectId)
    .executeTakeFirst();

  if (!project) return { error: "Progetto non trovato" };
  if (project.status === "deploying") return { error: DEPLOYING_MESSAGE };

  const lastDeploy = await db
    .selectFrom("deployments")
    .select(["id", "start_cmd", "artifact_dir", "resolved_contract"])
    .where("project_id", "=", projectId)
    .where("status", "in", ["running", "superseded"])
    .where("start_cmd", "is not", null)
    .orderBy("started_at", "desc")
    .limit(1)
    .executeTakeFirst();

  if (!lastDeploy?.start_cmd || !lastDeploy.artifact_dir) {
    return { error: "Non c'è nessun deploy riuscito da riavviare. Fai prima un deploy." };
  }

  // A deploy recorded before the data directory moved still names the old
  // tree. Follow the checkout to where it is now and fix the row, so the next
  // restart does not have to; with no checkout anywhere, say so rather than
  // hand PM2 a cwd it will fail on without a word. A docker project only
  // needs its image, so a missing directory is not a reason to refuse it.
  if (!fs.existsSync(lastDeploy.artifact_dir)) {
    const moved =
      relocatedArtifactDir(lastDeploy.artifact_dir, project.slug, config.reposDir) ??
      relocatedReleaseDir(lastDeploy.artifact_dir, project.slug, config.releasesDir);
    if (moved && fs.existsSync(moved)) {
      const startCmd = relocatedStartCmd(lastDeploy.start_cmd, lastDeploy.artifact_dir, moved);
      await db
        .updateTable("deployments")
        .set({ artifact_dir: moved, start_cmd: startCmd })
        .where("id", "=", lastDeploy.id)
        .execute();
      lastDeploy.artifact_dir = moved;
      lastDeploy.start_cmd = startCmd;
    } else if (project.runtime_type !== "docker") {
      return {
        error: `La cartella dell'ultimo deploy non esiste più (${lastDeploy.artifact_dir}). Fai un nuovo deploy.`,
      };
    }
  }

  const envRows = await db
    .selectFrom("env_vars")
    .select(["key", "value"])
    .where("project_id", "=", projectId)
    .execute();

  const envVars: Record<string, string> = {};
  for (const row of envRows) {
    envVars[row.key] = decrypt(row.value);
  }

  /*
    The contract this project was actually deployed with, not the panel's half
    of it.

    `builder_config` deliberately stores only what the operator set, so that a
    repository's `runpanel.json` can still contribute — which means reading it
    alone here dropped every value that came from the repository or the
    detected preset. A restart moved the app off `network: host`, took away its
    memory limit and unmounted its env file, silently, and the deploy that
    followed put them all back. Deploys record the merged result now; NULL is a
    row written before they did, and falling back is better than refusing to
    restart an app that is running fine.
  */
  const contract = lastDeploy.resolved_contract
    ? parseContractJson(lastDeploy.resolved_contract)
    : parseContractJson(project.builder_config);

  // The same connection strings a deploy injects, for the same reason. Without
  // this a restart handed the app whatever `DATABASE_URL` happened to be stored
  // on the project — a stale one, or none — while the identical app came back
  // correctly configured from a deploy. Every project restored after a reboot
  // goes through here, so the divergence surfaced as "it worked yesterday".
  //
  // A compose stack decides its viewpoint from its own file — entirely on
  // `network_mode: host` it reaches a service on localhost — so the file is
  // read again here, the way the deploy read it, rather than trusting the
  // contract's network mode, which compose never uses.
  let injectionNetwork: string = contract.docker.network;
  if (project.runtime_type === "compose") {
    const ctx = composeContext(project.slug, lastDeploy.artifact_dir);
    if (ctx) injectionNetwork = composeNetworkMode(await planComposeNetwork(ctx, envVars));
  }
  await injectLinkedServiceEnv(project, injectionNetwork, envVars);

  // Same rule as the deploy: a container project without a port publishes
  // nothing. Falling back to 3000 here injected PORT=3000 and -p 3000:3000.
  const port = project.port ?? (project.runtime_type === "docker" || project.runtime_type === "compose" ? 0 : 3000);
  const access = readAccess(project);

  // The gate holds the public port. It has to let go before the app can take it
  // back, and it is reopened below once the app is on the loopback port.
  const { closeGate } = await import("./access-gate");
  await closeGate("project", projectId);

  /*
    Deployed without downtime, the container goes back where nginx points:
    the same loopback port, so a restart (by hand, scheduled, after a crash, a
    bind apply) is a brief gap rather than a new address. Not under the
    panel's IP gate, which forwards to one listener of its own: restricting
    the project takes it back to the ordinary publishing, and nginx with it.
  */
  const livePort =
    project.runtime_type === "docker" && access.mode !== "restricted" && project.live_port ? project.live_port : undefined;

  const startOpts = buildStartOpts({
    project,
    contract,
    envVars,
    cwd: lastDeploy.artifact_dir,
    port,
    loopbackPort: access.mode === "restricted" ? listenPort(project, port) : undefined,
    livePort,
    // Labelled like a deploy's: at boot, the container of the deployment the
    // store calls online is the one that stays (lib/zero-downtime.ts).
    deploymentId: lastDeploy.id,
  });

  /*
    A deploy that built into a version folder of its own is started there
    again — that folder is what `artifact_dir` names — and becomes the current
    one, which is how a rollback puts the previous version back: the folder
    the file manager and the scheduled tasks follow moves with it.

    Its links into the project folder are checked first. That finishes a hand-
    over a panel restart cut short, and gives the version anything the project
    folder gained since it was made. Best effort: a version that ran yesterday
    can run today without it.
  */
  const release = project.runtime_type === "docker" ? null : releaseOfArtifact(project.slug, lastDeploy.artifact_dir);
  if (release) {
    try {
      await repairLinks({ dir: release.dir, checkout: getRepoPath(project.slug), envFile: envFileEntry(contract.envFile) });
    } catch (err) {
      console.warn(`[restart] ${project.slug}: links of release ${release.id} not checked:`, err instanceof Error ? err.message : err);
    }
  }

  // Rewritten on every start, as the container side already is: left to the
  // deploy alone, the file keeps a variable the operator has since deleted, and
  // a dotenv loader in the app brings it back. Same content a deploy writes,
  // into the folder the app runs from.
  if (contract.envFile.enabled && project.runtime_type !== "docker") {
    writeEnvFileInto(release?.dir ?? getRepoPath(project.slug), contract.envFile.path, startOpts.env ?? {});
  }

  if (release) {
    try {
      activateRelease(project.slug, release.id);
    } catch (err) {
      console.warn(`[restart] ${project.slug}: release ${release.id} not marked as current:`, err instanceof Error ? err.message : err);
    }
  } else if (project.runtime_type !== "docker" && project.runtime_type !== "compose") {
    // A deploy that built in place starts from the project folder — after the
    // first deploy into a version folder failed, say — so no version folder is
    // the current one any more, whatever was left pointing at one.
    try {
      clearCurrentRelease(project.slug);
    } catch {
      /* nothing was current */
    }
  }

  // The driver empties the process output before launching, so tell any open
  // viewer to do the same rather than leave it showing the previous run.
  projectEvents.emit(projectId, { type: "process:reset" });

  await processManager.start(project.slug, lastDeploy.start_cmd, project.runtime_type, startOpts);

  // A live port the start did not use no longer leads anywhere.
  const leftLivePort = project.live_port !== null && livePort === undefined;

  await db
    .updateTable("projects")
    .set({ status: "running", crashed_at: null, updated_at: nowIso(), ...(leftLivePort ? { live_port: null } : {}) })
    .where("id", "=", projectId)
    .execute();

  if (leftLivePort) {
    const { applyProxySoon } = await import("./proxy");
    applyProxySoon();
  }

  // After the app, never before: while the old process still holds the public
  // port, binding it is an EADDRINUSE rather than a gate.
  await syncGate("project", projectId, project, { publicPort: project.port, label: project.name });

  if (access.mode === "restricted" && access.port) {
    // Not awaited: it takes a few seconds by design, and the answer is a notice
    // on a page, not something the restart has to wait for.
    void checkLoopbackLeak(projectId, access.port);
  } else {
    forgetLeak(projectId);
  }

  return { success: true };
}
