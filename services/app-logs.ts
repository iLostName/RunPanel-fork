import fs from "fs";
import path from "path";
import { spawn } from "child_process";
import { StringDecoder } from "string_decoder";
import { config } from "@/lib/config";
import { getDb } from "@/lib/db";
import { sanitizedProcessEnv } from "@/lib/env";
import {
  APP_LOG_RETENTION,
  RUN_MARKER,
  cleanLogText,
  freshSince,
  fromArchiveLine,
  isoFromDockerTs,
  makeLogFilter,
  mergeStamped,
  splitTimestamped,
  toArchiveLine,
  toDownloadLine,
  type LogEntry,
  type LogStream,
  type StampCursor,
  type StampedLine,
} from "@/lib/log-search";
import { projectEvents } from "./events";
import { RotatingLogFile, isLogId, readNewLines, truncateLogFile, type FileCursor } from "./log-file";
import { dockerTry } from "./docker/cli";
import { dockerConfigEnv } from "./docker/registry";
import { LABEL_KIND, LABEL_PROJECT, appContainerName, ownedFilters, parseLabels } from "./docker/labels";
import { composeContext, composeLogs } from "./docker/compose";
import { getRepoPath } from "./git-manager";
import { pm2LogFile } from "./process-drivers/pm2-driver";

/**
 * What every app prints, kept by the panel across restarts and deploys.
 *
 * Neither runtime keeps it. PM2's files are emptied at every start, on purpose
 * (see `process-drivers/run-log.ts`), and a container's log is deleted with the
 * container, which a deploy replaces. So the crash that made somebody press
 * Restart was gone the moment they pressed it.
 *
 * The runtimes' own logs stay what they are — the current run, for the live
 * view and for a failed deploy's report. This reads them as they grow and
 * copies the new lines into a rotated archive per project
 * (`logs/apps/<id>/app*.log`, see `APP_LOG_RETENTION`), with a time and a
 * stream on each line. Reading, not following: a `docker logs -f` per project
 * held open forever costs a process each, and a read that starts where the
 * last one ended also catches up on whatever was printed while the panel was
 * down.
 *
 *  - PM2 files are read by byte offset every tick. Cheap, and the time stored
 *    is when the line was read: within one tick of when it was printed.
 *  - Containers are asked for `docker logs --since <last stamp>` less often,
 *    with Docker's own stamps, stdout and stderr apart.
 *  - Compose stacks the same way through `compose logs`, which merges the two
 *    streams and trims the lines: best effort.
 *
 * A new run is collected for the moment it is announced (`process:reset`),
 * before the driver empties the files. For PM2 that read is synchronous and
 * the deploy has already stopped the old process, so nothing is lost; a
 * container's read races its removal and usually wins.
 */

type RuntimeKind = "native" | "docker" | "compose";

function runtimeKind(runtimeType: string): RuntimeKind {
  if (runtimeType === "compose") return "compose";
  if (runtimeType === "docker") return "docker";
  return "native";
}

interface ProjectRow {
  id: string;
  slug: string;
  runtime_type: string;
  status: string;
}

/** Ten seconds between reads of PM2's files; containers are read every third tick. */
const TICK_MS = 10_000;
const CONTAINER_EVERY_MS = 30_000;
/**
 * Soon after boot, and before the autostart pass (20 s): it restarts PM2 apps
 * with `processManager.restart`, which empties their files without a
 * `process:reset` — and what an app printed before the machine went down is
 * the line somebody will come looking for.
 */
const FIRST_TICK_MS = 5_000;
const PRUNE_EVERY_MS = 5 * 60_000;
/** What a request waits for a fresh read before answering with what is stored. */
const COLLECT_WAIT_MS = 4_000;

/** Bytes read from one PM2 file per tick; a backlog is read over several. */
const NATIVE_READ_BYTES = 4 * 1024 * 1024;
/**
 * A PM2 file past this is emptied once it has been read — nothing else ever
 * bounds it while the app runs. 16 MB keeps the current run readable through
 * `processManager.logs()` for anything but a very chatty app.
 */
