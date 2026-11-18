import fs from "fs";
import path from "path";
import { config } from "@/lib/config";
import { getDb, nowIso } from "@/lib/db";
import type { BackupCopyStatus, BackupDestinationsTable, BackupRunCopiesTable, BackupRunsTable } from "@/lib/db/schema";
import { formatBytes } from "@/lib/format";
import { S3Failure } from "@/lib/s3-errors";
import { generateId } from "@/lib/utils";
import { countCopies, primaryCopy, readOrder, retryProblem, type CopyCount } from "@/lib/backup-copies";
import { opsEvents } from "../events";
import { isPanelClosing, PANEL_CLOSING_MESSAGE } from "../project-lock";
import { archiveForRestore } from "./archive-source";
import { buildDestination, destinationFacts } from "./destinations";
import { hashFile } from "./integrity";
import { FREE_SPACE_RESERVE, archiveFileName, assertBackupId, backupLog, freeBytes } from "./paths";
import type { Destination } from "./types";

/**
 * Several copies of every backup.
 *
 * A run writes its archive once — encrypted, when a backup password is set —
 * and then hands that one staged file to every destination of its policy, in
 * the policy's order, one after the other: the uplink is shared, so two
 * uploads at once finish no sooner than one after the other, and a machine
 * that is also serving the user's applications gets one predictable load
 * instead of several. The primary goes first, so the run is restorable as
 * early as it can be. A copy that fails does not fail the run; only a run with
 * no copy at all failed.
 *
 * Reading goes the other way: a restore, a download or an integrity check
 * takes the first copy that answers — the ones on this disk first — and moves
 * on to the next when one is missing or unreachable (`readFirstCopy`).
 *
 * The rules themselves (order, outcome, retention) are pure, in
 * lib/backup-copies.ts; this file is their storage and their I/O.
 */

/** A copy as the readers need it: the row, plus what its destination is now. */
export interface CopyRecord extends BackupRunCopiesTable {
  /** The destination's name now, or the one it had when it was deleted. */
  name: string;
  type: string;
  /** Its destination still exists. */
  configured: boolean;
  /** Its destination keeps archives on this server's disk. */
  local: boolean;
  row: BackupDestinationsTable | null;
}

// --- Planning and recording ---------------------------------------------------

export interface PlannedCopy {
  destination: BackupDestinationsTable;
  position: number;
}

/**
 * The destinations a run writes to, in the order asked, each once. An id that
 * no longer exists is left out and named, so the run can say so rather than
 * fail on it after an hour of dumps.
 */
export async function planCopies(destinationIds: readonly string[]): Promise<{ planned: PlannedCopy[]; missing: string[] }> {
  const ids = [...new Set(destinationIds)];
  if (ids.length === 0) return { planned: [], missing: [] };
  const db = await getDb();
  const rows = await db.selectFrom("backup_destinations").selectAll().where("id", "in", ids).execute();
  const byId = new Map(rows.map((row) => [row.id, row]));
  const planned: PlannedCopy[] = [];
  const missing: string[] = [];
  for (const id of ids) {
    const row = byId.get(id);
    if (row) planned.push({ destination: row, position: planned.length });
    else missing.push(id);
  }
  return { planned, missing };
}

/** The rows a run starts with: every copy waiting its turn. */
export function pendingCopyRows(runId: string, planned: readonly PlannedCopy[], at: string): BackupRunCopiesTable[] {
  return planned.map(({ destination, position }) => ({
    id: generateId(),
    run_id: runId,
    destination_id: destination.id,
    destination_name: destination.name,
    destination_type: destination.type,
    position,
    status: "pending" as BackupCopyStatus,
    ref: null,
    bytes: null,
    error_message: null,
    started_at: null,
    finished_at: null,
    created_at: at,
  }));
}

type CopyPatch = Partial<Pick<BackupRunCopiesTable, "status" | "ref" | "bytes" | "error_message" | "started_at" | "finished_at">>;

