import { formatBytes } from "@/lib/format";

/**
 * Progress worth a line in the run log: every tenth, or every minute on a slow
 * line, and nothing at all for an archive that uploads in seconds.
 *
 * Shared by the drivers that upload over the network — Telegram, SFTP,
 * WebDAV — so an hour-long upload reads the same in every run log, and a log
 * that sits still for that hour does not look hung.
 */
export function progressLog(
  log: (line: string) => void,
  total: number,
  now: () => number = Date.now
): (done: number) => void {
  const startedAt = now();
  let lastAt = startedAt;
  let lastTenth = 0;
  return (done) => {
    if (total < 32 * 1024 * 1024 || done >= total) return;
    const tenth = Math.floor((done * 10) / total);
    const at = now();
    if (tenth <= lastTenth && at - lastAt < 60_000) return;
    lastTenth = Math.max(lastTenth, tenth);
    lastAt = at;
    const rate = done / Math.max(1, (at - startedAt) / 1000);
    log(`  caricati ${formatBytes(done)} di ${formatBytes(total)} (${Math.floor((done * 100) / total)}%) · ${formatBytes(rate)}/s`);
  };
}
