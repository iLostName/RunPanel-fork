import fs from "fs";
import path from "path";
import { hasPermission, type Principal } from "@/lib/authz";
import { normalizeExcludeList } from "@/lib/backup-settings";
import { decrypt, encrypt } from "@/lib/crypto";
import { config } from "@/lib/config";
import { resolveInside } from "@/lib/fs-safe";
import { getDb, nowIso } from "@/lib/db";
import type { ProjectsTable, ServicesTable } from "@/lib/db/schema";
import { getEnv } from "@/lib/env";
import { generateId } from "@/lib/utils";
import { formatBytes, formatWhen } from "@/lib/format";
import { requireHostIfReaching } from "@/lib/host-guard";
import { configRestoreProblem } from "@/lib/restore-gate";
import { stripRemoteCredentials } from "@/lib/git-remote";
import { mongoToolCall, postgresRestoreCommand } from "@/lib/service-exec";
import { docker, dockerFromFile, dockerTry } from "../docker/cli";
import { opsEvents } from "../events";
import { processManager } from "../process-manager";
import { appIsUp } from "../project-restart";
import { projectFileRoots } from "../project-releases";
import { sealContract } from "../build-env";
import {
  busyMessage,
  isPanelClosing,
  PANEL_CLOSING_MESSAGE,
  tryLock,
  type ReleaseLock,
} from "../project-lock";
import { canSignIn, databaseAdmin, execArgs, serviceTarget, type ServiceTarget } from "../service-databases";
import { containerMounts } from "../docker/volumes";
import { extractArchiveEntry, isSafeEntryPath, listArchiveEntries, type ArchiveHandle } from "./archive-read";
import { ArchiveLockedError, checkArchivePassword, readSealedHead, type ZipOpener } from "./archive-crypto";
import { buildDestination } from "./destinations";
import { archiveForRestore } from "./archive-source";
import { readOrder } from "@/lib/backup-copies";
import { readFirstCopy, runCopies, StopFallback } from "./copies";
import { memberFailureMessage, readArchiveChecksums, verifyMembers } from "./integrity";
import { keyAvailability, panelArchiveOpener } from "./keyring";
import { touchUpload, uploadArchivePath, uploadArtifacts, uploadPasswords } from "./uploads";
import { FREE_SPACE_RESERVE, assertBackupId, freeBytes, resolveArchivePath, restoreLog } from "./paths";
import { backupDocker, projectOwner, projectVolumes } from "./project-export";
import { startBackup } from "./runner";
import type { BackupTarget } from "./types";
import { holdVolumeForRestore, startContainers, writeVolume } from "./volume-ops";

interface Stopped {
  projects: { slug: string; runtime: string }[];
  containers: string[];
  /** Project locks, held until those projects are back up. */
  locks: ReleaseLock[];
  /** Whose locks those are: a project can be touched by several artifacts. */
  held: Set<string>;
}

/** Keep a project to this restore until it ends. */
function holdProject(projectId: string, stopped: Stopped): void {
  if (stopped.held.has(projectId)) return;
  const release = tryLock(projectId, "restore");
  if (!release) throw new Error(busyMessage(projectId));
  stopped.held.add(projectId);
  stopped.locks.push(release);
}

/**
 * Take a project down for the rest of this restore.
 *
 * Only what was up comes back in the caller's `finally`: a project somebody
 * stopped has to stay that way.
 */
async function takeDown(
  project: ProjectsTable,
  stopped: Stopped,
  emit: (line: string) => void
): Promise<void> {
  holdProject(project.id, stopped);
  if (stopped.projects.some((entry) => entry.slug === project.slug)) return;

  const wasUp = await appIsUp(project);
  emit(`  fermo ${project.slug}…`);
  await processManager.stop(project.slug, project.runtime_type).catch(() => {});
  if (wasUp) stopped.projects.push({ slug: project.slug, runtime: project.runtime_type });
}

/**
 * Take every project this restore will touch, before it touches anything.
 *
 * One at a time, a project busy with a deploy would fail the run after the items
 * before it were already overwritten. Before the safety copy too: a migration
 * landing after that copy would be in neither the copy nor the archive.
 */
async function holdTargets(
  planned: RestoreMapping[],
  artifacts: Map<string, RestorableArtifact>,
  stopped: Stopped
): Promise<void> {
  const db = await getDb();

  for (const mapping of planned) {
    const artifact = artifacts.get(mapping.artifactId);
    if (!artifact) continue;

    const target = mapping.targetId ?? artifact.refId;
    if (!target) continue;

    if (artifact.kind === "service-db") {
      const service = await db
        .selectFrom("services")
        .select("project_id")
        .where("id", "=", target)
        .executeTakeFirst();
      if (service?.project_id) holdProject(service.project_id, stopped);
    } else if (artifact.kind.startsWith("project-")) {
      holdProject(target, stopped);
    }
  }
}

/**
 * Putting a backup back.
 *
 * This is the only part of the panel that can destroy production data, so the
 * shape is defensive on purpose:
 *
 *  - a safety backup of exactly what is about to be overwritten runs first, and
 *    **if it fails the restore stops** unless someone explicitly said otherwise;
 *  - the target's engine has to match the artifact's, checked here and not only
 *    in the browser;
 *  - anything that had to be stopped is started again in a `finally`, so a
 *    failure never leaves applications down;
 *  - the panel's own store is never restored underneath the running process.
 */

