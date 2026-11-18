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

// --- Rotated logs -------------------------------------------------------------

export interface RotationPolicy {
  /** A file is closed and a new one started past this size. */
  fileBytes: number;
  /** Files kept, the live one included; the oldest is dropped when one more starts. */
  files: number;
}

/**
 * Where a batch of lines goes, given how big the live file already is.
 *
 * Lines are never split across files, so a file ends on a line. A batch larger
 * than everything the policy keeps loses its oldest lines up front (`skip`):
 * written anyway, they would only be rotated out by the end of the same call.
 * A single line larger than a file gets a file of its own rather than being cut
 * here — the caller caps line length.
 */
export function planRotation(
  currentBytes: number,
  lineBytes: readonly number[],
  policy: RotationPolicy
): { skip: number; groups: { rotate: boolean; count: number }[] } {
  const budget = policy.fileBytes * policy.files;
  let total = lineBytes.reduce((sum, bytes) => sum + bytes, 0);
  let skip = 0;
  // The last line always stays, however large: dropping it would lose the one
  // line nothing else would replace.
  while (skip < lineBytes.length - 1 && total > budget) total -= lineBytes[skip++];

  const groups: { rotate: boolean; count: number }[] = [];
  let size = currentBytes;
  for (let i = skip; i < lineBytes.length; i++) {
    const bytes = lineBytes[i];
    if (size > 0 && size + bytes > policy.fileBytes) {
      groups.push({ rotate: true, count: 0 });
      size = 0;
    } else if (groups.length === 0) {
      groups.push({ rotate: false, count: 0 });
    }
    groups[groups.length - 1].count++;
    size += bytes;
  }
  return { skip, groups };
}

/**
 * A log kept as a few files of bounded size: `<base>.log` is written, and
 * `<base>.1.log` … `<base>.<files-1>.log` are the older ones, newest first.
 *
 * Synchronous, like `AppendLogFile.flush`: the writer is a collector that has
 * already batched its lines, and a rename sequence that interleaved with
 * another write would be the one way to lose a file.
 */
export class RotatingLogFile {
  readonly dir: string;
  readonly base: string;
  readonly policy: RotationPolicy;

  constructor(dir: string, base: string, policy: RotationPolicy) {
    this.dir = dir;
    this.base = base;
    this.policy = policy;
  }

  /** The file of generation `index`: 0 is the live one. */
  fileAt(index: number): string {
    return path.join(this.dir, index === 0 ? `${this.base}.log` : `${this.base}.${index}.log`);
  }

  /** Every file there is, oldest first, so reading them in order reads the log in order. */
  files(): string[] {
    const out: string[] = [];
    for (let i = this.policy.files - 1; i >= 0; i--) {
      const file = this.fileAt(i);
      if (fs.existsSync(file)) out.push(file);
    }
    return out;
  }

  /** Bytes on disk across every file. */
  totalBytes(): number {
    return this.files().reduce((sum, file) => {
      try {
        return sum + fs.statSync(file).size;
      } catch {
        return sum;
      }
    }, 0);
  }

  append(lines: readonly string[]): void {
    if (lines.length === 0) return;
    fs.mkdirSync(this.dir, { recursive: true });

    let size = 0;
    try {
      size = fs.statSync(this.fileAt(0)).size;
    } catch {
      /* not there yet: it starts empty */
    }

    const plan = planRotation(size, lines.map((line) => Buffer.byteLength(line) + 1), this.policy);
    let next = plan.skip;
    for (const group of plan.groups) {
      if (group.rotate) this.rotate();
      const chunk = lines.slice(next, next + group.count);
      next += group.count;
      // 0600 on creation, for the reason `AppendLogFile` gives: an app's output
      // carries whatever the app chose to print, secrets included.
      fs.appendFileSync(this.fileAt(0), `${chunk.join("\n")}\n`, { mode: 0o600 });
    }
  }

  private rotate(): void {
    fs.rmSync(this.fileAt(this.policy.files - 1), { force: true });
    for (let i = this.policy.files - 2; i >= 0; i--) {
      const from = this.fileAt(i);
      if (fs.existsSync(from)) fs.renameSync(from, this.fileAt(i + 1));
    }
  }

