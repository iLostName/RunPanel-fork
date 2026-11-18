import fs from "fs";
import path from "path";
import { config } from "@/lib/config";
import { nowIso } from "@/lib/db";
import { formatBytes } from "@/lib/format";
import { generateId } from "@/lib/utils";
import { readArchiveManifest } from "./archive-read";
import { readArchiveChecksums, verifyMembers, type MemberFailure } from "./integrity";
import { FREE_SPACE_RESERVE, assertBackupId, freeBytes } from "./paths";
import type { BackupManifest } from "./types";

/**
 * An archive brought in from outside — a download from this panel, a copy
 * from the old server — to restore from.
 *
 * It arrives in pieces of a few megabytes, one request each. A single request
 * would have to carry gigabytes through `proxy.ts`, which buffers every body it
 * sees and truncates past 10 MB without a word, and through whatever proxy is
 * in front of the panel. Pieces also give a progress bar and a retry that does
 * not start over.
 *
 * Each upload is three files under `data/backups/uploads`: `<id>.part` while it
 * arrives, `<id>.zip` once complete, and `<id>.json`, which says where it is.
 * When complete it is checked whole — manifest, every member's CRC, sha256 and
 * gzip stream — and only an archive that passes can be restored from. Uploads
 * left alone for a day are removed: they are full copies of someone's data.
 */

/** Under the 10 MB `proxy.ts` buffers, with room for a slow link to finish one. */
export const UPLOAD_CHUNK_BYTES = 8 * 1024 * 1024;
/** An upload nobody has touched for this long is deleted. */
const UPLOAD_TTL_MS = 24 * 60 * 60 * 1000;

export type UploadStatus = "uploading" | "checking" | "ready" | "invalid";

export interface UploadArtifact {
  /** Its index in the manifest: what a restore mapping names. */
  id: string;
  kind: string;
  refId: string | null;
  refName: string;
  entryPath: string;
  bytes: number;
  checksum: string | null;
  meta: Record<string, unknown>;
}

export interface UploadRecord {
  id: string;
  /** As the browser named it, for display only: never a path. */
  fileName: string;
  bytes: number;
  received: number;
  status: UploadStatus;
  /** Why it was refused, or what the check found. */
  message: string | null;
  createdAt: string;
  updatedAt: string;
  /** While checking: how far it got. */
  progress: { done: number; total: number | null } | null;
  manifest: {
    runId: string;
    policyName: string | null;
    trigger: string;
    createdAt: string;
    panelVersion: string | null;
    storeDriver: string | null;
  } | null;
  artifacts: UploadArtifact[];
  failures: MemberFailure[];
}

function dir(): string {
  return config.backupUploadsDir;
}

function partPath(id: string): string {
  return path.join(dir(), `${assertBackupId(id)}.part`);
}

export function uploadArchivePath(id: string): string {
  return path.join(dir(), `${assertBackupId(id)}.zip`);
}

function recordPath(id: string): string {
  return path.join(dir(), `${assertBackupId(id)}.json`);
}

function write(record: UploadRecord): void {
  const file = recordPath(record.id);
  const temp = `${file}.tmp`;
  fs.writeFileSync(temp, JSON.stringify(record), { mode: 0o600 });
  fs.renameSync(temp, file);
}

export function readUpload(id: string): UploadRecord | null {
  try {
    return JSON.parse(fs.readFileSync(recordPath(id), "utf8")) as UploadRecord;
  } catch {
    return null;
  }
}

export function listUploads(): UploadRecord[] {
  pruneUploads();
  let names: string[] = [];
  try {
    names = fs.readdirSync(dir());
  } catch {
    return [];
  }
  return names
    .filter((name) => name.endsWith(".json"))
    .map((name) => readUpload(name.slice(0, -".json".length)))
    .filter((record): record is UploadRecord => record !== null)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export class UploadError extends Error {
  readonly status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.name = "UploadError";
    this.status = status;
  }
}

