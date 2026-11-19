"use client";

import { useState } from "react";
import { Icon } from "@iconify/react";
import { cn } from "@/lib/utils";
import { useClipboard } from "@/lib/hooks/useClipboard";

/**
 * A read-only value with a copy button — connection strings, webhook URLs,
 * generated passwords. Secrets stay masked until explicitly revealed, so a
 * credential is not left on screen for a passing shoulder.
 */
export function CopyField({
  value,
  label,
  secret = false,
  className,
}: {
  value: string;
  label?: string;
  secret?: boolean;
  className?: string;
}) {
  const { copied, copy } = useClipboard();
  const [revealed, setRevealed] = useState(!secret);

  return (
    <div className={cn("space-y-1.5", className)}>
      {label && <span className="text-muted text-xs font-medium">{label}</span>}
      <div className="border-border bg-surface-secondary flex items-center gap-1 rounded-[var(--radius)] border px-3 py-2">
        {/* On a phone a revealed value wraps instead of ending in "…": a
            connection string cut at a third of its length could not be read
            there, and a phone has no hover to show the rest. */}
        <code className="text-foreground min-w-0 flex-1 truncate font-mono text-xs max-md:whitespace-normal max-md:[overflow-wrap:anywhere]">
          {revealed ? value : "•".repeat(Math.min(value.length, 32))}
        </code>

        {secret && (
          <button
            type="button"
            onClick={() => setRevealed((r) => !r)}
            className="touch-target text-muted hover:text-foreground self-start rounded p-1 transition-colors md:self-auto"
            aria-label={revealed ? "Nascondi valore" : "Mostra valore"}
          >
            <Icon icon={revealed ? "solar:eye-closed-linear" : "solar:eye-linear"} width={15} />
          </button>
        )}

        <button
          type="button"
          onClick={() => copy(value)}
          className="touch-target text-muted hover:text-foreground self-start rounded p-1 transition-colors md:self-auto"
          aria-label={`Copia${label ? ` ${label}` : ""}`}
        >
          <Icon icon={copied ? "solar:check-read-linear" : "solar:copy-linear"} width={15} />
        </button>
      </div>
    </div>
  );
}
