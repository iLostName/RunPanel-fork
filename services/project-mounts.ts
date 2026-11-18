import { getDb, nowIso } from "@/lib/db";
import type { ProjectsTable } from "@/lib/db/schema";
import { generateId } from "@/lib/utils";
import { formatMountString, parseMountString } from "@/lib/mount";
import { parseContractJson, withContractMounts, type DeployContract } from "@/lib/deploy-contract";
import { appContainerName } from "./docker/labels";
import { dockerTry } from "./docker/cli";
import { projectEvents, type MountPhase } from "./events";
import { AppendLogFile, logPathFor, readLogFile } from "./log-file";
import { config } from "@/lib/config";
import {
  copyOutOfContainer,
  destinationEntries,
  diskOf,
  freeKb,
  localFreeKb,
  sizeInContainerKb,
  sizeInImageKb,
} from "./mount-seed";
import { appIsUp, restartFromLastDeployment } from "./project-restart";
import { spaceShortfall, type SeedEstimate } from "@/lib/mount-space";
import { busyMessage, tryLock } from "./project-lock";
import { assertMountable, MountRefused, type MountJournal } from "./service-mounts";
import path from "path";

/**
 * The same bind list, on a project that runs in a container.
 *
 * `docker.mounts` has been in the deploy contract from the beginning: panel-only
 * so a repository cannot grant itself a mount of `/` or of the Docker socket,
 * and already reaching `docker run -v`. What it never had was a way to set it —
 * only hand-writing the contract — nor any validation, nor the seeding that
 * makes a new bind show what was already there.
 *
 * The differences from the service side are three, and they are all about what a
 * project is: there is no engine, so no data directory to treat carefully and
 * nothing to verify afterwards; the content to seed from always lives in the
 * image rather than in a volume; and applying is a restart from the last
 * deployment rather than a container recreated from a template.
 */

export interface ProjectMount {
  source: string;
  target: string;
  readOnly: boolean;
  enabled: boolean;
}

/**
 * The contract's mounts as rows.
 *
 * A stored string carries no on/off switch, so anything already in a contract
 * is by definition enabled — it is being passed to `docker run` today.
 */
export function projectMounts(contract: DeployContract): ProjectMount[] {
  return contract.docker.mounts
    .map((raw) => parseMountString(raw))
    .filter((spec): spec is NonNullable<typeof spec> => spec !== null)
    .map((spec) => ({ ...spec, enabled: true }));
}

/** Back to the spelling the contract stores. Disabled rows simply do not appear. */
export function mountStrings(mounts: ProjectMount[]): string[] {
  return mounts.filter((mount) => mount.enabled).map(formatMountString);
}

export function parseApplyJournal(raw: string | null): MountJournal | null {
  if (!raw) return null;
  try {
    return JSON.parse(raw) as MountJournal;
  } catch {
    return null;
  }
}

const TERMINAL: MountPhase[] = ["done", "failed"];
export const isApplyInFlight = (journal: MountJournal | null): boolean =>
  Boolean(journal && !TERMINAL.includes(journal.phase));

export function applyLogPath(projectId: string): string {
  return logPathFor(path.join(config.logsDir, "project-mounts"), projectId);
}

export function applyLog(projectId: string, tailLines = 500): string {
  return readLogFile(applyLogPath(projectId), tailLines);
}

/**
 * The image the project's container runs.
 *
 * Taken from the last successful deployment's start command, which the Docker
 * driver stores as `docker:<ref>`. Null before the first deploy — and then there
 * is genuinely nothing to copy out of, which is worth saying rather than seeding
 * an empty folder in silence.
 */
async function deployedImage(projectId: string): Promise<string | null> {
  const db = await getDb();
  const last = await db
    .selectFrom("deployments")
    .select("start_cmd")
    .where("project_id", "=", projectId)
    .where("status", "=", "running")
    .orderBy("started_at", "desc")
    .executeTakeFirst();

  const command = last?.start_cmd ?? "";
  return command.startsWith("docker:") ? command.slice("docker:".length) : null;
}

async function writeJournal(projectId: string, journal: MountJournal): Promise<void> {
  const db = await getDb();
  await db
    .updateTable("projects")
    .set({ mount_apply: JSON.stringify(journal), updated_at: nowIso() })
    .where("id", "=", projectId)
    .execute();
}

const inFlight = new Set<string>();

/**
 * Validate the whole list, then apply it in the background.
 *
 * Everything that can refuse does so before anything is touched, so a refusal
 * leaves the project exactly as it was.
 */
