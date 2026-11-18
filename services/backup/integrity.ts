import crypto from "node:crypto";
import fs from "node:fs";
import { Transform, Writable, type Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import zlib from "node:zlib";
import yauzl from "yauzl";
import type { ZipOpener } from "./archive-crypto";

/**
 * Whether an archive is still what the panel wrote.
 *
 * Three layers, each catching what the one before cannot:
 *
 *  - the **archive's sha256**, recorded when the run finished, says the file
 *    is byte for byte the one that was written — a bucket, a disk or a copy
 *    that changed one bit fails here;
 *  - each member's **CRC-32**, from the zip's own directory, and its
 *    **sha256** from `checksums.txt`, say the zip was written right and each
 *    dump is the one that was staged. yauzl checks neither by itself;
 *  - a `.gz` member is **decompressed to the end**, because a truncated dump
 *    still has a valid checksum of its truncated self — and `gunzip | psql`
 *    stopping halfway is a database whose DROP already ran.
 *
 * Nothing is written to disk: members are streamed through the checks and
 * dropped. Only `node:` imports and yauzl, so the unit suite loads it directly.
 *
 * An encrypted archive is checked the same way through `open`, the opener
 * that knows its password: the sha256 is the encrypted file's, the members
 * are read through the decryption — which authenticates every chunk on the
 * way. Without `open` a file is read as a plain zip, as it always was.
 */

export interface MemberFailure {
  entryPath: string;
  reason: string;
}

export interface MemberReport {
  checked: number;
  /** Members whose sha256 was compared, as opposed to their CRC alone. */
  withSha256: number;
  bytes: number;
  failures: MemberFailure[];
}

export interface IntegrityReport {
  ok: boolean;
  /** One sentence, plain Italian. */
  message: string;
  archiveSha256: string | null;
  expectedSha256: string | null;
  /** Null when there was nothing to compare against. */
  archiveMatches: boolean | null;
  /** Null when members were not opened (a remote archive checked by its hash only). */
  members: MemberReport | null;
}

export type Progress = (done: number, total: number | null) => void;

/** A pass-through that hashes and counts, for a stream on its way somewhere else. */
export function hashingTap(onProgress?: Progress, total: number | null = null) {
  const hash = crypto.createHash("sha256");
  let bytes = 0;
  const tap = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      hash.update(chunk);
      bytes += chunk.length;
      onProgress?.(bytes, total);
      callback(null, chunk);
    },
  });
  return { tap, digest: () => ({ sha256: hash.digest("hex"), bytes }) };
}

function discard(): Writable {
  return new Writable({
    write(_chunk, _encoding, callback) {
      callback();
    },
  });
}

/** sha256 of a whole stream, read once and dropped. */
export async function hashStream(source: Readable, onProgress?: Progress, total: number | null = null) {
  const { tap, digest } = hashingTap(onProgress, total);
  await pipeline(source, tap, discard());
  return digest();
}

export async function hashFile(file: string, onProgress?: Progress) {
  return hashStream(fs.createReadStream(file), onProgress, fs.statSync(file).size);
}

// --- Inside the zip -------------------------------------------------------------

function openZip(file: string, open?: ZipOpener): Promise<yauzl.ZipFile> {
  if (open) return open(file);
  return new Promise((resolve, reject) => {
    yauzl.open(file, { lazyEntries: true, autoClose: false }, (err, zip) => {
      if (err || !zip) reject(err ?? new Error("Archivio illeggibile"));
      else resolve(zip);
    });
  });
}

/** A missing or wrong password: a fact about the reader, not about the archive. */
function isLocked(err: unknown): err is Error {
  return err instanceof Error && err.name === "ArchiveLockedError";
}

/** One entry at a time, so each can be checked before the next is read. */
function nextEntry(zip: yauzl.ZipFile): Promise<yauzl.Entry | null> {
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      zip.off("entry", onEntry);
      zip.off("end", onEnd);
      zip.off("error", onError);
    };
    const onEntry = (entry: yauzl.Entry) => {
      cleanup();
      resolve(entry);
    };
    const onEnd = () => {
      cleanup();
      resolve(null);
    };
    const onError = (err: Error) => {
      cleanup();
      reject(err);
    };
    zip.on("entry", onEntry);
    zip.on("end", onEnd);
    zip.on("error", onError);
    zip.readEntry();
  });
}

function openEntry(zip: yauzl.ZipFile, entry: yauzl.Entry): Promise<Readable> {
  return new Promise((resolve, reject) => {
    zip.openReadStream(entry, (err, stream) => {
      if (err || !stream) reject(err ?? new Error(`Impossibile leggere ${entry.fileName}`));
      else resolve(stream);
    });
  });
}

