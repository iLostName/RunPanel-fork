import { getDb, nowIso } from "@/lib/db";
import type { DeploymentsTable, ProjectsTable } from "@/lib/db/schema";
import { decrypt } from "@/lib/crypto";
import { redactGitSecrets } from "@/lib/redact";
import { stripRemoteCredentials } from "@/lib/git-remote";
import { openBuildEnv } from "./build-env";
import {
  cleanKeepingTracked,
  gitPull,
  gitClone,
  gitCheckoutCommit,
  repoExists,
  getRepoPath,
  getLatestCommit,
} from "./git-manager";
import { buildProject } from "./builder-registry";
import { processManager } from "./process-manager";
import { isWindows } from "./env-utils";
import { runReleaseCommand, waitForHealthy } from "./deploy-steps";
import {
  claimForDeploy,
  releaseUnrun,
  runPhase,
  type PhaseContext,
} from "./one-time-commands";
import { notify } from "./notify";
import { shouldAnnounceDeploy, type DeployTrigger } from "./notify/messages";
import { writeEnvFileInto } from "./env-file";
import { buildStartOpts } from "./start-opts";
import { detectPreset, readRepoContract, RUNPANEL_CONFIG_FILE } from "./deploy-presets";
import {
  detectedPresetLayer,
  parseContractJson,
  preflight,
  resolveContract,
  resolveContractJson,
  safeJsonReviver,
  selectBuildEnv,
  stripPanelOnlyFields,
} from "@/lib/deploy-contract";
import { checkLoopbackLeak, listenPort, readAccess, syncGate } from "./access";
import { closeGate } from "./access-gate";
import { injectLinkedServiceEnv } from "./service-injection";
import { alignServiceNames } from "./service-rename";
import { maskUrlPassword } from "@/lib/service-env";
import { composeContext } from "./docker/compose";
import { markCurrentImage } from "./docker/images";
import { imageRepo, networkName } from "./docker/labels";
import {
  applyComposeNetwork,
  composeNetworkMode,
  planComposeNetwork,
  type ComposeNetworkPlan,
} from "./compose-network";
import { sweep } from "./docker/gc";
import { restartFromLastDeployment } from "./project-restart";
import { KEPT_ONLINE_NOTE, ROLLBACK_NOTE } from "@/lib/deploy-explain";
import { decideZeroDowntime, describeBlockers, runZeroDowntimeRelease } from "./zero-downtime";
import { applyProxySoon } from "./proxy";
import { envFileEntry, releaseMode, rollbackPlan } from "@/lib/releases";
import { createRelease, freeCheckoutBuildDirs } from "./releases-fs";
import {
  activateRelease,
  currentRelease,
  handOver,
  leaveReleases,
  manifestOf,
  previousGoodRelease,
  projectWorkDir,
  pruneReleases,
  releasesRoot,
  type ReleaseRef,
} from "./project-releases";
import { BuildLogFile } from "./build-logs";
import { projectEvents } from "./events";
import path from "path";
import fs from "fs";

type Project = ProjectsTable;

interface DeployOptions {
  onLog?: (line: string) => void;
  mode?: "deploy" | "rebuild";
  /** Aborted when the operator stops the deploy. */
  signal?: AbortSignal;
}

const CANCELLED_MESSAGE = "Deploy interrotto dall'operatore";

/** The panel's own column as written, before any default fills it in. */
function parsePanelConfig(json: string | null): unknown {
  try {
    return JSON.parse(json ?? "{}", safeJsonReviver);
  } catch {
    return {};
  }
}

/** Directories wiped by a rebuild, by runtime. */
const REBUILD_CLEAN_DIRS: Record<string, string[]> = {
  node: [".next", "node_modules", "dist", "build", ".turbo"],
  static: ["dist", "build"],
  custom: ["venv", "__pycache__", "dist", "build"],
  docker: [],
  compose: [],
};

/**
 * Runtimes whose build writes into the same directory the app runs from —
 * unless it gets a release folder of its own (lib/releases.ts), which is never
 * the case on Windows.
 *
 * Docker and Compose build an image instead, so a running container holds
 * nothing on the host and the old instance can stay up through the build.
 */
const IN_PLACE_BUILD_RUNTIMES = new Set(["node", "static", "custom"]);

/**
 * Deploys are started with `void executeDeploy(...)` — nothing awaits them, so
 * this must never reject. An unhandled rejection here would take down the whole
 * panel, not just the deploy.
 */
export async function executeDeploy(
  project: Project,
  deploymentId: string,
  opts: DeployOptions = {}
): Promise<void> {
  try {
    await runDeploy(project, deploymentId, opts);
    await announce(project, deploymentId);
  } catch (err) {
    // Only reachable if the store itself is unavailable — runDeploy handles
    // every failure it can still record.
    console.error(`[deploy] Unrecoverable error for deployment ${deploymentId}:`, err);
  }
}

/**
 * Tell somebody how it went.
 *
 * Out here rather than at the two points inside `runDeploy` that write the
 * final status, and reading the row back rather than being handed the facts:
 * by this line the deployment row already holds every one of them — outcome,
 * trigger, commit, and both timestamps — so a second copy of that bookkeeping
 * would only be a second thing to keep in step. It also means the two exits
 * cannot disagree about what a finished deploy is.
 *
 * Never throws. A notification that cannot be sent is not a deploy that failed.
 */
async function announce(project: Project, deploymentId: string): Promise<void> {
  try {
    const db = await getDb();
    const row = await db
      .selectFrom("deployments")
      .select([
        "status",
        "trigger_type",
        "commit_sha",
        "commit_message",
        "started_at",
        "finished_at",
        "error_message",
      ])
      .where("id", "=", deploymentId)
      .executeTakeFirst();

    if (!row || (row.status !== "running" && row.status !== "failed")) return;

    const ok = row.status === "running";
    const trigger = (row.trigger_type ?? "manual") as DeployTrigger;
    if (!shouldAnnounceDeploy(trigger, ok)) return;

    const started = Date.parse(row.started_at ?? "");
    const finished = Date.parse(row.finished_at ?? "");

    void notify({
      key: "deploy.finished",
      slug: project.slug,
      ok,
      trigger,
      commitSha: row.commit_sha,
      commitMessage: row.commit_message,
      durationMs:
        Number.isFinite(started) && Number.isFinite(finished) ? finished - started : null,
      error: row.error_message,
    });
  } catch (err) {
    console.error("[deploy] Notifica dell'esito non riuscita:", err);
  }
}

