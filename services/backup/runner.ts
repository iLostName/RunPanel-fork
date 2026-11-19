import fs from "fs";
import path from "path";
import { getDb, nowIso } from "@/lib/db";
import type {
  BackupArtifactStatus,
  BackupRunStatus,
  BackupTrigger,
  ProjectsTable,
} from "@/lib/db/schema";
import { generateId } from "@/lib/utils";
import { formatBytes, formatWhen } from "@/lib/format";
import { copiesLabel, countCopies, primaryCopy, runOutcome } from "@/lib/backup-copies";
import { panelVersion } from "@/lib/version";
import { opsEvents } from "../events";
import { notify } from "../notify";
import { isDockerAvailable } from "../docker/cli";
import { writeArchive } from "./archive";
import {
  copyReport,
  noCopyMessage,
  pendingCopyRows,
  planCopies,
  runCopies,
  sendCopies,
  type CopyRecord,
} from "./copies";
import { DumpSkipped, dumpServiceDatabase } from "./dumpers";
import { sealForNewArchive } from "./keyring";
import { dumpPanelStore } from "./panel-store";
import {
  FREE_SPACE_RESERVE,
  archiveFileName,
  backupLog,
  clearStaging,
  freeBytes,
  relativeArchivePath,
  stagingDir,
} from "./paths";
import { resumeAbandonedPauses } from "./pause-journal";
import {
  exportProjectConfig,
  exportProjectRepo,
  exportProjectVolume,
  projectVolumes,
  shouldIncludeRepo,
} from "./project-export";
import { applyRetention } from "./retention";
import type {
  BackupJob,
  BackupManifest,
  BackupTarget,
  JobOutcome,
  RunContext,
  StagedFile,
} from "./types";
import type { ProjectVolume } from "./volume-ops";
import { serviceDisplayName } from "@/lib/service-name";
import { isPanelClosing, PANEL_CLOSING_MESSAGE } from "../project-lock";

/**
 * One backup, start to finish.
 *
 * The shape that matters: a target that fails does not end the run. A night
 * where nine of ten databases were saved is worth having, and a run that aborted
 * on the first unreachable container would have saved none of them. Failures
 * become artifacts with a reason, and the run closes `partial`.
 */

export interface RunRequest {
  trigger: BackupTrigger;
  targets: BackupTarget[];
  /**
   * Where the archive goes, in order: the first is the primary, every other a
   * copy of the same file (services/backup/copies.ts).
   */
  destinationIds?: string[];
  /** One destination: the same as `destinationIds: [destinationId]`. */
  destinationId?: string;
  policyId?: string | null;
  policyName?: string | null;
  includeSecretKey?: boolean;
  /** Exempt from retention. Safety dumps taken before a restore are. */
  pinned?: boolean;
  signal?: AbortSignal;
}

export interface RunSummary {
  runId: string;
  status: BackupRunStatus;
  ok: number;
  failed: number;
  skipped: number;
  bytes: number;
  error?: string;
}

/**
 * One at a time, process-wide. Dumps are heavy on the same disk and CPU the
 * user's applications are running on, and two of them at once turn a background
 * chore into an outage.
 */
const globalRef = globalThis as typeof globalThis & {
  __runpanelBackupActive?: string | null;
  __runpanelRestoreActive?: string | null;
};

export function activeBackupRunId(): string | null {
  return globalRef.__runpanelBackupActive ?? null;
}

export class BackupBusyError extends Error {
  constructor(message = "Un backup è già in corso") {
    super(message);
    this.name = "BackupBusyError";
  }
}


/**
 * Create the run and return as soon as its row exists, with the work still
 * going.
 *
 * The split matters for one reason: "Esegui ora" has to answer with an id the
 * browser can immediately open a log stream on. Doing the insert first and the
 * dumping after means there is no window where the client holds an id the
 * database has never heard of.
 */
