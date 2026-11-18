/**
 * The arithmetic of the metrics history: what a sample is, how samples are
 * condensed, what a chart is handed, and when a reading becomes an alarm.
 *
 * Zero imports: the unit suite loads this file directly with Node's strip-only
 * loader, and the collector, the API and the browser all use it. Everything
 * here is a pure function of its arguments — the clock included, which every
 * caller passes in.
 */

// --- What is kept, and for how long ---------------------------------------------

/**
 * How often the collector looks. Thirty seconds is the cheap end of what a
 * chart of the last hour needs: one `docker stats`, one `pm2 jlist` (shared
 * with the status sweep) and a few syscalls per tick, whatever the number of
 * projects.
 */
export const SAMPLE_INTERVAL_MS = 30_000;

/**
 * The resolutions on disk, each named by the width of its bucket in
 * milliseconds; raw samples are tier 0. A tier is computed from the one below
 * it once a bucket has closed, which is why each one outlives the window it is
 * read for by a margin: the 24-hour chart must still find its first hour.
 */
export const TIER_RAW = 0;
export const TIER_MINUTE = 60_000;
export const TIER_QUARTER = 15 * 60_000;
export type Tier = typeof TIER_RAW | typeof TIER_MINUTE | typeof TIER_QUARTER;

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

export const KEEP_MS: Record<Tier, number> = {
  [TIER_RAW]: 70 * 60_000,
  [TIER_MINUTE]: 25 * HOUR,
  [TIER_QUARTER]: 31 * DAY,
};

/**
 * The ceiling past which a tier is purged even when the one above has not
 * caught up with it. Without it a roll-up that kept failing would also stop the
 * purge, and the table would grow for as long as the failure lasted.
 */
export const HARD_KEEP_MS: Record<Tier, number> = {
  [TIER_RAW]: 6 * HOUR,
  [TIER_MINUTE]: 3 * DAY,
  [TIER_QUARTER]: 31 * DAY,
};

/** Each tier and the one it is rolled up from. */
export const ROLLUPS: readonly { from: Tier; to: Tier }[] = [
  { from: TIER_RAW, to: TIER_MINUTE },
  { from: TIER_MINUTE, to: TIER_QUARTER },
];

/**
 * How long after a bucket closes it is rolled up. A sample is stamped with the
 * moment its tick started and written when the tick ends — an uptime probe can
 * take its whole timeout — so a bucket is left open a little past its end.
 */
export const ROLLUP_GRACE_MS = 20_000;

// --- Samples -------------------------------------------------------------------------

/** The measured columns, in the store's own spelling. */
export const METRIC_FIELDS = [
  "cpu",
  "mem",
  "mem_pct",
  "disk",
  "disk_pct",
  "net_rx",
  "net_tx",
  "up",
  "latency",
] as const;
export type MetricField = (typeof METRIC_FIELDS)[number];

export type MetricValues = Record<MetricField, number | null>;

/**
 * One row of `metric_samples`: a reading (`n` = 1) or the weighted average of
 * `n` readings.
 *
 * `cpu` is a share of the whole host, 0–100 — not Docker's "percent of one
 * core", which reads 350% on a busy four-core machine and cannot be put on the
 * same axis as the host. `mem_pct` is against whatever limit applies to the
 * subject: its own memory limit when it has one, the host's RAM otherwise.
 */
export interface Sample extends MetricValues {
  scope: string;
  subject_id: string;
  ts: number;
  n: number;
}

export function emptyValues(): MetricValues {
  return {
    cpu: null,
    mem: null,
    mem_pct: null,
    disk: null,
    disk_pct: null,
    net_rx: null,
    net_tx: null,
    up: null,
    latency: null,
  };
}

/** The start of the bucket `ts` falls in. Buckets are aligned on the epoch. */
export function bucketStart(ts: number, size: number): number {
  if (size <= 0) return ts;
  return Math.floor(ts / size) * size;
}

/** Two decimals: more is noise, fewer would flatten a CPU line between 0 and 1%. */
function round(value: number): number {
  return Math.round(value * 100) / 100;
}

/**
 * Condense samples into buckets of `size`, per subject.
 *
 * Weighted by `n`, so a quarter-hour built from fifteen minutes that held two
 * samples each and one that held one is the average of the samples, not of
 * the minutes. A missing value is left out of its field's average rather than
 * counted as zero: a project with no network reading does not have zero
 * traffic, and an average that read it so would halve every gap's neighbour.
 */