/** `sha256sum -c` lines: "<hex>  <path>". Anything else is ignored rather than trusted. */
export function parseChecksums(text: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const line of text.split(/\r?\n/)) {
    const match = /^([0-9a-f]{64}) [ *](.+)$/i.exec(line.trim());
    if (match) out.set(match[2], match[1].toLowerCase());
  }
  return out;
}

async function readSmallEntry(zip: yauzl.ZipFile, entry: yauzl.Entry, max: number): Promise<string | null> {
  if (entry.uncompressedSize > max) return null;
  const chunks: Buffer[] = [];
  for await (const chunk of await openEntry(zip, entry)) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

/** The archive's own `checksums.txt`, or an empty map when it has none. */
export async function readArchiveChecksums(file: string, open?: ZipOpener): Promise<Map<string, string>> {
  const zip = await openZip(file, open);
  try {
    for (let entry = await nextEntry(zip); entry; entry = await nextEntry(zip)) {
      if (entry.fileName === "checksums.txt") {
        return parseChecksums((await readSmallEntry(zip, entry, 16 * 1024 * 1024)) ?? "");
      }
    }
    return new Map();
  } finally {
    zip.close();
  }
}

const hasCrc32 = typeof (zlib as { crc32?: unknown }).crc32 === "function";

/**
 * Open each member and check it: CRC-32 always, sha256 when the archive lists
 * one, and a full decompression for `.gz` members.
 *
 * `only` narrows it to what a restore is about to use — an exact entry path,
 * or a prefix ending in `/` for a repository tree — so restoring one database
 * does not first read every volume in the archive.
 */
export async function verifyMembers(
  file: string,
  opts: {
    checksums?: Map<string, string>;
    only?: readonly string[];
    signal?: AbortSignal;
    onProgress?: Progress;
    open?: ZipOpener;
  } = {}
): Promise<MemberReport> {
  const checksums = opts.checksums ?? (await readArchiveChecksums(file, opts.open));
  const wanted = (name: string) =>
    !opts.only || opts.only.some((path) => (path.endsWith("/") ? name.startsWith(path) : name === path));

  const report: MemberReport = { checked: 0, withSha256: 0, bytes: 0, failures: [] };
  const found = new Set<string>();
  const zip = await openZip(file, opts.open);

  try {
    for (let entry = await nextEntry(zip); entry; entry = await nextEntry(zip)) {
      if (opts.signal?.aborted) throw new Error("Verifica annullata");
      const name = entry.fileName;
      if (name.endsWith("/") || !wanted(name)) continue;
      found.add(name);

      const expected = checksums.get(name) ?? null;
      const hash = expected ? crypto.createHash("sha256") : null;
      let crc = 0;
      const tap = new Transform({
        transform(chunk: Buffer, _encoding, callback) {
          if (hasCrc32) crc = zlib.crc32(chunk, crc);
          hash?.update(chunk);
          report.bytes += chunk.length;
          opts.onProgress?.(report.bytes, null);
          callback(null, chunk);
        },
      });

      try {
        const stream = await openEntry(zip, entry);
        // A dump that was cut short still checksums as its own short self:
        // only reading it to the end says whether it is whole.
        if (name.endsWith(".gz")) await pipeline(stream, tap, zlib.createGunzip(), discard());
        else await pipeline(stream, tap, discard());
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        report.failures.push({
          entryPath: name,
          reason: /unexpected end|incorrect header|invalid|header check|stored block/i.test(message)
            ? `il file compresso è troncato o danneggiato (${message})`
            : `non si legge fino in fondo (${message})`,
        });
        report.checked++;
        continue;
      }

      report.checked++;
      if (hasCrc32 && crc >>> 0 !== entry.crc32 >>> 0) {
        report.failures.push({ entryPath: name, reason: "il contenuto non corrisponde al CRC registrato nello zip" });
        continue;
      }
      if (hash && expected) {
        report.withSha256++;
        if (hash.digest("hex") !== expected) {
          report.failures.push({ entryPath: name, reason: "il contenuto non corrisponde al suo sha256 in checksums.txt" });
        }
      }
    }
  } finally {
    zip.close();
  }

  // Asked for by name and not there: an archive that lost a member is not whole.
  for (const path of opts.only ?? []) {
    if (path.endsWith("/") ? ![...found].some((name) => name.startsWith(path)) : !found.has(path)) {
      report.failures.push({ entryPath: path, reason: "manca dall'archivio" });
    }
  }

  return report;
}

function summarise(failures: MemberFailure[]): string {
  const first = failures[0];
  const more = failures.length > 1 ? ` (e altri ${failures.length - 1})` : "";
  return `${first.entryPath}: ${first.reason}${more}`;
}

/**
 * The whole check, for a file on this disk.
 *
 * With an expected sha256 a mismatch ends it there: once the bytes differ,
 * which member is affected says nothing useful, and the answer is the same —
 * this archive is not the one that was written.
 */
export async function verifyArchiveFile(
  file: string,
  opts: { expectedSha256?: string | null; signal?: AbortSignal; onProgress?: Progress; open?: ZipOpener } = {}
): Promise<IntegrityReport> {
  const expected = opts.expectedSha256 ?? null;
  let archiveSha256: string | null = null;
  let archiveMatches: boolean | null = null;

  if (expected) {
    archiveSha256 = (await hashFile(file, opts.onProgress)).sha256;
    archiveMatches = archiveSha256 === expected;
    if (!archiveMatches) {
      return {
        ok: false,
        message:
          "L'archivio non è più quello creato dal backup: il suo sha256 è cambiato. È danneggiato, o è stato modificato fuori dal pannello.",
        archiveSha256,
        expectedSha256: expected,
        archiveMatches,
        members: null,
      };
    }
  }

  let members: MemberReport;
  try {
    members = await verifyMembers(file, { signal: opts.signal, onProgress: opts.onProgress, open: opts.open });
  } catch (err) {
    if (isLocked(err)) {
      // Bytes that match are an intact archive, as for one in a bucket checked
      // by its hash alone: what is missing is a password, not data.
      return {
        ok: archiveMatches === true,
        message:
          (archiveMatches
            ? "Identico a quando è stato creato: il suo sha256 corrisponde. Il contenuto non si può controllare da qui: "
            : "Il contenuto non si può controllare: ") + err.message,
        archiveSha256,
        expectedSha256: expected,
        archiveMatches,
        members: null,
      };
    }
    // An encrypted archive that fails its own checks already says so in a sentence.
    const sealed = err instanceof Error && err.name === "SealedArchiveError";
    return {
      ok: false,
      message: sealed ? (err as Error).message : `Non è uno zip leggibile: ${err instanceof Error ? err.message : String(err)}`,
      archiveSha256,
      expectedSha256: expected,
      archiveMatches,
      members: null,
    };
  }

  if (members.failures.length > 0) {
    return {
      ok: false,
      message: `Un elemento dell'archivio è danneggiato: ${summarise(members.failures)}.`,
      archiveSha256,
      expectedSha256: expected,
      archiveMatches,
      members,
    };
  }

  return {
    ok: true,
    message:
      (archiveMatches ? "Identico a quando è stato creato, e " : "") +
      `${members.checked === 1 ? "l'unico file contenuto si legge" : `tutti i ${members.checked} file contenuti si leggono`} per intero e corrispondono ai loro checksum.`,
    archiveSha256,
    expectedSha256: expected,
    archiveMatches,
    members,
  };
}

/** For an archive that is not on this disk: its bytes, streamed once, against the recorded sha256. */
export async function verifyArchiveStream(
  source: Readable,
  expectedSha256: string | null,
  opts: { total?: number | null; onProgress?: Progress } = {}
): Promise<IntegrityReport> {
  const { sha256 } = await hashStream(source, opts.onProgress, opts.total ?? null);
  if (!expectedSha256) {
    return {
      ok: true,
      message:
        "Si scarica per intero, ma per questo archivio non è stato registrato un checksum con cui confrontarlo.",
      archiveSha256: sha256,
      expectedSha256: null,
      archiveMatches: null,
      members: null,
    };
  }
  const matches = sha256 === expectedSha256;
  return {
    ok: matches,
    message: matches
      ? "Identico a quando è stato creato: il suo sha256 corrisponde. Il contenuto di ogni file viene controllato anche prima di ogni ripristino."
      : "L'archivio non è più quello creato dal backup: il suo sha256 è cambiato. È danneggiato, o è stato modificato fuori dal pannello.",
    archiveSha256: sha256,
    expectedSha256,
    archiveMatches: matches,
    members: null,
  };
}

/** What a restore says when a member it needs fails the check. */
export function memberFailureMessage(failures: MemberFailure[]): string {
  return `L'archivio è danneggiato e il ripristino si ferma qui, prima di toccare qualsiasi cosa. ${summarise(failures)}.`;
}