async function runDeploy(
  project: Project,
  deploymentId: string,
  opts: DeployOptions
): Promise<void> {
  const db = await getDb();
  const externalLog = opts.onLog;
  const mode = opts.mode ?? "deploy";
  const logFile = new BuildLogFile(deploymentId);

  // The row is a record of intent, and it drifts from reality: a deploy that
  // starts the app and then fails its health check records "error"/"stopped"
  // while the process it started is still online. Only the driver knows what is
  // running — but asking costs a pm2 spawn, so it is asked only where believing
  // the row actually breaks something.
  //
  // That is Windows. There, a rebuild that skips its stop then walks into
  // `rm -rf node_modules` and cannot remove a directory holding a mapped native
  // addon:
  //
  //   EPERM, Permission denied: …\data\repos\spanel\node_modules
  //
  // Elsewhere an open file is no obstacle to unlinking it, so a stale row costs
  // at most a stop that no-ops — not worth a spawn on every deploy.
  let wasRunning = project.status === "running";
  if (isWindows) {
    try {
      wasRunning = (await processManager.status(project.slug, project.runtime_type)).running;
    } catch {
      /* a driver that cannot answer leaves the row's opinion standing */
    }
  }

  // Resolved once the source is on disk, so an in-repo `runpanel.json` can take
  // part. Until then, the panel's settings alone.
  let contract = parseContractJson(project.builder_config);

  // Known only once the source has been fetched, and only interesting to the
  // one-time commands, which record the commit they ran against so the history
  // stays readable after the deployment row has been swept away.
  let commitSha: string | null = null;

  // Set when the failure is the new version not answering, which is the one
  // failure the previous version can stand in for (the rollback below).
  let healthFailed = false;

  // Set once this deploy goes without downtime (lib/zero-downtime.ts): the
  // version online is not stopped, and a failure before the switch leaves it
  // exactly as it was — so there is nothing for the rollback to bring back.
  let zeroDowntime = false;
  // Set when that sequence began: from there, a failure says the version
  // online stayed online, which it did.
  let zeroDowntimeStarted = false;

  /*
    Where the version being deployed lives. Until the source is resolved, the
    version that runs now: its release folder, or the project folder. From
    then on, the folder this deploy builds in — its own release folder when
    the project has one (lib/releases.ts), the project folder otherwise.
  */
  let deployDir = projectWorkDir(project.slug);
  let release: ReleaseRef | null = null;
  // A project going back to building in place hands its last version's data
  // to the project folder; its version folders are removed once that worked.
  let leftReleases = false;

  async function updateDeployment(fields: Partial<DeploymentsTable>) {
    await db.updateTable("deployments").set(fields).where("id", "=", deploymentId).execute();
    if (fields.status) {
      projectEvents.emit(project.id, {
        type: "deploy:status",
        deploymentId,
        status: fields.status,
        message: fields.error_message ?? undefined,
      });
    }
  }

  /**
   * One call sends a line three places: the optional in-process callback, the
   * on-disk log, and every browser watching this project. Publishing here is
   * what makes a deploy visible while it happens rather than only afterwards.
   */
  function appendLog(line: string) {
    externalLog?.(line);
    logFile.append(line);
    projectEvents.emit(project.id, { type: "deploy:log", deploymentId, line });
  }

  const label = mode === "rebuild" ? "Re-Build" : "Deploy";

  // Between steps. The long ones listen to the signal themselves; this is what
  // keeps a stop from being followed by the next step of a deploy that is over.
  const { signal } = opts;
  const checkpoint = () => {
    if (signal?.aborted) throw new Error(CANCELLED_MESSAGE);
  };

  // The environment of whatever runs on the host while the app itself runs in
  // containers: see the compose branch below. Null when that is the same one.
  let commandEnv: Record<string, string> | null = null;

  try {
    await updateDeployment({ status: "building" });
    appendLog(`=== ${label} started ===`);

    /*
      The environment is read here rather than after the contract, which is
      where it used to sit. Nothing between the two points depends on it —
      only the service injection below does, and that stays where it is
      because it needs the contract's network. Moving it up is what lets a
      `pre-deploy` command see the project's own variables, which is half the
      reason to put a command there at all: a dump, an authenticated call, a
      notification.
    */
    const envRows = await db
      .selectFrom("env_vars")
      .select(["key", "value"])
      .where("project_id", "=", project.id)
      .execute();

    appendLog(`Loaded ${envRows.length} env var(s)`);

    const envVars: Record<string, string> = {};
    for (const row of envRows) {
      envVars[row.key] = decrypt(row.value);
    }

    // Container runtimes publish whatever their own definition says, so an
    // unset port means "no HTTP probe" rather than "assume 3000".
    const isContainerRuntime = project.runtime_type === "docker" || project.runtime_type === "compose";
    const port = project.port ?? (isContainerRuntime ? 0 : 3000);
    if (port > 0) {
      envVars.PORT = port.toString();
    }
    if (!envVars.NODE_ENV) {
      envVars.NODE_ENV = "production";
    }

    const isDockerApp = project.runtime_type === "docker";

    /*
      Take the project's one-time commands for this deploy, all of them, now.

      Claiming once at the top rather than per phase is the point: the queue a
      deploy runs is the queue as it stood when the deploy started, so a
      command added while it is running belongs to the next one and cannot be
      run twice. Whatever is never reached goes back in the `finally`.
    */
    const oneTime = await claimForDeploy(project, deploymentId, appendLog);

    /*
      `contract`, `envVars` and `commitSha` are read at call time rather than
      captured: the contract is still being resolved when the first phase
      runs, and the commit is not known until the source has been fetched.

      `projectDir` is the folder of the version being deployed in every phase
      (`deployDir`: its release folder when it has one) — deliberately not the
      artifact directory. For a static project the two differ, and a one-time
      chore belongs to the project rather than to the folder that ends up
      being served.
    */
    const phaseCtx = (image: string | null): PhaseContext => ({
      runtimeType: project.runtime_type,
      slug: project.slug,
      projectDir: deployDir,
      image,
      env: envVars,
      hostEnv: commandEnv ?? undefined,
      contract,
      commitSha,
      onLog: appendLog,
      signal,
    });

    await runPhase("pre-deploy", oneTime, phaseCtx(null));
    checkpoint();

    /*
      REBUILD in place only: stop + clean first. Run once the contract says
      whether this deploy builds in place: a version folder starts empty, so
      there is nothing to clean, and the running app can stay up until the
      switch.
    */
    const cleanForRebuild = async () => {
      if (wasRunning) {
        appendLog("--- Stopping process for clean rebuild ---");
        try {
          await processManager.stop(project.slug, project.runtime_type);
          appendLog("Process stopped.");
        } catch {
          appendLog("No process to stop.");
        }
      }

      // An uploaded project has no remote to get these back from: its dist/ or
      // build/ may be the prebuilt site itself, and deleting it is final.
      const cleanDirs = project.source_type === "upload" ? [] : (REBUILD_CLEAN_DIRS[project.runtime_type] ?? []);
      appendLog(
        project.source_type === "upload"
          ? "\n--- Build artifacts kept: an uploaded project has no other copy of them ---"
          : "\n--- Cleaning build artifacts ---"
      );
      const cleanDir = getRepoPath(project.slug);
      for (const dir of cleanDirs) {
        const fullPath = path.join(cleanDir, dir);
        if (fs.existsSync(fullPath)) {
          try {
            if (await cleanKeepingTracked(cleanDir, dir)) {
              appendLog(`Cleaned ${dir}/ (files tracked by git kept)`);
              continue;
            }
            fs.rmSync(fullPath, { recursive: true, force: true });
          } catch (err: unknown) {
            // Windows only: there EPERM/EBUSY on a directory means something
            // has it open, and `force: true` does not help — raw, the error
            // reads as a permissions problem and sends you to check ACLs. On
            // POSIX the same codes really are about permissions, so rewriting
            // the message there would only mislead.
            const code = (err as NodeJS.ErrnoException).code;
            if (isWindows && (code === "EPERM" || code === "EBUSY" || code === "EACCES")) {
              throw new Error(
                `Cannot remove ${dir}/: a process still has it open. ` +
                  `On Windows a running app locks its native modules, so stop anything ` +
                  `using ${cleanDir} — including editors and terminals — and retry.`
              );
            }
            throw err;
          }
          appendLog(`Removed ${dir}/`);
        }
      }
    };

    // Source acquisition — deploy pulls from git, rebuild keeps local files
    const projectDir = getRepoPath(project.slug);

    if (mode === "deploy" && project.source_type === "github" && project.source_url) {
      appendLog("\n--- Fetching source ---");
      if (project.pinned_sha) {
        /*
          The project is held at a commit, so that is what gets built — not the
          head of the branch.

          The row is fresh: the queue re-reads it inside `claim()` before every
          run, including the coalesced follow-up. That is why the pin does not
          need to travel through the request; a webhook delivery that slipped
          through the suspension check would land here and build the pinned
          commit, which is the right outcome rather than a race to lose.
        */
        appendLog(`Restoring commit ${project.pinned_sha.slice(0, 7)} from ${project.source_branch}...`);
        const commit = await gitCheckoutCommit(
          project.slug,
          project.source_branch,
          project.pinned_sha,
          { repoUrl: project.source_url, onLog: appendLog }
        );
        commitSha = commit.sha;
        await updateDeployment({ commit_sha: commit.sha, commit_message: commit.message });
        appendLog(`Commit: ${commit.sha.slice(0, 7)} - ${commit.message}`);
      } else if (repoExists(project.slug)) {
        appendLog(`Pulling latest from ${project.source_branch}...`);
        const commit = await gitPull(project.slug, project.source_branch);
        commitSha = commit.sha;
        await updateDeployment({ commit_sha: commit.sha, commit_message: commit.message });
        appendLog(`Commit: ${commit.sha.slice(0, 7)} - ${commit.message}`);
      } else {
        appendLog(`Cloning ${stripRemoteCredentials(project.source_url)}...`);
        await gitClone(project.source_url, project.source_branch, project.slug);
        const commit = await getLatestCommit(project.slug);
        commitSha = commit.sha;
        await updateDeployment({ commit_sha: commit.sha, commit_message: commit.message });
        appendLog(`Cloned at: ${commit.sha.slice(0, 7)} - ${commit.message}`);
      }
    }

    checkpoint();

    // A project whose source was never fetched has no directory on disk, and
    // every step from here on would run against a path that is not there. On
    // Windows that surfaces as `spawn cmd.exe ENOENT` — an error that points at
    // the shell instead of the cause — so say what is actually missing.
    if (!fs.existsSync(projectDir)) {
      throw new Error(
        project.source_type === "github" && !project.source_url
          ? "No repository configured. Open the project's Source settings, set a GitHub URL, then deploy."
          : "No source on disk for this project. Connect a GitHub repository or upload a ZIP, then deploy."
      );
    }

    /*
      What this deploy builds from. A deploy builds what it just fetched into
      the project folder. A rebuild fetches nothing and rebuilds the version
      that runs now: with version folders that is the current one, which also
      holds any edit made from the file manager, and which may be on an older
      commit than the project folder after a deploy that failed and went back.
    */
    const sourceDir = mode === "rebuild" ? projectWorkDir(project.slug) : projectDir;

    // Now that the source is on disk, work out the rest of the contract.
    //
    // Precedence, lowest first: a preset detected from the repository's shape,
    // then the repository's own runpanel.json, then whatever the operator set.
    // The detected preset is what lets a project with no configuration at all
    // deploy anyway.
    // The repository's contract is untrusted input: it arrives with whatever
    // was pushed. Strip the fields that would let it reach outside its own
    // container before it takes part in the merge at all.
    const rawRepoContract = readRepoContract(sourceDir);
    const stripped = rawRepoContract === null ? null : stripPanelOnlyFields(rawRepoContract);
    const repoContract = stripped?.contract ?? null;
    const preset = detectPreset(sourceDir, project.runtime_type);

    if (preset) {
      appendLog(`Detected project shape: ${preset.label}`);
    }

    if (preset || repoContract) {
      const presetLayer =
        preset &&
        detectedPresetLayer(preset.contract, project.runtime_type, {
          panel: parsePanelConfig(project.builder_config),
          repo: repoContract,
        });
      const layers = [presetLayer, repoContract].filter(Boolean);
      let base: unknown = {};
      for (const layer of layers) base = resolveContract(layer as object, base);
      contract = resolveContractJson(project.builder_config, base);

      if (repoContract) {
        appendLog(`Found ${RUNPANEL_CONFIG_FILE} in the repository — merged under the panel settings.`);
      }
      const sealed = stripped?.rejected.filter((field) => field.startsWith("buildEnv.")) ?? [];
      const hostly = stripped?.rejected.filter((field) => !field.startsWith("buildEnv.")) ?? [];
      if (hostly.length > 0) {
        appendLog(
          `Ignored ${hostly.join(", ")} from ${RUNPANEL_CONFIG_FILE}: ` +
            `these grant access to the host and can only be set from the panel.`
        );
      }
      if (sealed.length > 0) {
        appendLog(
          `Ignored ${sealed.join(", ")} from ${RUNPANEL_CONFIG_FILE}: ` +
            `an encrypted value is only ever opened when the panel wrote it.`
        );
      }
    }

    /*
      Without downtime, or the ordinary way. Decided on the resolved contract,
      where the switch can only have come from the panel (`PANEL_ONLY_FIELDS`),
      and on what the store and nginx say now. Asked for and not possible —
      the address removed, nginx down, the health check turned off — the
      deploy is an ordinary one and says why, rather than failing a deploy
      that would work.
    */
    if (isDockerApp && contract.zeroDowntime.enabled) {
      appendLog("\n--- Deploy senza interruzioni ---");
      try {
        const decision = await decideZeroDowntime(project, contract);
        zeroDowntime = decision.blockers.length === 0;
        appendLog(
          zeroDowntime
            ? "La versione online resta accesa: la nuova parte accanto, e nginx passa a lei solo quando risponde."
            : `Non si applica a questo deploy, che sarà un deploy normale: ${describeBlockers(decision.blockers)}`
        );
      } catch (err) {
        appendLog(`Non verificabile (${err instanceof Error ? err.message : String(err)}): deploy normale.`);
      }
    }

    /*
      A folder of its own for this version, or the project folder as before.

      Decided here, on the resolved contract, because the automatic return is
      what switches it — together with the native opt-in, off unless the
      operator turned it on, and which a repository cannot set for itself
      (`PANEL_ONLY_FIELDS`). Off, a native project builds in place exactly as
      it always did. Made before the env file, the post-source commands and
      the build, which all run in it. Nothing has been stopped yet, so a
      version folder that cannot be made fails a deploy that cost nothing.
    */
    const releases = releaseMode({
      runtimeType: project.runtime_type,
      platform: process.platform,
      sourceType: project.source_type,
      gitCheckout: repoExists(project.slug),
      rollbackEnabled: contract.rollback.enabled,
      nativeEnabled: contract.rollback.native,
    });

    if (releases.on) {
      appendLog("\n--- Release folder ---");
      const previous = currentRelease(project.slug);
      const created = await createRelease({
        id: deploymentId,
        root: releasesRoot(project.slug),
        checkout: projectDir,
        source: sourceDir,
        previous: previous ? { ...previous, manifest: manifestOf(project.slug, previous.id) } : null,
        // A rebuild is a clean one: nothing reused from the version before.
        seed: mode === "deploy",
        envFile: envFileEntry(contract.envFile),
        log: appendLog,
        signal,
      });
      release = { id: created.id, dir: created.dir };
      deployDir = created.dir;
      appendLog(`Building in ${created.dir}`);
    } else {
      deployDir = projectDir;
      // A Docker rebuild has no files to clean (`REBUILD_CLEAN_DIRS`), so the
      // stop is all it would do — and without downtime nothing stops.
      if (mode === "rebuild" && !zeroDowntime) await cleanForRebuild();
    }
    checkpoint();

    // Auto-inject service connection URLs (DB, Redis, etc.).
    //
    // Shared with `restartFromLastDeployment`, which has to produce the same
    // environment: see `services/service-injection.ts` for why they used to
    // differ and what that cost. The rule itself lives in `lib/service-env.ts`
    // as a pure function, so the whole on/off × key-already-defined matrix is
    // testable without a daemon.
    //
    // A compose stack is put on the project network by an override file built
    // from its resolved config (`services/compose-network.ts`). Planned before
    // the injection because the plan is what says whether the stack reaches a
    // service by container name or — entirely on `network_mode: host` — like a
    // native process would.
    let composePlan: ComposeNetworkPlan | null = null;
    const composeCtx = project.runtime_type === "compose" ? composeContext(project.slug, projectDir) : null;
    if (composeCtx) {
      composePlan = await planComposeNetwork(composeCtx, envVars);
    }
    const injectionNetwork = composeCtx ? composeNetworkMode(composePlan) : contract.docker.network;

    // Services the operator renamed take their new container name here, before
    // the environment is built from `container_name` — so the app is started
    // with the new host. See `services/service-rename.ts`; it never fails the
    // deploy, and the old name keeps resolving as an alias.
    await alignServiceNames(project, appendLog);

    // A compose project has no container to run its release and one-time
    // commands in, and a docker project has none yet at `post-source`, so those
    // run on the host, where the service names of the project network do not
    // resolve. They get the addresses a native process would, from the same
    // variables as they stood before the injection below.
    const runsOnHost = composeCtx || project.runtime_type === "docker";
    const hostCommandEnv = runsOnHost && injectionNetwork !== "host" ? { ...envVars } : null;

    const { applied, skipped, conflicts } = await injectLinkedServiceEnv(
      project,
      injectionNetwork,
      envVars
    );

    for (const injection of applied) {
      // The host in the line, the password out of it: whether the app was
      // handed a container name or `localhost` is the whole question when a
      // database cannot be reached, and it used to be invisible here.
      const shown = maskUrlPassword(injection.value);
      appendLog(
        injection.replaced
          ? `Servizio "${injection.service}" → ${injection.key}: sostituisce il valore definito sul progetto con ${shown}`
          : `Servizio "${injection.service}" → ${injection.key} = ${shown}`
      );
    }
    for (const name of skipped) {
      appendLog(`Servizio "${name}": iniezione disattivata, il progetto usa le proprie variabili.`);
    }
    if (hostCommandEnv) {
      await injectLinkedServiceEnv(project, "host", hostCommandEnv);
      commandEnv = hostCommandEnv;
      if (composeCtx && applied.length > 0) {
        appendLog("I comandi di release e una tantum girano sull'host: raggiungono i servizi su localhost.");
      }
    }
    for (const conflict of conflicts) {
      // Reported rather than resolved by row order, which is how the second
      // database of a pair used to disappear without anyone being told.
      appendLog(
        `ATTENZIONE: ${conflict.services.join(", ")} vogliono tutti ${conflict.key}. ` +
          `Vale il primo (${conflict.services[0]}); cambia la variabile degli altri per usarli.`
      );
    }

    if (composeCtx) {
      // A file that would not resolve without the injected variables — a
      // `${DATABASE_URL:?}` — resolves now that they are in place.
      if (composePlan?.error) composePlan = await planComposeNetwork(composeCtx, envVars);

      const network = networkName(project.slug);
      if (composePlan?.override) {
        // Written before the build, which is what makes `config`, `build` and
        // `up` all see it: the builder reads the same context the driver does.
        await applyComposeNetwork(project.slug, composePlan);
        appendLog(
          `Rete del progetto: ${composePlan.override.attached.join(", ")} → ${network} ` +
            `(override generato, il compose del repository non viene toccato).`
        );
        for (const name of composePlan.override.skipped) {
          appendLog(`Rete del progetto: "${name}" usa network_mode e non può essere agganciato.`);
        }
      } else if (composePlan?.hostOnly) {
        await applyComposeNetwork(project.slug, composePlan);
        appendLog(
          `ATTENZIONE: ogni servizio del compose usa network_mode: host, quindi nessuno viene agganciato a ${network}. ` +
            `I servizi collegati sono raggiunti su localhost, come da un processo nativo.`
        );
      } else if (composePlan?.error) {
        appendLog(
          `ATTENZIONE: impossibile leggere il compose per agganciarlo a ${network} — ` +
            `${composePlan.error.split("\n").find((line) => line.trim()) ?? "errore sconosciuto"}`
        );
      }
    }

    // Fail fast on anything knowable before a build that may run for minutes.
    // Opened here and only here: `contract` is what the deployment records, and
    // it keeps the build arguments sealed.
    const readable = { ...contract, buildEnv: openBuildEnv(contract.buildEnv, project.id) };
    const issues = preflight(readable, { runtimeType: project.runtime_type, envVars });
    if (issues.length > 0) {
      appendLog("\n--- Preflight ---");
      for (const issue of issues) appendLog(`[warn] ${issue.field}: ${issue.message}`);
    }

    // Values a frontend build inlines into its client bundle have to exist at
    // BUILD time. Supplying them only at runtime either ships the wrong value
    // or fails a Dockerfile that asserts on them.
    const buildEnv = selectBuildEnv(readable, envVars);
    if (Object.keys(buildEnv).length > 0) {
      appendLog(`Build-time variables: ${Object.keys(buildEnv).sort().join(", ")}`);
    }

    // Materialise a .env file when the app reads one itself. The container case
    // is handled by `buildStartOpts`, which writes the file and adds the mount
    // together — appending it to the contract here left it out of every restart,
    // because a restart re-reads the contract from the row and this never wrote
    // it back.
    // Into the version's own folder: a release gets its own file rather than a
    // link to one, see `envFileEntry`.
    if (contract.envFile.enabled && !isDockerApp) {
      const written = writeEnvFileInto(deployDir, contract.envFile.path, envVars);
      appendLog(`Wrote env file to ${path.relative(deployDir, written)}`);
    }

    /*
      The new commit is on disk, the contract is resolved, the environment is
      decrypted with the linked services injected, and the dotenv is written —
      and nothing has been installed or built yet. That is the most useful
      reading of "dopo il git, prima degli install", and it is why this sits
      here rather than immediately after the fetch.

      The one thing a command here cannot do is change the contract of the
      very deploy running it: that was resolved a few lines above.
    */
    await runPhase("post-source", oneTime, phaseCtx(null));
    checkpoint();

    // Windows cannot replace a file that a running process has mapped, and a
    // native addon is always mapped — Prisma's query engine, better-sqlite3,
    // sharp. Since an in-place build writes into the very node_modules the old
    // instance is executing from, leaving it up does not buy zero downtime, it
    // costs the whole deploy: `prisma generate` dies with
    //
    //   EPERM: operation not permitted, rename
    //   '…/.prisma/client/query_engine-windows.dll.node.tmp3776' -> '….nodè
    //
    // and every subsequent deploy of a Prisma project fails the same way, for
    // as long as the app is up. Real zero-downtime here needs a separate build
    // directory, not a later stop — which is what a release folder is, and why
    // Windows, where there are none, still stops. Placed after preflight so a
    // deploy that was never going to run does not take the app down on its way out.
    let stoppedForBuild = false;
    if (
      isWindows &&
      wasRunning &&
      mode === "deploy" &&
      !release &&
      IN_PLACE_BUILD_RUNTIMES.has(project.runtime_type)
    ) {
      appendLog("\n--- Stopping previous instance ---");
      appendLog("Windows: the build writes into the directory it runs from.");
      try {
        await processManager.stop(project.slug, project.runtime_type);
        appendLog("Previous instance stopped.");
      } catch {
        appendLog("No previous instance to stop.");
      }
      stoppedForBuild = true;
    }

    // Build (install + compile). Everywhere else the old process stays up for
    // this phase; see above for why Windows cannot.
    appendLog("\n--- Building ---");

    const buildResult = await buildProject(deployDir, project.runtime_type, {
      slug: project.slug,
      deploymentId,
      buildCmd: contract.commands.build,
      startCmd: contract.commands.start,
      installCmd: contract.commands.install,
      packageManager: contract.packageManager,
      dockerImage: contract.docker.image,
      dockerfile: contract.docker.dockerfile,
      buildContext: contract.docker.context,
      target: contract.docker.target,
      buildArgs: buildEnv,
      buildTimeout: contract.build.timeoutSec * 1000,
      // Only the native builders call this back — see `BuildContext.onPhase`.
      onPhase: (phase) => runPhase(phase, oneTime, phaseCtx(null)),
      signal,
      // Build-time env for native runtimes, plus any Node heap override.
      envVars: {
        // The project's own value wins: it was typed for this app, while
        // `build.nodeOptions` usually comes from a preset's general guess.
        ...(contract.build.nodeOptions ? { NODE_OPTIONS: contract.build.nodeOptions } : {}),
        ...envVars,
        ...buildEnv,
      },
      onLog: appendLog,
    });

    checkpoint();

    if (!buildResult.success) {
      throw new Error(buildResult.error || "Build failed");
    }

    /*
      The tag of what was just built, for the phases that can run inside it.
      `startsWith` rather than the `replace(/^docker:/)` used below, because a
      compose build answers `compose:<file>` and that is not an image anybody
      can `docker run` — the phase runner has to be able to tell "there is an
      image" from "there is not".
    */
    const builtImage = buildResult.startCmd.startsWith("docker:")
      ? buildResult.startCmd.slice("docker:".length)
      : null;

    // Before the release command on purpose: `commands.release` is the
    // contract's migration slot and should be the last thing before the app
    // starts, so a chore that prepares for it has to come first.
    await runPhase("post-build", oneTime, phaseCtx(builtImage));
    checkpoint();

    // Release command: one-shot work that must happen after the build and
    // before the app serves traffic — migrations, schema push, cache warm.
    if (contract.commands.release) {
      appendLog("\n--- Release ---");
      await runReleaseCommand(contract.commands.release, {
        runtimeType: project.runtime_type,
        slug: project.slug,
        // The version's folder, as the settings promise and the one-time phases
        // use: a static build's artifactDir is dist/, where repo-relative paths
        // and the written .env are not. In a release folder the data the app
        // keeps is linked in, so a migration reaches the live database.
        projectDir: deployDir,
        image: buildResult.startCmd.replace(/^docker:/, ""),
        // In the image for docker, on the project network: the names resolve there.
        env: composeCtx ? (commandEnv ?? envVars) : envVars,
        contract,
        onLog: appendLog,
        signal,
      });
      appendLog("Release command completed.");
    }
    checkpoint();

    await updateDeployment({
      start_cmd: buildResult.startCmd,
      artifact_dir: buildResult.artifactDir,
      /*
        Written down next to the other two facts about what actually ran.

        `projects.builder_config` holds only the panel's half; this is that
        merged over the repository's `runpanel.json` and the detected preset,
        which until now existed nowhere but this function's local variable. A
        restart re-derived it from the sparse column and quietly lost the
        memory limit, the network mode and the env-file mount the repository
        had contributed. See migration 017.
      */
      resolved_contract: JSON.stringify(contract),
    });

    // Stop the old process only after the build succeeded — unless the build
    // itself already required it down. Whatever the row says when a release
    // folder is involved, coming or going: the hand-over below moves files out
    // of the version that ran, and that version has to be stopped for it.
    const leaving = !release && IN_PLACE_BUILD_RUNTIMES.has(project.runtime_type) && currentRelease(project.slug) !== null;
    // Without downtime the version online goes on serving until nginx has moved.
    if ((release || leaving || (wasRunning && mode === "deploy")) && !stoppedForBuild && !zeroDowntime) {
      appendLog("\n--- Stopping previous instance ---");
      try {
        await processManager.stop(project.slug, project.runtime_type);
        appendLog("Previous instance stopped.");
      } catch {
        appendLog("No previous instance to stop.");
      }
    }

    /*
      The data the outgoing version wrote where the project folder had nothing
      yet goes to the project folder now that it has stopped (planPromotion in
      lib/releases.ts). Going back to building in place does the same, so the
      app finds it in the folder it is about to start from.

      A failure here is said and stepped over: until the hand-over the new
      version reaches those files through links into the old one, and the old
      one is kept on disk for as long as it holds them, so continuing loses
      nothing — while stopping would leave the app down.
    */
    try {
      if (release) {
        appendLog("\n--- Switching release ---");
        await handOver(project.slug, release, contract, appendLog);
      } else if (leaving) {
        leftReleases = await leaveReleases(project.slug, contract, appendLog);
      }
    } catch (err) {
      appendLog(`ATTENZIONE: passaggio dei dati alla cartella del progetto non riuscito: ${err instanceof Error ? err.message : String(err)}`);
    }

    // After the stop and before the start, which is what the name has to
    // mean: in this instant nothing is serving, and that is the window a
    // chore like swapping a database file needs.
    await runPhase("pre-start", oneTime, phaseCtx(builtImage));
    checkpoint();

    // The new version becomes `current` right before it starts, so whatever
    // follows the project's files — the file manager, a scheduled task — finds
    // the version that is running. Not fatal: the process is started from the
    // artifact directory whatever the pointer says.
    if (release) {
      try {
        activateRelease(project.slug, release.id);
        appendLog(`Current release: ${release.id}`);
      } catch (err) {
        appendLog(`ATTENZIONE: il puntatore alla versione corrente non è stato aggiornato: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    /*
      Without downtime: the new version next to the old one, the health check
      on it, the "A deploy riuscito" commands, nginx moved with a validated
      reload — and the deploy recorded as done in the same step, inside the
      proxy's apply chain, so nginx and the store never tell two stories. Then
      the old container drains and goes. A failure before the switch rejects
      with the new container removed and the old one never touched, and lands
      in the catch below like any other.
    */
    if (zeroDowntime) {
      const startOpts = buildStartOpts({
        project,
        contract,
        envVars,
        cwd: buildResult.artifactDir,
        port,
        deploymentId,
        onLog: appendLog,
      });
      zeroDowntimeStarted = true;
      await runZeroDowntimeRelease({
        project,
        deploymentId,
        startCmd: buildResult.startCmd,
        startOpts,
        contract,
        port,
        signal,
        log: appendLog,
        checkpoint,
        afterStart: () => runPhase("post-start", oneTime, phaseCtx(builtImage)),
        beforeSwitch: () => runPhase("post-deploy", oneTime, phaseCtx(builtImage)),
        commit: async (livePort) => {
          const finishedAt = nowIso();
          await db.transaction().execute(async (trx) => {
            await trx
              .updateTable("deployments")
              .set({ status: "running", finished_at: finishedAt })
              .where("id", "=", deploymentId)
              .execute();
            await trx
              .updateTable("deployments")
              .set({ status: "superseded" })
              .where("project_id", "=", project.id)
              .where("id", "!=", deploymentId)
              .where("status", "=", "running")
              .execute();
            await trx
              .updateTable("projects")
              .set({ status: "running", port: port > 0 ? port : null, live_port: livePort, crashed_at: null, updated_at: finishedAt })
              .where("id", "=", project.id)
              .execute();
          });
          appendLog(`\n=== ${label} successful ===`);
          logFile.flush();
          projectEvents.emit(project.id, { type: "deploy:status", deploymentId, status: "running" });
        },
      });

      // Only now, as on the ordinary path: proved good, and ours.
      if (builtImage?.startsWith(`${imageRepo(project.slug)}:`)) {
        try {
          await markCurrentImage(project.slug, builtImage);
        } catch (err) {
          console.error(`[deploy] Could not tag ${builtImage} as current:`, err);
        }
      }
      // After the old container is gone, so the image it held can be retired with the rest.
      try {
        await sweep({ project: project.slug });
      } catch (err) {
        console.error("[deploy] Image cleanup failed:", err);
      }
      return;
    }

    // Start new process
    appendLog("\n--- Starting application ---");
    // Announced before the start, not after: the driver empties the output as
    // its first act, and a viewer told afterwards would clear the lines the new
    // run has already printed.
    projectEvents.emit(project.id, { type: "process:reset" });

    // A restricted project listens on loopback with the panel's gate in front,
    // so the gate has to let the public port go before the app can be started
    // on it, and take it back afterwards. `access.port` is null when open, and
    // then none of this happens.
    const access = readAccess(project);
    const restricted = access.mode === "restricted" && access.port !== null;
    if (restricted) await closeGate("project", project.id);
    // Everything downstream — the health probe included — has to look at where
    // the app really is, not where its callers reach it.
    const listenOn = restricted ? listenPort(project, port) : port;

    await processManager.start(
      project.slug,
      buildResult.startCmd,
      project.runtime_type,
      buildStartOpts({
        project,
        contract,
        envVars,
        cwd: buildResult.artifactDir,
        port,
        loopbackPort: restricted ? listenOn : undefined,
        deploymentId,
        onLog: appendLog,
      })
    );

    // Started the ordinary way, on its own port, after deploys without
    // downtime (turned off since, or not possible this time): the live port
    // nginx was sent to belongs to the container just replaced. Cleared at
    // once rather than on success, so a rollback below starts the previous
    // version the ordinary way too, where nginx is about to point.
    if (project.live_port !== null) {
      try {
        await db.updateTable("projects").set({ live_port: null }).where("id", "=", project.id).execute();
        appendLog("Pubblicata di nuovo sulla sua porta: nginx torna a puntare lì.");
        applyProxySoon();
      } catch (err) {
        appendLog(`ATTENZIONE: porta di nginx non aggiornata: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    if (restricted) {
      try {
        await syncGate("project", project.id, project, { publicPort: project.port, label: project.name });
        appendLog(`Accesso limitato: porta ${project.port} filtrata dal pannello.`);
        // Whether the app honoured the loopback bind is checked, not assumed.
        // Not awaited: the answer is a notice on a page, not a deploy step.
        void checkLoopbackLeak(project.id, listenOn);
      } catch (err) {
        // Said out loud rather than swallowed: from the outside a gate that did
        // not open and a restriction working perfectly look identical.
        appendLog(`ATTENZIONE: la porta ${project.port} non è stata aperta — ${(err as Error).message}`);
      }
    }

    // Before the probe, so a chore that warms a cache is what makes the probe
    // pass. The app may not be answering yet at this instant — the settings
    // tab says so, and points at "A deploy riuscito" for anything that needs
    // it up.
    await runPhase("post-start", oneTime, phaseCtx(builtImage));

    appendLog("\n--- Health check ---");
    const health = await waitForHealthy({
      slug: project.slug,
      runtimeType: project.runtime_type,
      port: listenOn,
      contract,
      onLog: appendLog,
      signal,
    });
    checkpoint();

    if (!health.healthy) {
      const driverName = project.runtime_type === "docker" ? "Docker" : "PM2";
      appendLog(`\n--- ${driverName} process logs ---`);
      try {
        const recentLogs = await processManager.logs(project.slug, project.runtime_type, 40);
        if (recentLogs.length > 0) {
          for (const line of recentLogs) appendLog(line);
        } else {
          appendLog(`(no ${driverName} logs available)`);
        }
      } catch {
        appendLog(`(failed to retrieve ${driverName} logs)`);
      }
      healthFailed = true;
      throw new Error(
        `Health check failed after ${contract.healthcheck.timeoutSec}s: ${health.reason}`
      );
    }

    /*
      The app is up and answering. Placed before the row is written rather
      than after, so a failure here produces a cleanly failed deploy instead
      of a row that flips from running back to failed. The cost is that
      "a deploy riuscito" means "the health check passed" rather than "it is
      already recorded", which is the smaller of the two lies.
    */
    await runPhase("post-deploy", oneTime, phaseCtx(builtImage));
    checkpoint();

    /*
      Now that this version has proved good, the ones no longer needed go: all
      but it and the one before, which is what the next failed deploy goes
      back to — or all of them, for a project back to building in place. The
      project folder's own node_modules and build output go too, unused since
      the app runs from a version folder. Before the final line, so the log
      says what was removed; never a reason to fail a deploy that worked.
    */
    if (release || leftReleases) {
      try {
        await pruneReleases(project, contract, appendLog, { keepNone: !release });
        if (release) await freeCheckoutBuildDirs(projectDir, appendLog);
      } catch (err) {
        appendLog(`Old release folders not cleaned up: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    // Finalize
    appendLog(`\n=== ${label} successful ===`);
    logFile.flush();

    await updateDeployment({ status: "running", finished_at: nowIso() });

    await db
      .updateTable("deployments")
      .set({ status: "superseded" })
      .where("project_id", "=", project.id)
      .where("id", "!=", deploymentId)
      .where("status", "=", "running")
      .execute();

    await db
      .updateTable("projects")
      // `port` is 0 for a container runtime with none configured, and 0 is not
      // a port — `updateProjectSchema` demands `min(1)`, so writing it made
      // every later save of the settings form answer 400. Null is what
      // "no port" already means on this column.
      .set({ status: "running", port: port > 0 ? port : null, crashed_at: null, updated_at: nowIso() })
      .where("id", "=", project.id)
      .execute();

    // Only now: an image is `:current` once it has been proved good. Only ours,
    // too: a template project runs somebody else's image, and that has no alias.
    if (builtImage?.startsWith(`${imageRepo(project.slug)}:`)) {
      try {
        await markCurrentImage(project.slug, builtImage);
      } catch (err) {
        console.error(`[deploy] Could not tag ${builtImage} as current:`, err);
      }
    }

    // Retire images this project no longer needs. Scoped to the project and run
    // after success, so a failed deploy never destroys the image that is still
    // serving traffic. Orphans are left alone — those need a human decision.
    if (project.runtime_type === "docker") {
      try {
        const result = await sweep({ project: project.slug });
        if (result.prunedImageTags.length > 0) {
          console.log(
            `[deploy] Retired ${result.prunedImageTags.length} old image(s) for ${project.slug}`
          );
        }
      } catch (err) {
        console.error("[deploy] Image cleanup failed:", err);
      }
    }
  } catch (err: unknown) {
    // Redacted once, here, and not per log line: this is the point where a
    // failure becomes something written down. An `execFile` rejection pastes
    // the whole command line into its message, and the stack carries it again,
    // so a fetch that failed while authenticating used to put the credential
    // into the deploy log and into `deployments.error_message`. The header now
    // travels in the environment instead of the argv, which closes that at the
    // root; this is the belt to that pair of braces, and it also covers a
    // remote URL somebody typed with the credentials still in it.
    // Whatever a stopped step happened to throw, the operator stopped it.
    const cancelled = signal?.aborted === true;
    const message = cancelled
      ? CANCELLED_MESSAGE
      : redactGitSecrets(err instanceof Error ? err.message : "Deploy failed");
    const stack =
      !cancelled && err instanceof Error && err.stack ? redactGitSecrets(err.stack) : undefined;
    appendLog(`\n=== ${label} FAILED: ${message} ===`);
    if (stack) appendLog(`Stack: ${stack}`);
    logFile.flush();

    await updateDeployment({
      status: "failed",
      error_message: message,
      finished_at: nowIso(),
    });

    // A stop asked for the app to be down, and the old instance may well have
    // stayed up through the build. Done here and not left to the route, which
    // stops waiting after a while and may be long gone.
    if (cancelled) {
      try {
        await processManager.stop(project.slug, project.runtime_type);
      } catch {
        /* nothing to stop is the state that was asked for */
      }
    }

    // Record what is actually up, not what was up when the deploy began: a
    // health check failure arrives with the new process already started, and
    // the pipeline may itself have stopped the old instance (rebuild, or a
    // start that failed after the stop). A row left at "error" with nothing
    // running is one the reconciler never revisits.
    let stillRunning = wasRunning;
    try {
      stillRunning = (await processManager.status(project.slug, project.runtime_type)).running;
    } catch {
      /* a driver that cannot answer leaves the opening snapshot standing */
    }

    // Without downtime, a failure of the new version is no failure of the app:
    // the version online was never stopped, and goes on serving as before —
    // the same outcome a successful rollback reports, without the restart.
    const keptOnline = zeroDowntimeStarted && !cancelled && stillRunning;

    // Running after a failed deploy is an error state — it is serving, but not
    // what this deploy intended. Not running is simply stopped.
    await db
      .updateTable("projects")
      .set({
        status: keptOnline ? "running" : stillRunning ? "error" : "stopped",
        // Not a crash, so the scheduled restart leaves the project alone.
        ...(cancelled ? { crashed_at: null } : {}),
        updated_at: nowIso(),
      })
      .where("id", "=", project.id)
      .execute();

    if (keptOnline) {
      appendLog("La versione online non è mai stata fermata: l'app continua a funzionare con quella.");
      await db
        .updateTable("deployments")
        .set({ error_message: `${message} — ${KEPT_ONLINE_NOTE}` })
        .where("id", "=", deploymentId)
        .execute();
      logFile.flush();
    }

    /*
      Automatic rollback: a version that never answered is replaced by the last
      one that did, instead of leaving the app down or half up.

      Docker: each deploy is its own image, and the previous one is still on
      disk — the sweep that retires old images runs after a success, never
      after a failure. Native: each deploy is its own release folder, and the
      previous one is kept for exactly this (`pruneReleases`); the restart
      points `current` back at it and starts it as it was, data links and all.
      A native deploy that built in place has nothing to go back to: by now
      the previous version's files are gone and "restart the last good deploy"
      would run the new code. Compose rebuilds the stack from the checkout,
      with the same problem. `rollbackPlan` has the cases.

      After the status update above, because the restart refuses a project
      that still reads "deploying"; under the deploy's lock, which it already
      holds. The deployment stays failed, with a note saying what came back.
    */
    const previousRelease = release ? await previousGoodRelease(project.id, project.slug).catch(() => null) : null;
    const rollback = rollbackPlan({
      // Without downtime there is nothing to bring back: it never went.
      healthFailed: healthFailed && !zeroDowntime,
      cancelled,
      rollbackEnabled: contract.rollback.enabled,
      runtimeType: project.runtime_type,
      usedRelease: release !== null,
      previous: previousRelease,
    });

    if (!rollback.attempt && (rollback.reason === "first" || rollback.reason === "missing")) {
      appendLog("\n--- Rollback ---");
      appendLog(
        rollback.reason === "first"
          ? "Nessuna versione precedente da rimettere online: è il primo deploy con le cartelle per versione, " +
              "e quella di prima girava nella cartella del progetto, che il deploy ha già portato al nuovo commit."
          : "Nessuna versione precedente da rimettere online: la sua cartella non c'è più."
      );
      logFile.flush();
    }

    if (rollback.attempt) {
      appendLog("\n--- Rollback ---");
      try {
        const result = await restartFromLastDeployment(project.id, { underLock: true });
        if ("success" in result) {
          appendLog("La nuova versione non ha superato il controllo di salute: è tornata online la precedente.");
          await db
            .updateTable("deployments")
            .set({ error_message: `${message} — ${ROLLBACK_NOTE}` })
            .where("id", "=", deploymentId)
            .execute();
        } else {
          appendLog(`Nessuna versione precedente da rimettere online: ${result.error}`);
        }
      } catch (rollbackErr) {
        appendLog(
          `Ritorno alla versione precedente non riuscito: ${redactGitSecrets(rollbackErr instanceof Error ? rollbackErr.message : String(rollbackErr))}`
        );
      }
      logFile.flush();
    }

    // A version folder that never ran goes now, and one the rollback left
    // behind with it — unless it holds something the app wrote. The current
    // one stays, whatever it is: after a failed deploy with no way back, that
    // is the version still up.
    if (release) {
      try {
        await pruneReleases(project, contract, appendLog);
      } catch (pruneErr) {
        appendLog(`Old release folders not cleaned up: ${pruneErr instanceof Error ? pruneErr.message : String(pruneErr)}`);
      }
      logFile.flush();
    }
  } finally {
    // Anything this deploy took and never got to goes back in the queue. A
    // no-op after a run that reached every phase; after one that failed early
    // it is what stops the rest of the queue being swallowed by it.
    await releaseUnrun(deploymentId);
    logFile.flush();
  }
}