const PM2_FILE_CAP = 16 * 1024 * 1024;
/** Lines asked of Docker per read: a 30-second window that overflows this is sampled. */
const DOCKER_TAIL = 5000;
const DOCKER_READ_MS = 20_000;
/** A run that loses lines is a run that says so. */
const GAP_MARKER = "[RunPanel] Alcune righe non sono state salvate: l'app ne ha scritte troppe in poco tempo.";

const ACTIVE = new Set(["running", "error", "deploying"]);

// --- Where things are kept ------------------------------------------------------

export function appLogDir(projectId: string): string {
  // The id becomes a path: refused before anything is joined, as in `logPathFor`.
  if (!isLogId(projectId)) throw new Error(`Invalid project id: ${projectId}`);
  return path.join(config.logsDir, "apps", projectId);
}

function archiveFor(projectId: string): RotatingLogFile {
  return new RotatingLogFile(appLogDir(projectId), "app", APP_LOG_RETENTION);
}

/** How far each source has been read. One file per project, next to the logs it describes. */
interface Cursor {
  native?: { out: FileCursor | null; err: FileCursor | null };
  docker?: StampCursor & { container: string | null };
  compose?: StampCursor;
}

function cursorFile(projectId: string): string {
  return path.join(appLogDir(projectId), "cursor.json");
}

function readCursor(projectId: string): Cursor {
  try {
    const parsed = JSON.parse(fs.readFileSync(cursorFile(projectId), "utf8")) as unknown;
    return parsed && typeof parsed === "object" ? (parsed as Cursor) : {};
  } catch {
    return {};
  }
}

function writeCursor(projectId: string, cursor: Cursor): void {
  const file = cursorFile(projectId);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  // Renamed into place: a cursor cut in half would restart every source from
  // its beginning and store all of it twice.
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(cursor), { mode: 0o600 });
  fs.renameSync(tmp, file);
}

// --- Reading the runtimes ---------------------------------------------------------

/** New PM2 output. Synchronous, so it can run inside the `process:reset` event. */
function collectNative(project: ProjectRow): number {
  const cursor = readCursor(project.id);
  const previous = cursor.native ?? { out: null, err: null };
  const next = { ...previous };
  const now = new Date().toISOString();
  const entries: LogEntry[] = [];
  let restarted = false;
  const full: string[] = [];

  const sources: [file: string, stream: LogStream, key: "out" | "err"][] = [
    [pm2LogFile(project.slug, "out"), "stdout", "out"],
    [pm2LogFile(project.slug, "error"), "stderr", "err"],
  ];
  for (const [file, stream, key] of sources) {
    const read = readNewLines(file, previous[key], NATIVE_READ_BYTES);
    if (!read) continue;
    restarted ||= read.restarted;
    next[key] = read.cursor;
    for (const line of read.lines) entries.push({ at: now, stream, text: cleanLogText(line) });
    if (read.cursor.offset >= PM2_FILE_CAP) full.push(file);
  }

  // The file went back to empty: PM2 started the app again. Said in the log, so
  // the lines before and after it read as two runs, not one.
  if (restarted) entries.unshift({ at: now, stream: "stdout", text: RUN_MARKER });
  if (entries.length > 0) archiveFor(project.id).append(entries.map(toArchiveLine));

  // Everything up to here is in the archive: a file past its cap can go back to
  // empty. Only when the read reached its end, so no unread line goes with it.
  for (const [file, , key] of sources) {
    if (!full.includes(file)) continue;
    try {
      if (fs.statSync(file).size !== next[key]?.offset) continue;
    } catch {
      continue;
    }
    if (truncateLogFile(file)) next[key] = { offset: 0, mark: "" };
  }

  if (entries.length > 0 || JSON.stringify(next) !== JSON.stringify(previous)) {
    writeCursor(project.id, { ...cursor, native: next });
  }
  return entries.length;
}

