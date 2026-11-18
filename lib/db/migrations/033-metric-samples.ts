import { Kysely } from "kysely";

/**
 * The history behind the Monitor's charts: one row per subject per sample, and
 * the same rows condensed — see `lib/metrics-math.ts` for the tiers.
 *
 *   scope       'host' | 'project' | 'service' (and 'uptime', from 034)
 *   subject_id  the project or service id; 'host' for the machine
 *   tier        bucket width in ms: 0 raw (every 30 s, kept ~1 h),
 *               60000 (kept a day), 900000 (kept a month)
 *   ts          the bucket start, or the sample time for raw rows
 *   n           how many raw samples the row stands for
 *
 * Two departures from the conventions in `lib/db/schema.ts`, both deliberate.
 * The time is epoch milliseconds, not ISO text: this table is bucketed by
 * arithmetic and holds tens of thousands of rows, and an ISO string would
 * triple its size and turn every roll-up into string parsing. It is still
 * written by application code (`Date.now()`), never by a database default, so
 * the two dialects cannot disagree on it. And the key is the natural one,
 * not a nanoid: a roll-up is idempotent because the bucket can only be
 * inserted once.
 *
 * `bigint` because Postgres' `integer` is 32 bits and an epoch in milliseconds
 * is 41. `pg` hands an int8 back as a string, which is why the schema types
 * `ts` that way and every reader goes through `Number()`. The measurements are
 * `double precision`, which both drivers return as a number.
 *
 * No foreign key: `subject_id` names a project, a service or the host. Rows of
 * a subject that no longer exists are deleted by the collector's hourly sweep.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .createTable("metric_samples")
    .ifNotExists()
    .addColumn("scope", "text", (col) => col.notNull())
    .addColumn("subject_id", "text", (col) => col.notNull())
    .addColumn("tier", "integer", (col) => col.notNull())
    .addColumn("ts", "bigint", (col) => col.notNull())
    .addColumn("n", "integer", (col) => col.notNull())
    // Percent of the whole host, 0–100.
    .addColumn("cpu", "double precision")
    // Bytes, and percent of whatever limit applies to the subject.
    .addColumn("mem", "double precision")
    .addColumn("mem_pct", "double precision")
    // The host only: bytes used and percent of the volume.
    .addColumn("disk", "double precision")
    .addColumn("disk_pct", "double precision")
    // Bytes per second, averaged over the interval.
    .addColumn("net_rx", "double precision")
    .addColumn("net_tx", "double precision")
    // The key leads with what every chart filters on and ends with time, so a
    // range read is one walk of the index in order.
    .addPrimaryKeyConstraint("metric_samples_pkey", ["scope", "subject_id", "tier", "ts"])
    .execute();

  // For the purge and for "the newest bucket of this tier", which the roll-up
  // asks on every tick: neither filters on a subject.
  await db.schema
    .createIndex("idx_metric_samples_tier_ts")
    .ifNotExists()
    .on("metric_samples")
    .columns(["tier", "ts"])
    .execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.dropTable("metric_samples").ifExists().execute();
}
