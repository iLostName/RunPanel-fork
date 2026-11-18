/**
 * An app's log as the panel keeps it, and finding a line in it.
 *
 * The panel saves what each app prints into files of its own (see
 * `services/app-logs.ts`), because the runtimes do not keep it: PM2's files
 * are emptied at every start and a container's log goes with the container at
 * every deploy. Those files are read back by the API, which searches them, and
 * by the Logs tab, which searches what it already has on screen. Both search
 * with the functions here, so a line found in one place is found in the other.
 *
 * One stored line is `<time>\t<o|e>\t<text>`: the time in UTC to the
 * millisecond (empty when the source gave none), `o` or `e` for stdout or
 * stderr, then the line as printed. Tabs inside the text are fine — only the
 * first two separate fields — and a stored line never contains a newline.
 *
 * Zero imports: the unit suite loads this file directly, and the browser uses
 * it as is.
 */

export type LogStream = "stdout" | "stderr";

export interface LogEntry {
  /** ISO 8601 in UTC, to the millisecond. Null when the source had no time. */
  at: string | null;
  stream: LogStream;
  text: string;
}

/**
 * How much of an app's output is kept: five files of 4 MB, the oldest dropped
 * as a new one starts. 20 MB holds days of an ordinary app and hours of a
 * chatty one, and stays small next to the 30 MB Docker keeps per container.
 */
export const APP_LOG_RETENTION = { fileBytes: 4 * 1024 * 1024, files: 5 } as const;

/** Longer lines are cut: one JSON blob on a single line must not be a whole file. */
export const MAX_LOG_LINE_CHARS = 16 * 1024;

/** What the panel writes into an app's log when it notices a new run. */
export const RUN_MARKER = "[RunPanel] ── nuovo avvio dell'app ──";

// Spelled with fromCharCode for the reason `services/docker/cli.ts` gives: a raw
// escape byte in source is what an editor or a diff quietly eats.
const ANSI = new RegExp(`${String.fromCharCode(27)}\\[[0-9;?]*[ -/]*[@-~]`, "g");
const CONTROL = new RegExp(
  `[${String.fromCharCode(0)}-${String.fromCharCode(8)}${String.fromCharCode(11)}-${String.fromCharCode(31)}${String.fromCharCode(127)}]`,
  "g"
);

/**
 * One printed line, made fit to store and to show.
 *
 * Colour codes go, as they do in the live view. A carriage return in the middle
 * is a progress bar redrawing its line: what a terminal would show is what
 * follows the last one.
 */
export function cleanLogText(raw: string): string {
  let text = raw.replace(ANSI, "").replace(/\r+$/, "");
  const cr = text.lastIndexOf("\r");
  if (cr >= 0) text = text.slice(cr + 1);
  text = text.replace(CONTROL, "");
  return text.length > MAX_LOG_LINE_CHARS ? `${text.slice(0, MAX_LOG_LINE_CHARS)} …[riga troncata]` : text;
}

export function toArchiveLine(entry: LogEntry): string {
  return `${entry.at ?? ""}\t${entry.stream === "stderr" ? "e" : "o"}\t${entry.text}`;
}

/** A stored line, or null for one this format did not write. */
export function fromArchiveLine(line: string): LogEntry | null {
  const first = line.indexOf("\t");
  if (first < 0) return null;
  const second = line.indexOf("\t", first + 1);
  if (second < 0) return null;
  const code = line.slice(first + 1, second);
  if (code !== "o" && code !== "e") return null;
  const at = line.slice(0, first);
  return { at: at || null, stream: code === "e" ? "stderr" : "stdout", text: line.slice(second + 1) };
}

