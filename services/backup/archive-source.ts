import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { Transform, type Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

/**
 * Where a restore reads its archive from.
 *
 * A local destination already holds the zip on this disk, and the restore
 * reads it in place. Any other destination (S3 and friends) is copied into the
 * restore's own staging folder first: extracting entries needs random access
 * to the file, which a network stream cannot give. The staging folder is
 * removed when the restore ends, so the copy goes with it.
 *
 * The copy is hashed on its way in, for free: the restore compares it with the
 * sha256 recorded when the archive was written, before it touches anything.
 *
 * Only `node:` imports, so a standalone suite can load it.
 */

export interface ArchiveSourceDestination {
  type: string;
  open(ref: string): Promise<Readable>;
}

export interface ArchiveSourceOptions {
  /** Size of the archive as the destination reports it. */
  bytes: number;
  /** Free bytes on the staging disk, or null when unknown. */
  freeBytes: number | null;
  /** Space that must stay free after the copy. */
  reserveBytes: number;
  /** The local path of a ref on a local destination. */
  localPath: (ref: string) => string;
}

export async function archiveForRestore(
  destination: ArchiveSourceDestination,
  ref: string,
  staging: string,
  opts: ArchiveSourceOptions
): Promise<{ file: string; downloaded: boolean; sha256: string | null }> {
  if (destination.type === "local") return { file: opts.localPath(ref), downloaded: false, sha256: null };

  if (opts.freeBytes !== null && opts.freeBytes - opts.bytes < opts.reserveBytes) {
    throw new Error("Spazio libero insufficiente per scaricare l'archivio prima del ripristino");
  }

  fs.mkdirSync(staging, { recursive: true });
  const file = path.join(staging, "archive.zip");
  const hash = crypto.createHash("sha256");
  const tap = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      hash.update(chunk);
      callback(null, chunk);
    },
  });
  try {
    await pipeline(await destination.open(ref), tap, fs.createWriteStream(file, { mode: 0o600 }));
  } catch (err) {
    fs.rmSync(file, { force: true });
    throw new Error(`Download dell'archivio non riuscito: ${err instanceof Error ? err.message : String(err)}`);
  }
  return { file, downloaded: true, sha256: hash.digest("hex") };
}