export function rollup(rows: readonly Sample[], size: number): Sample[] {
  interface Group {
    scope: string;
    subject_id: string;
    ts: number;
    n: number;
    sums: number[];
    weights: number[];
  }
  const groups = new Map<string, Group>();

  for (const row of rows) {
    const ts = bucketStart(row.ts, size);
    const key = `${row.scope}\u0000${row.subject_id}\u0000${ts}`;
    let group = groups.get(key);
    if (!group) {
      group = {
        scope: row.scope,
        subject_id: row.subject_id,
        ts,
        n: 0,
        sums: METRIC_FIELDS.map(() => 0),
        weights: METRIC_FIELDS.map(() => 0),
      };
      groups.set(key, group);
    }

    const weight = row.n > 0 ? row.n : 1;
    group.n += weight;
    METRIC_FIELDS.forEach((field, index) => {
      const value = row[field];
      if (value === null || !Number.isFinite(value)) return;
      group.sums[index] += value * weight;
      group.weights[index] += weight;
    });
  }

  const out: Sample[] = [];
  for (const group of groups.values()) {
    const values = emptyValues();
    METRIC_FIELDS.forEach((field, index) => {
      values[field] = group.weights[index] > 0 ? round(group.sums[index] / group.weights[index]) : null;
    });
    out.push({ scope: group.scope, subject_id: group.subject_id, ts: group.ts, n: group.n, ...values });
  }
  return out.sort((a, b) => a.ts - b.ts);
}

/**
 * The span of buckets of `size` that can be rolled up now: from the first one
 * the target tier does not have yet, to the last one that has closed (plus the
 * grace above). Null when there is nothing to do.
 *
 * `lastTarget` is the newest bucket already in the target tier; `firstSource`
 * the oldest row of the source tier, for a target that is still empty.
 */
export function rollupWindow(
  lastTarget: number | null,
  firstSource: number | null,
  size: number,
  now: number
): { from: number; to: number } | null {
  const from = lastTarget !== null ? lastTarget + size : firstSource !== null ? bucketStart(firstSource, size) : null;
  if (from === null) return null;
  const to = bucketStart(now - ROLLUP_GRACE_MS, size);
  return to > from ? { from, to } : null;
}

/**
 * Below which instant a tier may be deleted.
 *
 * Its retention, but never past what the next tier has already absorbed —
 * deleting raw samples that were never rolled up would punch a hole in every
 * chart — and never later than the hard ceiling, for the reason given on
 * `HARD_KEEP_MS`. `coveredUntil` is the end of the newest bucket of the next
 * tier, or null when there is no next tier.
 */
export function purgeCutoff(tier: Tier, coveredUntil: number | null, now: number): number {
  const byAge = now - KEEP_MS[tier];
  const hard = now - HARD_KEEP_MS[tier];
  if (coveredUntil === null) return byAge;
  return Math.max(hard, Math.min(byAge, coveredUntil));
}

// --- What a chart is handed --------------------------------------------------------

export const METRIC_RANGES = ["1h", "24h", "7d"] as const;
export type MetricRange = (typeof METRIC_RANGES)[number];

export interface RangeSpec {
  span: number;
  /** The coarsest tier that still has the whole span. */
  tier: Tier;
  /** The spacing of the points handed to the chart; 0 means "as sampled". */
  step: number;
}

/**
 * A few hundred points per chart at most: one per pixel column of a wide card
 * is already more than an eye can use, and the payload stays small.
 */
export const RANGE_SPECS: Record<MetricRange, RangeSpec> = {
  "1h": { span: HOUR, tier: TIER_RAW, step: 0 },
  "24h": { span: DAY, tier: TIER_MINUTE, step: 5 * 60_000 },
  "7d": { span: 7 * DAY, tier: TIER_QUARTER, step: 30 * 60_000 },
};

export function isMetricRange(value: unknown): value is MetricRange {
  return METRIC_RANGES.includes(value as MetricRange);
}

/** The tiers a range reads, coarsest first: the finer ones fill the stretch it has not rolled up yet. */
export function tiersFor(range: MetricRange): Tier[] {
  const tier = RANGE_SPECS[range].tier;
  return [TIER_QUARTER, TIER_MINUTE, TIER_RAW].filter((t) => t <= tier) as Tier[];
}

export interface SeriesPayload {
  from: number;
  to: number;
  /** Nominal spacing of the points, for telling a gap from a slow tick. */
  step: number;
  t: number[];
  series: Partial<Record<MetricField, (number | null)[]>>;
}