export interface RestoreMapping {
  artifactId: string;
  action: "restore" | "skip";
  /** Which service or project to put it into. Defaults to where it came from. */
  targetId?: string;
  targetDatabase?: string;
}

export interface RestoreRequest {
  /** Who asked: what an artifact would change is only known once it is open. */
  principal: Principal;
  runId?: string;
  uploadId?: string;
  mappings: RestoreMapping[];
  skipSafetyBackup?: boolean;
  /**
   * For a run whose archive is encrypted with a password this panel does not
   * have (its store came from another server, say). An upload is unlocked
   * before it is checked, and keeps its password with it.
   */
  password?: string;
}

export class RestoreBusyError extends Error {
  constructor(message = "Un ripristino è già in corso") {
    super(message);
    this.name = "RestoreBusyError";
  }
}

const globalRef = globalThis as typeof globalThis & { __runpanelRestoreActive?: string | null };

/** The restore in progress, if any. What the panel update checks before it swaps. */
export function activeRestoreId(): string | null {
  return globalRef.__runpanelRestoreActive ?? null;
}


/**
 * Why a restore of this run cannot start for want of a password, or null.
 *
 * Only for an archive encrypted with a password this panel no longer has —
 * its own it opens by itself. Asked before the 202, so the dialog stays open
 * with what was chosen: no password is refused at once, and a wrong one too
 * when the archive is on this disk. One in a bucket is tried once downloaded,
 * and a wrong password stops that restore before anything is touched.
 */
export async function restorePasswordProblem(runId: string, password: string | undefined): Promise<string | null> {
  const db = await getDb();
  const run = await db
    .selectFrom("backup_runs")
    .select(["archive_path", "encryption_key_id"])
    .where("id", "=", runId)
    .executeTakeFirst();
  if (!run?.encryption_key_id || !run.archive_path) return null;
  if ((await keyAvailability()).get(run.encryption_key_id)?.usable) return null;
  if (!password) {
    return "Questo archivio è cifrato con una password dei backup che il pannello non ha più: scrivila per ripristinarlo.";
  }

  // Tried on a copy on this disk, if there is one: every copy is the same
  // file, sealed with the same password.
  for (const copy of readOrder(await runCopies(runId))) {
    if (!copy.local || !copy.row || !copy.ref) continue;
    let file: string;
    try {
      file = buildDestination(copy.row).localPath?.(copy.ref) ?? "";
    } catch {
      continue;
    }
    if (!file || !fs.existsSync(file)) continue;
    return (await checkArchivePassword(file, password).catch(() => true))
      ? null
      : "La password non è quella di questo archivio: serve quella dei backup in uso il giorno in cui è stato creato.";
  }
  return null;
}

/** How many times open Postgres sessions are looked for, and how far apart. */
const SESSION_CHECKS = 6;
const SESSION_CHECK_DELAY_MS = 1_000;

/** Where an artifact is unpacked before it is fed to an engine. */
function restoreStaging(restoreId: string): string {
  return path.join(config.backupStagingDir, `restore-${assertBackupId(restoreId)}`);
}

export async function startRestore(
  request: RestoreRequest
): Promise<{ restoreId: string; done: Promise<void> }> {
  if (globalRef.__runpanelRestoreActive) throw new RestoreBusyError();
  if (isPanelClosing()) throw new RestoreBusyError(PANEL_CLOSING_MESSAGE);

  // Claimed before the first await, so two starts cannot both pass the check;
  // released only by its owner.
  const restoreId = generateId();
  globalRef.__runpanelRestoreActive = restoreId;
  const release = () => {
    if (globalRef.__runpanelRestoreActive === restoreId) globalRef.__runpanelRestoreActive = null;
  };

  const db = await getDb().catch((err: unknown) => {
    release();
    throw err;
  });
  const now = nowIso();

  await db
    .insertInto("restore_runs")
    .values({
      id: restoreId,
      run_id: request.runId ?? null,
      source: request.uploadId ? "upload" : "catalog",
      archive_path: null,
      targets: JSON.stringify(request.mappings),
      safety_run_id: null,
      status: "running",
      error_message: null,
      started_at: now,
      finished_at: null,
      heartbeat_at: now,
    })
    .execute()
    .catch((err: unknown) => {
      release();
      throw err;
    });

  opsEvents.emit(restoreId, { type: "restore:status", status: "running" });

  const done = execute(restoreId, request).finally(release);

  return { restoreId, done };
}

