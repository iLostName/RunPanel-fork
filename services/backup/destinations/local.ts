import fs from "fs";
import path from "path";
import type { Readable } from "stream";
import { config } from "@/lib/config";
import type { BackupDestinationsTable } from "@/lib/db/schema";
import { archiveDirFor, relativeArchivePath, resolveArchivePath } from "../paths";
import type { Destination } from "../types";

/**
 * The archive stays on this machine, under `data/backups/archives`.
 *
 * `put` is a rename, not a copy, which is the reason staging deliberately lives
 * under the data directory too: publishing a finished archive is then atomic and
 * costs nothing, instead of a second full write that can be interrupted halfway.
 */
export function localDestination(row: BackupDestinationsTable): Destination {
  return {
    id: row.id,
    type: "local",
    name: row.name,

    async put(localPath, fileName) {
      const directory = archiveDirFor(new Date());
      fs.mkdirSync(directory, { recursive: true });
      const target = path.join(directory, fileName);

      try {
        fs.renameSync(localPath, target);
      } catch (err) {
        // Different filesystems, which happens when the data directory spans
        // mounts. Copy and remove instead of giving up.
        if ((err as NodeJS.ErrnoException).code !== "EXDEV") throw err;
        fs.copyFileSync(localPath, target);
        fs.rmSync(localPath, { force: true });
      }

      return { ref: relativeArchivePath(target), bytes: fs.statSync(target).size };
    },

    async remove(ref) {
      fs.rmSync(resolveArchivePath(ref), { force: true });
    },

    async open(ref): Promise<Readable> {
      const file = resolveArchivePath(ref);
      if (!fs.existsSync(file)) {
        throw new Error(`L'archivio non è più sul disco di questo server: è stato spostato o eliminato fuori dal pannello (${ref}).`);
      }
      return fs.createReadStream(file);
    },

    async stat(ref) {
      try {
        const stat = fs.statSync(resolveArchivePath(ref));
        return { bytes: stat.size, exists: true };
      } catch {
        return { bytes: 0, exists: false };
      }
    },

    async test() {
      // Writing and reading back a real file, not just checking that the
      // directory exists: a read-only mount and a full disk both look fine
      // until something writes.
      const directory = config.backupArchivesDir;
      const probe = path.join(directory, `.write-test-${process.pid}-${Date.now()}`);
      const marker = `runpanel ${Date.now()}`;
      try {
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
    default:
      return `Non riesco a scrivere in ${directory}: ${err instanceof Error ? err.message : String(err)}`;
  }
}
