/**
 * A live cache of per-container resource usage, fed by ONE long-running
 * `docker stats` process.
 *
 * What this replaces: every status poll ran `docker stats --no-stream` once per
 * container. Measured on this machine that call costs ~2.5s regardless of how
 * many containers it inspects, and `/api/monitor` fanned it out across every
 * running service on a 3-second interval — so the endpoint could not finish a
 * pass before the next one began.
 *
 * The stream only runs while someone is reading. dockerd samples the cgroups of
 * every running container about once a second for as long as it is open, and
 * entries go stale after 15 seconds, so one visit to the monitor page used to
 * cost that for the rest of the life of the panel. Past `idleStopMs` without a
 * read it stops; the next read starts it again.
 *
 * Behaviours confirmed against the Docker CLI rather than assumed:
 *  - a streaming `docker stats` picks up containers that start later, so no
 *    `docker events` subscription is needed to keep the set current;
 *  - each refresh cycle is prefixed with an ANSI cursor-home sequence (stripped
 *    in dockerStream);
 *  - transient rows can carry the literal name "--", which must be ignored or
 *    the cache grows a phantom entry.
 *
 * The daemon arrives through `StatsSource`, so the whole lifecycle can be driven
 * without one.
 */

export interface ContainerStats {
  name: string;
  /** Percent of one host CPU, as Docker reports it. */
  cpu: number;
  /** Bytes. */
  memory: number;
  memoryPercent: number;
  updatedAt: number;
}

interface RawStatsLine {
  Name?: string;
  CPUPerc?: string;
  MemUsage?: string;
  MemPerc?: string;
}

export interface StatsSource {
  available: () => Promise<boolean>;
  /** Start the stream. Returns the function that stops it. */
  stream: (onLine: (line: string) => void, onExit: () => void) => () => void;
}

export interface StatsTimings {
  idleStopMs: number;
  restartDelayMs: number;
}

/** Entries older than this are treated as gone rather than stale-but-true. */
const STALE_AFTER_MS = 15_000;

const DEFAULT_TIMINGS: StatsTimings = { idleStopMs: 60_000, restartDelayMs: 5_000 };

export class StatsCollector {
  private cache = new Map<string, ContainerStats>();
  private stop: (() => void) | null = null;
  private restartTimer: NodeJS.Timeout | null = null;
  private idleTimer: NodeJS.Timeout | null = null;
  private starting = false;
  private lastRead = 0;
  private readonly source: StatsSource;
  private readonly timings: StatsTimings;

  constructor(source: StatsSource, timings: StatsTimings = DEFAULT_TIMINGS) {
    this.source = source;
    this.timings = timings;
  }

  /** Whether the stream is up right now. */
  get streaming(): boolean {
    return this.stop !== null;
  }

  private hasReaders(): boolean {
    return Date.now() - this.lastRead < this.timings.idleStopMs;
  }

  /** Every read counts, and brings the stream back if it stopped for lack of them. */
  private noteRead(): Promise<void> {
    this.lastRead = Date.now();
    return this.start();
  }

  ensureStarted(): Promise<void> {
    return this.noteRead();
  }

  private async start(): Promise<void> {
    if (this.stop || this.starting) return;
    this.starting = true;
    try {
      if (!(await this.source.available())) return;
      this.spawn();
    } finally {
      this.starting = false;
    }
  }

  private spawn(): void {
    this.stop = this.source.stream(
      (line) => this.ingest(line),
      () => {
        this.stop = null;
        this.clearIdleTimer();
        // Docker restarted, or the daemon went away. Try again shortly rather
        // than silently serving a cache that will never update again — unless
        // nobody is reading it, in which case the next read will.
        if (this.restartTimer || !this.hasReaders()) return;
        this.restartTimer = setTimeout(() => {
          this.restartTimer = null;
          if (this.hasReaders()) void this.start();
        }, this.timings.restartDelayMs);
        this.restartTimer.unref?.();
      }
    );
    this.armIdleTimer();
  }

  private armIdleTimer(): void {
    this.clearIdleTimer();
    const remaining = this.lastRead + this.timings.idleStopMs - Date.now();

    this.idleTimer = setTimeout(() => {
      this.idleTimer = null;
      if (this.hasReaders()) this.armIdleTimer();
      else this.shutdown();
    }, Math.max(remaining, 1));
    this.idleTimer.unref?.();
  }

  private clearIdleTimer(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = null;
  }

  private ingest(line: string): void {
    if (!line.startsWith("{")) return;

    let raw: RawStatsLine;
    try {
      raw = JSON.parse(line);
    } catch {
      return;
    }

    const name = raw.Name?.trim();
    // Docker emits placeholder rows for containers mid-transition.
    if (!name || name === "--") return;

    this.cache.set(name, {
      name,
      cpu: parsePercent(raw.CPUPerc),
      memory: parseMemUsage(raw.MemUsage),
      memoryPercent: parsePercent(raw.MemPerc),
      updatedAt: Date.now(),
    });
  }

  get(name: string): ContainerStats | null {
    void this.noteRead();
    return this.peek(name);
  }

  /**
   * What is known, without asking for more.
   *
   * For the drivers: `status()` is also how the background sweep looks at every
   * project, every 30 seconds, and a read from there would keep the stream open
   * for ever on any host with a container to watch. Somebody looking at a page
   * says so with `ensureStarted`.
   */
  peek(name: string): ContainerStats | null {
    const entry = this.cache.get(name);
    if (!entry) return null;
    if (Date.now() - entry.updatedAt > STALE_AFTER_MS) {
      this.cache.delete(name);
      return null;
    }
    return entry;
  }

  all(): ContainerStats[] {
    void this.noteRead();
    const now = Date.now();
    const out: ContainerStats[] = [];
    for (const [name, entry] of this.cache) {
      if (now - entry.updatedAt > STALE_AFTER_MS) this.cache.delete(name);
      else out.push(entry);
    }
    return out;
  }

  shutdown(): void {
    this.stop?.();
    this.stop = null;
    this.clearIdleTimer();
    if (this.restartTimer) clearTimeout(this.restartTimer);
    this.restartTimer = null;
    this.cache.clear();
  }
}

/** "12.34%" -> 12.34 */
function parsePercent(value: string | undefined): number {
  if (!value) return 0;
  const n = Number.parseFloat(value.replace("%", "").trim());
  return Number.isFinite(n) ? n : 0;
}

/** "764KiB / 15.06GiB" -> bytes for the first figure. */
function parseMemUsage(value: string | undefined): number {
  if (!value) return 0;
  const match = value.match(/([\d.]+)\s*([KMGT]?i?B)/i);
  if (!match) return 0;

  const amount = Number.parseFloat(match[1]);
  if (!Number.isFinite(amount)) return 0;

  const unit = match[2].toUpperCase();
  const multipliers: Record<string, number> = {
    B: 1,
    KB: 1000, KIB: 1024,
    MB: 1000 ** 2, MIB: 1024 ** 2,
    GB: 1000 ** 3, GIB: 1024 ** 3,
    TB: 1000 ** 4, TIB: 1024 ** 4,
  };
  return amount * (multipliers[unit] ?? 1);
}