async function execute(restoreId: string, request: RestoreRequest): Promise<void> {
  const db = await getDb();
  const log = restoreLog(restoreId);
  const emit = (line: string) => {
    log.append(line);
    opsEvents.emit(restoreId, { type: "restore:log", line });
  };

  const staging = restoreStaging(restoreId);
  fs.mkdirSync(staging, { recursive: true });

  /**
   * What this restore stopped, and has to start again whatever happens: the
   * projects through their drivers, and by id the containers that still had a
   * volume open after that.
   */
  const stopped: Stopped = { projects: [], containers: [], locks: [], held: new Set() };
  let failure: string | null = null;

  try {
    const artifacts = await loadArtifacts(request);
    const planned = request.mappings.filter((mapping) => mapping.action === "restore");
    if (planned.length === 0) throw new Error("Nessun elemento selezionato");

    emit(`${planned.length} element${planned.length === 1 ? "o" : "i"} da ripristinare`);

    // First of all: a damaged archive must stop the restore while nothing has
    // been stopped, copied or overwritten yet. With several copies, one that
    // is missing, unreachable or damaged gives way to the next.
    const resolved = await resolveArchive(request, staging, emit, async (candidate) => {
      emit(`Archivio: ${path.basename(candidate.file)} (${formatBytes(fs.statSync(candidate.file).size)})`);
      const sealed = await readSealedHead(candidate.file).catch(() => null);
      if (sealed) {
        emit(
          `  cifrato con la password dei backup${sealed.header.keyCreatedAt ? ` del ${formatWhen(sealed.header.keyCreatedAt)}` : ""}`
        );
      }
      await verifyBeforeRestore(candidate, planned, artifacts, emit);
    });
    // The file and the opener that knows its password travel together: every
    // read below goes through the decryption, and the archive is never written
    // out in clear — only the members a step needs are extracted, as from a zip.
    const archive: ArchiveHandle = { file: resolved.file, open: resolved.open };

    // Before the safety copy and before anything is stopped: a restore that is
    // not theirs must leave every service exactly as it found it.
    await refuseBeyondPermissions(request.principal, planned, artifacts, archive, staging);
    await holdTargets(planned, artifacts, stopped);

    // The single most valuable step: a copy of exactly what is about to be
    // overwritten, taken before anything is touched and exempt from retention.
    if (!request.skipSafetyBackup) {
      const safetyId = await takeSafetyBackup(planned, artifacts, emit);
      if (safetyId) {
        await db
          .updateTable("restore_runs")
          .set({ safety_run_id: safetyId })
          .where("id", "=", restoreId)
          .execute();
      }
    } else {
      emit("ATTENZIONE: backup di sicurezza saltato su richiesta esplicita");
    }

    for (const mapping of planned) {
      const artifact = artifacts.get(mapping.artifactId);
      if (!artifact) {
        emit(`— elemento ${mapping.artifactId} non presente nell'archivio, lo salto`);
        continue;
      }
      await restoreArtifact(artifact, mapping, archive, staging, emit, stopped);
    }

    emit("Ripristino completato");
  } catch (err) {
    failure = err instanceof Error ? err.message : String(err);
    emit(`ERRORE: ${failure}`);
  } finally {
    // Whatever happened, nothing stays down because of us.
    //
    // `restart` rather than `start`: the container or the PM2 entry still
    // exists, it is merely stopped, so this needs none of the deploy contract —
    // no working directory, no environment, no port. Rebuilding that here would
    // be a second, quietly diverging copy of the deploy pipeline.
    for (const project of stopped.projects) {
      try {
        emit(`Riavvio ${project.slug}…`);
        await processManager.restart(project.slug, project.runtime);
      } catch (err) {
        emit(`Non sono riuscito a riavviare ${project.slug}: ${(err as Error).message}`);
      }
    }
    await startContainers(backupDocker, stopped.containers, emit);
    for (const release of stopped.locks) release();

    fs.rmSync(staging, { recursive: true, force: true });
    log.flush();

    await db
      .updateTable("restore_runs")
      .set({
        status: failure ? "failed" : "success",
        error_message: failure,
        finished_at: nowIso(),
        heartbeat_at: nowIso(),
      })
      .where("id", "=", restoreId)
      .execute();

    opsEvents.emit(restoreId, {
      type: "restore:status",
      status: failure ? "failed" : "success",
      ...(failure ? { message: failure } : {}),
    });
  }
}

// --- Finding the archive and what is in it -----------------------------------

interface ResolvedArchive {
  file: string;
  /** Recorded when the archive was written; null for an upload or a run that has none. */
  expectedSha256: string | null;
  /** Computed while it was downloaded; null when it was read in place. */
  downloadedSha256: string | null;
  /** Where it came from, for the messages. */
  sourceName: string;
  /** Opens it, plain or encrypted, with every password this restore may use. */
  open: ZipOpener;
}

/**
 * The archive to restore from, already through `check` — what the restore
 * verifies before it touches anything.
 *
 * A run's archive comes from its first copy that answers (services/backup/
 * copies.ts): the ones on this disk first, then the policy's order. A copy
 * that is gone, does not answer, or fails `check` — a download whose sha256
 * is not the one recorded, a member that does not read back — gives way to
 * the next one, and the log says which copy was used. A password that is
 * missing or wrong is not a fault of the copy: every copy is the same file,
 * so it stops the restore at once.
 */