/** A name to show: the last path segment, printable characters, not too long. */
function displayName(raw: string): string {
  const base = raw.split(/[\\/]/).pop() ?? "";
  const clean = base.replace(/[^\p{L}\p{N} ._()+-]/gu, "").trim().slice(0, 120);
  return clean || "archivio.zip";
}

export function createUpload(input: { fileName: string; bytes: number }): UploadRecord {
  pruneUploads();
  if (!Number.isSafeInteger(input.bytes) || input.bytes <= 0) throw new UploadError("Dimensione del file non valida");

  fs.mkdirSync(dir(), { recursive: true });
  const free = freeBytes();
  if (free !== null && free - input.bytes < FREE_SPACE_RESERVE) {
    throw new UploadError(
      `Spazio insufficiente: l'archivio è ${formatBytes(input.bytes)}, liberi ${formatBytes(free)} e ne devono restare almeno ${formatBytes(FREE_SPACE_RESERVE)}.`,
      507
    );
  }

  const now = nowIso();
  const record: UploadRecord = {
    id: generateId(),
    fileName: displayName(input.fileName),
    bytes: input.bytes,
    received: 0,
    status: "uploading",
    message: null,
    createdAt: now,
    updatedAt: now,
    progress: null,
    manifest: null,
    artifacts: [],
    failures: [],
  };
  // The record first: a sweep that ran in between must never see the piece
  // file alone and take it for something left behind.
  write(record);
  fs.writeFileSync(partPath(record.id), Buffer.alloc(0), { mode: 0o600 });
  return record;
}

/**
 * One piece at a time per upload: two writers at the same offset would
 * interleave. On `globalThis`, like every process-wide flag here: each route
 * is its own bundle, and a module-level set would be one per route.
 */
const writingRef = globalThis as typeof globalThis & { __runpanelUploadWrites?: Set<string> };
const writing: Set<string> = (writingRef.__runpanelUploadWrites ??= new Set());

/**
 * Write one piece at `offset`.
 *
 * Pieces arrive in order. One the panel already has — a retry after a lost
 * answer — is accepted and ignored, so the browser can simply send it again.
 */
export async function appendChunk(id: string, offset: number, chunk: Buffer): Promise<UploadRecord> {
  const record = readUpload(id);
  if (!record) throw new UploadError("Caricamento non trovato", 404);
  if (record.status !== "uploading") throw new UploadError("Questo caricamento è già completo", 409);
  if (!Number.isSafeInteger(offset) || offset < 0) throw new UploadError("Posizione non valida");
  if (chunk.length === 0 || chunk.length > UPLOAD_CHUNK_BYTES) throw new UploadError("Pezzo di dimensione non valida");

  if (offset + chunk.length <= record.received) return record;
  if (offset !== record.received) {
    throw new UploadError(`Pezzo fuori ordine: il pannello ne aspetta uno a partire da ${record.received}`, 409);
  }
  if (offset + chunk.length > record.bytes) throw new UploadError("Il file è più grande di quanto annunciato");

  if (writing.has(id)) throw new UploadError("Un altro pezzo è in scrittura", 409);
  writing.add(id);
  try {
    const free = freeBytes();
    if (free !== null && free - chunk.length < FREE_SPACE_RESERVE) {
      throw new UploadError("Spazio su disco esaurito durante il caricamento", 507);
    }
    const file = partPath(id);
    // A piece written halfway before a crash is cut back to what the record
    // says was received, so the next piece lands where it belongs.
    const handle = await fs.promises.open(file, "r+");
    try {
      await handle.truncate(offset);
      await handle.write(chunk, 0, chunk.length, offset);
    } finally {
      await handle.close();
    }
    record.received = offset + chunk.length;
    record.updatedAt = nowIso();
    write(record);
    return record;
  } finally {
    writing.delete(id);
  }
}

