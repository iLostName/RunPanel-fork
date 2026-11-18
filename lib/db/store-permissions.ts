import fs from "fs";

/**
 * Keep the live SQLite store away from other local accounts.
 *
 * It holds what the backups hold (`ensureDataDirs` closes those to everyone
 * else), and some of it in the clear, like webhook secrets and build variables,
 * while the default umask leaves it 0644.
 *
 * Run on every open, so a store from before this, or one a restore swapped in,
 * is corrected too. SQLite gives a -wal or -shm it creates later the mode of the
 * main file, so these three are enough.
 */
export function restrictStoreFiles(file: string): void {
  for (const target of [file, `${file}-wal`, `${file}-shm`]) {
    try {
      fs.chmodSync(target, 0o600);
    } catch {
      /* Not there yet, or Windows and some network filesystems have no mode bits to set. */
    }
  }
}