async function resolveArchive(
  request: RestoreRequest,
  staging: string,
  emit: (line: string) => void,
  check: (candidate: ResolvedArchive) => Promise<void>
): Promise<ResolvedArchive> {
  if (request.uploadId) {
    const file = uploadArchivePath(request.uploadId);
    if (!fs.existsSync(file)) throw new Error("L'archivio caricato non è più disponibile: caricalo di nuovo.");
    touchUpload(request.uploadId);
    emit("Sorgente: archivio caricato");
    const resolved: ResolvedArchive = {
      file,
      expectedSha256: null,
      downloadedSha256: null,
      sourceName: "l'archivio caricato",
      open: panelArchiveOpener(uploadPasswords(request.uploadId)),
    };
    await check(resolved);
    return resolved;
  }

  if (!request.runId) throw new Error("Nessuna sorgente indicata");

  const db = await getDb();
  const run = await db
    .selectFrom("backup_runs")
    .selectAll()
    .where("id", "=", assertBackupId(request.runId))
    .executeTakeFirst();

  if (!run || !run.archive_path) {
    throw new Error("Questo backup non ha un archivio da cui ripristinare");
  }

  emit(`Sorgente: backup del ${new Date(run.started_at).toLocaleString()}`);
  const several = readOrder(await runCopies(run.id)).length > 1;

  return readFirstCopy(
    run.id,
    async ({ copy, destination, bytes }) => {
      if (!destination.localPath) emit(`Scarico l'archivio da ${destination.name} (${formatBytes(bytes)})…`);
      else if (several) emit(`Uso la copia su «${destination.name}»`);

      const { file, sha256, downloaded } = await archiveForRestore(destination, copy.ref as string, staging, {
        bytes,
        freeBytes: freeBytes(),
        reserveBytes: FREE_SPACE_RESERVE,
        localPath: (ref) => destination.localPath?.(ref) ?? resolveArchivePath(ref),
      });
      const resolved: ResolvedArchive = {
        file,
        expectedSha256: run.checksum,
        downloadedSha256: sha256,
        sourceName: `«${destination.name}»`,
        open: panelArchiveOpener(request.password ? [request.password] : []),
      };
      try {
        await check(resolved);
      } catch (err) {
        if (downloaded) fs.rmSync(file, { force: true });
        if (err instanceof RestoreLockedError) throw new StopFallback(err);
        throw err;
      }
      return resolved;
    },
    { log: emit }
  );
}

/** A password missing or wrong: about the reader, not about any one copy. */
class RestoreLockedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RestoreLockedError";
  }
}

export interface RestorableArtifact {
  id: string;
  kind: string;
  refId: string | null;
  refName: string;
  entryPath: string;
  bytes: number;
  /** sha256 of the member, as recorded when it was staged. Null for a tree. */
  checksum: string | null;
  meta: Record<string, unknown>;
}

async function loadArtifacts(request: RestoreRequest): Promise<Map<string, RestorableArtifact>> {
  const db = await getDb();

  if (request.runId) {
    const rows = await db
      .selectFrom("backup_artifacts")
      .selectAll()
      .where("run_id", "=", request.runId)
      .where("status", "=", "ok")
      .execute();

    return new Map(
      rows.map((row) => [
        row.id,
        {
          id: row.id,
          kind: row.kind,
          refId: row.ref_id,
          refName: row.ref_name,
          entryPath: row.entry_path,
          bytes: row.bytes,
          checksum: row.checksum,
          meta: row.meta ? (JSON.parse(row.meta) as Record<string, unknown>) : {},
        },
      ])
    );
  }

  // An upload carries its own catalogue: the manifest, read and checked when
  // it finished arriving. One that failed that check never gets this far.
  if (request.uploadId) return uploadArtifacts(request.uploadId);

  throw new Error("Nessuna sorgente indicata");
}

/**
 * Check what is about to be used, before anything is touched.
 *
 * A downloaded archive is compared whole with the sha256 recorded when it was
 * written; then each member the restore will read is opened and checked — its
 * CRC, its sha256, and a `.gz` dump read to the end, since a truncated one
 * checksums perfectly as its own short self. Postgres runs `DROP DATABASE`
 * before it reads the data that follows, so a dump that turns out to be cut
 * short halfway through `psql` is a database lost: it is found here instead.
 */
async function verifyBeforeRestore(
  archive: ResolvedArchive,
  planned: RestoreMapping[],
  artifacts: Map<string, RestorableArtifact>,
  emit: (line: string) => void
): Promise<void> {
  if (archive.expectedSha256 && archive.downloadedSha256 && archive.expectedSha256 !== archive.downloadedSha256) {
    throw new Error(
      `L'archivio scaricato da ${archive.sourceName} non è quello creato dal backup: il suo sha256 è diverso. ` +
        "È danneggiato, o è stato modificato fuori dal pannello. Niente è stato toccato."
    );
  }

  const used = planned
    .map((mapping) => artifacts.get(mapping.artifactId))
    .filter((artifact): artifact is RestorableArtifact => Boolean(artifact));
  const only = used
    .map((artifact) =>
      artifact.kind === "project-repo" ? String(artifact.meta.prefix ?? artifact.entryPath) : artifact.entryPath
    )
    .filter((entry) => entry && isSafeEntryPath(entry));
  if (only.length === 0) return;

  emit("Controllo l'integrità di quello che sto per ripristinare…");
  let report: Awaited<ReturnType<typeof verifyMembers>>;
  try {
    const checksums = await readArchiveChecksums(archive.file, archive.open);
    // The catalogue's own record wins over the archive's: it was written by this
    // panel, the other travelled with the file.
    for (const artifact of used) {
      if (artifact.checksum && artifact.kind !== "project-repo") checksums.set(artifact.entryPath, artifact.checksum);
    }
    report = await verifyMembers(archive.file, { only, checksums, open: archive.open });
  } catch (err) {
    // The first read of the archive: a password missing or wrong stops it here.
    if (err instanceof ArchiveLockedError) throw new RestoreLockedError(`${err.message} Niente è stato toccato.`);
    throw err;
  }
  if (report.failures.length > 0) throw new Error(memberFailureMessage(report.failures));
  emit(
    `  integro: ${report.checked} file controllati (${formatBytes(report.bytes)})` +
      (archive.downloadedSha256 && archive.expectedSha256 ? ", e l'archivio è identico a quello creato" : "")
  );
}
// --- Who may apply what -------------------------------------------------------