  /** Every file, and the directory if nothing else is in it. */
  remove(): void {
    for (let i = 0; i < this.policy.files; i++) fs.rmSync(this.fileAt(i), { force: true });
    try {
      fs.rmdirSync(this.dir);
    } catch {
      /* something else lives there, or it was never created */
    }
  }
}

// --- Reading a file somebody else writes --------------------------------------

/**
 * How far a file written by another process has been read.
 *
 * `mark` is the base64 of the bytes just before `offset`. The writer can empty
 * the file and fill it again between two reads — PM2's files are truncated at
 * every start — and a size that is larger than the offset again says nothing
 * about it. Bytes that no longer match the ones read last time do.
 */
export interface FileCursor {
  offset: number;
  mark: string;
  /**
   * Where reading this file began: 0 when it was read from its start, more
   * when a long file was first met and only its end was read. Whoever empties
   * a file after reading it needs to know nothing older was skipped.
   */
  from?: number;
}

const MARK_BYTES = 64;
/** A line that never ends is taken as it is past this, or it would hold the reader forever. */
const MAX_PENDING_LINE = 64 * 1024;

function readRange(fd: number, start: number, length: number): Buffer {
  const buffer = Buffer.allocUnsafe(length);
  const read = fs.readSync(fd, buffer, 0, length, start);
  return buffer.subarray(0, read);
}

/**
 * The complete lines added to `file` since `cursor`, and the cursor after them.
 *
 * At most `maxBytes` per call: a backlog is read over several calls, never all
 * at once. With no cursor the read starts `maxBytes` from the end, at a line
 * boundary, so a file that grew for months before anybody read it costs one
 * bounded read. `restarted` says the file was emptied or replaced since the
 * cursor, and the read went back to its start. Null when there is no file.
 */
export function readNewLines(
  file: string,
  cursor: FileCursor | null,
  maxBytes: number
): { lines: string[]; cursor: FileCursor; restarted: boolean } | null {
  let fd: number;
  try {
    fd = fs.openSync(file, "r");
  } catch {
    return null;
  }

  try {
    const size = fs.fstatSync(fd).size;
    let start = 0;
    let restarted = false;

    if (cursor) {
      start = cursor.offset;
      if (size < cursor.offset) {
        restarted = true;
        start = 0;
      } else if (cursor.offset > 0 && cursor.mark) {
        const length = Math.min(MARK_BYTES, cursor.offset);
        if (readRange(fd, cursor.offset - length, length).toString("base64") !== cursor.mark) {
          restarted = true;
          start = 0;
        }
      }
    } else if (size > maxBytes) {
      // The first read of a long file: its end, from the first whole line.
      start = size - maxBytes;
      const head = readRange(fd, start, Math.min(maxBytes, MAX_PENDING_LINE));
      const newline = head.indexOf(0x0a);
      start = newline >= 0 ? start + newline + 1 : size;
    }

    const length = Math.min(size - start, maxBytes);
    const chunk = length > 0 ? readRange(fd, start, length) : Buffer.alloc(0);
    let end = chunk.lastIndexOf(0x0a) + 1;
    // A line still being written waits for its newline, unless it never gets one.
    if (end === 0 && chunk.length >= MAX_PENDING_LINE) end = chunk.length;

    const consumed = chunk.subarray(0, end);
    const offset = start + end;
    const markLength = Math.min(MARK_BYTES, offset);
    const mark =
      offset === 0
        ? ""
        : end >= markLength
          ? consumed.subarray(end - markLength).toString("base64")
          : readRange(fd, offset - markLength, markLength).toString("base64");

    const lines = consumed
      .toString("utf8")
      .split("\n")
      .filter((line) => line.trim() !== "");
    const from = cursor && !restarted ? (cursor.from ?? 0) : start;
    return { lines, cursor: { offset, mark, from }, restarted };
  } finally {
    fs.closeSync(fd);
  }
}

/** Empty a file in place, keeping it open for whoever writes it. */
export function truncateLogFile(file: string): boolean {
  try {
    fs.truncateSync(file, 0);
    return true;
  } catch {
    return false;
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
