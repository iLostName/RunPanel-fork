"use client";

import { useCallback, useId, useMemo, useRef, useState } from "react";
import { cn } from "@/lib/utils";
import { formatBytes } from "@/lib/format";
import {
  chartRuns,
  niceBytesScale,
  niceScale,
  summarize,
  timeTicks,
  type MetricRange,
  type Scale,
} from "@/lib/metrics-math";

/**
 * A line over time, drawn in SVG with nothing but the arithmetic in
 * `lib/metrics-math.ts` — no chart library for a few hundred points.
 *
 * How it is built, because each choice answers a requirement:
 *  - The plot is an SVG stretched to its box (`preserveAspectRatio="none"`)
 *    with strokes that do not scale, so it needs no measuring and no resize
 *    observer, and renders the same on the server and on a phone. Everything
 *    that must not stretch — labels, the hover dot, the tooltip — is HTML
 *    placed over it in percent.
 *  - A missing sample is a gap, not a drop to zero, and two points further
 *    apart than the sampling allows are not joined: a line across a night the
 *    panel was off would claim to know what happened in it.
 *  - A percentage keeps its 0–100 axis. CPU at 6% drawn to the top of its own
 *    box reads as a machine at full load.
 *  - A threshold is a tinted band above its line: "above here for five
 *    minutes, and an alert goes out".
 *  - The value under the pointer is in a tooltip that lists every series, and
 *    the same readout is reachable from the keyboard (arrows, Home, End) and
 *    announced. The summary under the chart — average and peak — is text, so
 *    nothing is only in the picture.
 */

export type ChartUnit = "percent" | "bytes" | "rate" | "ms";

export interface ChartSeries {
  label: string;
  /** Aligned with `t`; null is a gap. */
  values: ReadonlyArray<number | null>;
  /** The second series of a pair steps back. */
  tone?: "accent" | "muted";
}

export interface ChartThreshold {
  value: number;
  tone: "warning" | "danger";
  /** What crossing it means, for the summary: "soglia degli avvisi". */
  label: string;
}

const HOUR = new Intl.DateTimeFormat("it-IT", { hour: "2-digit", minute: "2-digit" });
const WEEKDAY = new Intl.DateTimeFormat("it-IT", { weekday: "short" });
const FULL = new Intl.DateTimeFormat("it-IT", {
  weekday: "short",
  day: "numeric",
  month: "short",
  hour: "2-digit",
  minute: "2-digit",
});

/** One way to print each unit, used by the axis, the tooltip and the summary alike. */
export function formatMetric(value: number | null | undefined, unit: ChartUnit): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return "—";
  switch (unit) {
    case "percent":
      return `${value < 10 && value > 0 ? value.toFixed(1) : Math.round(value)}%`;
    case "bytes":
      return formatBytes(value);
    case "rate":
      return `${formatBytes(value)}/s`;
    case "ms":
      return value >= 1000 ? `${(value / 1000).toFixed(1)} s` : `${Math.round(value)} ms`;
  }
}

const TONE_TEXT = { accent: "text-accent", muted: "text-muted" } as const;
const BAND_TEXT = { warning: "text-warning", danger: "text-danger" } as const;

/** Virtual width of the plot; the box it is drawn in decides the real one. */
const W = 1000;

function nearestIndex(t: readonly number[], ts: number): number {
  let lo = 0;
  let hi = t.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (t[mid] < ts) lo = mid + 1;
    else hi = mid;
  }
  if (lo > 0 && Math.abs(t[lo - 1] - ts) < Math.abs(t[lo] - ts)) return lo - 1;
  return lo;
}