/** One line-splitting decoder per pipe: a chunk can end inside a character or a line. */
class StampedCollector {
  private decoder = new StringDecoder("utf8");
  private pending = "";
  readonly lines: StampedLine[] = [];
  private readonly stream: LogStream;

  constructor(stream: LogStream) {
    this.stream = stream;
  }

  push(chunk: Buffer): void {
    this.pending += this.decoder.write(chunk);
    const parts = this.pending.split("\n");
    this.pending = parts.pop() ?? "";
    for (const part of parts) this.take(part);
  }

  finish(): StampedLine[] {
    this.pending += this.decoder.end();
    if (this.pending) this.take(this.pending);
    this.pending = "";
    return this.lines;
  }

  private take(raw: string): void {
    const split = splitTimestamped(raw.replace(/\r$/, ""));
    // Every line of `--timestamps` has a stamp; one that does not continues the
    // line before it, and keeps its time.
    const previous = this.lines[this.lines.length - 1];
    if (!split) {
      if (previous && raw.trim()) this.lines.push({ ts: previous.ts, stream: this.stream, text: cleanLogText(raw) });
      return;
    }
    if (!split.text.trim()) return;
    this.lines.push({ ts: split.ts, stream: this.stream, text: cleanLogText(split.text) });
  }
}

/**
 * `docker logs` with stdout and stderr kept apart.
 *
 * Not `dockerStream`: that joins both pipes into one callback and trims every
 * line, and here the stream is half of what is stored. The environment is the
 * one every docker call gets. Null when Docker said no, or took too long —
 * then nothing is stored and the cursor stays, so the next read tries again.
 */
function readDockerLogs(args: string[]): Promise<{ out: StampedLine[]; err: StampedLine[] } | null> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value: { out: StampedLine[]; err: StampedLine[] } | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };

    const out = new StampedCollector("stdout");
    const err = new StampedCollector("stderr");
    const child = spawn("docker", args, {
      windowsHide: true,
      env: { ...sanitizedProcessEnv(), ...(dockerConfigEnv() ?? {}) },
    });
    const timer = setTimeout(() => {
      child.kill();
      finish(null);
    }, DOCKER_READ_MS);

    child.stdout?.on("data", (chunk: Buffer) => out.push(chunk));
    child.stderr?.on("data", (chunk: Buffer) => err.push(chunk));
    child.on("error", () => finish(null));
    child.on("close", (code) => finish(code === 0 ? { out: out.finish(), err: err.finish() } : null));
  });
}

interface AppContainer {
  id: string;
  state: string;
}

const CONTAINER_LIST_TTL_MS = 10_000;

/**
 * RunPanel's app containers by project, in one listing for every project.
 *
 * A name is not ownership — `foreignOwner` in `docker/labels.ts` says why —
 * and a log read from a container that merely answers to the name would show
 * one project somebody else's output. Only a container labelled as this
 * project's app counts. The id is what tells a new run from the old one.
 */
async function appContainers(): Promise<Map<string, AppContainer> | null> {
  const cached = state.containers;
  if (cached && Date.now() - cached.at < CONTAINER_LIST_TTL_MS) return cached.value;

  const result = await dockerTry(
    ["ps", "-a", ...ownedFilters({ kind: "app" }), "--format", "{{.ID}}|{{.Names}}|{{.State}}|{{.Labels}}"],
    { timeout: 15_000 }
  );
  let value: Map<string, AppContainer> | null = null;
  if (result) {
    value = new Map();
    for (const line of result.stdout.split("\n")) {
      const [id, names, containerState, ...rest] = line.trim().split("|");
      if (!id || !names) continue;
      const labels = parseLabels(rest.join("|"));
      const slug = labels[LABEL_PROJECT];
      if (!slug || labels[LABEL_KIND] !== "app") continue;
      if (!names.split(",").map((name) => name.trim()).includes(appContainerName(slug))) continue;
      value.set(slug, { id, state: containerState ?? "" });
    }
  }
  state.containers = { at: Date.now(), value };
  return value;
}

