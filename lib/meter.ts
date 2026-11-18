/**
 * The arithmetic behind the panel's small charts and gauges.
 *
 * Zero imports: the unit suite loads this file directly, and both the server
 * and the browser use it.
 */

export type MeterTone = "success" | "warning" | "danger";

/**
 * The colour a usage gauge should be. A bar at 98% that looks exactly like one
 * at 10% says nothing; these are the thresholds the notifications already use
 * for disk (warning near full, danger when the next write may fail).
 */
export function meterTone(percent: number, warnAt = 75, dangerAt = 90): MeterTone {
  if (!Number.isFinite(percent)) return "success";
  if (percent >= dangerAt) return "danger";
  if (percent >= warnAt) return "warning";
  return "success";
}

export interface SparkPath {
  /** `points` for an SVG polyline. */
  line: string;
  /** `points` for the polygon under it, closed along the bottom. */
  area: string;
  /** Where the last value sits, for the end dot. Null with no data. */
  last: { x: number; y: number } | null;
  min: number;
  max: number;
}

/**
 * Points for a sparkline drawn in a `width` × `height` box.
 *
 * The scale starts at zero for anything that cannot go negative, so a CPU line
 * between 4% and 6% reads as flat and low rather than as a cliff; a series that
 * does go negative uses its own minimum. A gap (NaN, null) is dropped rather
 * than drawn as zero. `pad` keeps the stroke and the end dot inside the box.
 *
 * `ceiling` fixes the top of the scale for values with a natural maximum, such
 * as percentages: CPU at 6% then drawn at the top of its own little box would
 * read as a machine at full load.
 */
export function sparkPath(
  values: ReadonlyArray<number | null | undefined>,
  width: number,
  height: number,
  pad = 2,
  ceiling?: number
): SparkPath {
  const points = values
    .map((value, index) => ({ value, index }))
    .filter((p): p is { value: number; index: number } => typeof p.value === "number" && Number.isFinite(p.value));

  if (points.length === 0) return { line: "", area: "", last: null, min: 0, max: 0 };

  const raw = points.map((p) => p.value);
  const lowest = Math.min(...raw);
  const min = lowest < 0 ? lowest : 0;
  const max = ceiling !== undefined ? Math.max(ceiling, ...raw) : Math.max(...raw);
  const span = max - min || 1;
  const stepX = values.length > 1 ? (width - pad * 2) / (values.length - 1) : 0;

  const coords = points.map((p) => ({
    x: values.length > 1 ? pad + p.index * stepX : width / 2,
    y: pad + (height - pad * 2) * (1 - (p.value - min) / span),
  }));

  const fmt = (n: number) => (Math.round(n * 10) / 10).toString();
  const line = coords.map((c) => `${fmt(c.x)},${fmt(c.y)}`).join(" ");
  const first = coords[0];
  const last = coords[coords.length - 1];
  const area = `${fmt(first.x)},${fmt(height)} ${line} ${fmt(last.x)},${fmt(height)}`;

  return { line, area, last, min, max };
}
