"use client";

import { useCallback, useSyncExternalStore } from "react";
import { Segmented } from "@/components/ui/Segmented";
import { isMetricRange, type MetricRange } from "@/lib/metrics-math";

const OPTIONS = [
  { value: "1h" as const, label: "Ultima ora" },
  { value: "24h" as const, label: "24 ore" },
  { value: "7d" as const, label: "7 giorni" },
];

/** The one filter of a set of charts, in a row above everything it scopes. */
export function RangePicker({
  value,
  onChange,
  className,
}: {
  value: MetricRange;
  onChange: (next: MetricRange) => void;
  className?: string;
}) {
  return <Segmented value={value} onChange={onChange} options={OPTIONS} label="Periodo dei grafici" className={className} />;
}

/**
 * The period last chosen, per browser, like the folders of the overview: which
 * one someone keeps open is theirs, not the server's.
 *
 * An external store rather than state seeded from `localStorage`: the server
 * renders "Ultima ora", and a first client render that read the saved value
 * instead would not match it. Kept in memory as well, so the switch still
 * works where storage throws (a private window, a blocked origin).
 */
const KEY = "runpanel.metrics.range";
let memory: MetricRange = "1h";
const listeners = new Set<() => void>();

function snapshot(): MetricRange {
  try {
    const saved = localStorage.getItem(KEY);
    if (isMetricRange(saved)) return saved;
  } catch {
    /* fall back to memory */
  }
  return memory;
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  window.addEventListener("storage", listener);
  return () => {
    listeners.delete(listener);
    window.removeEventListener("storage", listener);
  };
}

export function useMetricRange(): [MetricRange, (next: MetricRange) => void] {
  const range = useSyncExternalStore(subscribe, snapshot, () => "1h" as MetricRange);
  const setRange = useCallback((next: MetricRange) => {
    memory = next;
    try {
      localStorage.setItem(KEY, next);
    } catch {
      /* remembered for this page only */
    }
    for (const listener of listeners) listener();
  }, []);
  return [range, setRange];
}