/** Store a read: its fresh lines, a marker for a new run, a marker for a gap. */
function storeStamped(
  project: ProjectRow,
  fresh: readonly StampedLine[],
  opts: { newRun: boolean; gap: boolean }
): number {
  const entries: LogEntry[] = fresh.map((line) => ({ at: isoFromDockerTs(line.ts), stream: line.stream, text: line.text }));
  if (entries.length === 0) return 0;
  const first = entries[0].at;
  if (opts.gap) entries.unshift({ at: first, stream: "stdout", text: GAP_MARKER });
  if (opts.newRun) entries.unshift({ at: first, stream: "stdout", text: RUN_MARKER });
  archiveFor(project.id).append(entries.map(toArchiveLine));
  return entries.length;
}

function sinceArgs(cursor: StampCursor): string[] {
  return cursor.since ? ["--since", cursor.since] : [];
}

/** Whether a read hit its line budget with lines still missing before it. */
function overflowed(lines: readonly StampedLine[], cursor: StampCursor): boolean {
  return lines.length >= DOCKER_TAIL && cursor.since !== null && lines[0].ts > cursor.since;
}

async function collectDocker(project: ProjectRow): Promise<number> {
  const containers = await appContainers();
  const container = containers?.get(project.slug);
  if (!container) return 0;

  const cursor = readCursor(project.id);
  const previous = cursor.docker ?? { since: null, skip: 0, container: null };
  // A new container is a new log. Its lines all come after the last stamp
  // stored, and the count of lines at that stamp belonged to the old one.
  const newRun = previous.container !== null && previous.container !== container.id;
  const start: StampCursor = newRun ? { since: previous.since, skip: 0 } : previous;

  const read = await readDockerLogs([
    "logs",
    "--timestamps",
    "--tail",
    String(DOCKER_TAIL),
    ...sinceArgs(start),
    appContainerName(project.slug),
  ]);
  if (!read) return 0;

  const merged = mergeStamped(read.out, read.err);
  const { fresh, cursor: next } = freshSince(merged, start);
  // Nothing from the new container yet: the cursor stays on the old one, so the
  // run marker is still owed when its first line arrives.
  if (newRun && fresh.length === 0) return 0;

  const stored = storeStamped(project, fresh, { newRun, gap: overflowed(merged, start) });
  if (stored > 0 || previous.container === null) {
    writeCursor(project.id, { ...cursor, docker: { ...next, container: container.id } });
  }
  return stored;
}

async function collectCompose(project: ProjectRow): Promise<number> {
  const ctx = composeContext(project.slug, getRepoPath(project.slug));
  if (!ctx) return 0;

  const cursor = readCursor(project.id);
  const start = cursor.compose ?? { since: null, skip: 0 };
  const raw = await composeLogs(ctx, DOCKER_TAIL, ["--timestamps", ...sinceArgs(start)]);

  // `service-1  | <stamp> <text>`; compose's own warnings carry no stamp and
  // are not the app's output.
  const stamped: StampedLine[] = [];
  for (const line of raw) {
    const bar = line.indexOf("|");
    const service = bar > 0 ? line.slice(0, bar).trim() : "";
    const split = splitTimestamped(bar > 0 ? line.slice(bar + 1).trimStart() : line);
    if (!split || !split.text.trim()) continue;
    stamped.push({ ts: split.ts, stream: "stdout", text: cleanLogText(service ? `${service} | ${split.text}` : split.text) });
  }
  // Services interleave in the order compose read them; the stamps say when.
  stamped.sort((a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : 0));

  const { fresh, cursor: next } = freshSince(stamped, start);
  const stored = storeStamped(project, fresh, { newRun: false, gap: overflowed(stamped, start) });
  if (stored > 0) writeCursor(project.id, { ...cursor, compose: next });
  return stored;
}