/** A line of the downloaded file: time, stream, text, in columns a `grep` can use. */
export function toDownloadLine(entry: LogEntry): string {
  return `${entry.at ?? "-".padEnd(24)}  ${entry.stream}  ${entry.text}`;
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export interface LogFilter {
  /** Text the line must contain, case-insensitively. Blank matches everything. */
  query?: string;
  stream?: LogStream | "all";
}

/**
 * The predicate for a search: a plain substring, case-insensitive, never a
 * regular expression. Someone pasting an error message to find it must not
 * have to escape its brackets first.
 */
export function makeLogFilter(filter: LogFilter): (line: { text: string; stream?: LogStream }) => boolean {
  const needle = filter.query?.trim() ?? "";
  const pattern = needle ? new RegExp(escapeRegExp(needle), "iu") : null;
  const stream = filter.stream && filter.stream !== "all" ? filter.stream : null;
  return (line) => (!stream || (line.stream ?? "stdout") === stream) && (!pattern || pattern.test(line.text));
}

/** `text` cut into the pieces that match `query` and those that do not, for highlighting. */
export function highlightParts(text: string, query: string): { text: string; match: boolean }[] {
  const needle = query.trim();
  if (!needle || !text) return [{ text, match: false }];

  const parts: { text: string; match: boolean }[] = [];
  let last = 0;
  for (const found of text.matchAll(new RegExp(escapeRegExp(needle), "giu"))) {
    const start = found.index ?? 0;
    if (start > last) parts.push({ text: text.slice(last, start), match: false });
    parts.push({ text: found[0], match: true });
    last = start + found[0].length;
  }
  if (last < text.length) parts.push({ text: text.slice(last), match: false });
  return parts;
}

// --- Docker's timestamps ------------------------------------------------------

/**
 * A stamp from `docker logs --timestamps`, with its fraction padded to nine
 * digits.
 *
 * Docker trims trailing zeros (`…:00.12Z` beside `…:00.1234Z`), which sorts
 * wrongly as text. Padded, two stamps compare as strings — and stay exact,
 * which a Date would not: it keeps milliseconds, and the read that follows has
 * to start at the very nanosecond the last one ended.
 */
export function normalizeDockerTs(ts: string): string | null {
  const match = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d{1,9}))?Z$/.exec(ts);
  if (!match) return null;
  return `${match[1]}.${(match[2] ?? "").padEnd(9, "0")}Z`;
}

/** The stamp and the text of one `--timestamps` line. */
export function splitTimestamped(line: string): { ts: string; text: string } | null {
  const space = line.indexOf(" ");
  const ts = normalizeDockerTs(space < 0 ? line : line.slice(0, space));
  if (!ts) return null;
  return { ts, text: space < 0 ? "" : line.slice(space + 1) };
}

/** A padded stamp as stored: milliseconds, the way `Date#toISOString` writes them. */
export function isoFromDockerTs(ts: string): string {
  return `${ts.slice(0, 23)}Z`;
}

export interface StampedLine {
  ts: string;
  stream: LogStream;
  text: string;
}

/**
 * stdout and stderr in the order they were written.
 *
 * They arrive on two pipes and each is in order on its own; the stamps put
 * them together. Equal stamps keep stdout first, the order `mergeLogTails`
 * already uses for the live tail.
 */
export function mergeStamped(a: readonly StampedLine[], b: readonly StampedLine[]): StampedLine[] {
  const out: StampedLine[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) out.push(b[j].ts < a[i].ts ? b[j++] : a[i++]);
  return out.concat(a.slice(i), b.slice(j));
}

/** Where the next `docker logs --since` starts, and how much of it was already stored. */
export interface StampCursor {
  since: string | null;
  /** Lines stamped exactly `since` that are already stored. */
  skip: number;
}

/**
 * The lines of a read that the previous read did not store, and the cursor
 * for the next one.
 *
 * `--since` includes its own instant, so a read that starts at the last stamp
 * stored gets those lines back: `skip` counts them, and they are dropped
 * instead of stored twice. A read with nothing new leaves the cursor as it was.
 */
export function freshSince(
  lines: readonly StampedLine[],
  cursor: StampCursor
): { fresh: StampedLine[]; cursor: StampCursor } {
  const fresh: StampedLine[] = [];
  let skipped = 0;
  for (const line of lines) {
    if (cursor.since !== null) {
      if (line.ts < cursor.since) continue;
      if (line.ts === cursor.since && skipped < cursor.skip) {
        skipped++;
        continue;
      }
    }
    fresh.push(line);
  }
  if (fresh.length === 0) return { fresh, cursor };

  const last = fresh[fresh.length - 1].ts;
  return { fresh, cursor: { since: last, skip: lines.filter((line) => line.ts === last).length } };
}
