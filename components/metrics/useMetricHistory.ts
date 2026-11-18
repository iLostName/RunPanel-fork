"use client";

import { useResource } from "@/lib/hooks/useResource";
import { useMemberApi, useNodeApi } from "@/lib/hooks/useNode";
import type { MetricField, MetricRange } from "@/lib/metrics-math";

/** What `/api/metrics/history` answers. */
export interface MetricHistory {
  scope: "host" | "project" | "service";
  id: string;
  range: MetricRange;
  from: number;
  to: number;
  step: number;
  t: number[];
  series: Partial<Record<MetricField, (number | null)[]>>;
  context: { cores: number; memTotal: number; diskTotal: number | null };
  alerts: Partial<Record<"cpu" | "memory", { since: number; peak: number | null }>>;
  sampling: { collecting: boolean; intervalMs: number; lastSampleAt: number | null };
}

/**
 * Re-asked about as often as there is something new to show: a point every
 * thirty seconds on the hour chart, one every five minutes on the day.
 */
const REFRESH_MS: Record<MetricRange, number> = { "1h": 30_000, "24h": 120_000, "7d": 600_000 };

/**
 * The history of one subject. `memberId` names the server explicitly — the
 * Monitor of a cluster draws every server's host on one page; without it the
 * call goes to the server the page is about, like every other page call.
 */
export function useMetricHistory(
  scope: "host" | "project" | "service",
  id: string | null,
  range: MetricRange,
  opts: { memberId?: string | null; enabled?: boolean } = {}
) {
  const api = useNodeApi();
  const memberApi = useMemberApi();
  const path = `/api/metrics/history?scope=${scope}${id ? `&id=${encodeURIComponent(id)}` : ""}&range=${range}`;
  const url = opts.enabled === false ? null : opts.memberId !== undefined ? memberApi(opts.memberId, path) : api(path);
  const result = useResource<MetricHistory>(url, { intervalMs: REFRESH_MS[range] });
  // The previous range stays on screen, dimmed, until the new one lands.
  const stale = result.data !== null && result.data.range !== range;
  return { ...result, stale };
}