function collectOnce(project: ProjectRow): Promise<number> {
  const kind = runtimeKind(project.runtime_type);
  if (kind === "docker") return collectDocker(project);
  if (kind === "compose") return collectCompose(project);
  try {
    return Promise.resolve(collectNative(project));
  } catch (err) {
    return Promise.reject(err);
  }
}

// --- The collector ------------------------------------------------------------

interface KnownProject extends ProjectRow {
  unsubscribe: () => void;
  wasActive: boolean;
  /** It stopped since the last read: one more read, for its last lines. */
  finalPending: boolean;
  collectedAt: number;
  lastError: string | null;
}

interface CollectorState {
  timer: NodeJS.Timeout | null;
  firstTick: NodeJS.Timeout | null;
  ticking: boolean;
  known: Map<string, KnownProject>;
  containersAt: number;
  prunedAt: number;
  running: Map<string, Promise<number>>;
  queued: Map<string, Promise<number>>;
  containers: { at: number; value: Map<string, AppContainer> | null } | null;
  refreshing?: Promise<boolean> | null;
}

// On globalThis so dev-mode reloads do not start a second timer, as in `status-reconcile.ts`.
const globalRef = globalThis as typeof globalThis & { __runpanelAppLogs?: CollectorState };
const state: CollectorState = (globalRef.__runpanelAppLogs ??= {
  timer: null,
  firstTick: null,
  ticking: false,
  known: new Map(),
  containersAt: 0,
  prunedAt: 0,
  running: new Map(),
  queued: new Map(),
  containers: null,
});

function report(project: KnownProject | undefined, err: unknown): void {
  const message = err instanceof Error ? err.message : String(err);
  // Once per change, not once per tick: a file that cannot be read stays
  // unreadable, and the panel's own log is not the place to count the ticks.
  if (project && project.lastError === message) return;
  if (project) project.lastError = message;
  console.error(`[app-logs] ${project?.slug ?? "?"}: ${message}`);
}

/**
 * Read a project now, one read at a time per project.
 *
 * A read already running is waited for and followed by one more, so a request
 * sees output printed after it arrived; callers that pile up share that one.
 */
function collectProject(project: ProjectRow): Promise<number> {
  const queued = state.queued.get(project.id);
  if (queued) return queued;

  const running = state.running.get(project.id);
  const run = (): Promise<number> => {
    const known = state.known.get(project.id);
    const job = collectOnce(project)
      .then((count) => {
        if (known) {
          known.collectedAt = Date.now();
          known.finalPending = false;
          known.lastError = null;
        }
        return count;
      })
      .finally(() => {
        if (state.running.get(project.id) === job) state.running.delete(project.id);
      });
    state.running.set(project.id, job);
    return job;
  };

  if (!running) return run();
  const next = running
    .catch(() => 0)
    .then(() => {
      state.queued.delete(project.id);
      return run();
    });
  state.queued.set(project.id, next);
  return next;
}

/** A new run is about to replace the old one: read the old one's last lines first. */
function onProjectEvent(projectId: string, type: string): void {
  if (type !== "process:reset") return;
  const project = state.known.get(projectId);
  if (!project) return;
  try {
    // Synchronous for PM2: this listener runs inside the emit, before the
    // driver empties the files.
    if (runtimeKind(project.runtime_type) === "native") {
      collectNative(project);
      project.collectedAt = Date.now();
    } else {
      void collectProject(project).catch((err) => report(project, err));
    }
  } catch (err) {
    // Never into the deploy that emitted the event.
    report(project, err);
  }
}

/** One listing at a time: two at once would each subscribe the same new project. */
function refreshKnown(): Promise<boolean> {
  state.refreshing ??= listProjects().finally(() => {
    state.refreshing = null;
  });
  return state.refreshing;
}

