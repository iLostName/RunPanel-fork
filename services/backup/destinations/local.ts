import fs from "fs";
import path from "path";
import type { Readable } from "stream";
import { config } from "@/lib/config";
import type { BackupDestinationsTable } from "@/lib/db/schema";
import { archiveDirFor, relativeArchivePath, resolveArchivePath } from "../paths";
import type { Destination } from "../types";

/**
 * The archive stays on a disk of this machine: under `data/backups/archives`,
 * or in a folder of its own choosing — a second disk, a mounted NAS — which is
 * what makes two local destinations two copies rather than one file twice.
 *
 * `put` hard-links the staged archive into place when it can, which is why
 * staging deliberately lives under the data directory too: publishing a
 * finished archive on the same disk is then atomic and costs nothing, and the
 * staged file stays for the next destination of the policy. Across disks, or
 * on a filesystem without hard links, it is a copy written beside the target
 * and renamed, so an interrupted copy never looks like an archive.
 */

/** A folder of its own, or null for the panel's archive folder. */
export function localDirectory(raw: Record<string, unknown>): string | null {
  const value = typeof raw.path === "string" ? raw.path.trim() : "";
  return value ? path.resolve(value) : null;
}

/**
 * Why a folder cannot be a destination of its own, or null.
 *
 * Outside the panel's data directory: inside it there is already the local
 * disk, and a folder of archives among the store, the staging area and the
 * uploads is one housekeeping job away from being cleaned up as something
 * else. Not the root of a disk either, where the archive tree would be mixed
 * with everything else on it.
 */
export function localPathProblem(raw: string): string | null {
  const value = raw.trim();
  if (!value || !path.isAbsolute(value)) return "Scrivi il percorso completo di una cartella, per esempio /mnt/backup";
  const resolved = path.resolve(value);
  if (path.parse(resolved).root === resolved) return "Scegli una cartella, non la radice del disco";
  const data = path.resolve(config.dataDir);
  // Windows paths compare without case, and so do the folders they name.
  const norm = (value: string) => (process.platform === "win32" ? value.toLowerCase() : value);
  const inside = (child: string, parent: string) =>
    norm(child) === norm(parent) || norm(child).startsWith(norm(parent) + path.sep);
  if (inside(resolved, data)) {
    return "La cartella è dentro i dati del pannello: per lì c'è già il disco locale. Scegline una fuori, meglio se su un altro disco.";
  }
  if (inside(data, resolved)) return "La cartella contiene i dati del pannello: scegline una che non li contenga.";
  return null;
}

function two(value: number): string {
  return String(value).padStart(2, "0");
}

