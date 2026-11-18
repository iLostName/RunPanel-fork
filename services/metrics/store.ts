import type { Selectable } from "kysely";
import { getDb } from "@/lib/db";
import type { MetricSamplesTable } from "@/lib/db/schema";
import {
  METRIC_FIELDS,
  RANGE_SPECS,
  ROLLUPS,
  SAMPLE_INTERVAL_MS,
  TIER_MINUTE,
  TIER_QUARTER,
  TIER_RAW,
  emptyValues,
  purgeCutoff,
  rollup,
  rollupWindow,
  tiersFor,
  toSeries,
  type MetricField,
  type MetricRange,
  type Sample,
  type SeriesPayload,
  type Tier,
} from "@/lib/metrics-math";

/**
 * Where the samples live, and the three chores that keep the table small:
 * condensing closed buckets into the next tier, purging what has aged out of
 * each tier, and forgetting subjects that no longer exist.
 *
 * Every function here is called from a background tick and from a request, so
 * none of them may assume the other side is not running at the same moment.
 * The roll-up is safe under that because a bucket can only be inserted once
 * (`ON CONFLICT DO NOTHING` on the natural key); the purge because it never
 * deletes past what the next tier already holds.
 */

export type MetricScope = "host" | "project" | "service" | "uptime";

/** A sample and the tier it was read from, which says how wide its bucket is. */
export type TieredSample = Sample & { tier: Tier };

/** SQLite caps the bound parameters of one statement; fourteen columns a row stays well under it. */
const INSERT_CHUNK = 200;

/**
 * How much of the source tier one roll-up pass reads at most. A store that sat
 * idle for days catches up over a few ticks instead of in one query that loads
 * everything it missed.
 */
const CATCH_UP_MS: Record<Tier, number> = {
  [TIER_RAW]: 0,
  [TIER_MINUTE]: 6 * 3_600_000,
  [TIER_QUARTER]: 24 * 3_600_000,
};