export async function applyProjectMounts(
  project: ProjectsTable,
  next: ProjectMount[],
  opts: { adopt?: string[] } = {}
): Promise<MountJournal> {
  // Held until the apply is over: a deploy in the middle would start the
  // container from a contract that is being rewritten.
  const release = tryLock(project.id, "mount-apply");
  if (!release) throw new MountRefused("project-busy", busyMessage(project.id));

  let started = false;
  try {
    const journal = await beginApply(project.id, next, opts, release);
    started = true;
    return journal;
  } finally {
    if (!started) release();
  }
}

async function beginApply(
  projectId: string,
  next: ProjectMount[],
  opts: { adopt?: string[] },
  release: () => void
): Promise<MountJournal> {
  // Read again now that nothing else can change it.
  const store = await getDb();
  const project = await store
    .selectFrom("projects")
    .selectAll()
    .where("id", "=", projectId)
    .executeTakeFirst();
  if (!project) throw new Error("Il progetto non esiste più.");

  if (project.runtime_type !== "docker") {
    throw new MountRefused(
      "runtime-not-docker",
      "I bind sono una cosa del container: questo progetto non ne ha uno."
    );
  }

  if (inFlight.has(project.id) || isApplyInFlight(parseApplyJournal(project.mount_apply))) {
    throw new MountRefused("apply-in-progress", "Un'applicazione è già in corso.");
  }

  for (const mount of next) assertMountable(mount.source);

  const targets = next.filter((m) => m.enabled).map((m) => m.target.replace(/\/+$/, ""));
  const duplicate = targets.find((t, i) => targets.indexOf(t) !== i);
  if (duplicate) {
    throw new Error(`Due bind puntano allo stesso percorso nel container: ${duplicate}`);
  }

  const contract = parseContractJson(project.builder_config);
  const previous = projectMounts(contract);
  const adopt = new Set(opts.adopt ?? []);

  const fresh = next.filter(
    (mount) =>
      mount.enabled &&
      !previous.some((old) => old.source === mount.source && old.target === mount.target)
  );

  const image = await deployedImage(project.id);
  const toSeed: ProjectMount[] = [];

  for (const mount of fresh) {
    if (!image) {
      throw new MountRefused(
        "no-image",
        "Il progetto non è mai stato distribuito, quindi non c'è niente da copiare fuori. Fai un deploy, poi aggiungi il bind."
      );
    }

    const entries = await destinationEntries(image, mount.source);
    if (entries.length > 0) {
      if (!adopt.has(mount.target)) {
        throw new MountRefused(
          "destination-not-empty",
          `${mount.source} non è vuota: contiene ${entries.slice(0, 5).join(", ")}${entries.length > 5 ? "…" : ""}.`,
          mount.target,
          entries
        );
      }
      continue;
    }
    toSeed.push(mount);
  }

  if (image && toSeed.length > 0) {
    const seeds: SeedEstimate[] = [];
    for (const mount of toSeed) {
      const [needed, available] = await Promise.all([
        sizeInContainerKb(appContainerName(project.slug), mount.target).then(
          (size) => size ?? sizeInImageKb(image, mount.target)
        ),
        freeKb(image, mount.source),
      ]);
      if (needed === null || available === null) continue;
      seeds.push({ place: mount.source, disk: diskOf(mount.source), neededKb: needed, freeKb: available });
    }

    const scratchFree = localFreeKb(config.tmpDir);
    const short = spaceShortfall(
      seeds,
      scratchFree === null ? null : { place: config.tmpDir, disk: diskOf(config.tmpDir), freeKb: scratchFree }
    );
    if (short) {
      throw new MountRefused(
        "insufficient-space",
        `Non c'è spazio a sufficienza in ${short.place}: servono ${Math.ceil(short.neededKb / 1024)} MB.`
      );
    }
  }

  const journal: MountJournal = { id: generateId(), phase: "checking", startedAt: nowIso() };
  await writeJournal(project.id, journal);
  inFlight.add(project.id);

  void runApply(project, journal, previous, next, toSeed, image).finally(() => {
    inFlight.delete(project.id);
    release();
  });

  return journal;
}

/**
 * Applications the last process never finished.
 *
 * Nothing ends them otherwise: the journal would say "in progress" for ever,
 * refuse every new apply and replay its log at every visit. Not resumed, for the
 * reason services are not. A container left removed is up to the project's
 * restart, which the page offers.
 */
export async function reconcileProjectApplies(): Promise<number> {
  const db = await getDb();
  const rows = await db
    .selectFrom("projects")
    .select(["id", "mount_apply"])
    .where("mount_apply", "is not", null)
    .execute();

  let repaired = 0;
  for (const row of rows) {
    const journal = parseApplyJournal(row.mount_apply);
    if (!journal || !isApplyInFlight(journal)) continue;
    journal.phase = "failed";
    journal.finishedAt = nowIso();
    journal.error = "Il pannello si è riavviato durante l'applicazione: controlla i bind e riavvia il progetto.";
    journal.rolledBack = false;
    await writeJournal(row.id, journal);
    repaired++;
  }
  return repaired;
}