/**
 * The points of one subject over a range, in columns.
 *
 * Raw samples go out as sampled; coarser ones are condensed to the range's
 * step. A field with no value anywhere is left out, so the client draws only
 * the charts it has something for — a project has no disk, a worker no
 * network.
 */
export function toSeries(rows: readonly Sample[], range: MetricRange, now: number, fields: readonly MetricField[]): SeriesPayload {
  const spec = RANGE_SPECS[range];
  const from = now - spec.span;
  const inRange = rows.filter((row) => row.ts >= from && row.ts <= now);
  const points = spec.step > 0 ? rollup(inRange, spec.step) : [...inRange].sort((a, b) => a.ts - b.ts);

  const series: Partial<Record<MetricField, (number | null)[]>> = {};
  for (const field of fields) {
    const values = points.map((p) => p[field]);
    if (values.some((v) => v !== null)) series[field] = values;
  }
  return {
    from,
    to: now,
    step: spec.step > 0 ? spec.step : SAMPLE_INTERVAL_MS,
    t: points.map((p) => p.ts),
    series,
  };
}

// --- Rates -------------------------------------------------------------------------------

export interface Counter {
  value: number;
  at: number;
}

/**
 * Bytes per second between two readings of a counter that only grows.
 *
 * Null when there is nothing honest to say: no earlier reading, a clock that
 * did not move, a counter that went backwards (the container restarted, the
 * interface was re-created) or readings so far apart that the average would
 * hide everything that happened in between.
 */
export function ratePerSecond(previous: Counter | undefined, current: Counter, maxGapMs = 5 * SAMPLE_INTERVAL_MS): number | null {
  if (!previous) return null;
  const elapsed = current.at - previous.at;
  if (elapsed <= 0 || elapsed > maxGapMs) return null;
  const delta = current.value - previous.value;
  if (delta < 0) return null;
  return round((delta * 1000) / elapsed);
}

/** Docker's and PM2's CPU is a percent of one core; the charts use a share of the host. */
export function shareOfHost(perCorePercent: number | null | undefined, cores: number): number | null {
  if (perCorePercent === null || perCorePercent === undefined || !Number.isFinite(perCorePercent)) return null;
  const share = perCorePercent / Math.max(1, cores);
  return round(Math.max(0, Math.min(100, share)));
}

export function percentOf(part: number | null | undefined, whole: number | null | undefined): number | null {
  if (part === null || part === undefined || !whole || whole <= 0) return null;
  return round(Math.max(0, (part / whole) * 100));
}

// --- Reading what the host prints ----------------------------------------------

const UNITS: Record<string, number> = {
  B: 1,
  KB: 1000,
  KIB: 1024,
  MB: 1000 ** 2,
  MIB: 1024 ** 2,
  GB: 1000 ** 3,
  GIB: 1024 ** 3,
  TB: 1000 ** 4,
  TIB: 1024 ** 4,
};

/** "1.5GiB", "764kB", "0B" → bytes. Docker mixes binary (memory) and decimal (network) units. */
export function parseByteSize(text: string | undefined): number | null {
  if (!text) return null;
  const match = text.trim().match(/^([\d.]+)\s*([KMGT]?i?B)$/i);
  if (!match) return null;
  const amount = Number.parseFloat(match[1]);
  const unit = UNITS[match[2].toUpperCase()];
  if (!Number.isFinite(amount) || unit === undefined) return null;
  return amount * unit;
}

function parsePercentText(text: string | undefined): number | null {
  if (!text) return null;
  const value = Number.parseFloat(text.replace("%", "").trim());
  return Number.isFinite(value) ? value : null;
}

/** "a / b", the shape of `MemUsage` and `NetIO`. */
function parsePair(text: string | undefined): [number | null, number | null] {
  if (!text) return [null, null];
  const [first, second] = text.split("/");
  return [parseByteSize(first), parseByteSize(second)];
}

export interface ContainerReading {
  name: string;
  /** Percent of one core, as Docker prints it. */
  cpu: number | null;
  mem: number | null;
  /** The container's memory limit; the host's RAM when it has none. */
  memLimit: number | null;
  /** Against that limit. */
  memPct: number | null;
  /** Cumulative since the container started. */
  netRx: number | null;
  netTx: number | null;
}