/** Every piece is in: make it a zip and check it, in the background. */
export function finishUpload(id: string): UploadRecord {
  const record = readUpload(id);
  if (!record) throw new UploadError("Caricamento non trovato", 404);
  if (record.status !== "uploading") return record;
  if (record.received !== record.bytes) {
    throw new UploadError(`Mancano ancora ${formatBytes(record.bytes - record.received)} da caricare`, 409);
  }

  fs.renameSync(partPath(id), uploadArchivePath(id));
  record.status = "checking";
  record.progress = { done: 0, total: null };
  record.updatedAt = nowIso();
  write(record);

  launchCheck(record);
  return record;
}

const globalRef = globalThis as typeof globalThis & { __runpanelUploadChecks?: Set<string> };
const checking: Set<string> = (globalRef.__runpanelUploadChecks ??= new Set());

function launchCheck(record: UploadRecord): void {
  if (checking.has(record.id)) return;
  checking.add(record.id);
  void inspect(record)
    .catch((err) => {
      const current = readUpload(record.id);
      if (!current) return; // deleted meanwhile
      write({
        ...current,
        status: "invalid",
        progress: null,
        message: `Controllo non riuscito: ${err instanceof Error ? err.message : String(err)}`,
        updatedAt: nowIso(),
      });
    })
    .finally(() => checking.delete(record.id));
}

/**
 * A check the panel was in the middle of when it restarted starts over: an
 * upload left "checking" forever could neither be restored nor trusted.
 */
export function resumeInterruptedChecks(): void {
  for (const record of listUploads()) {
    if (record.status === "checking" && !checking.has(record.id)) launchCheck(record);
  }
}

/** Is it a RunPanel archive, and is every member whole? */
async function inspect(record: UploadRecord): Promise<void> {
  const file = uploadArchivePath(record.id);
  const head = Buffer.alloc(4);
  const fd = fs.openSync(file, "r");
  try {
    fs.readSync(fd, head, 0, 4, 0);
  } finally {
    fs.closeSync(fd);
  }
  const done = (patch: Partial<UploadRecord>) => {
    const current = readUpload(record.id);
    if (!current) return;
    write({ ...current, ...patch, progress: null, updatedAt: nowIso() });
  };

  if (head.readUInt32LE(0) !== 0x04034b50) {
    done({ status: "invalid", message: "Non è un archivio ZIP: un backup di RunPanel si scarica dalla sua pagina come file .zip." });
    return;
  }

  const manifest: BackupManifest | null = await readArchiveManifest(file).catch(() => null);
  if (!manifest || !Array.isArray(manifest.artifacts)) {
    done({ status: "invalid", message: "Non è un backup di RunPanel: manca manifest.json, che ogni archivio del pannello contiene." });
    return;
  }
  if (manifest.schemaVersion !== 1) {
    done({
      status: "invalid",
      message: `L'archivio è in un formato più recente (versione ${String(manifest.schemaVersion)}): aggiorna il pannello per ripristinarlo.`,
    });
    return;
  }

  // Ids are positions in the manifest, failed items included, so they stay
  // the same however the list is filtered.
  const artifacts: UploadArtifact[] = manifest.artifacts
    .map((artifact, index) => ({ artifact, index }))
    .filter(({ artifact }) => artifact.status === "ok")
    .map(({ artifact, index }) => ({
      id: String(index),
      kind: artifact.kind,
      refId: artifact.refId ?? null,
      refName: String(artifact.refName ?? `elemento ${index + 1}`),
      entryPath: String(artifact.entryPath ?? ""),
      bytes: Number(artifact.bytes ?? 0),
      checksum: artifact.sha256 ?? null,
      meta: (artifact.meta ?? {}) as Record<string, unknown>,
    }));

  const summary = {
    runId: String(manifest.runId ?? ""),
    policyName: manifest.policyName ?? null,
    trigger: String(manifest.trigger ?? "manual"),
    createdAt: String(manifest.createdAt ?? ""),
    panelVersion: manifest.panel?.version ?? null,
    storeDriver: manifest.panel?.storeDriver ?? null,
  };

  const checksums = await readArchiveChecksums(file);
  for (const artifact of artifacts) {
    if (artifact.checksum && artifact.entryPath && !checksums.has(artifact.entryPath)) {
      checksums.set(artifact.entryPath, artifact.checksum);
    }
  }

  let lastWrite = 0;
  const report = await verifyMembers(file, {
    checksums,
    onProgress: (done) => {
      // A progress bar, not a journal: the record is rewritten a few times a second at most.
      if (Date.now() - lastWrite < 500) return;
      lastWrite = Date.now();
      const current = readUpload(record.id);
      if (current) write({ ...current, progress: { done, total: null } });
    },
  });

  if (report.failures.length > 0) {
    const first = report.failures[0];
    done({
      status: "invalid",
      manifest: summary,
      artifacts,
      failures: report.failures.slice(0, 20),
      message: `L'archivio è danneggiato: ${first.entryPath} — ${first.reason}${report.failures.length > 1 ? ` (e altri ${report.failures.length - 1})` : ""}. Non si può ripristinare da qui.`,
    });
    return;
  }

  done({
    status: "ready",
    manifest: summary,
    artifacts,
    failures: [],
    message:
      artifacts.length === 0
        ? "L'archivio è integro, ma non contiene elementi salvati con successo."
        : `Integro: tutti i ${report.checked} file si leggono per intero e corrispondono ai loro checksum.`,
  });
}