async function runApply(
  project: ProjectsTable,
  journal: MountJournal,
  previous: ProjectMount[],
  next: ProjectMount[],
  toSeed: ProjectMount[],
  image: string | null
): Promise<void> {
  const file = new AppendLogFile(applyLogPath(project.id));
  const emit = (line: string) => {
    file.append(`${nowIso()} ${line}`);
    projectEvents.emit(project.id, { type: "mount:log", line });
  };
  const report = {
    emit,
    progress: (copiedKb: number, totalKb: number | null) =>
      projectEvents.emit(project.id, { type: "mount:progress", copiedKb, totalKb }),
  };

  const phase = async (value: MountPhase, error?: string) => {
    journal.phase = value;
    if (error) journal.error = error;
    if (value === "done" || value === "failed") journal.finishedAt = nowIso();
    await writeJournal(project.id, journal);
    projectEvents.emit(project.id, { type: "mount:phase", phase: value, error });
  };

  const db = await getDb();

  /*
    Both places a mount list lives.

    A restart starts from what the last deployment recorded, not from the
    project row, so writing only the row left the container exactly as it was
    while the journal said `done`: the new binds reached it at the next deploy,
    and not before.
  */
  const write = async (mounts: ProjectMount[]): Promise<boolean> => {
    const strings = mountStrings(mounts);
    // Read again: seeding takes minutes, and a save made meanwhile is not this
    // operation's to undo.
    const { builder_config: stored } = await db
      .selectFrom("projects")
      .select("builder_config")
      .where("id", "=", project.id)
      .executeTakeFirstOrThrow();
    await db
      .updateTable("projects")
      .set({ builder_config: withContractMounts(stored, strings), updated_at: nowIso() })
      .where("id", "=", project.id)
      .execute();

    const last = await db
      .selectFrom("deployments")
      .select(["id", "resolved_contract"])
      .where("project_id", "=", project.id)
      .where("status", "in", ["running", "superseded"])
      .where("start_cmd", "is not", null)
      .orderBy("started_at", "desc")
      .limit(1)
      .executeTakeFirst();

    if (last?.resolved_contract) {
      await db
        .updateTable("deployments")
        .set({ resolved_contract: withContractMounts(last.resolved_contract, strings) })
        .where("id", "=", last.id)
        .execute();
    }
    return Boolean(last);
  };

  const wasUp = await appIsUp(project);

  /** Never deployed or stopped means nothing to recreate: the next start reads the list. */
  const restart = async (deployed: boolean) => {
    if (!deployed) {
      emit("Nessun deploy riuscito finora: la lista vale dal prossimo.");
      return;
    }
    if (!wasUp) {
      emit("Il progetto era fermo: resta fermo. La lista vale da Avvia o dal prossimo deploy.");
      return;
    }
    const result = await restartFromLastDeployment(project.id, { underLock: true });
    if ("error" in result) throw new Error(result.error);
  };

  let recreating = false;

  try {
    if (toSeed.length > 0 && image) {
      await phase("seeding");
      for (const mount of toSeed) {
        journal.seeding = { id: mount.target, source: mount.source, target: mount.target, careful: false };
        await writeJournal(project.id, journal);
        emit(`Semino ${mount.source} da ${mount.target}…`);
        await copyOutOfContainer({
          sourceContainer: appContainerName(project.slug),
          image,
          target: mount.target,
          to: mount.source,
          report,
        });
      }
      journal.seeding = undefined;
    }

    await phase("recreating");
    emit("Riavvio il container con la nuova lista…");
    // Written before the restart, because `restartFromLastDeployment` re-reads
    // the row to build the start options.
    recreating = true;
    await restart(await write(next));

    emit("Fatto.");
    await phase("done");
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    emit(`Errore: ${message}`);

    await phase("rolling-back");
    emit("Torno alla lista precedente…");
    try {
      // A seed that failed wrote nothing and touched no container: nothing to undo,
      // and writing anyway would drop whatever `projectMounts` cannot read.
      if (recreating) await restart(await write(previous));
      journal.rolledBack = true;
      emit("Il progetto è di nuovo com'era.");
    } catch (rollbackErr) {
      journal.rolledBack = false;
      emit(
        `Anche il ritorno indietro è fallito: ${rollbackErr instanceof Error ? rollbackErr.message : rollbackErr}`
      );
    }

    await phase("failed", message);
  } finally {
    file.flush();
    await dockerTry(["rm", "-f", `runpanel-mountseed-${project.id}`], { timeout: 30_000 });
  }
}