async function markCopy(copyId: string, patch: CopyPatch): Promise<void> {
  const db = await getDb();
  await db.updateTable("backup_run_copies").set(patch).where("id", "=", copyId).execute();
}

/** Every copy of these runs, in the policy's order, with what their destinations are now. */
export async function loadCopies(runIds: readonly string[]): Promise<Map<string, CopyRecord[]>> {
  const out = new Map<string, CopyRecord[]>();
  if (runIds.length === 0) return out;
  const db = await getDb();
  const [rows, destinations] = await Promise.all([
    db
      .selectFrom("backup_run_copies")
      .selectAll()
      .where("run_id", "in", [...new Set(runIds)])
      .orderBy("position", "asc")
      .execute(),
    db.selectFrom("backup_destinations").selectAll().execute(),
  ]);
  const byId = new Map(destinations.map((row) => [row.id, row]));
  const facts = destinationFacts(destinations);
  for (const row of rows) {
    const destination = row.destination_id ? byId.get(row.destination_id) ?? null : null;
    const record: CopyRecord = {
      ...row,
      name: destination?.name ?? row.destination_name,
      type: destination?.type ?? row.destination_type,
      configured: destination !== null,
      local: destination ? facts.get(destination.id)?.local === true : false,
      row: destination,
    };
    const list = out.get(row.run_id);
    if (list) list.push(record);
    else out.set(row.run_id, [record]);
  }
  return out;
}

export async function runCopies(runId: string): Promise<CopyRecord[]> {
  return (await loadCopies([runId])).get(runId) ?? [];
}

/**
 * Point the run's own `archive_path`, `archive_bytes` and `destination_id` at
 * its primary copy — the first in order that holds the archive.
 *
 * Those columns are what everything written before copies existed reads, the
 * API's `hasArchive` and `destinationName` among them, so they are kept true
 * whenever a copy arrives or goes.
 */
export async function syncRunArchive(runId: string): Promise<void> {
  const copies = await runCopies(runId);
  if (copies.length === 0) return;
  const primary = primaryCopy(copies);
  const db = await getDb();
  await db
    .updateTable("backup_runs")
    .set({
      archive_path: primary?.ref ?? null,
      archive_bytes: primary?.bytes ?? null,
      destination_id: primary ? primary.destination_id : copies[0].destination_id,
    })
    .where("id", "=", runId)
    .execute();
}

// --- Sending the copies of a new run ----------------------------------------------

export interface SendArgs {
  runId: string;
  /** The staged archive; left in place, the caller removes it. */
  file: string;
  fileName: string;
  bytes: number;
  emit: (line: string) => void;
  signal?: AbortSignal;
}

/**
 * Hand the staged archive to every destination of the run, in order, one at a
 * time. Each copy's outcome is written as it happens, so a panel that stops
 * halfway knows at the next boot which copies arrived.
 */
export async function sendCopies({ runId, file, fileName, bytes, emit, signal }: SendArgs): Promise<CopyRecord[]> {
  const copies = await runCopies(runId);
  const single = copies.length === 1;

  for (const [index, copy] of copies.entries()) {
    if (copy.status !== "pending") continue;
    if (signal?.aborted) {
      await settle(runId, copy, { status: "failed", error_message: "Backup annullato prima di questa copia", finished_at: nowIso() });
      continue;
    }
    if (!copy.row) {
      await settle(runId, copy, { status: "failed", error_message: "La destinazione non esiste più", finished_at: nowIso() });
      emit(`✗ «${copy.name}»: la destinazione non esiste più`);
      continue;
    }

    await settle(runId, copy, { status: "uploading", started_at: nowIso() });
    let destination: Destination;
    try {
      destination = buildDestination(copy.row);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await settle(runId, copy, { status: "failed", error_message: message, finished_at: nowIso() });
      emit(`✗ «${copy.name}»: ${message}`);
      continue;
    }

    if (single) {
      if (destination.type !== "local") emit(`Carico l'archivio su «${destination.name}» (${formatBytes(bytes)})…`);
    } else {
      emit(`Copia ${index + 1} di ${copies.length}: «${destination.name}»${destination.localPath ? "" : ` (${formatBytes(bytes)})`}…`);
    }

    try {
      const stored = await destination.put(file, fileName);
      await settle(runId, copy, { status: "done", ref: stored.ref, bytes: stored.bytes, error_message: null, finished_at: nowIso() });
      emit(single ? `Archivio pronto: ${formatBytes(stored.bytes)} — ${stored.ref}` : `  ✓ salvata: ${formatBytes(stored.bytes)} — ${stored.ref}`);
    } catch (err) {
      // The sentence a person acts on goes into the copy; the provider's own
      // code and words, for whoever reads the log, go there.
      if (err instanceof S3Failure && err.problem.detail) emit(`  dettaglio: ${err.problem.detail}`);
      const message = err instanceof Error ? err.message : String(err);
      await settle(runId, copy, { status: "failed", error_message: message, finished_at: nowIso() });
      // With one destination the run itself fails with this sentence, and says it.
      if (!single) emit(`  ✗ non riuscita: ${message}`);
    }
  }

  return runCopies(runId);
}