/** The artifacts a restore may use, only from an upload that passed its check. */
export function uploadArtifacts(id: string): Map<string, UploadArtifact> {
  const record = readUpload(id);
  if (!record) throw new Error("L'archivio caricato non è più disponibile");
  if (record.status !== "ready") {
    throw new Error(
      record.status === "invalid"
        ? `L'archivio caricato non ha superato il controllo: ${record.message ?? "è danneggiato"}`
        : "L'archivio caricato non è ancora stato controllato"
    );
  }
  return new Map(record.artifacts.map((artifact) => [artifact.id, artifact]));
}

/** Touch it, so a restore just finished — or failed and to be retried — keeps it a day longer. */
export function touchUpload(id: string): void {
  const record = readUpload(id);
  if (record) write({ ...record, updatedAt: nowIso() });
}

export function deleteUpload(id: string): boolean {
  const existed = readUpload(id) !== null;
  for (const file of [partPath(id), uploadArchivePath(id), recordPath(id), `${recordPath(id)}.tmp`]) {
    fs.rmSync(file, { force: true });
  }
  return existed;
}

/** A file with no record is left alone this long, in case its record is being written. */
const ORPHAN_GRACE_MS = 10 * 60 * 1000;

/**
 * Uploads nobody has touched for a day, and files with no record.
 *
 * Never while a restore runs: it may be reading one of them.
 */
export function pruneUploads(now = Date.now()): number {
  const globalRef = globalThis as typeof globalThis & { __runpanelRestoreActive?: string | null };
  if (globalRef.__runpanelRestoreActive) return 0;

  let names: string[];
  try {
    names = fs.readdirSync(dir());
  } catch {
    return 0;
  }

  const files = new Map<string, string[]>();
  for (const name of names) {
    const id = name.replace(/\.(part|zip|json|json\.tmp)$/, "");
    if (id === name) continue;
    files.set(id, [...(files.get(id) ?? []), name]);
  }

  let removed = 0;
  for (const [id, own] of files) {
    try {
      assertBackupId(id);
    } catch {
      continue;
    }
    const record = readUpload(id);
    let stale: boolean;
    if (record) {
      const touched = Date.parse(record.updatedAt);
      stale = !Number.isFinite(touched) || now - touched > UPLOAD_TTL_MS;
    } else {
      // A file with no record cannot be shown, used or deleted from the page.
      const newest = Math.max(
        ...own.map((name) => {
          try {
            return fs.statSync(path.join(dir(), name)).mtimeMs;
          } catch {
            return 0;
          }
        })
      );
      stale = now - newest > ORPHAN_GRACE_MS;
    }
    if (stale) {
      deleteUpload(id);
      removed++;
    }
  }
  return removed;
}