export async function startBackup(
  request: RunRequest
): Promise<{ runId: string; done: Promise<RunSummary> }> {
  if (globalRef.__runpanelBackupActive) throw new BackupBusyError();
  // The panel exits in a moment, and a half-written archive is not a backup.
  if (isPanelClosing()) throw new BackupBusyError(PANEL_CLOSING_MESSAGE);
  // A restore writes the very data a backup would read; only its own safety
  // copy may run alongside it. Read through globalThis: restore.ts imports
  // this module, so importing it back would be a cycle.
  if (globalRef.__runpanelRestoreActive && request.trigger !== "pre-restore") {
    throw new BackupBusyError("Un ripristino è in corso: il backup non parte finché non finisce");
  }

  // Claimed before the first await, so two starts in the same tick (the
  // scheduler and "Esegui ora") cannot both pass the check above. Released
  // only by its owner, so a finishing run never clears another one's claim.
  const runId = generateId();
  globalRef.__runpanelBackupActive = runId;
  const release = () => {
    if (globalRef.__runpanelBackupActive === runId) globalRef.__runpanelBackupActive = null;
  };

  // Anything that throws before the run exists must give the claim back.
  let db: Awaited<ReturnType<typeof getDb>>;
  let log: ReturnType<typeof backupLog>;
  let plan: Awaited<ReturnType<typeof planCopies>>;
  try {
    db = await getDb();
    log = backupLog(runId);
    plan = await planCopies(request.destinationIds ?? (request.destinationId ? [request.destinationId] : []));
  } catch (err) {
    release();
    throw err;
  }
  const startedAt = new Date();

  const emit = (line: string) => {
    log.append(line);
    opsEvents.emit(runId, { type: "backup:log", line });
  };

  // The run and the copies it will make, together: the page that opens on
  // the id shows from the first second where the archive is going. The flag
  // is already up: a failed write must not leave it there forever.
  await db
    .transaction()
    .execute(async (trx) => {
      await trx
        .insertInto("backup_runs")
        .values({
          id: runId,
          policy_id: request.policyId ?? null,
          policy_name: request.policyName ?? null,
          trigger: request.trigger,
          status: "running",
          // The primary, as before copies: what every older reader looks at.
          destination_id: plan.planned[0]?.destination.id ?? null,
          archive_path: null,
          archive_bytes: null,
          checksum: null,
          manifest: null,
          error_message: null,
          pinned: request.pinned ? 1 : 0,
          started_at: startedAt.toISOString(),
          finished_at: null,
          heartbeat_at: startedAt.toISOString(),
        })
        .execute();
      if (plan.planned.length > 0) {
        await trx.insertInto("backup_run_copies").values(pendingCopyRows(runId, plan.planned, startedAt.toISOString())).execute();
      }
    })
    .catch((err: unknown) => {
      release();
      throw err;
    });

  opsEvents.emit(runId, { type: "backup:status", status: "running" });

  const done = execute({ runId, request, startedAt, emit, log, missing: plan.missing }).finally(release);

  return { runId, done };
}

/** Start a backup and wait for it. What the scheduler uses. */
export async function runBackup(request: RunRequest): Promise<RunSummary> {
  const { done } = await startBackup(request);
  return done;
}

interface ExecuteArgs {
  runId: string;
  request: RunRequest;
  startedAt: Date;
  emit: (line: string) => void;
  log: { flush: () => void };
  /** Destinations asked for that no longer exist. */
  missing: string[];
}

