"use client";

import { Disclosure } from "@heroui/react";
import { useExpertMode } from "@/components/Providers";
import { cn } from "@/lib/utils";

/**
 * Detail only an expert reads: a container name, a PID, a raw command, an id.
 *
 * Shown in expert mode, replaced by `fallback` (nothing by default) otherwise.
 * Use it for facts that are true but say nothing to someone who only wants the
 * site online; anything a person needs to act on stays visible to everyone.
 */
export function Technical({ children, fallback = null }: { children: React.ReactNode; fallback?: React.ReactNode }) {
  const { expert } = useExpertMode();
  return <>{expert ? children : fallback}</>;
}

/**
 * The settings most people never need, folded away, inside a form or a panel.
 *
 * One spelling for "advanced" across the panel, so it reads the same wherever it
 * appears. Closed by default and open in expert mode: whoever turned that on
 * has said they want to see these without a click. Read once at mount, so
 * switching modes does not fold a section under the cursor.
 */
export function Advanced({
  title = "Avanzate",
  summary,
  defaultExpanded,
  children,
  className,
}: {
  title?: React.ReactNode;
  /** What is inside, in a few words: "porta, comandi, controllo di avvio". */
  summary?: React.ReactNode;
  /** Overrides the expert-mode default. */
  defaultExpanded?: boolean;
  children: React.ReactNode;
  className?: string;
}) {
  const { expert } = useExpertMode();
  return (
    <Disclosure
      defaultExpanded={defaultExpanded ?? expert}
      className={cn("border-border rounded-[var(--radius)] border", className)}
    >
      <Disclosure.Heading>
        <Disclosure.Trigger className="hover:bg-surface-hover flex w-full items-center gap-2.5 rounded-[var(--radius)] px-3 py-2.5 text-left transition-colors">
          <Disclosure.Indicator className="text-muted shrink-0" />
          <span className="min-w-0 flex-1">
            <span className="text-foreground text-sm font-medium">{title}</span>
            {summary && <span className="text-muted ml-2 text-meta">{summary}</span>}
          </span>
        </Disclosure.Trigger>
      </Disclosure.Heading>
      <Disclosure.Content>
        <div className="border-separator space-y-4 border-t px-3 py-3.5">{children}</div>
      </Disclosure.Content>
    </Disclosure>
  );
}
