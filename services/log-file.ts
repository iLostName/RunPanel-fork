import fs from "fs";
import path from "path";

/**
 * One buffered append-only log file, addressed by an id.
 *
 * This started as the deploy-only `BuildLogFile` and moved here when backups
 * and restores needed the same three properties: a chatty producer must not
 * cost one syscall per line, the file must be tailable while it is being
 * written, and an id that came from the outside must never become a path.
 *
 * The id check is the important one. It runs *before* anything is joined, so a
 * caller cannot reach `../../.secret` — `path.join` would happily normalise it
 * away and hand back a path that looks fine.
 */

const ID_PATTERN = /^[A-Za-z0-9_-]{1,32}$/;

export function isLogId(id: string): boolean {
  return ID_PATTERN.test(id);
}

export function logPathFor(dir: string, id: string): string {
  if (!isLogId(id)) throw new Error(`Invalid log id: ${id}`);
  return path.join(dir, `${id}.log`);
}

export class AppendLogFile {
  private pending: string[] = [];
  private timer: NodeJS.Timeout | null = null;
  readonly file: string;
  private readonly flushMs: number;

  // Declared and assigned rather than written as constructor parameter
  // properties: Node's strip-only TypeScript loader rejects those, and the unit
  // suites import modules like this one directly rather than through a bundler.
  constructor(file: string, flushMs = 200) {
    this.file = file;
    this.flushMs = flushMs;
    fs.mkdirSync(path.dirname(file), { recursive: true });
  }

  append(line: string): void {
    this.pending.push(line);
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.flush();
    }, this.flushMs);
  }

  flush(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (this.pending.length === 0) return;

    const chunk = `${this.pending.join("\n")}\n`;
    this.pending = [];
    try {
      // 0600, and only on creation, so the hot path pays nothing: these files
      // carry build output, remote URLs and the names of environment
      // variables, and an update log carries whatever git said when a fetch
      // failed. None of that is for every local user on a shared host.
      fs.appendFileSync(this.file, chunk, { mode: 0o600 });
    } catch (err) {
      console.error(`[log-file] Failed to write ${path.basename(this.file)}:`, err);
    }
  }
}

const NEWLINE = 0x0a;
const TAIL_CHUNK_BYTES = 64 * 1024;
/** Where a tail stops however few lines it found: one line can be the whole file. */
export const MAX_TAIL_BYTES = 8 * 1024 * 1024;

interface TailRead {
  position: number;
  length: number;
}

/** The bytes of a character whose start fell before a cut. */
function dropLeadingContinuation(bytes: Buffer): Buffer {
  let start = 0;
  while (start < 3 && start < bytes.length && (bytes[start] & 0xc0) === 0x80) start++;
  return bytes.subarray(start);
}

/**
 * Walk a file backwards until it has its last `lines` lines, in the sense of
 * `split("\n")`: a final newline counts as an empty last line.
 *
 * A log nobody rotates reaches gigabytes, and reading one whole to show a
 * hundred lines stalled the panel, then threw past V8's string limit. Only the
 * end is read now. Decoded once, at the end: a chunk boundary can fall inside a
 * character, and a cut at a newline cannot, since that byte never occurs inside
 * a UTF-8 sequence.
 *
 * It yields what it wants read, so the same walk serves both drivers below.
 */
function* tailWalk(size: number, lines: number): Generator<TailRead, string, Buffer> {
  const chunks: Buffer[] = [];
  let position = size;
  let held = 0;
  let newlines = 0;

  while (position > 0 && held < MAX_TAIL_BYTES) {
    const length = Math.min(TAIL_CHUNK_BYTES, position);
    position -= length;
    const chunk = yield { position, length };

    for (let i = chunk.length - 1; i >= 0; i--) {
      if (chunk[i] !== NEWLINE || ++newlines < lines) continue;
      chunks.push(chunk.subarray(i + 1));
      return Buffer.concat(chunks.reverse()).toString("utf8");
    }

    chunks.push(chunk);
    held += chunk.length;
    // Truncated while being read, as a restart does: what precedes is gone.
    if (chunk.length < length) break;
  }

  const bytes = Buffer.concat(chunks.reverse());
  return (position > 0 ? dropLeadingContinuation(bytes) : bytes).toString("utf8");
}

function tailSync(file: string, lines: number): string {
  const fd = fs.openSync(file, "r");
  try {
    const walk = tailWalk(fs.fstatSync(fd).size, lines);
    let step = walk.next();
    while (!step.done) {
      const { position, length } = step.value;
      const buffer = Buffer.allocUnsafe(length);
      const read = fs.readSync(fd, buffer, 0, length, position);
      step = walk.next(buffer.subarray(0, read));
    }
    return step.value;
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * Read a log. `tailLines` returns only the end of it.
 *
 * Synchronous because its callers are, the SSE routes among them. With
 * `tailLines` the cost is the tail and not the file, bounded by
 * `MAX_TAIL_BYTES`. A request path that can wait uses `tailLogFile`.
 */
export function readLogFile(file: string, tailLines?: number): string {
  if (!fs.existsSync(file)) return "";

  try {
    return tailLines ? tailSync(file, tailLines) : fs.readFileSync(file, "utf8");
  } catch {
    return "";
  }
}

/** `readLogFile` with a tail, off the event loop. */
export async function tailLogFile(file: string, tailLines: number): Promise<string> {
  try {
    const handle = await fs.promises.open(file, "r");
    try {
      const walk = tailWalk((await handle.stat()).size, tailLines);
      let step = walk.next();
      while (!step.done) {
        const { position, length } = step.value;
        const buffer = Buffer.allocUnsafe(length);
        const { bytesRead } = await handle.read(buffer, 0, length, position);
        step = walk.next(buffer.subarray(0, bytesRead));
      }
      return step.value;
    } finally {
      await handle.close();
    }
  } catch {
    return "";
  }
}

/** The last `lines` non-empty lines of a log. */
export async function tailLogLines(file: string, lines: number): Promise<string[]> {
  // One more, for the empty element a final newline makes.
  const all = (await tailLogFile(file, lines + 1)).split("\n").filter(Boolean);
  return all.slice(Math.max(0, all.length - lines));
}

/**
 * Fit two streams into one budget, stdout first as it always was.
 *
 * Lines carry no timestamp, so they cannot be interleaved, and cutting from the
 * joined list let a hundred stderr lines hide stdout altogether. Each stream is
 * sure of half, and what one does not use goes to the other.
 */
export function mergeLogTails(out: string[], err: string[], lines: number): string[] {
  const keptErr = Math.min(err.length, Math.max(Math.ceil(lines / 2), lines - out.length));
  const keptOut = Math.min(out.length, lines - keptErr);
  return out.slice(out.length - keptOut).concat(err.slice(err.length - keptErr));
}

export function removeLogFile(file: string): void {
  try {
    if (fs.existsSync(file)) fs.rmSync(file, { force: true });
  } catch {
    /* a log that cannot be removed is not worth failing a sweep over */
  }
}

/** Drop every `<id>.log` in `dir` whose id is not in `keepIds`. */
export function pruneLogDir(dir: string, keepIds: Set<string>): number {
  if (!fs.existsSync(dir)) return 0;

  let removed = 0;
  for (const entry of fs.readdirSync(dir)) {
    if (!entry.endsWith(".log")) continue;
    if (keepIds.has(entry.slice(0, -4))) continue;
    try {
      fs.rmSync(path.join(dir, entry), { force: true });
      removed++;
    } catch {
      /* keep going — one stuck file should not stop the sweep */
    }
  }
  return removed;
}