async function listProjects(): Promise<boolean> {
  let rows: ProjectRow[];
  try {
    const db = await getDb();
    rows = await db.selectFrom("projects").select(["id", "slug", "runtime_type", "status"]).execute();
  } catch (err) {
    report(undefined, err);
    return false;
  }

  const seen = new Set<string>();
  for (const row of rows) {
    if (!isLogId(row.id)) continue;
    seen.add(row.id);
    const known = state.known.get(row.id);
    if (known) {
      known.slug = row.slug;
      known.runtime_type = row.runtime_type;
      known.status = row.status;
      continue;
    }
    state.known.set(row.id, {
      ...row,
      unsubscribe: projectEvents.subscribe(row.id, (event) => onProjectEvent(row.id, event.type)),
      wasActive: false,
      finalPending: false,
      collectedAt: 0,
      lastError: null,
    });
  }
  for (const [id, known] of state.known) {
    if (seen.has(id)) continue;
    known.unsubscribe();
    state.known.delete(id);
  }
  return true;
}

/** Archives of projects that no longer exist. Only after a listing that worked. */
function prune(): void {
  const dir = path.join(config.logsDir, "apps");
  let entries: string[];
  try {
    entries = fs.readdirSync(dir);
  } catch {
    return;
  }
  for (const entry of entries) {
    if (!isLogId(entry) || state.known.has(entry)) continue;
    fs.rmSync(path.join(dir, entry), { recursive: true, force: true });
  }
}

async function tick(): Promise<void> {
  if (state.ticking) return;
  state.ticking = true;
  try {
    const listed = await refreshKnown();
    const now = Date.now();
    const containersDue = now - state.containersAt >= CONTAINER_EVERY_MS;
    if (containersDue) state.containersAt = now;

    for (const project of state.known.values()) {
      const active = ACTIVE.has(project.status);
      if (project.wasActive && !active) project.finalPending = true;
      project.wasActive = active;
      // Running, just stopped, or not read since boot: what was printed while
      // the panel was down is still in the runtime's own log.
      if (!active && !project.finalPending && project.collectedAt !== 0) continue;
      if (state.running.has(project.id)) continue;

      const native = runtimeKind(project.runtime_type) === "native";
      if (!native && !containersDue) continue;
      try {
        // In turn rather than all at once: every docker call is a process.
        await collectProject(project);
      } catch (err) {
        report(project, err);
      }
    }

    if (listed && now - state.prunedAt >= PRUNE_EVERY_MS) {
      state.prunedAt = now;
      prune();
    }
  } catch (err) {
    report(undefined, err);
  } finally {
    state.ticking = false;
  }
}

export function startAppLogCollector(): void {
  if (state.timer) return;
  // Listening from the start, reading only later: a run replaced before the
  // first tick — the autostart pass after a reboot — still has its old lines
  // read before the driver empties them.
  void refreshKnown();
  state.timer = setInterval(() => void tick(), TICK_MS);
  state.timer.unref?.();
  state.firstTick = setTimeout(() => void tick(), FIRST_TICK_MS);
  state.firstTick.unref?.();
}

// --- Reading the archive -------------------------------------------------------

function withTimeout(promise: Promise<unknown>, ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    promise.then(
      () => {
        clearTimeout(timer);
        resolve();
      },
      () => {
        clearTimeout(timer);
        resolve();
      }
    );
  });
}

/**
 * Every archive file opened before any is read.
 *
 * A rotation renames the files under a reader that goes by name, which would
 * read one of them twice and skip another. An open handle keeps reading the
 * file it opened, renamed or deleted, on Windows too: Node opens with sharing
 * for delete.
 */
async function openArchive(projectId: string): Promise<fs.promises.FileHandle[]> {
  const handles = await Promise.all(
    archiveFor(projectId)
      .files()
      .map((file) => fs.promises.open(file, "r").catch(() => null))
  );
  return handles.filter((handle): handle is fs.promises.FileHandle => handle !== null);
}