/**
 * The line `PATCH /api/projects/:id` draws, applied to what the archive holds.
 *
 * It cannot be drawn in the route with the other restore checks: the runtime,
 * the mounts and the source are inside the encrypted artifact, and the archive
 * may first have to come down from S3, well after the 202. Restoring a
 * project's repository needs no reading, so `restoreProblem` refuses that one.
 */
async function refuseBeyondPermissions(
  principal: Principal,
  planned: RestoreMapping[],
  artifacts: Map<string, RestorableArtifact>,
  archive: ArchiveHandle,
  staging: string
): Promise<void> {
  if (principal.isOwner) return;
  const db = await getDb();

  for (const mapping of planned) {
    const artifact = artifacts.get(mapping.artifactId);
    if (artifact?.kind !== "project-config") continue;

    const { project } = await readProjectConfig(artifact, archive, staging);
    const targetId = mapping.targetId ?? project.id;
    const current = await db
      .selectFrom("projects")
      .select(["source_type", "source_url", "source_branch"])
      .where("id", "=", targetId)
      .executeTakeFirst();
    if (!current) throw new Error("Il progetto di destinazione non esiste più");

    const problem = configRestoreProblem(
      { host: hasPermission(principal, "host"), github: hasPermission(principal, "github") },
      current,
      project
    );
    if (problem) throw new Error(problem);

    const refused = await requireHostIfReaching(
      principal,
      targetId,
      "ripristinare la configurazione di un progetto che raggiunge l'host",
      { runtimeType: project.runtime_type, builderConfig: project.builder_config }
    );
    if (refused) throw new Error(((await refused.json()) as { error: string }).error);
  }
}

// --- The safety copy ---------------------------------------------------------

async function takeSafetyBackup(
  mappings: RestoreMapping[],
  artifacts: Map<string, RestorableArtifact>,
  emit: (line: string) => void
): Promise<string | null> {
  const targets: BackupTarget[] = [];
  const seen = new Set<string>();

  for (const mapping of mappings) {
    const artifact = artifacts.get(mapping.artifactId);
    if (!artifact) continue;

    const id = mapping.targetId ?? artifact.refId;
    if (!id) {
      if (artifact.kind === "panel-store" && !seen.has("panel")) {
        seen.add("panel");
        targets.push({ kind: "panel" });
      }
      continue;
    }

    if (artifact.kind === "service-db" && !seen.has(`s:${id}`)) {
      seen.add(`s:${id}`);
      targets.push({ kind: "service", id });
    }
    if (artifact.kind.startsWith("project-") && !seen.has(`p:${id}`)) {
      seen.add(`p:${id}`);
      targets.push({ kind: "project", id, include: ["config", "volumes"] });
    }
  }

  if (targets.length === 0) return null;

  emit("Backup di sicurezza di quello che sto per sovrascrivere…");

  // One copy, on the default destination, even when the policies write to
  // several: the restore waits for it, and its job is to undo this restore in
  // the next minutes, not to outlive a disk. Pinned, it is never pruned, so
  // a copy everywhere would pile up on every destination with every restore.
  const { defaultDestinationId } = await import("./destinations");
  const destinationId = await defaultDestinationId();
  if (!destinationId) throw new Error("Nessuna destinazione per il backup di sicurezza");

  const { done, runId } = await startBackup({
    trigger: "pre-restore",
    targets,
    destinationIds: [destinationId],
    policyName: "Sicurezza pre-ripristino",
    pinned: true,
  });

  const summary = await done;
  if (summary.status === "failed") {
    // Refusing here is the whole point: without a copy, a restore that goes
    // wrong has nothing to go back to.
    throw new Error(
      `Il backup di sicurezza è fallito (${summary.error ?? "motivo sconosciuto"}). ` +
        "Il ripristino è stato annullato."
    );
  }

  emit(`Backup di sicurezza pronto: ${runId} (${formatBytes(summary.bytes)})`);
  return runId;
}

// --- Restoring one artifact ---------------------------------------------------

async function restoreArtifact(
  artifact: RestorableArtifact,
  mapping: RestoreMapping,
  archive: ArchiveHandle,
  staging: string,
  emit: (line: string) => void,
  stopped: Stopped
): Promise<void> {
  emit(`→ ${artifact.refName}`);

  switch (artifact.kind) {
    case "service-db":
      return restoreDatabase(artifact, mapping, archive, staging, emit, stopped);
    case "panel-store":
      return restorePanelStore(artifact, archive, emit);
    case "project-config":
      return restoreProjectConfig(artifact, mapping, archive, staging, emit, stopped);
    case "project-volume":
      return restoreVolume(artifact, mapping, archive, staging, emit, stopped);
    case "project-repo":
      return restoreRepo(artifact, mapping, archive, emit, stopped);
    default:
      throw new Error(`Non so ripristinare un elemento di tipo "${artifact.kind}"`);
  }
}

async function extract(archive: ArchiveHandle, entryPath: string, staging: string): Promise<string> {
  if (!isSafeEntryPath(entryPath)) {
    throw new Error(`Nome di file rifiutato nell'archivio: ${entryPath}`);
  }
  const destination = path.join(staging, entryPath);
  await extractArchiveEntry(archive, entryPath, destination);
  return destination;
}