function num(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

/** A row as it comes back: `pg` returns `bigint` as a string, and nothing here trusts either driver's types. */
function fromRow(row: Selectable<MetricSamplesTable>): Sample {
  const values = emptyValues();
  for (const field of METRIC_FIELDS) values[field] = num(row[field]);
  return { scope: row.scope, subject_id: row.subject_id, ts: Number(row.ts), n: num(row.n) ?? 1, ...values };
}

export async function writeSamples(rows: readonly Sample[], tier: Tier = TIER_RAW): Promise<void> {
  if (rows.length === 0) return;
  const db = await getDb();
  for (let i = 0; i < rows.length; i += INSERT_CHUNK) {
    const chunk = rows.slice(i, i + INSERT_CHUNK).map((row) => ({ ...row, tier }));
    await db
      .insertInto("metric_samples")
      .values(chunk)
      .onConflict((oc) => oc.doNothing())
      .execute();
  }
}

async function edgeTs(tier: Tier, edge: "max" | "min", atLeast?: number): Promise<number | null> {
  const db = await getDb();
  let query = db
    .selectFrom("metric_samples")
    .select((eb) => (edge === "max" ? eb.fn.max("ts") : eb.fn.min("ts")).as("ts"))
    .where("tier", "=", tier);
  if (atLeast !== undefined) query = query.where("ts", ">=", atLeast);
  const row = await query.executeTakeFirst();
  return num(row?.ts);
}

/**
 * Condense every closed bucket that the next tier does not have yet.
 *
 * Starts from the oldest source row past the newest finished bucket rather
 * than from the bucket after it: after a stretch with no samples at all (the
 * panel was off) the window would otherwise sit on empty buckets for ever,
 * since a bucket with nothing in it is never written and so never moves the
 * mark.
 */
export async function compact(now: number): Promise<number> {
  const db = await getDb();
  let written = 0;

  for (const { from, to } of ROLLUPS) {
    const newest = await edgeTs(to, "max");
    const first = await edgeTs(from, "min", newest === null ? undefined : newest + to);
    const window = rollupWindow(null, first, to, now);
    if (!window) continue;

    const end = Math.min(window.to, window.from + CATCH_UP_MS[to]);
    const rows = await db
      .selectFrom("metric_samples")
      .selectAll()
      .where("tier", "=", from)
      .where("ts", ">=", window.from)
      .where("ts", "<", end)
      .execute();

    const rolled = rollup(rows.map(fromRow), to);
    await writeSamples(rolled, to);
    written += rolled.length;
  }
  return written;
}

/** Delete what each tier no longer needs. Returns the number of rows removed. */
export async function purge(now: number): Promise<number> {
  const db = await getDb();
  const next: Record<Tier, Tier | null> = {
    [TIER_RAW]: TIER_MINUTE,
    [TIER_MINUTE]: TIER_QUARTER,
    [TIER_QUARTER]: null,
  };

  let removed = 0;
  for (const tier of [TIER_RAW, TIER_MINUTE, TIER_QUARTER] as Tier[]) {
    const above = next[tier];
    // An empty next tier covers nothing: only the hard ceiling applies.
    const covered = above === null ? null : (((await edgeTs(above, "max")) ?? -Infinity) + above);
    const cutoff = purgeCutoff(tier, covered, now);
    const result = await db
      .deleteFrom("metric_samples")
      .where("tier", "=", tier)
      .where("ts", "<", cutoff)
      .executeTakeFirst();
    removed += Number(result.numDeletedRows ?? 0);
  }
  return removed;
}

/**
 * Rows of projects and services that were deleted. A deleted project's history
 * is not worth keeping a month, and nothing else would ever come back for it.
 */
export async function forgetMissingSubjects(): Promise<number> {
  const db = await getDb();
  const projects = await db
    .deleteFrom("metric_samples")
    .where("scope", "in", ["project", "uptime"])
    .where("subject_id", "not in", db.selectFrom("projects").select("id"))
    .executeTakeFirst();
  const services = await db
    .deleteFrom("metric_samples")
    .where("scope", "=", "service")
    .where("subject_id", "not in", db.selectFrom("services").select("id"))
    .executeTakeFirst();
  return Number(projects.numDeletedRows ?? 0) + Number(services.numDeletedRows ?? 0);
}

/**
 * Every row of one subject since `from`, read from the coarsest tier that has
 * it and filled forward by the finer ones — the newest stretch is only in the
 * raw tier until its bucket closes.
 */
export async function readSamples(
  scope: MetricScope,
  subjectId: string,
  from: number,
  now: number,
  tiers: readonly Tier[]
): Promise<TieredSample[]> {
  const db = await getDb();
  const out: TieredSample[] = [];
  let coveredUntil = from;

  for (const tier of tiers) {
    const rows = await db
      .selectFrom("metric_samples")
      .selectAll()
      .where("scope", "=", scope)
      .where("subject_id", "=", subjectId)
      .where("tier", "=", tier)
      .where("ts", ">=", coveredUntil)
      .where("ts", "<=", now)
      .orderBy("ts", "asc")
      .execute();
    if (rows.length === 0) continue;
    const samples = rows.map((row) => ({ ...fromRow(row), tier }));
    out.push(...samples);
    coveredUntil = samples[samples.length - 1].ts + (tier === TIER_RAW ? 1 : tier);
  }
  return out;
}

/** What one chart range shows of a subject, in columns. */
export async function readHistory(
  scope: MetricScope,
  subjectId: string,
  range: MetricRange,
  now: number,
  fields: readonly MetricField[]
): Promise<SeriesPayload> {
  const rows = await readSamples(scope, subjectId, now - RANGE_SPECS[range].span, now, tiersFor(range));
  return toSeries(rows, range, now, fields);
}

/** The newest raw sample of a subject, if one is recent enough to still describe it. */
export async function latestSample(scope: MetricScope, subjectId: string, now: number, maxAgeMs = 3 * SAMPLE_INTERVAL_MS): Promise<Sample | null> {
  const db = await getDb();
  const row = await db
    .selectFrom("metric_samples")
    .selectAll()
    .where("scope", "=", scope)
    .where("subject_id", "=", subjectId)
    .where("tier", "=", TIER_RAW)
    .where("ts", ">=", now - maxAgeMs)
    .orderBy("ts", "desc")
    .limit(1)
    .executeTakeFirst();
  return row ? fromRow(row) : null;
}