async function execute({ runId, request, startedAt, emit, log, missing }: ExecuteArgs): Promise<RunSummary> {
  const db = await getDb();

  // A run that hangs on an unresponsive engine should look hung, not finished.
  const heartbeat = setInterval(() => {
    void db
      .updateTable("backup_runs")
      .set({ heartbeat_at: nowIso() })
      .where("id", "=", runId)
      .execute()
      .catch(() => {});
  }, 30_000);
  heartbeat.unref?.();

  const ctx: RunContext = {
    runId,
    stagingDir: stagingDir(runId),
    log: emit,
    signal: request.signal,
    preBackup: new Map(),
  };
  fs.mkdirSync(ctx.stagingDir, { recursive: true });

  let summary: RunSummary = { runId, status: "failed", ok: 0, failed: 0, skipped: 0, bytes: 0 };
  let copies: CopyRecord[] = [];

  try {
    const free = freeBytes();
    if (free !== null && free < FREE_SPACE_RESERVE) {
      throw new Error(
        `Spazio insufficiente: liberi ${formatBytes(free)}, ne servono almeno ${formatBytes(FREE_SPACE_RESERVE)}`
      );
    }

    emit(`Backup ${runId} — ${request.policyName ?? "esecuzione manuale"}`);

    // Before any dump: an archive with nowhere to go is an hour of dumps for
    // nothing, found out at the end.
    if (missing.length > 0) {
      emit(missing.length === 1 ? "Una destinazione non esiste più: la salto" : `${missing.length} destinazioni non esistono più: le salto`);
    }
    copies = await runCopies(runId);
    if (copies.length === 0) throw new Error("Nessuna destinazione configurata per questo backup");
    if (copies.length > 1) {
      emit(`${copies.length} copie: ${copies.map((copy) => `«${copy.name}»`).join(", ")}`);
    }

    // Before any dump: a password that is on but cannot be read stops the run
    // now, not after an hour of copying, and never lets the archive out in clear.
    const seal = await sealForNewArchive();

    const resumed = await resumeAbandonedPauses().catch(() => 0);
    if (resumed > 0) emit(`Ripresi ${resumed} container rimasti in pausa da un backup interrotto`);
    if (!(await isDockerAvailable())) {
      // Recorded as a failed run, never skipped in silence: a policy that
      // quietly does nothing is worse than one that visibly fails.
      emit("Docker non è raggiungibile: i dump dei container non sono possibili");
    }

    const jobs = await resolveJobs(request.targets, request.includeSecretKey ?? false, emit);
    emit(`${jobs.length} elementi da salvare`);

    const outcomes: JobOutcome[] = [];
    for (const job of jobs) {
      if (request.signal?.aborted) throw new Error("Backup annullato");
      outcomes.push(await runJob(job, ctx));

      const remaining = freeBytes();
      if (remaining !== null && remaining < FREE_SPACE_RESERVE) {
        throw new Error(
          `Spazio esaurito durante il backup: liberi ${formatBytes(remaining)}`
        );
      }
    }

    const ok = outcomes.filter((o) => o.status === "ok");
    const failed = outcomes.filter((o) => o.status === "failed");
    const skipped = outcomes.filter((o) => o.status === "skipped");

    await recordArtifacts(runId, outcomes);

    if (ok.length === 0) {
      throw new Error(
        failed.length > 0
          ? `Nessun elemento salvato: ${failed[0].error ?? "errore sconosciuto"}`
          : "Nessun elemento da salvare"
      );
    }

    const manifest: BackupManifest = {
      schemaVersion: 1,
      runId,
      policyId: request.policyId ?? null,
      policyName: request.policyName ?? null,
      trigger: request.trigger,
      createdAt: startedAt.toISOString(),
      panel: { version: panelVersion(), storeDriver: (await import("@/lib/env")).getEnv().db.driver },
      artifacts: outcomes.map((outcome) => ({
        kind: outcome.kind,
        refId: outcome.refId,
        refName: outcome.refName,
        entryPath: outcome.entryPath,
        bytes: outcome.bytes,
        sha256: outcome.sha256,
        status: outcome.status,
        error: outcome.error,
        meta: outcome.meta,
      })),
    };

    const files: StagedFile[] = outcomes.flatMap((outcome) => outcome.files);
    const fileName = archiveFileName(runId, request.policyName ?? null, startedAt, { encrypted: seal !== null });

    emit(
      seal
        ? `Creo l'archivio cifrato con la password dei backup${seal.keyCreatedAt ? ` del ${formatWhen(seal.keyCreatedAt)}` : ""} (${files.length} file)…`
        : `Creo l'archivio (${files.length} file)…`
    );
    // Written once into staging — encrypted, when a password is set — and the
    // same file then handed to every destination in turn. Each one leaves it
    // in place (on this disk a local destination links it: atomic and free),
    // and it goes with the staging directory once they have all finished.
    const staged = path.join(ctx.stagingDir, fileName);
    const archive = await writeArchive(staged, files, manifest, { seal });

    // Before the first copy leaves: a panel that stops halfway through the
    // copies finds at the next boot an archive it can still describe, and
    // the copies that did arrive (lib/db/index.ts, `recoverFromCrash`).
    await db
      .updateTable("backup_runs")
      .set({
        checksum: archive.sha256,
        encryption_key_id: seal?.keyId ?? null,
        manifest: JSON.stringify(manifest),
        heartbeat_at: nowIso(),
      })
      .where("id", "=", runId)
      .execute();

    copies = await sendCopies({
      runId,
      file: archive.absolutePath,
      fileName,
      bytes: archive.bytes,
      sha256: archive.sha256,
      emit,
      signal: request.signal,
    });
    const count = countCopies(copies);
    if (count.done === 0) throw new Error(noCopyMessage(copies));
    if (count.failed > 0) {
      emit(
        `${copiesLabel(count)} salvate: l'archivio è al sicuro, ma ${count.failed === 1 ? "una copia non è arrivata" : `${count.failed} copie non sono arrivate`}. Si possono riprovare dalla pagina di questo backup.`
      );
    }

    const status = runOutcome(failed.length, count) as BackupRunStatus;
    const primary = primaryCopy(copies);

    await db
      .updateTable("backup_runs")
      .set({
        status,
        archive_path: primary?.ref ?? null,
        archive_bytes: primary?.bytes ?? archive.bytes,
        destination_id: primary?.destination_id ?? copies[0]?.destination_id ?? null,
        finished_at: nowIso(),
        heartbeat_at: nowIso(),
        error_message: failed.length > 0 ? `${failed.length} elementi non salvati` : null,
      })
      .where("id", "=", runId)
      .execute();

    opsEvents.emit(runId, { type: "backup:status", status });

    summary = {
      runId,
      status,
      ok: ok.length,
      failed: failed.length,
      skipped: skipped.length,
      bytes: primary?.bytes ?? archive.bytes,
    };

    // Only after a success, and never the newest one: a disk that is full must
    // not be able to delete the last good backup while trying to make room.
    // Its own try: a destination that will not answer a delete must not turn
    // the backup that just succeeded into a failed one.
    try {
      const pruned = await applyRetention(request.policyId ?? null);
      if (pruned.copies > 0) emit(`Retention: ${retentionLine(pruned)}`);
    } catch (err) {
      emit(`Retention non applicata: ${err instanceof Error ? err.message : String(err)}`);
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    emit(`ERRORE: ${message}`);
    summary = { ...summary, status: "failed", error: message };

    await db
      .updateTable("backup_runs")
      .set({
        status: "failed",
        error_message: message,
        finished_at: nowIso(),
        heartbeat_at: nowIso(),
      })
      .where("id", "=", runId)
      .execute();

    // Copies that never got their turn say why, instead of waiting for ever.
    await db
      .updateTable("backup_run_copies")
      .set({ status: "failed", error_message: "Il backup si è fermato prima di questa copia", finished_at: nowIso() })
      .where("run_id", "=", runId)
      .where("status", "in", ["pending", "uploading"])
      .execute()
      .catch(() => {});
    copies = await runCopies(runId).catch(() => copies);

    opsEvents.emit(runId, { type: "backup:status", status: "failed", message });
  } finally {
    clearInterval(heartbeat);
    clearStaging(runId);
    log.flush();

    /*
      In the `finally`, which is the only line both exits pass through.

      A backup is the one operation whose failure is invisible by design: it
      runs at four in the morning, writes to a directory nobody opens, and the
      day you find out it stopped working is the day you needed it. Success is
      announced too, and deliberately — a channel that only ever speaks up when
      something is wrong teaches you nothing about whether it is still working.
    */
    void notify({
      key: "backup.finished",
      policy: request.policyName ?? null,
      status: summary.status,
      ok: summary.ok,
      failed: summary.failed,
      skipped: summary.skipped,
      bytes: summary.bytes,
      durationMs: Date.now() - startedAt.getTime(),
      error: summary.error ?? null,
      // Only once there was an archive to copy: a run that failed before has
      // nothing to say about its copies that the error does not already say.
      ...(summary.status !== "failed" ? { copies: copyReport(copies) } : {}),
    });
  }

  return summary;
}

function retentionLine(pruned: { copies: number; runs: number }): string {
  if (pruned.copies === pruned.runs) {
    return pruned.runs === 1 ? "rimosso l'archivio più vecchio" : `rimossi ${pruned.runs} archivi più vecchi`;
  }
  return `${pruned.copies === 1 ? "rimossa una copia più vecchia" : `rimosse ${pruned.copies} copie più vecchie`}, ognuna con la conservazione della sua destinazione`;
}

// --- Turning selectors into work --------------------------------------------

async function resolveJobs(
  targets: BackupTarget[],
  includeSecret: boolean,
  log: (line: string) => void
): Promise<BackupJob[]> {
  const db = await getDb();
  const jobs: BackupJob[] = [];
  const seen = new Set<string>();

  const push = (job: BackupJob, key: string) => {
    // `all-services` alongside a named service would otherwise dump it twice.
    if (seen.has(key)) return;
    seen.add(key);
    jobs.push(job);
  };

  const addService = async (id: string, databases?: string[]) => {
    const service = await db
      .selectFrom("services")
      .selectAll()
      .where("id", "=", id)
      .executeTakeFirst();

    if (!service) {
      push(
        {
          kind: "missing",
          targetKind: "service-db",
          refId: id,
          refName: id,
          reason: "Il database non esiste più",
        },
        `missing:service:${id}`
      );
      return;
    }

    if (!databases || databases.length === 0) {
      push({ kind: "service-db", service, database: null }, `service:${id}:*`);
      return;
    }
    for (const database of databases) {
      push({ kind: "service-db", service, database }, `service:${id}:${database}`);
    }
  };

  const addProject = async (project: ProjectsTable, include: string[]) => {
    if (include.includes("config")) {
      push({ kind: "project-config", project }, `config:${project.id}`);
    }
    if (shouldIncludeRepo(project, include.includes("repo"))) {
      push({ kind: "project-repo", project }, `repo:${project.id}`);
    }
    if (include.includes("volumes")) {
      let volumes: ProjectVolume[];
      try {
        volumes = await projectVolumes(project.slug);
      } catch (err) {
        // Recorded rather than swallowed: an empty list here used to look
        // exactly like a project that has no data, and the run said nothing.
        push(
          {
            kind: "missing",
            targetKind: "project-volume",
            refId: project.id,
            refName: `${project.slug} — volumi`,
            reason: `Impossibile elencare i volumi: ${err instanceof Error ? err.message : String(err)}`,
          },
          `volumes-unlisted:${project.id}`
        );
        return;
      }

      log(
        volumes.length > 0
          ? `${project.slug}: ${volumes.length} volum${volumes.length === 1 ? "e" : "i"} — ${volumes
              .map((volume) => (volume.origin === "compose" ? `${volume.name} (Compose)` : volume.name))
              .join(", ")}`
          : `${project.slug}: nessun volume trovato`
      );
      for (const volume of volumes) {
        push({ kind: "project-volume", project, volume: volume.name }, `volume:${volume.name}`);
      }
    }
  };

  for (const target of targets) {
    switch (target.kind) {
      case "panel":
        push({ kind: "panel-store", includeSecret }, "panel");
        break;

      case "service":
        await addService(target.id, target.databases);
        break;

      case "all-services": {
        const services = await db.selectFrom("services").select("id").execute();
        for (const service of services) await addService(service.id);
        break;
      }

      case "project": {
        const project = await db
          .selectFrom("projects")
          .selectAll()
          .where("id", "=", target.id)
          .executeTakeFirst();
        if (!project) {
          push(
            {
              kind: "missing",
              targetKind: "project-config",
              refId: target.id,
              refName: target.id,
              reason: "Il progetto non esiste più",
            },
            `missing:project:${target.id}`
          );
          break;
        }
        await addProject(project, target.include);
        break;
      }

      case "all-projects": {
        const projects = await db.selectFrom("projects").selectAll().execute();
        for (const project of projects) await addProject(project, target.include);
        break;
      }
    }
  }

  return jobs;
}

// --- Running one job ---------------------------------------------------------

function describe(job: BackupJob): { refId: string | null; refName: string } {
  switch (job.kind) {
    case "service-db":
      return {
        refId: job.service.id,
        refName: job.database
          ? `${serviceDisplayName(job.service)} / ${job.database}`
          : serviceDisplayName(job.service),
      };
    case "panel-store":
      return { refId: null, refName: "Store del pannello" };
    case "project-config":
      return { refId: job.project.id, refName: `${job.project.slug} — configurazione` };
    case "project-repo":
      return { refId: job.project.id, refName: `${job.project.slug} — repository` };
    case "project-volume":
      return { refId: job.project.id, refName: `${job.project.slug} — volume ${job.volume}` };
    case "missing":
      return { refId: job.refId, refName: job.refName };
  }
}

function artifactKind(job: BackupJob) {
  return job.kind === "missing" ? job.targetKind : job.kind;
}

async function runJob(job: BackupJob, ctx: RunContext): Promise<JobOutcome> {
  const { refId, refName } = describe(job);
  const kind = artifactKind(job);

  const outcome = (
    status: BackupArtifactStatus,
    extra: Partial<JobOutcome> = {}
  ): JobOutcome => ({
    kind,
    refId,
    refName,
    status,
    entryPath: "",
    files: [],
    bytes: 0,
    sha256: null,
    ...extra,
  });

  if (job.kind === "missing") {
    ctx.log(`— ${refName}: ${job.reason}`);
    opsEvents.emit(ctx.runId, {
      type: "backup:artifact",
      label: refName,
      status: "skipped",
      error: job.reason,
    });
    return outcome("skipped", { error: job.reason });
  }

  try {
    const produced = await produce(job, ctx);
    opsEvents.emit(ctx.runId, {
      type: "backup:artifact",
      label: refName,
      status: "ok",
      bytes: produced.bytes,
    });
    return outcome("ok", produced);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const status: BackupArtifactStatus = err instanceof DumpSkipped ? "skipped" : "failed";
    ctx.log(`${status === "skipped" ? "—" : "✗"} ${refName}: ${message}`);
    opsEvents.emit(ctx.runId, {
      type: "backup:artifact",
      label: refName,
      status,
      error: message,
    });
    return outcome(status, { error: message });
  }
}

async function produce(
  job: Exclude<BackupJob, { kind: "missing" }>,
  ctx: RunContext
): Promise<Pick<JobOutcome, "entryPath" | "files" | "bytes" | "sha256" | "meta">> {
  switch (job.kind) {
    case "service-db": {
      const dump = await dumpServiceDatabase(job.service, job.database, ctx);
      return {
        entryPath: dump.entryPath,
        files: [dump],
        bytes: dump.bytes,
        sha256: dump.sha256,
        meta: dump.meta,
      };
    }

    case "panel-store": {
      const dump = await dumpPanelStore(ctx, job.includeSecret);
      const primary = dump.files[0];
      return {
        entryPath: primary.entryPath,
        files: dump.files,
        bytes: dump.files.reduce((total, file) => total + file.bytes, 0),
        sha256: primary.sha256,
        meta: dump.meta,
      };
    }

    case "project-config": {
      const exported = await exportProjectConfig(job.project, ctx);
      return {
        entryPath: exported.files[0].entryPath,
        files: exported.files,
        bytes: exported.files.reduce((total, file) => total + file.bytes, 0),
        sha256: exported.files[0].sha256,
        meta: exported.meta,
      };
    }

    case "project-repo": {
      const exported = await exportProjectRepo(job.project, ctx);
      return {
        // A tree, so the artifact points at the prefix its entries share.
        entryPath: `projects/${job.project.slug}/repo/`,
        files: exported.files,
        bytes: exported.files.reduce((total, file) => total + file.bytes, 0),
        sha256: null,
        meta: exported.meta,
      };
    }

    case "project-volume": {
      const exported = await exportProjectVolume(job.project, job.volume, ctx);
      return {
        entryPath: exported.file.entryPath,
        files: [exported.file],
        bytes: exported.file.bytes,
        sha256: exported.file.sha256,
        meta: exported.meta,
      };
    }
  }
}

async function recordArtifacts(runId: string, outcomes: JobOutcome[]): Promise<void> {
  if (outcomes.length === 0) return;

  const db = await getDb();
  const now = nowIso();

  await db
    .insertInto("backup_artifacts")
    .values(
      outcomes.map((outcome) => ({
        id: generateId(),
        run_id: runId,
        kind: outcome.kind,
        ref_id: outcome.refId,
        ref_name: outcome.refName,
        entry_path: outcome.entryPath,
        bytes: outcome.bytes,
        checksum: outcome.sha256,
        status: outcome.status,
        error_message: outcome.error ?? null,
        meta: outcome.meta ? JSON.stringify(outcome.meta) : null,
        created_at: now,
      }))
    )
    .execute();
}

export { relativeArchivePath };