async function requireService(id: string, expectedType: string): Promise<ServicesTable> {
  const db = await getDb();
  const service = await db
    .selectFrom("services")
    .selectAll()
    .where("id", "=", id)
    .executeTakeFirst();

  if (!service) throw new Error("Il servizio di destinazione non esiste più");
  if (expectedType && service.type !== expectedType) {
    // Checked here and not only in the browser: a mismatched engine would
    // either fail confusingly or, worse, half-apply.
    throw new Error(
      `Il backup è di un ${expectedType}, la destinazione è un ${service.type}`
    );
  }
  return service;
}

/**
 * Refuse while anything but this restore is connected to a Postgres server.
 *
 * The script starts with `DROP DATABASE`, in order. Postgres refuses to drop a
 * database in use and `ON_ERROR_STOP` ends the script right there: the databases
 * before it are gone and nothing has been restored. Asked a few times, because an
 * app just stopped takes a moment to let go. Not terminated: as in the database
 * page, ending other people's sessions is not what was confirmed.
 */
async function refuseOpenSessions(target: ServiceTarget, env: Record<string, string>): Promise<void> {
  const sql =
    "SELECT string_agg(DISTINCT datname, ', ') FROM pg_stat_activity " +
    "WHERE datname IS NOT NULL AND pid <> pg_backend_pid() AND backend_type = 'client backend'";

  let busy = "";
  for (let attempt = 0; attempt < SESSION_CHECKS; attempt++) {
    if (attempt > 0) await new Promise((resolve) => setTimeout(resolve, SESSION_CHECK_DELAY_MS));
    const result = await dockerTry(
      [...execArgs(target, env), "psql", "-U", target.credentials.user, "-d", "postgres", "-tAc", sql],
      { env, timeout: 15_000 }
    );
    if (!result) throw new Error("Il servizio non risponde: niente è stato toccato.");
    busy = result.stdout.trim();
    if (!busy) return;
  }

  throw new Error(
    `Ci sono ancora connessioni aperte su ${busy}: chiudile e ripeti il ripristino. Niente è stato toccato.`
  );
}

async function restoreDatabase(
  artifact: RestorableArtifact,
  mapping: RestoreMapping,
  archive: ArchiveHandle,
  staging: string,
  emit: (line: string) => void,
  stopped: Stopped
): Promise<void> {
  const engine = String(artifact.meta.engine ?? "");
  const service = await requireService(mapping.targetId ?? artifact.refId ?? "", engine);
  const target = serviceTarget(service);
  const file = await extract(archive, artifact.entryPath, staging);

  // An app holding its connections would stop the Postgres script halfway, and on
  // any engine a deploy's migration would run into the data being replaced.
  if (service.project_id) {
    const db = await getDb();
    const owner = await db
      .selectFrom("projects")
      .selectAll()
      .where("id", "=", service.project_id)
      .executeTakeFirst();
    if (owner) await takeDown(owner, stopped, emit);
  }

  if (engine === "postgresql") {
    // pg_dumpall and pg_dump --create both carry their own DROP/CREATE, so the
    // restore connects to `postgres` and lets the script do the rest.
    //
    // `-i` on all three engines below: without it `docker exec` does not attach
    // stdin, the client reads an empty script and exits 0, and a restore that
    // wrote nothing reports success.
    const env = { PGPASSWORD: target.credentials.password };
    await refuseOpenSessions(target, env);
    await dockerFromFile(
      [
        ...execArgs(target, env, { interactive: true }),
        ...postgresRestoreCommand(target.credentials.user, artifact.meta.tool),
      ],
      file,
      { env, decompress: true, onStderr: (line) => emit(`  ${line}`) }
    );
  } else if (engine === "mysql") {
    const env = { MYSQL_PWD: target.credentials.password };
    await dockerFromFile(
      [...execArgs(target, env, { interactive: true }), "mysql", "-u", "root"],
      file,
      { env, decompress: true, onStderr: (line) => emit(`  ${line}`) }
    );
    // Some versions' --all-databases includes the `mysql` schema itself, and
    // the grants it just rewrote are not live until this runs.
    await dockerTry(
      [...execArgs(target, env), "mysql", "-u", "root", "-e", "FLUSH PRIVILEGES"],
      { env, timeout: 30_000 }
    );
  } else if (engine === "mongodb") {
    const { env, argv } = mongoToolCall(target, ["mongorestore", "--archive", "--gzip", "--drop"]);
    await dockerFromFile(
      [...execArgs(target, env, { interactive: true }), ...argv],
      file,
      // mongodump already gzipped it, and mongorestore is being told to expect
      // that — decompressing on our side would hand it the wrong thing.
      { env, decompress: false, onStderr: (line) => emit(`  ${line}`) }
    );
  } else if (engine === "redis") {
    await restoreRedis(service, file, emit);
  } else {
    throw new Error(`Motore "${engine}" non supportato per il ripristino`);
  }

  // A full MySQL or Mongo dump carries its server's users. On another service
  // they replace the ones the panel and the linked apps know: said here, because
  // a run ending in success would leave them all locked out with no explanation.
  if (!(await canSignIn(target, engine))) {
    throw new Error(
      "I dati sono stati ripristinati, ma il dump ha sostituito gli utenti del servizio: " +
        "le credenziali salvate nel pannello non funzionano più. Servono quelle del servizio di origine."
    );
  }

  const admin = databaseAdmin(service.type);
  if (admin.supported) {
    // Show what is actually there afterwards rather than asserting success.
    const databases = await admin.list(target).catch(() => []);
    emit(`  database presenti: ${databases.join(", ") || "nessuno"}`);
  }
}