export function MetricChart({
  title,
  t,
  from,
  to,
  step,
  series,
  unit,
  range,
  thresholds = [],
  detail,
  current,
  badge,
  height = 112,
  stale = false,
  emptyText = "Ancora nessun dato per questo periodo: il primo punto arriva entro un minuto.",
  className,
}: {
  title: string;
  t: readonly number[];
  from: number;
  to: number;
  /** Nominal spacing of the points: two further apart than 2.5 steps are not joined. */
  step: number;
  series: readonly ChartSeries[];
  unit: ChartUnit;
  range: MetricRange;
  thresholds?: readonly ChartThreshold[];
  /** One more line in the tooltip for a point: the bytes behind a percentage. */
  detail?: (index: number) => string | null;
  /** Shown next to the title; the last value of the first series by default. */
  current?: React.ReactNode;
  badge?: React.ReactNode;
  height?: number;
  /** The data on screen belongs to another range and a new one is on its way. */
  stale?: boolean;
  emptyText?: string;
  className?: string;
}) {
  const titleId = useId();
  const descId = useId();
  const plotRef = useRef<HTMLDivElement>(null);
  const [active, setActive] = useState<number | null>(null);

  const all = useMemo(() => series.flatMap((s) => s.values), [series]);
  const scale: Scale = useMemo(() => {
    if (unit === "percent") return niceScale(all, { ceiling: 100, ticks: 2 });
    if (unit === "bytes" || unit === "rate") return niceBytesScale(all, 2);
    return niceScale(all, { ticks: 2 });
  }, [all, unit]);

  const runs = useMemo(
    () => series.map((s) => chartRuns(t, s.values, { from, to, max: scale.max, width: W, height }, step * 2.5)),
    [series, t, from, to, scale.max, height, step]
  );
  const summaries = useMemo(() => series.map((s) => summarize(s.values)), [series]);
  const hasData = summaries.some((s) => s !== null);

  // The offset at the end of the range: a pure function of the data, so the
  // render stays one too.
  const ticks = useMemo(
    () => timeTicks(from, to, range === "7d" ? 7 : 4, new Date(to).getTimezoneOffset()).ticks,
    [from, to, range]
  );
  const xPercent = (ts: number) => ((ts - from) / (to - from || 1)) * 100;
  const yPx = (value: number) => height - (Math.max(0, Math.min(scale.max, value)) / (scale.max || 1)) * height;
  const tickLabel = (ts: number) => (range === "7d" ? WEEKDAY.format(ts) : HOUR.format(ts));

  const lastValue = summaries[0]?.last ?? null;
  const shownCurrent = current ?? formatMetric(lastValue, unit);

  const summaryText = !hasData
    ? emptyText
    : series
        .map((s, i) => {
          const sum = summaries[i];
          if (!sum) return null;
          const name = series.length > 1 ? `${s.label}: ` : "";
          return `${name}media ${formatMetric(sum.avg, unit)} · picco ${formatMetric(sum.max, unit)}`;
        })
        .filter(Boolean)
        .join(" — ") +
      (thresholds.length > 0 ? `. Fascia colorata: ${thresholds.map((th) => `${th.label} (${formatMetric(th.value, unit)})`).join(", ")}` : "");

  const pick = useCallback(
    (clientX: number) => {
      const box = plotRef.current?.getBoundingClientRect();
      if (!box || box.width <= 0 || t.length === 0) return;
      const fraction = Math.max(0, Math.min(1, (clientX - box.left) / box.width));
      setActive(nearestIndex(t, from + fraction * (to - from)));
    },
    [t, from, to]
  );

  const onKeyDown = (event: React.KeyboardEvent) => {
    if (t.length === 0) return;
    const last = t.length - 1;
    const at = active ?? last;
    let next: number | null = null;
    if (event.key === "ArrowLeft") next = Math.max(0, at - 1);
    else if (event.key === "ArrowRight") next = Math.min(last, at + 1);
    else if (event.key === "Home") next = 0;
    else if (event.key === "End") next = last;
    else if (event.key === "Escape") {
      setActive(null);
      return;
    } else return;
    event.preventDefault();
    setActive(next);
  };

  const readout =
    active !== null && t[active] !== undefined
      ? {
          x: xPercent(t[active]),
          when: FULL.format(t[active]),
          rows: series.map((s, i) => ({ label: s.label, tone: s.tone ?? (i === 0 ? "accent" : "muted"), value: s.values[active] })),
          extra: detail?.(active) ?? null,
        }
      : null;

  const spoken = readout
    ? `${readout.when}: ${readout.rows.map((row) => `${series.length > 1 ? `${row.label} ` : ""}${formatMetric(row.value, unit)}`).join(", ")}`
    : "";

  return (
    <figure className={cn("min-w-0", className)} aria-labelledby={titleId} aria-describedby={descId}>
      <figcaption className="mb-2 flex min-w-0 flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
        <span className="flex min-w-0 items-center gap-2">
          <span id={titleId} className="text-muted truncate text-xs font-medium">
            {title}
          </span>
          {badge}
        </span>
        <span className="text-foreground text-sm font-semibold">{hasData ? shownCurrent : "—"}</span>
      </figcaption>

      {series.length > 1 && (
        <ul className="text-muted mb-2 flex flex-wrap gap-x-3 gap-y-1 text-meta" aria-label="Legenda">
          {series.map((s, i) => (
            <li key={s.label} className="flex items-center gap-1.5">
              <span className={cn("h-0.5 w-3 rounded-full bg-current", TONE_TEXT[s.tone ?? (i === 0 ? "accent" : "muted")])} aria-hidden />
              {s.label}
            </li>
          ))}
        </ul>
      )}

      <div className="grid grid-cols-[2.75rem_minmax(0,1fr)]">
        {/* Value axis: labels in HTML so they never stretch with the plot. */}
        <div className="relative" style={{ height }} aria-hidden>
          {scale.ticks.map((tick) => (
            <span
              key={tick}
              className="text-muted absolute right-2 -translate-y-1/2 text-meta tabular-nums whitespace-nowrap"
              style={{ top: yPx(tick) }}
            >
              {formatMetric(tick, unit)}
            </span>
          ))}
        </div>

        <div
          ref={plotRef}
          role="group"
          aria-label={`${title}: grafico. Frecce sinistra e destra per leggere i valori.`}
          tabIndex={hasData ? 0 : -1}
          onKeyDown={onKeyDown}
          onFocus={() => setActive((previous) => previous ?? (t.length > 0 ? t.length - 1 : null))}
          onBlur={() => setActive(null)}
          onPointerMove={(event) => pick(event.clientX)}
          onPointerDown={(event) => pick(event.clientX)}
          // A finger lifting is not a reader leaving: on a phone the value stays
          // until the chart loses focus.
          onPointerLeave={(event) => {
            if (event.pointerType === "mouse") setActive(null);
          }}
          className={cn(
            "relative touch-pan-y rounded-sm outline-none transition-opacity focus-visible:ring-2 focus-visible:ring-[var(--focus)]",
            stale && "opacity-50"
          )}
          style={{ height }}
        >
          <svg
            viewBox={`0 0 ${W} ${height}`}
            preserveAspectRatio="none"
            className="absolute inset-0 h-full w-full overflow-visible"
            aria-hidden
          >
            {scale.ticks.map((tick) => (
              <line
                key={tick}
                x1={0}
                x2={W}
                y1={yPx(tick)}
                y2={yPx(tick)}
                stroke="var(--border)"
                strokeWidth={1}
                vectorEffect="non-scaling-stroke"
              />
            ))}

            {thresholds
              .filter((th) => th.value < scale.max)
              .map((th) => (
                <g key={th.value} className={BAND_TEXT[th.tone]}>
                  <rect x={0} y={0} width={W} height={yPx(th.value)} fill="currentColor" fillOpacity={0.07} />
                  <line
                    x1={0}
                    x2={W}
                    y1={yPx(th.value)}
                    y2={yPx(th.value)}
                    stroke="currentColor"
                    strokeOpacity={0.45}
                    strokeWidth={1}
                    vectorEffect="non-scaling-stroke"
                  />
                </g>
              ))}

            {runs.map((seriesRuns, si) => {
              const tone = series[si].tone ?? (si === 0 ? "accent" : "muted");
              return (
                <g key={series[si].label} className={TONE_TEXT[tone]}>
                  {si === 0 &&
                    seriesRuns
                      .filter((run) => run.length > 1)
                      .map((run, ri) => (
                        <polygon
                          key={`a${ri}`}
                          points={`${run[0].x},${height} ${run.map((p) => `${p.x},${p.y}`).join(" ")} ${run[run.length - 1].x},${height}`}
                          fill="currentColor"
                          fillOpacity={0.1}
                        />
                      ))}
                  {seriesRuns.map((run, ri) =>
                    run.length > 1 ? (
                      <polyline
                        key={`l${ri}`}
                        points={run.map((p) => `${p.x},${p.y}`).join(" ")}
                        fill="none"
                        stroke="currentColor"
                        strokeWidth={2}
                        strokeLinejoin="round"
                        strokeLinecap="round"
                        vectorEffect="non-scaling-stroke"
                      />
                    ) : (
                      // A point with no neighbour still has to be seen.
                      <line
                        key={`l${ri}`}
                        x1={run[0].x}
                        x2={run[0].x + 0.01}
                        y1={run[0].y}
                        y2={run[0].y}
                        stroke="currentColor"
                        strokeWidth={4}
                        strokeLinecap="round"
                        vectorEffect="non-scaling-stroke"
                      />
                    )
                  )}
                </g>
              );
            })}
          </svg>

          {!hasData && (
            <p className="text-muted absolute inset-0 flex items-center justify-center px-4 text-center text-xs">{emptyText}</p>
          )}

          {readout && (
            <>
              <div className="bg-border pointer-events-none absolute top-0 bottom-0 w-px" style={{ left: `${readout.x}%` }} aria-hidden />
              {readout.rows.map((row) =>
                row.value === null || row.value === undefined ? null : (
                  <span
                    key={row.label}
                    className={cn(
                      "pointer-events-none absolute size-2.5 -translate-x-1/2 -translate-y-1/2 rounded-full bg-current ring-2 ring-[var(--surface)]",
                      TONE_TEXT[row.tone]
                    )}
                    style={{ left: `${readout.x}%`, top: yPx(row.value) }}
                    aria-hidden
                  />
                )
              )}
              <div
                className={cn(
                  "border-border bg-overlay pointer-events-none absolute top-1 z-10 rounded-md border px-2 py-1.5 text-meta shadow-[var(--overlay-shadow)] whitespace-nowrap",
                  readout.x > 55 ? "-translate-x-[calc(100%+8px)]" : "translate-x-2"
                )}
                style={{ left: `${readout.x}%` }}
                aria-hidden
              >
                <p className="text-muted">{readout.when}</p>
                {readout.rows.map((row) => (
                  <p key={row.label} className="flex items-center gap-1.5">
                    <span className={cn("h-0.5 w-2.5 rounded-full bg-current", TONE_TEXT[row.tone])} />
                    <span className="text-foreground font-semibold tabular-nums">{formatMetric(row.value, unit)}</span>
                    {series.length > 1 && <span className="text-muted">{row.label}</span>}
                  </p>
                ))}
                {readout.extra && <p className="text-muted">{readout.extra}</p>}
              </div>
            </>
          )}
        </div>

        <div aria-hidden />
        {/* Time axis: round local times, the ones at the very edges left out so they never spill. */}
        <div className="relative mt-1 h-4" aria-hidden>
          {ticks
            .filter((tick) => xPercent(tick) > 3 && xPercent(tick) < 97)
            .map((tick) => (
              <span
                key={tick}
                className="text-muted absolute -translate-x-1/2 text-meta tabular-nums whitespace-nowrap"
                style={{ left: `${xPercent(tick)}%` }}
              >
                {tickLabel(tick)}
              </span>
            ))}
        </div>
      </div>

      <p id={descId} className="text-muted mt-1.5 text-meta leading-relaxed">
        {summaryText}
      </p>
      <span className="sr-only" aria-live="polite">
        {spoken}
      </span>
    </figure>
  );
}