/**
 * The output of one `docker stats --no-stream --format "{{json .}}"`, by name.
 *
 * The placeholder rows Docker prints for a container in mid-transition (named
 * `--`) and anything that is not a JSON object are skipped, as the streaming
 * collector does.
 */
export function parseDockerStats(stdout: string): Map<string, ContainerReading> {
  const out = new Map<string, ContainerReading>();
  for (const raw of stdout.split("\n")) {
    // From the first brace: a cycle can open with a cursor code nobody stripped.
    const brace = raw.indexOf("{");
    if (brace === -1) continue;
    const line = raw.slice(brace).trim();

    let parsed: { Name?: string; CPUPerc?: string; MemUsage?: string; MemPerc?: string; NetIO?: string };
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }
    const name = parsed.Name?.trim();
    if (!name || name === "--") continue;

    const [mem, memLimit] = parsePair(parsed.MemUsage);
    const [netRx, netTx] = parsePair(parsed.NetIO);
    out.set(name, {
      name,
      cpu: parsePercentText(parsed.CPUPerc),
      mem,
      memLimit,
      memPct: parsePercentText(parsed.MemPerc),
      netRx,
      netTx,
    });
  }
  return out;
}

/**
 * The interfaces the default route leaves through, from `/proc/net/route`.
 *
 * Summing every interface would count the same byte three times on a Docker
 * host — on the container's veth, on the bridge and on the way out — so the
 * host's traffic is what crosses the interfaces the machine talks to the world
 * through.
 */
export function defaultRouteInterfaces(routeTable: string): string[] {
  const names = new Set<string>();
  for (const line of routeTable.split("\n").slice(1)) {
    const [iface, destination] = line.trim().split(/\s+/);
    if (iface && destination === "00000000") names.add(iface);
  }
  return [...names];
}

/** Interfaces that only ever carry traffic already counted elsewhere. */
const VIRTUAL_INTERFACE = /^(lo|docker\d*|br-|veth|virbr|cni|flannel|cali|vxlan|kube)/;

/**
 * Received and sent bytes since boot, from `/proc/net/dev`, over `only` when
 * given and over every physical-looking interface otherwise.
 */
export function parseNetDev(text: string, only?: readonly string[]): { rx: number; tx: number } | null {
  const wanted = only && only.length > 0 ? new Set(only) : null;
  let rx = 0;
  let tx = 0;
  let seen = false;

  for (const line of text.split("\n")) {
    const colon = line.indexOf(":");
    if (colon === -1) continue;
    const name = line.slice(0, colon).trim();
    if (!name) continue;
    if (wanted ? !wanted.has(name) : VIRTUAL_INTERFACE.test(name)) continue;

    const fields = line.slice(colon + 1).trim().split(/\s+/).map(Number);
    // Receive bytes is the first column, transmit bytes the ninth.
    if (fields.length < 9 || !Number.isFinite(fields[0]) || !Number.isFinite(fields[8])) continue;
    rx += fields[0];
    tx += fields[8];
    seen = true;
  }
  return seen ? { rx, tx } : null;
}

// --- Alarms ------------------------------------------------------------------------------

export interface AlertRule {
  /** At or above this, for `holdMs`, it fires. */
  trigger: number;
  /** Below this, for `holdMs`, it clears. */
  clear: number;
  holdMs: number;
  /** A longer silence between readings breaks the streak: nobody knows what happened in it. */
  maxGapMs: number;
}

/**
 * CPU or memory at 90% for five minutes, back under 80% for five more.
 *
 * Two thresholds and a hold, because either alone flaps. A single line at 90%
 * alternates warning and all-clear for as long as a machine hovers on it, and
 * that is exactly what a machine under steady load does; the hold alone still
 * flaps at the boundary, only slower. Five minutes is long enough that a build
 * or a backup peaking for a minute says nothing, and short enough that a
 * runaway process is reported while it can still be stopped.
 */
export const RESOURCE_ALERT_RULE: AlertRule = {
  trigger: 90,
  clear: 80,
  holdMs: 5 * 60_000,
  maxGapMs: 3 * SAMPLE_INTERVAL_MS,
};

export interface AlertState {
  firing: boolean;
  /** When the current alarm started: the first reading of the streak that fired it. */
  since: number | null;
  /** The first reading of a streak towards the other state, if one is under way. */
  streakStart: number | null;
  lastAt: number | null;
  /** The highest reading since it fired. */
  peak: number | null;
}

export function initialAlertState(): AlertState {
  return { firing: false, since: null, streakStart: null, lastAt: null, peak: null };
}