/**
 * Redis is genuinely different: an RDB cannot be loaded into a running server.
 *
 * The order matters and the AOF is the trap — a Redis with append-only enabled
 * rebuilds from the AOF at boot and ignores the RDB entirely, so a restore that
 * only replaced dump.rdb would appear to do nothing at all.
 */
async function restoreRedis(
  service: ServicesTable,
  file: string,
  emit: (line: string) => void
): Promise<void> {
  // Asked, not re-derived. This used to rebuild the volume name from the
  // service name with `projectSlug: null`, so for a Redis inside a project it
  // named `runpanel-redis-<nome>` while the data was in
  // `runpanel-redis-<slug>-<nome>`. `docker run -v` then *created* that empty
  // volume, wrote the dump into it, and the container restarted on the real
  // one: a restore that restored nothing, reported success, and left no trace.
  // Docker knows where the data is mounted — and it keeps knowing once a
  // service can be moved to a host directory.
  const mounts = await containerMounts(service.container_name);
  const data = mounts.find((mount) => mount.destination === "/data");
  const source = data?.name || data?.source;
  if (!source) throw new Error("Non riesco a determinare dove questo Redis tiene i dati");

  emit(`  dati in ${source}`);
  emit("  fermo il servizio…");
  await docker(["stop", service.container_name], { timeout: 60_000 });

  try {
    await dockerFromFile(
      [
        "run", "--rm", "-i",
        "-v", `${source}:/data`,
        "redis:" + service.version,
        "sh", "-c",
        "rm -f /data/appendonly.aof; rm -rf /data/appendonlydir; cat > /data/dump.rdb",
      ],
      file,
      { decompress: true, onStderr: (line) => emit(`  ${line}`) }
    );
  } finally {
    emit("  riavvio il servizio…");
    await docker(["start", service.container_name], { timeout: 60_000 });
  }
}

/**
 * The panel's own store.
 *
 * SQLite is swapped in at the next boot, by `instrumentation.ts`, because a file
 * the process has open cannot be replaced underneath it. Postgres is refused
 * outright: restoring the database you are running on is a stop-the-world
 * operation, and pretending otherwise produces half-restored panels.
 */
async function restorePanelStore(
  artifact: RestorableArtifact,
  archive: ArchiveHandle,
  emit: (line: string) => void
): Promise<void> {
  const env = getEnv();

  if (env.db.driver !== "sqlite") {
    throw new Error(
      "Lo store Postgres del pannello non si ripristina da qui. Ferma RunPanel ed esegui " +
        "pg_restore --clean --if-exists sul dump contenuto nell'archivio: il comando esatto è " +
        "nel LEGGIMI.txt dentro l'archivio stesso."
    );
  }

  const pending = path.join(config.dataDir, "runpanel.restored.db");
  await extractArchiveEntry(archive, artifact.entryPath, pending);
  fs.writeFileSync(path.join(config.dataDir, ".restore-pending"), nowIso(), { mode: 0o600 });

  emit(
    "  store estratto. Verrà messo in servizio al prossimo riavvio del pannello, " +
      "e quello attuale sarà conservato come runpanel.db.pre-restore-<data>."
  );
}

interface ProjectConfigPayload {
  project: ProjectsTable;
  envVars: { key: string; value: string }[];
}

async function readProjectConfig(
  artifact: RestorableArtifact,
  archive: ArchiveHandle,
  staging: string
): Promise<ProjectConfigPayload> {
  const file = await extract(archive, artifact.entryPath, staging);
  let plain: string;
  try {
    plain = decrypt(fs.readFileSync(file, "utf8"));
  } catch {
    // The usual reason is an archive from another panel: the configuration is
    // sealed with the key of the panel that wrote it.
    throw new Error(
      `La configurazione di ${artifact.refName} è cifrata con la chiave di un altro pannello, e senza quella chiave ` +
        "non si legge. Ripristina solo i dati (database e volumi), oppure rimetti prima la chiave di quel pannello."
    );
  }
  return JSON.parse(plain) as ProjectConfigPayload;
}