export interface AppLogPage {
  /** Oldest first. */
  entries: LogEntry[];
  /** Older lines matching the same filter exist past the limit. */
  more: boolean;
  stored: { bytes: number; files: number; since: string | null };
  retention: { fileBytes: number; files: number };
  runtime: RuntimeKind;
}

/** The last `limit` stored lines that match, read after a fresh collection. */
export async function readAppLog(
  project: ProjectRow,
  opts: { limit: number; query?: string; stream?: LogStream }
): Promise<AppLogPage> {
  await withTimeout(collectProject(project), COLLECT_WAIT_MS);

  const handles = await openArchive(project.id);
  const filter = makeLogFilter({ query: opts.query, stream: opts.stream });
  const picked: LogEntry[] = [];
  let more = false;
  let bytes = 0;
  let since: string | null = null;

  try {
    for (const file of handles) bytes += (await file.stat()).size;
    if (handles.length > 0) since = await firstStoredTime(handles[0]);
    // Newest file first, newest line first, until there are enough.
    for (let i = handles.length - 1; i >= 0 && !more; i--) {
      const lines = (await readHandle(handles[i])).split("\n");
      for (let j = lines.length - 1; j >= 0; j--) {
        const entry = fromArchiveLine(lines[j]);
        if (!entry || !filter(entry)) continue;
        if (picked.length >= opts.limit) {
          more = true;
          break;
        }
        picked.push(entry);
      }
    }
  } finally {
    await Promise.all(handles.map((file) => file.close().catch(() => {})));
  }

  return {
    entries: picked.reverse(),
    more,
    stored: { bytes, files: handles.length, since },
    retention: { ...APP_LOG_RETENTION },
    runtime: runtimeKind(project.runtime_type),
  };
}

async function readHandle(file: fs.promises.FileHandle): Promise<string> {
  try {
    return await file.readFile({ encoding: "utf8" });
  } catch {
    return "";
  }
}

/** When the oldest stored line was printed, from the head of the oldest file. */
async function firstStoredTime(file: fs.promises.FileHandle): Promise<string | null> {
  try {
    const head = Buffer.alloc(4096);
    const { bytesRead } = await file.read(head, 0, head.length, 0);
    for (const line of head.subarray(0, bytesRead).toString("utf8").split("\n")) {
      const entry = fromArchiveLine(line);
      if (entry?.at) return entry.at;
    }
  } catch {
    /* an unreadable head leaves the date unknown, nothing more */
  }
  return null;
}

/**
 * The whole archive as a text file, oldest line first, streamed file by file.
 *
 * Read after a fresh collection, so the file ends with what the app printed a
 * moment ago and not with whatever the last tick happened to store.
 */
export async function appLogDownload(project: ProjectRow & { name?: string }): Promise<ReadableStream<Uint8Array>> {
  await withTimeout(collectProject(project), COLLECT_WAIT_MS);

  const handles = await openArchive(project.id);
  const encoder = new TextEncoder();
  let index = 0;
  const header =
    `# Log dell'app${project.name ? ` «${project.name}»` : ""} salvato da RunPanel, ` +
    `scaricato il ${new Date().toISOString()}\n` +
    `# ora (UTC)                stream  riga\n`;

  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode(header));
    },
    async pull(controller) {
      if (index >= handles.length) {
        controller.close();
        return;
      }
      const current = handles[index++];
      const text = await readHandle(current);
      await current.close().catch(() => {});
      const lines: string[] = [];
      for (const line of text.split("\n")) {
        const entry = fromArchiveLine(line);
        if (entry) lines.push(toDownloadLine(entry));
      }
      if (lines.length > 0) controller.enqueue(encoder.encode(`${lines.join("\n")}\n`));
    },
    async cancel() {
      await Promise.all(handles.slice(index).map((h) => h.close().catch(() => {})));
    },
  });
}
