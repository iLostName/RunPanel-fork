import { cn } from "@/lib/utils";

/**
 * The one card surface.
 *
 * The app previously had four competing recipes: HeroUI's own Card, a
 * 14px-radius translucent-white variant, a 12px one with a different tint, and
 * a blurred black glass copied inline four times in a single file. Every panel
 * now comes from here, so a change to elevation or radius happens in one place.
 */

interface PanelProps extends React.HTMLAttributes<HTMLDivElement> {
  /** `flush` drops the padding for panels that host their own scroll area. */
  padding?: "default" | "compact" | "flush";
  /** Slightly lighter surface, for panels nested inside another panel. */
  nested?: boolean;
  interactive?: boolean;
}

const PADDING = {
  default: "p-4 sm:p-5",
  compact: "p-3",
  flush: "p-0",
} as const;

export function Panel({
  padding = "default",
  nested = false,
  interactive = false,
  className,
  children,
  ...props
}: PanelProps) {
  return (
    <div
      className={cn(
        "border-border rounded-[var(--radius)] border",
        // The shadow is transparent in the dark theme and a hairline in the
        // light one, where surface steps alone barely separate card from page.
        nested ? "bg-surface-secondary" : "bg-surface shadow-[var(--surface-shadow)]",
        PADDING[padding],
        interactive && "hover:border-separator hover:bg-surface-hover transition-colors",
        className
      )}
      {...props}
    >
      {children}
    </div>
  );
}

export function PanelHeader({
  title,
  description,
  actions,
  className,
}: {
  title: React.ReactNode;
  description?: React.ReactNode;
  actions?: React.ReactNode;
  className?: string;
}) {
  // On a phone the actions go under the title when the two do not fit side by
  // side: next to a segmented switch or two buttons, the title was cut to a
  // word and its description squeezed into a column of three-word lines. A
  // title with a sentence under it keeps at least 12rem before anything moves;
  // a bare one only its own width, so "Ultimo deploy" keeps its link beside it.
  return (
    <div className={cn("flex items-start justify-between gap-3 max-md:flex-wrap max-md:gap-y-2.5", className)}>
      <div className={cn("min-w-0", description ? "max-md:flex-[1_1_12rem]" : "max-md:flex-[1_1_auto]")}>
        <h2 className="text-foreground truncate text-sm font-medium">{title}</h2>
        {description && <p className="text-muted mt-0.5 text-xs">{description}</p>}
      </div>
      {actions && <div className="flex shrink-0 flex-wrap items-center justify-end gap-2 max-md:max-w-full">{actions}</div>}
    </div>
  );
}
