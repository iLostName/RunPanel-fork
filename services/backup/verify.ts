import { getDb, nowIso } from "@/lib/db";
import { readOrder } from "@/lib/backup-copies";
import { readFirstCopy, runCopies } from "./copies";
import { verifyArchiveFile, verifyArchiveStream, type IntegrityReport, type MemberFailure } from "./integrity";
import { panelArchiveOpener } from "./keyring";

/**
 * "Verifica integrità" on a backup run: reading its archive back, now, and
 * comparing it with what was recorded when it was written.
 *
 * In the background, because an archive is gigabytes and a request that waits
 * for one times out in some proxy in between; the page polls. One at a time,
 * process-wide: each reads a whole archive off the disk or the network the
 * applications are using.
 *
 * On this disk the check is complete — the archive's sha256, then every member
 * (see integrity.ts). An archive in a bucket is streamed once through its
 * sha256 and never stored: that proves the bytes are the ones that were
 * written, and the members are checked again, on the downloaded copy, before
 * any restore uses them.
 */

export interface VerificationView {
  status: "running" | "ok" | "failed";
  /** One sentence, plain Italian. */
  message: string;
  startedAt: string | null;
  checkedAt: string | null;
  /** `full`: archive and every member. `archive`: the archive's sha256 only (not on this disk). */
  depth: "full" | "archive" | null;
  /** The copy that was read: the first that answered. Null for a check from before copies. */
  source: { destinationName: string; destinationType: string } | null;
  progress: { done: number; total: number | null } | null;
  failures: MemberFailure[];
}

interface LiveJob extends VerificationView {
  runId: string;
}

const globalRef = globalThis as typeof globalThis & { __runpanelVerifications?: Map<string, LiveJob> };
const live: Map<string, LiveJob> = (globalRef.__runpanelVerifications ??= new Map());

export class VerifyBusyError extends Error {
  constructor(message = "Un'altra verifica è in corso: riprova quando finisce") {
    super(message);
    this.name = "VerifyBusyError";
  }
}

/** The check in progress or just finished in this process, if any. */
export function liveVerification(runId: string): VerificationView | null {
  const job = live.get(runId);
  if (!job) return null;
  const { runId: _id, ...view } = job;
  void _id;
  return view;
}

/** The last finished check, as stored. */
export async function storedVerification(runId: string): Promise<VerificationView | null> {
  const db = await getDb();
  const row = await db.selectFrom("backup_verifications").selectAll().where("run_id", "=", runId).executeTakeFirst();
  if (!row) return null;
  let detail: {
    depth?: "full" | "archive";
    failures?: MemberFailure[];
    source?: VerificationView["source"];
  } = {};
  try {
    detail = row.detail ? JSON.parse(row.detail) : {};
  } catch {
    /* an unreadable detail still leaves the verdict and its sentence */
  }
  return {
    status: row.status === "ok" ? "ok" : "failed",
    message: row.message,
    startedAt: null,
    checkedAt: row.checked_at,
    depth: detail.depth ?? null,
    source: detail.source ?? null,
    progress: null,
    failures: detail.failures ?? [],
  };
}

/** What the run page shows: the live check while one runs, the stored one otherwise. */
export async function runVerification(runId: string): Promise<VerificationView | null> {
  const current = liveVerification(runId);
  if (current?.status === "running") return current;
  return (await storedVerification(runId)) ?? current;
}

async function store(runId: string, view: VerificationView): Promise<void> {
  const db = await getDb();
  const values = {
    status: view.status === "ok" ? "ok" : "failed",
    message: view.message,
    detail: JSON.stringify({ depth: view.depth, failures: view.failures.slice(0, 20), source: view.source }),
    checked_at: view.checkedAt ?? nowIso(),
  };
  await db
    .insertInto("backup_verifications")
    .values({ run_id: runId, ...values })
    .onConflict((oc) => oc.column("run_id").doUpdateSet(values))
    .execute();
}

async function loadRun(runId: string) {
  const db = await getDb();
  const run = await db.selectFrom("backup_runs").selectAll().where("id", "=", runId).executeTakeFirst();
  if (!run) throw new Error("Backup non trovato");
  if (run.status === "running") throw new VerifyBusyError("Il backup è ancora in corso: lo si verifica quando ha finito");
  const order = readOrder(await runCopies(runId));
  if (!run.archive_path || order.length === 0) {
    throw new Error(
      run.archive_path
        ? "La destinazione di questo backup non è più configurata"
        : "Questo backup non ha un archivio da verificare"
    );
  }
  return { expected: run.checksum, bytes: run.archive_bytes ?? null, firstIsLocal: order[0].local };
}

/**
 * Start checking a run's archive. Resolves once the check is under way; the
 * result lands in `backup_verifications` and in `liveVerification`.
 */
export async function startRunVerification(runId: string): Promise<VerificationView> {
  if ([...live.values()].some((job) => job.status === "running")) throw new VerifyBusyError();

  // Claimed before the first await, so two presses cannot both start; given
  // back if the run turns out to have nothing to check.
  const job: LiveJob = {
    runId,
    status: "running",
    message: "Verifica in corso…",
    startedAt: nowIso(),
    checkedAt: null,
    depth: null,
    source: null,
    progress: null,
    failures: [],
  };
  live.set(runId, job);

  let run: Awaited<ReturnType<typeof loadRun>>;
  try {
    run = await loadRun(runId);
  } catch (err) {
    live.delete(runId);
    throw err;
  }
  const { expected } = run;
  job.depth = run.firstIsLocal ? "full" : "archive";
  job.progress = { done: 0, total: run.bytes };

  void (async () => {
    let report: IntegrityReport;
    try {
      const onProgress = (done: number, total: number | null) => {
        job.progress = { done, total: total ?? job.progress?.total ?? null };
      };

      // The first copy that answers, the ones on this disk first: a copy that
      // is gone or unreachable gives way to the next. One that answers is the
      // one checked — a damaged copy is reported, never passed over.
      report = await readFirstCopy(runId, async ({ copy, destination, bytes }) => {
        job.source = { destinationName: destination.name, destinationType: destination.type };
        if (destination.localPath) {
          job.depth = "full";
          // An encrypted archive is opened with the password it was sealed
          // with, which this panel keeps; one it no longer has is reported,
          // not failed.
          return verifyArchiveFile(destination.localPath(copy.ref as string), {
            expectedSha256: expected,
            onProgress,
            open: panelArchiveOpener(),
          });
        }
        job.depth = "archive";
        job.progress = { done: 0, total: bytes };
        return verifyArchiveStream(await destination.open(copy.ref as string), expected, { total: bytes, onProgress });
      });
    } catch (err) {
      report = {
        ok: false,
        message: `Non sono riuscito a leggere l'archivio: ${err instanceof Error ? err.message : String(err)}`,
        archiveSha256: null,
        expectedSha256: expected,
        archiveMatches: null,
        members: null,
      };
    }

    job.status = report.ok ? "ok" : "failed";
    job.message = report.message;
    // On this disk but not opened — an encrypted archive whose password the
    // panel no longer has: what was checked is the sha256 alone.
    if (job.depth === "full" && report.members === null) job.depth = "archive";
    job.checkedAt = nowIso();
    job.failures = report.members?.failures ?? [];
    await store(runId, job).catch((err) => console.error("[backup] Verifica non registrata:", err));
    // Kept a while for the page that is polling, then dropped: the stored row
    // is the record, this is only the progress bar.
    setTimeout(() => {
      if (live.get(runId) === job) live.delete(runId);
    }, 10 * 60_000).unref?.();
  })();

  return liveVerification(runId) as VerificationView;
}