export type AlertEvent =
  | { kind: "fire"; since: number; value: number }
  | { kind: "clear"; since: number; value: number; peak: number };

/**
 * One reading through the rule. Returns the next state, and an event on the
 * reading that changes it.
 *
 * A missing reading (null) breaks the streak in either direction without
 * changing the state: a project that stopped is not "back to normal", and one
 * that came back is not "still high" until it says so.
 */
export function stepAlert(
  state: AlertState,
  value: number | null,
  at: number,
  rule: AlertRule = RESOURCE_ALERT_RULE
): { state: AlertState; event: AlertEvent | null } {
  if (value === null || !Number.isFinite(value)) {
    return { state: { ...state, streakStart: null }, event: null };
  }

  const next: AlertState = { ...state };
  if (next.lastAt !== null && at - next.lastAt > rule.maxGapMs) next.streakStart = null;
  next.lastAt = at;

  if (!next.firing) {
    if (value < rule.trigger) {
      next.streakStart = null;
      return { state: next, event: null };
    }
    next.streakStart ??= at;
    if (at - next.streakStart < rule.holdMs) return { state: next, event: null };
    const since = next.streakStart;
    return {
      state: { firing: true, since, streakStart: null, lastAt: at, peak: value },
      event: { kind: "fire", since, value },
    };
  }

  next.peak = Math.max(next.peak ?? value, value);
  if (value >= rule.clear) {
    next.streakStart = null;
    return { state: next, event: null };
  }
  next.streakStart ??= at;
  if (at - next.streakStart < rule.holdMs) return { state: next, event: null };
  return {
    state: { ...initialAlertState(), lastAt: at },
    event: { kind: "clear", since: next.since ?? next.streakStart, value, peak: next.peak ?? value },
  };
}

/**
 * After an all-clear has gone out, how long a new alarm on the same thing stays
 * unannounced. The hold above keeps a machine on the line from flapping; this
 * keeps one whose load comes and goes in waves — five minutes high, five
 * normal — to one pair of messages per half hour instead of one every ten.
 */
export const QUIET_AFTER_CLEAR_MS = 30 * 60_000;

export interface AlertDamper {
  /** The alarm under way was not announced, so its all-clear will not be either. */
  silent: boolean;
  quietUntil: number;
}

/**
 * Whether an alarm event is worth a message. Announced in pairs or not at all:
 * an all-clear for an alarm nobody was told about is noise, and an alarm whose
 * all-clear was swallowed is a warning standing for ever.
 */
export function dampAlert(damper: AlertDamper, event: AlertEvent, at: number): { announce: boolean; damper: AlertDamper } {
  if (event.kind === "fire") {
    const silent = at < damper.quietUntil;
    return { announce: !silent, damper: { silent, quietUntil: damper.quietUntil } };
  }
  if (damper.silent) return { announce: false, damper: { silent: false, quietUntil: damper.quietUntil } };
  return { announce: true, damper: { silent: false, quietUntil: at + QUIET_AFTER_CLEAR_MS } };
}

// --- Scales ---------------------------------------------------------------------------

export interface Scale {
  max: number;
  ticks: number[];
}

/** 1, 2, 2.5 or 5 times a power of ten: the steps an axis can be read in. */
function niceStep(rough: number): number {
  if (!Number.isFinite(rough) || rough <= 0) return 1;
  const power = 10 ** Math.floor(Math.log10(rough));
  const fraction = rough / power;
  const nice = fraction <= 1 ? 1 : fraction <= 2 ? 2 : fraction <= 2.5 ? 2.5 : fraction <= 5 ? 5 : 10;
  return nice * power;
}

/**
 * The top of a value axis and the ticks under it.
 *
 * `ceiling` fixes the top for a value with a natural maximum — a percentage —
 * for the reason `sparkPath` gives: CPU at 6% drawn to the top of its own box
 * reads as a machine at full load. Without it the top is the next round number
 * above the data, and never zero, so a flat line at zero still has an axis.
 */
export function niceScale(values: ReadonlyArray<number | null | undefined>, opts: { ceiling?: number; ticks?: number } = {}): Scale {
  const count = opts.ticks ?? 4;
  if (opts.ceiling !== undefined) {
    const step = opts.ceiling / count;
    return { max: opts.ceiling, ticks: Array.from({ length: count + 1 }, (_, i) => round(i * step)) };
  }
  let peak = 0;
  for (const value of values) {
    if (typeof value === "number" && Number.isFinite(value) && value > peak) peak = value;
  }
  if (peak <= 0) return { max: 1, ticks: [0, 1] };
  const step = niceStep(peak / count);
  const max = Math.ceil(peak / step) * step;
  const ticks: number[] = [];
  for (let tick = 0; tick <= max + step / 2; tick += step) ticks.push(round(tick));
  return { max, ticks };
}

