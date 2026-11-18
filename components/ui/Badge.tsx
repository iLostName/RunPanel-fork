import { Icon } from "@iconify/react";
import { cn } from "@/lib/utils";

export type BadgeTone = "neutral" | "accent" | "success" | "warning" | "danger";

const TONES: Record<BadgeTone, string> = {
  neutral: "text-muted bg-default border-border",
  accent: "text-accent bg-accent/10 border-accent/25",
  success: "text-success bg-success/10 border-success/25",
  warning: "text-warning bg-warning/10 border-warning/30",
  danger: "text-danger bg-danger/10 border-danger/30",
};

/**
 * A short fact attached to something: "Autonomo", "PostgreSQL 16", "Versione
 * attuale". Not a status: a status has a lifecycle and goes through
 * `StatusBadge`, which knows its colour. A badge is a label.
 */
export function Badge({
  children,
  tone = "neutral",
  icon,
  mono = false,
  className,
}: {
  children: React.ReactNode;
  tone?: BadgeTone;
  /** Iconify name, as a literal so the icon bundler finds it. */
  icon?: string;
  /** For values that are code: a version, a port, a commit. */
  mono?: boolean;
  className?: string;
}) {
  return (
    <span
      className={cn(
        "inline-flex h-5 shrink-0 items-center gap-1 rounded-md border px-1.5 text-meta font-medium whitespace-nowrap",
        TONES[tone],
        mono && "font-mono",
        className
      )}
    >
      {icon && <Icon icon={icon} width={12} aria-hidden />}
      {children}
    </span>
  );
}
