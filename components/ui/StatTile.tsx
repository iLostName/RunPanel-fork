import { Icon } from "@iconify/react";
import { cn } from "@/lib/utils";
import { meterTone, type MeterTone } from "@/lib/meter";
import { Sparkline } from "./Sparkline";

const BAR: Record<MeterTone, string> = {
  success: "bg-success",
  warning: "bg-warning",
  danger: "bg-danger",
};

const NOTE: Record<MeterTone, string> = {
  success: "text-muted",
  warning: "text-warning",
  danger: "text-danger",
};

/**
 * One number, what it is, and how worried to be about it.
 *
 * The bar used to be the accent colour at any value, so a disk at 98% looked
 * like one at 10%. It now takes its colour from the thresholds in
 * `lib/meter.ts`, and `note` says in words what the colour means when it
 * matters. `trend` adds the recent shape when there is a history to show.
 */
export function StatTile({
  label,
  value,
  hint,
  icon,
  percent,
  note,
  trend,
  className,
}: {
  label: string;
  value: React.ReactNode;
  hint?: string;
  /** Iconify name, as a literal so the icon bundler finds it. */
  icon?: string;
  /** Draws the usage bar, coloured by threshold. */
  percent?: number;
  /** A sentence under the value; coloured like the bar when it is a warning. */
  note?: React.ReactNode;
  /** Recent values, oldest first. */
  trend?: ReadonlyArray<number | null | undefined>;
  className?: string;
}) {
  const clamped = percent === undefined ? undefined : Math.max(0, Math.min(100, percent));
  const tone = clamped === undefined ? "success" : meterTone(clamped);

  return (
    <div
      className={cn(
        "border-border bg-surface flex flex-col rounded-[var(--radius)] border px-4 py-3.5 shadow-[var(--surface-shadow)]",
        className
      )}
    >
      <div className="flex items-center gap-2">
        {icon && <Icon icon={icon} width={15} className="text-muted" aria-hidden />}
        <span className="text-muted text-xs font-medium">{label}</span>
      </div>

      <div className="mt-1.5 flex min-w-0 flex-wrap items-baseline gap-x-1.5">
        <span className="text-foreground text-xl font-semibold tabular-nums tracking-tight">{value}</span>
        {hint && <span className="text-muted text-xs">{hint}</span>}
      </div>

      {trend && trend.length > 1 && (
        <Sparkline values={trend} tone={clamped === undefined ? "accent" : tone === "success" ? "accent" : tone} className="mt-2" height={28} />
      )}

      {clamped !== undefined && (
        <div
          className="bg-default mt-2.5 h-1 w-full overflow-hidden rounded-full"
          role="meter"
          aria-valuenow={Math.round(clamped)}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-label={label}
        >
          <div
            className={cn("h-full rounded-full transition-[width] duration-500", BAR[tone])}
            style={{ width: `${clamped}%` }}
          />
        </div>
      )}

      {note && <p className={cn("mt-2 text-meta leading-relaxed", NOTE[tone])}>{note}</p>}
    </div>
  );
}