/**
 * The same for bytes, in the binary unit the values are read in, so the ticks
 * land on "200 MB" rather than on "190,7 MB".
 */
export function niceBytesScale(values: ReadonlyArray<number | null | undefined>, ticks = 4): Scale {
  let peak = 0;
  for (const value of values) {
    if (typeof value === "number" && Number.isFinite(value) && value > peak) peak = value;
  }
  let unit = 1;
  while (peak / unit >= 1024 && unit < 1024 ** 4) unit *= 1024;
  const scaled = niceScale(
    values.map((v) => (typeof v === "number" ? v / unit : v)),
    { ticks }
  );
  return { max: scaled.max * unit, ticks: scaled.ticks.map((t) => t * unit) };
}

const TIME_STEPS = [
  5 * 60_000,
  10 * 60_000,
  15 * 60_000,
  30 * 60_000,
  HOUR,
  2 * HOUR,
  3 * HOUR,
  6 * HOUR,
  12 * HOUR,
  DAY,
  2 * DAY,
];

/**
 * Where the labels of a time axis go: on round local times (a whole hour, a
 * midnight), about `target` of them.
 *
 * `offsetMinutes` is what `Date.prototype.getTimezoneOffset` returns, passed in
 * so this stays pure: without it the ticks would land on round hours of UTC,
 * which in Rome is "01:00, 07:00, 13:00".
 */
export function timeTicks(from: number, to: number, target = 4, offsetMinutes = 0): { step: number; ticks: number[] } {
  const span = to - from;
  if (span <= 0) return { step: HOUR, ticks: [] };
  const step = TIME_STEPS.find((s) => span / s <= target) ?? TIME_STEPS[TIME_STEPS.length - 1];
  const shift = -offsetMinutes * 60_000;
  const ticks: number[] = [];
  let tick = Math.ceil((from + shift) / step) * step - shift;
  while (tick <= to) {
    ticks.push(tick);
    tick += step;
  }
  return { step, ticks };
}

export interface SeriesSummary {
  min: number;
  max: number;
  avg: number;
  last: number;
  count: number;
}

/** Min, max, average and last of the values that exist; null when there are none. */
export function summarize(values: ReadonlyArray<number | null | undefined>): SeriesSummary | null {
  let min = Infinity;
  let max = -Infinity;
  let sum = 0;
  let count = 0;
  let last: number | null = null;
  for (const value of values) {
    if (typeof value !== "number" || !Number.isFinite(value)) continue;
    min = Math.min(min, value);
    max = Math.max(max, value);
    sum += value;
    count++;
    last = value;
  }
  if (count === 0 || last === null) return null;
  return { min, max, avg: round(sum / count), last, count };
}

/**
 * The x and y of each point of a series in a `width` × `height` box, split
 * into runs wherever a value is missing or two points are further apart than
 * `maxGap`. A gap is drawn as a gap: a line across a night the panel was off
 * would claim to know what happened in it.
 */
export function chartRuns(
  t: readonly number[],
  values: ReadonlyArray<number | null>,
  box: { from: number; to: number; max: number; width: number; height: number },
  maxGap: number
): { x: number; y: number; i: number }[][] {
  const span = box.to - box.from || 1;
  const runs: { x: number; y: number; i: number }[][] = [];
  let run: { x: number; y: number; i: number }[] = [];
  let previous: number | null = null;

  t.forEach((ts, i) => {
    const value = values[i];
    const broken = value === null || value === undefined || !Number.isFinite(value) || (previous !== null && ts - previous > maxGap);
    if (broken && run.length > 0) {
      runs.push(run);
      run = [];
    }
    if (value === null || value === undefined || !Number.isFinite(value)) {
      previous = null;
      return;
    }
    const clamped = Math.max(0, Math.min(box.max, value));
    run.push({
      i,
      x: Math.round(((ts - box.from) / span) * box.width * 10) / 10,
      y: Math.round((box.height - (clamped / (box.max || 1)) * box.height) * 10) / 10,
    });
    previous = ts;
  });
  if (run.length > 0) runs.push(run);
  return runs;
}