async function restoreProjectConfig(
  artifact: RestorableArtifact,
  mapping: RestoreMapping,
  archive: ArchiveHandle,
  staging: string,
  emit: (line: string) => void,
  stopped: Stopped
): Promise<void> {
  const payload = await readProjectConfig(artifact, archive, staging);

  const db = await getDb();
  const targetId = mapping.targetId ?? payload.project.id;

  const existing = await db
    .selectFrom("projects")
    .selectAll()
    .where("id", "=", targetId)
    .executeTakeFirst();

  if (!existing) throw new Error("Il progetto di destinazione non esiste più");

  // A deploy under way has read the row this replaces.
  holdProject(existing.id, stopped);

  // One transaction: a configuration applied halfway is worse than one not
  // applied at all, because nothing says which half.
  await db.transaction().execute(async (trx) => {
    await trx
      .updateTable("projects")
      .set({
        builder_config: sealContract(payload.project.builder_config, targetId),
        port: payload.project.port,
        runtime_type: payload.project.runtime_type,
        source_type: payload.project.source_type,
        source_url: payload.project.source_url && stripRemoteCredentials(payload.project.source_url),
        source_branch: payload.project.source_branch,
        app_name: payload.project.app_name,
        // The archive describes a configuration, and a pin is not part of one —
        // it is where this installation happened to hold the project. Left in
        // place, the restored configuration would go out built from a commit
        // that has nothing to do with it.
        pinned_sha: null,
        pinned_at: null,
        // How its volumes are backed up is configuration too. An archive from
        // before the column existed says nothing, and the current value stays.
        ...(payload.project.backup_settings !== undefined
          ? { backup_settings: payload.project.backup_settings }
          : {}),
        updated_at: nowIso(),
      })
      .where("id", "=", targetId)
      .execute();

    await trx.deleteFrom("env_vars").where("project_id", "=", targetId).execute();

    if (payload.envVars.length > 0) {
      await trx
        .insertInto("env_vars")
        .values(
          payload.envVars.map((variable) => ({
            id: generateId(),
            project_id: targetId,
            key: variable.key,
            // Re-encrypted with this panel's key, which may not be the one that
            // produced the archive.
            value: encrypt(variable.value),
            created_at: nowIso(),
          }))
        )
        .execute();
    }
  });

  emit(`  configurazione e ${payload.envVars.length} variabili ripristinate`);
}

async function restoreVolume(
  artifact: RestorableArtifact,
  mapping: RestoreMapping,
  archive: ArchiveHandle,
  staging: string,
  emit: (line: string) => void,
  stopped: Stopped
): Promise<void> {
  const db = await getDb();
  const project = await db
    .selectFrom("projects")
    .selectAll()
    .where("id", "=", mapping.targetId ?? artifact.refId ?? "")
    .executeTakeFirst();

  if (!project) throw new Error("Il progetto di destinazione non esiste più");

  const volume = String(artifact.meta.volume ?? "");
  if (!volume) throw new Error("L'elemento non dice a quale volume appartiene");

  const owned = (await projectVolumes(project.slug)).some((entry) => entry.name === volume);
  if (!owned) {
    throw new Error(
      artifact.meta.composeProject
        ? `Il volume "${volume}" non esiste: lo crea lo stack Compose di ${project.slug}. ` +
            "Fai prima un deploy del progetto, poi ripeti il ripristino."
        : `Il volume "${volume}" non risulta di ${project.slug}`
    );
  }

  const file = await extract(archive, artifact.entryPath, staging);

  // Writing into a volume a running container has mounted is how you get a
  // half-updated dataset, so the project goes down first and comes back in the
  // caller's `finally`.
  // A deploy in the middle would bring the app back onto a half-written volume,
  // which is what the lock in there is for.
  await takeDown(project, stopped, emit);

  // The driver's stop is best-effort — a Compose one needs the compose file in
  // the checkout and swallows its own failure — so what it left running is
  // found by the mount itself, and nothing is written while anything is.
  await holdVolumeForRestore(backupDocker, volume, projectOwner(project.slug), emit, stopped.containers);

  // Read from the artifact, not from today's settings: what matters is what
  // this archive left out. Validated again, since it goes into a shell script.
  const keep = normalizeExcludeList(
    Array.isArray(artifact.meta.excludes)
      ? artifact.meta.excludes.filter((path): path is string => typeof path === "string")
      : []
  );

  await writeVolume(backupDocker, { volume, image: "alpine", archive: file, keep, log: emit });

  emit(`  volume ${volume} ripristinato`);
}

async function restoreRepo(
  artifact: RestorableArtifact,
  mapping: RestoreMapping,
  archive: ArchiveHandle,
  emit: (line: string) => void,
  stopped: Stopped
): Promise<void> {
  const db = await getDb();
  const project = await db
    .selectFrom("projects")
    .selectAll()
    .where("id", "=", mapping.targetId ?? artifact.refId ?? "")
    .executeTakeFirst();

  if (!project) throw new Error("Il progetto di destinazione non esiste più");

  // A build running in this checkout would read files as they are replaced.
  holdProject(project.id, stopped);

  const prefix = String(artifact.meta.prefix ?? artifact.entryPath);
  const entries = (await listArchiveEntries(archive)).filter((entry) =>
    entry.entryPath.startsWith(prefix)
  );

  if (entries.length === 0) throw new Error("Nessun file di repository nell'archivio");

  /*
    Into the folder the app runs from. For a native project with version
    folders that is the current version: its data links lead into the project
    folder, so the data lands there as before, while a file the version holds
    itself — one the app created since it started — is replaced where the app
    reads it, rather than beside it in a project folder the app does not look in.
  */
  const { root: destination, also } = projectFileRoots(project.slug);
  fs.mkdirSync(destination, { recursive: true });

  let written = 0;
  let skipped = 0;
  for (const entry of entries) {
    const relative = entry.entryPath.slice(prefix.length);
    if (!relative || !isSafeEntryPath(relative)) continue;
    // The live checkout may hold links committed after the backup was taken;
    // resolved for real, so a restored file is never written through one —
    // except a version folder's own links into the project folder.
    const target = resolveInside(destination, relative, also);
    if (!target) {
      skipped++;
      continue;
    }
    await extractArchiveEntry(archive, entry.entryPath, target);
    written++;
  }
  if (skipped > 0) emit(`  ${skipped} file saltati: il percorso esce dalla copia locale tramite un collegamento`);

  emit(`  ${written} file ripristinati in ${destination}`);
}