export function localDestination(row: BackupDestinationsTable, raw: Record<string, unknown> = {}): Destination {
  const base = localDirectory(raw);
  // Under the panel's folder a ref stays relative to `data/backups`, exactly as
  // every archive before folders existed; in a folder of its own, relative to it.
  const root = base ?? config.backupArchivesDir;

  const resolve = (ref: string): string => {
    if (!base) return resolveArchivePath(ref);
    const resolved = path.resolve(base, ref);
    if (resolved !== base && !resolved.startsWith(base + path.sep)) {
      throw new Error("Percorso dell'archivio fuori dalla cartella della destinazione");
    }
    return resolved;
  };

  return {
    id: row.id,
    type: "local",
    name: row.name,

    async put(localPath, fileName) {
      const now = new Date();
      const directory = base
        ? path.join(base, String(now.getUTCFullYear()), two(now.getUTCMonth() + 1))
        : archiveDirFor(now);
      if (base && !fs.existsSync(base)) throw new Error(missingFolder(base));
      const target = path.join(directory, fileName);
      try {
        fs.mkdirSync(directory, { recursive: true });
        placeCopy(localPath, target);
      } catch (err) {
        throw new Error(localProblem(err, directory));
      }

      const bytes = fs.statSync(target).size;
      return {
        ref: base ? path.relative(base, target).split(path.sep).join("/") : relativeArchivePath(target),
        bytes,
      };
    },

    async remove(ref) {
      fs.rmSync(resolve(ref), { force: true });
    },

    async open(ref): Promise<Readable> {
      const file = resolve(ref);
      if (!fs.existsSync(file)) {
        throw new Error(
          base
            ? `L'archivio non è più in ${base}: il disco non è montato, oppure è stato spostato o eliminato fuori dal pannello (${ref}).`
            : `L'archivio non è più sul disco di questo server: è stato spostato o eliminato fuori dal pannello (${ref}).`
        );
      }
      return fs.createReadStream(file);
    },

    async stat(ref) {
      try {
        const stat = fs.statSync(resolve(ref));
        return { bytes: stat.size, exists: true };
      } catch {
        return { bytes: 0, exists: false };
      }
    },

    localPath: resolve,

    location() {
      const resolved = path.resolve(root);
      return `local:${process.platform === "win32" ? resolved.toLowerCase() : resolved}`;
    },

    async test() {
      // Writing and reading back a real file, not just checking that the
      // directory exists: a read-only mount and a full disk both look fine
      // until something writes.
      const directory = root;
      const probe = path.join(directory, `.write-test-${process.pid}-${Date.now()}`);
      const marker = `runpanel ${Date.now()}`;
      try {
        // A folder of its own is created only by the panel's own folder: one
        // that is missing is more often a disk that is not mounted, and filling
        // the empty mount point underneath would hide that.
        if (base && !fs.existsSync(base)) return { ok: false, message: missingFolder(base), code: "ENOENT" };
        fs.mkdirSync(directory, { recursive: true });
        fs.writeFileSync(probe, marker, { mode: 0o600 });
        const back = fs.readFileSync(probe, "utf8");
        fs.rmSync(probe, { force: true });
        if (back !== marker) {
          return { ok: false, message: `Il file scritto in ${directory} si rilegge diverso: il disco potrebbe essere danneggiato.` };
        }
        return { ok: true, message: `Scrittura e lettura riuscite in ${directory}, su questo server.` };
      } catch (err) {
        fs.rmSync(probe, { force: true });
        return { ok: false, message: localProblem(err, directory), code: (err as NodeJS.ErrnoException).code };
      }
    },
  };
}

/**
 * Put `source` at `target` and leave `source` where it is.
 *
 * A hard link first: on the same disk it is instant and takes no space, and
 * the two names share one file the backup never writes to again. When that
 * is refused — another disk, or a filesystem without links such as FAT or
 * some network mounts — a full copy, flushed to the disk before it takes the
 * archive's name: a copy cut short by a power cut must not be the file a
 * restore later finds.
 */
function placeCopy(source: string, target: string): void {
  const partial = `${target}.part`;
  fs.rmSync(partial, { force: true });
  try {
    fs.linkSync(source, partial);
  } catch {
    try {
      fs.copyFileSync(source, partial);
      const fd = fs.openSync(partial, "r+");
      try {
        fs.fsyncSync(fd);
      } finally {
        fs.closeSync(fd);
      }
      const expected = fs.statSync(source).size;
      const written = fs.statSync(partial).size;
      if (written !== expected) {
        throw new Error(`La copia si è fermata a ${written} byte su ${expected}: il disco potrebbe essere pieno.`);
      }
    } catch (err) {
      fs.rmSync(partial, { force: true });
      throw err;
    }
  }
  fs.renameSync(partial, target);
  // Renaming a name onto another name of the same file leaves both in place.
  fs.rmSync(partial, { force: true });
}

function missingFolder(base: string): string {
  return `La cartella ${base} non esiste. Se è un disco o una cartella di rete, controlla che sia montato; altrimenti creala e dalla all'utente con cui gira RunPanel.`;
}

/** The usual reasons a folder cannot be written to, with what to do. */
export function localProblem(err: unknown, directory: string): string {
  const code = (err as NodeJS.ErrnoException)?.code;
  switch (code) {
    case "EACCES":
    case "EPERM":
      return `Il pannello non ha il permesso di scrivere in ${directory}. Dai la cartella all'utente con cui gira RunPanel (per esempio con chown).`;
    case "ENOSPC":
      return `Il disco che contiene ${directory} è pieno. Libera spazio o conserva meno archivi.`;
    case "EROFS":
      return `Il disco che contiene ${directory} è montato in sola lettura.`;
    case "EDQUOT":
      return `L'utente del pannello ha esaurito la sua quota di spazio sul disco di ${directory}.`;
    case "ENOTDIR":
    case "EEXIST":
      return `${directory} non è una cartella: al suo posto, o lungo il percorso, c'è un file.`;
    default:
      return `Non riesco a scrivere in ${directory}: ${err instanceof Error ? err.message : String(err)}`;
  }
}
