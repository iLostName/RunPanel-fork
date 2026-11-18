"use client";

import { useMemo } from "react";
import { downsample } from "@/lib/metrics-math";
import { useMetricHistory } from "./useMetricHistory";

/** Points per sparkline: one every two minutes of the last hour. */
const POINTS = 30;

/**
 * The last hour of the host, shaped for the Panoramica's tiles: CPU, memory and
 * disk as percentages, oldest first. Null until it arrives, or when `enabled`
 * is false — an account without the Monitor permission has no tiles to draw it
 * in, and the request would be refused anyway.
 */
export function useHostTrend(enabled: boolean): { cpu: (number | null)[]; mem: (number | null)[]; disk: (number | null)[] } | null {
  const { data } = useMetricHistory("host", null, "1h", { enabled });
  return useMemo(() => {
    if (!data || data.t.length < 2) return null;
    return {
      cpu: downsample(data.series.cpu ?? [], POINTS),
      mem: downsample(data.series.mem_pct ?? [], POINTS),
      disk: downsample(data.series.disk_pct ?? [], POINTS),
    };
  }, [data]);
}