/** Write a copy's new state and tell whoever is watching the run. */
async function settle(runId: string, copy: CopyRecord, patch: CopyPatch): Promise<void> {
  await markCopy(copy.id, patch);
  opsEvents.emit(runId, {
    type: "backup:copy",
    copyId: copy.id,
    destination: copy.name,
    status: patch.status ?? copy.status,
    ...(patch.bytes ? { bytes: patch.bytes } : {}),
    ...(patch.error_message ? { error: patch.error_message } : {}),
  });
}

/** Why a run has no archive anywhere: what each copy said. */
export function noCopyMessage(copies: readonly CopyRecord[]): string {
  if (copies.length === 0) return "Nessuna destinazione per questo backup";
  if (copies.length === 1) {
    return `Salvataggio su «${copies[0].name}» non riuscito: ${copies[0].error_message ?? "motivo sconosciuto"}`;
  }
  return `Nessuna copia salvata: ${copies.map((copy) => `«${copy.name}»: ${copy.error_message ?? "motivo sconosciuto"}`).join("; ")}`;
}

/** What the notification says about the copies. */
export function copyReport(copies: readonly CopyRecord[]): { total: number; saved: number; failed: { name: string; error: string }[] } {
  const count: CopyCount = countCopies(copies);
  return {
    total: count.total,
    saved: count.done,
    failed: copies
      .filter((copy) => copy.status === "failed")
      .map((copy) => ({ name: copy.name, error: copy.error_message ?? "motivo sconosciuto" })),
  };
}

// --- Reading: the first copy that answers -----------------------------------------------

export interface FoundCopy {
  copy: CopyRecord;
  destination: Destination;
  /** As the destination reports it. */
  bytes: number;
}

/**
 * Stop trying copies: what went wrong is not about this copy, and would go
 * wrong with every other — a missing password, an archive that is not this
 * run's.
 */
export class StopFallback extends Error {
  readonly inner: Error;
  constructor(inner: Error) {
    super(inner.message);
    this.name = "StopFallback";
    this.inner = inner;
  }
}

function describeMissing(destination: Destination): string {
  return destination.localPath
    ? `L'archivio non è più in «${destination.name}», sul disco di questo server: è stato spostato o eliminato fuori dal pannello, o il disco non è montato.`
    : `L'archivio non c'è più in «${destination.name}»: è stato eliminato fuori dal pannello, o da una regola di scadenza del servizio.`;
}

/**
 * Hand `read` the first copy of the run that answers, in read order: the ones
 * on this server's disk first, then the policy's order. A copy whose
 * destination is gone, does not answer or no longer has the file is skipped,
 * and so is one for which `read` throws — a download cut off, an archive whose
 * sha256 is not the one recorded — unless it throws `StopFallback`.
 *
 * `log` hears every copy that was passed over, and why: a restore that read
 * the second copy says so.
 */
