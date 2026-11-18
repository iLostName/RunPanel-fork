import { getDb } from "@/lib/db";
import { TIER_MINUTE, TIER_QUARTER, TIER_RAW, toSeries, type SeriesPayload } from "@/lib/metrics-math";
import { UPTIME_INTERVAL_MS, dailyRatios, upSince } from "@/lib/uptime-math";
import { readSamples, type TieredSample } from "../metrics/store";

const DAY = 86_400_000;

/** Incidents the card lists. Older ones still count in the figures while they are in the window. */
const INCIDENTS_SHOWN = 20;

export interface UptimeIncident {
  id: string;
  startedAt: string;
  endedAt: string | null;
  cause: string | null;
  resolution: string | null;
  durationMs: number | null;
}

export interface UptimeSummary {
  /** Share of checks that got an answer, 0–1. */
  up24h: number | null;
  up30d: number | null;
  checks24h: number;
  /** Average milliseconds to the first byte over the last day. */
  latency24h: number | null;
  last: { at: number; ok: boolean; latencyMs: number | null } | null;
  since: { at: number; atLeast: boolean } | null;
  days: { day: number; ratio: number | null }[];
  /** Response time and share up, over the last day. */
  series: SeriesPayload;
  open: UptimeIncident | null;
  incidents: UptimeIncident[];
}

/** Weighted by the checks each row stands for; a row with no value is left out. */
function weighted(samples: readonly TieredSample[], field: "up" | "latency"): { value: number | null; n: number } {
  let sum = 0;
  let n = 0;
  for (const sample of samples) {
    const value = sample[field];
    if (value === null) continue;
    sum += value * sample.n;
    n += sample.n;
  }
  return { value: n > 0 ? sum / n : null, n };
}

/**
 * Everything the uptime card shows about one project, from the samples and
 * the incident rows. A month of quarter-hours and a day of minutes: a few
 * thousand rows, read when someone has the card open.
 */
export async function uptimeSummary(projectId: string, now: number, offsetMinutes: number): Promise<UptimeSummary> {
  // Read twice on purpose: the month from the coarsest tier that has it, the
  // day from the minutes — a quarter-hour cut out of the month would draw the
  // day's chart in steps three times too wide.
  const [month, day] = await Promise.all([
    readSamples("uptime", projectId, now - 30 * DAY, now, [TIER_QUARTER, TIER_MINUTE, TIER_RAW]),
    readSamples("uptime", projectId, now - DAY, now, [TIER_MINUTE, TIER_RAW]),
  ]);

  const up24 = weighted(day, "up");
  const newest = [...day].reverse().find((sample) => sample.tier === TIER_RAW) ?? null;

  const db = await getDb();
  const rows = await db
    .selectFrom("uptime_incidents")
    .selectAll()
    .where("project_id", "=", projectId)
    .orderBy("started_at", "desc")
    .limit(INCIDENTS_SHOWN)
    .execute();

  const incidents: UptimeIncident[] = rows.map((row) => {
    const start = Date.parse(row.started_at);
    const end = row.ended_at ? Date.parse(row.ended_at) : null;
    return {
      id: row.id,
      startedAt: row.started_at,
      endedAt: row.ended_at,
      cause: row.cause,
      resolution: row.resolution,
      durationMs: Number.isFinite(start) ? (end ?? now) - start : null,
    };
  });

  return {
    up24h: up24.value,
    up30d: weighted(month, "up").value,
    checks24h: up24.n,
    latency24h: weighted(day, "latency").value,
    last:
      newest && newest.up !== null && now - newest.ts <= 3 * UPTIME_INTERVAL_MS
        ? { at: newest.ts, ok: newest.up >= 1, latencyMs: newest.latency }
        : null,
    since: upSince(
      month
        .filter((sample) => sample.up !== null)
        .map((sample) => ({
          ts: sample.ts,
          size: sample.tier === TIER_RAW ? UPTIME_INTERVAL_MS : sample.tier,
          up: sample.up as number,
        })),
      now
    ),
    days: dailyRatios(
      month.filter((sample) => sample.up !== null).map((sample) => ({ ts: sample.ts, up: sample.up as number, n: sample.n })),
      30,
      now,
      offsetMinutes
    ),
    series: toSeries(day, "24h", now, ["latency", "up"]),
    open: incidents.find((incident) => incident.endedAt === null) ?? null,
    incidents,
  };
}
