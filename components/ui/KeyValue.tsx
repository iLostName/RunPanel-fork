"use client";

import { useExpertMode } from "@/components/Providers";
import { cn } from "@/lib/utils";

export interface KeyValueItem {
  label: React.ReactNode;
  value: React.ReactNode;
  /** Shown only in expert mode: an id, a path, a raw command. */
  technical?: boolean;
  /** Set the value in the monospace face: code, hashes, ports. */
  mono?: boolean;
}

/**
 * Label and value pairs, aligned in two columns.
 *
 * Three pages had grown their own copy (a backup run, the updates page, the
 * autostart details), each with different spacing. One `dl` now, with the
 * technical rows hidden unless expert mode is on.
 */
export function KeyValue({ items, className }: { items: KeyValueItem[]; className?: string }) {
  const { expert } = useExpertMode();
  const shown = items.filter((item) => expert || !item.technical);
  if (shown.length === 0) return null;

  return (
    <dl className={cn("grid grid-cols-[auto_minmax(0,1fr)] gap-x-5 gap-y-2 text-sm", className)}>
      {shown.map((item, index) => (
        <div key={index} className="contents">
          <dt className="text-muted whitespace-nowrap">{item.label}</dt>
          <dd className={cn("text-foreground min-w-0 break-words", item.mono && "font-mono text-xs leading-5")}>{item.value}</dd>
        </div>
      ))}
    </dl>
  );
}