export async function readFirstCopy<T>(
  runId: string,
  read: (found: FoundCopy) => Promise<T>,
  opts: { log?: (line: string) => void; exclude?: string } = {}
): Promise<T> {
  const copies = await runCopies(runId);
  const order = readOrder(copies).filter((copy) => copy.id !== opts.exclude && copy.ref);
  if (order.length === 0) {
    const gone = copies.some((copy) => copy.status === "done" && !copy.configured);
    throw new Error(
      gone
        ? "La destinazione di questo backup non è più configurata: l'archivio, se c'è ancora, il pannello non lo raggiunge."
        : "Questo backup non ha un archivio"
    );
  }

  const problems: string[] = [];
  const passOver = (copy: CopyRecord, problem: string) => {
    problems.push(problem);
    if (order.length > 1) opts.log?.(`  ${problem} Provo la copia successiva.`);
  };

  for (const copy of order) {
    let destination: Destination;
    try {
      destination = buildDestination(copy.row as BackupDestinationsTable);
    } catch (err) {
      passOver(copy, `«${copy.name}»: ${err instanceof Error ? err.message : String(err)}.`);
      continue;
    }

    let stat: { bytes: number; exists: boolean };
    try {
      stat = await destination.stat(copy.ref as string);
    } catch (err) {
      passOver(copy, `Non riesco a raggiungere l'archivio su «${destination.name}»: ${err instanceof Error ? err.message : String(err)}`);
      continue;
    }
    if (!stat.exists) {
      passOver(copy, describeMissing(destination));
      continue;
    }

    try {
      return await read({ copy, destination, bytes: stat.bytes });
    } catch (err) {
      if (err instanceof StopFallback) throw err.inner;
      // With nothing to fall back on, the error is the one the caller made.
      if (order.length === 1) throw err;
      passOver(copy, `«${destination.name}»: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  throw new Error(
    problems.length === 1
      ? problems[0]
      : `Nessuna delle ${problems.length} copie dell'archivio si è potuta leggere. ${problems.join(" ")}`
  );
}

/** The name the archive was written under: rebuilt from the run, since a ref is the destination's business. */
export function runArchiveFileName(run: Pick<BackupRunsTable, "id" | "policy_name" | "started_at" | "encryption_key_id">): string {
  return archiveFileName(run.id, run.policy_name, new Date(run.started_at), { encrypted: Boolean(run.encryption_key_id) });
}

// --- Removing ----------------------------------------------------------------------------

/**
 * Delete one copy: the file first, then the row. A file that will not go
 * keeps its row — losing the row would leave the file with nothing that knows
 * about it. A copy whose destination is gone has nothing the panel can delete,
 * and only its row goes.
 */
export async function removeCopy(copy: CopyRecord): Promise<{ ok: true } | { ok: false; error: string }> {
  if (copy.ref && copy.row) {
    try {
      await buildDestination(copy.row).remove(copy.ref);
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }
  const db = await getDb();
  await db.deleteFrom("backup_run_copies").where("id", "=", copy.id).execute();
  return { ok: true };
}

// --- Sending one copy again ---------------------------------------------------------------

const globalRef = globalThis as typeof globalThis & {
  __runpanelBackupActive?: string | null;
  __runpanelRestoreActive?: string | null;
};

export class CopyRetryError extends Error {
  readonly status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = "CopyRetryError";
    this.status = status;
  }
}

/**
 * "Riprova la copia": send a failed copy again, from another copy of the same
 * archive.
 *
 * The staged file of the run is long gone, so the archive comes from the first
 * copy that answers. Before it is sent anywhere it is compared with the sha256
 * recorded when it was written: a damaged copy must not become two.
 *
 * It holds the backup slot while it runs, like the backup it finishes: the
 * same disk and the same uplink, and the panel's own update waits for it.
 * The slot is read through `globalThis` rather than imported: runner.ts
 * imports this module.
 */
export async function startCopyRetry(runId: string, copyId: string): Promise<CopyRecord> {
  if (globalRef.__runpanelBackupActive) throw new CopyRetryError("Un backup è già in corso: riprova quando finisce", 409);
  if (globalRef.__runpanelRestoreActive) throw new CopyRetryError("Un ripristino è in corso: riprova quando finisce", 409);
  if (isPanelClosing()) throw new CopyRetryError(PANEL_CLOSING_MESSAGE, 409);
  assertBackupId(copyId);

  // Claimed before the first await, so two presses cannot both start.
  globalRef.__runpanelBackupActive = runId;
  const release = () => {
    if (globalRef.__runpanelBackupActive === runId) globalRef.__runpanelBackupActive = null;
  };

  let run: BackupRunsTable | undefined;
  let copy: CopyRecord | undefined;
  try {
    const db = await getDb();
    run = await db.selectFrom("backup_runs").selectAll().where("id", "=", runId).executeTakeFirst();
    if (!run) throw new CopyRetryError("Backup non trovato", 404);
    const copies = await runCopies(runId);
    copy = copies.find((entry) => entry.id === copyId);
    if (!copy) throw new CopyRetryError("Copia non trovata", 404);
    const problem = retryProblem(copy, copies.filter((entry) => entry.id !== copyId), run.status);
    if (problem) throw new CopyRetryError(problem, 409);
    await settle(runId, copy, { status: "uploading", started_at: nowIso(), finished_at: null, error_message: null, ref: null, bytes: null });
  } catch (err) {
    release();
    throw err;
  }

  const target = copy;
  const source = run;
  void retry(source, target).finally(release);
  return { ...target, status: "uploading" };
}

async function retry(run: BackupRunsTable, copy: CopyRecord): Promise<void> {
  const log = backupLog(run.id);
  const emit = (line: string) => {
    log.append(line);
    opsEvents.emit(run.id, { type: "backup:log", line });
  };
  const staging = path.join(config.backupStagingDir, `copy-${assertBackupId(copy.id)}`);
  const fileName = runArchiveFileName(run);

  try {
    emit(`Riprovo la copia su «${copy.name}»…`);
    const sourceFile = await readFirstCopy(
      run.id,
      async ({ copy: from, destination, bytes }) => {
        let file: string;
        let sha256: string | null;
        if (destination.localPath) {
          file = destination.localPath(from.ref as string);
          sha256 = run.checksum ? (await hashFile(file)).sha256 : null;
        } else {
          emit(`  scarico l'archivio da «${destination.name}» (${formatBytes(bytes)})…`);
          const downloaded = await archiveForRestore(destination, from.ref as string, staging, {
            bytes,
            freeBytes: freeBytes(),
            reserveBytes: FREE_SPACE_RESERVE,
            localPath: (ref) => ref,
          });
          file = downloaded.file;
          sha256 = downloaded.sha256;
        }
        if (run.checksum && sha256 !== run.checksum) {
          throw new Error("la copia non è l'archivio creato dal backup (sha256 diverso): non la propago");
        }
        emit(`  parto dalla copia su «${destination.name}», identica all'archivio creato`);
        return file;
      },
      { log: emit, exclude: copy.id }
    );

    if (!copy.row) throw new Error("La destinazione non esiste più");
    const destination = buildDestination(copy.row);
    const stored = await destination.put(sourceFile, fileName);
    await settle(run.id, copy, { status: "done", ref: stored.ref, bytes: stored.bytes, error_message: null, finished_at: nowIso() });
    await syncRunArchive(run.id);
    emit(`  ✓ copia su «${copy.name}» salvata: ${formatBytes(stored.bytes)} — ${stored.ref}`);
  } catch (err) {
    if (err instanceof S3Failure && err.problem.detail) emit(`  dettaglio: ${err.problem.detail}`);
    const message = err instanceof Error ? err.message : String(err);
    await settle(run.id, copy, { status: "failed", error_message: message, finished_at: nowIso() }).catch(() => {});
    emit(`  ✗ copia su «${copy.name}» non riuscita: ${message}`);
  } finally {
    fs.rmSync(staging, { recursive: true, force: true });
    log.flush();
  }
}
