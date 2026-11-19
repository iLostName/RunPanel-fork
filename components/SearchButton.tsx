"use client";

import { Icon } from "@iconify/react";
import { openCommandPalette } from "@/components/CommandPalette";
import { cn } from "@/lib/utils";

/**
 * The palette's front door.
 *
 * Search existed only behind Ctrl+K, which nobody finds by looking and which a
 * phone does not have. This is a field-shaped button on wide screens and an
 * icon on narrow ones; both open the same palette.
 */
export function SearchButton({ className }: { className?: string }) {
  return (
    <button
      type="button"
      onClick={openCommandPalette}
      // Everything the button shows, shortcut included: whoever operates the
      // page by voice says what is on screen (WCAG 2.5.3). The label stays for
      // a phone, where only the icon is drawn.
      aria-label="Cerca progetti, database, pagine e azioni (Ctrl K)"
      aria-keyshortcuts="Control+K Meta+K"
      className={cn(
        "border-border bg-field text-muted hover:text-foreground hover:border-separator flex h-9 min-w-0 items-center gap-2 rounded-[var(--radius)] border px-2.5 text-sm transition-colors",
        "w-9 justify-center sm:w-64 sm:justify-start lg:w-80",
        className
      )}
    >
      <Icon icon="solar:magnifier-linear" width={16} className="shrink-0" aria-hidden />
      {/* The whole sentence, cut by the width: a literal "…" was text the name could not contain. */}
      <span className="hidden flex-1 truncate text-left sm:inline">Cerca progetti, database, pagine e azioni</span>
      {/* Not drawn in a flex row, but it keeps "azioni" and "Ctrl" two words for whoever reads the text. */}
      {" "}
      <kbd className="border-border text-meta hidden rounded border px-1.5 py-0.5 font-sans sm:inline-block">Ctrl K</kbd>
    </button>
  );
}
