import { cn } from "@/lib/utils";
import { sparkPath } from "@/lib/meter";

const TONE = {
  accent: "text-accent",
  success: "text-success",
  warning: "text-warning",
  danger: "text-danger",
  muted: "text-muted",
} as const;

/**
 * A small line of recent values, under a number that says what it is.
 *
 * Decorative to assistive technology: the caller always shows the value it
 * summarises in text, so the line only adds the shape. Drawn in `currentColor`,
 * which takes the tone from the theme tokens in both themes.
 */
export function Sparkline({
  values,
  tone = "accent",
  height = 36,
  ceiling,
  className,
}: {
  values: ReadonlyArray<number | null | undefined>;
  tone?: keyof typeof TONE;
  height?: number;
  /** The top of the scale for a value with a natural maximum: 100 for a percentage. */
  ceiling?: number;
  className?: string;
}) {
  // A fixed coordinate box; the SVG stretches to its container's width.
  const width = 120;
  const path = sparkPath(values, width, height, 2, ceiling);
  if (!path.last) return <div aria-hidden className={cn("w-full", className)} style={{ height }} />;

  return (
    <svg
      viewBox={`0 0 ${width} ${height}`}
      preserveAspectRatio="none"
      aria-hidden
      className={cn("block w-full overflow-visible", TONE[tone], className)}
      style={{ height }}
    >
      <line x1="0" x2={width} y1={height - 0.5} y2={height - 0.5} stroke="var(--border)" strokeWidth="1" vectorEffect="non-scaling-stroke" />
      <polygon points={path.area} fill="currentColor" fillOpacity="0.14" />
      <polyline
        points={path.line}
        fill="none"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinejoin="round"
        strokeLinecap="round"
        vectorEffect="non-scaling-stroke"
      />
    </svg>
  );
}
