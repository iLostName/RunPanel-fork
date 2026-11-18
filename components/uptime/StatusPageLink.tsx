"use client";

import { Button } from "@heroui/react";
import { Icon } from "@iconify/react";
import { Tip } from "@/components/ui/Tooltip";
import { useClipboard } from "@/lib/hooks/useClipboard";
import { cn } from "@/lib/utils";

/**
 * The address of the public status page, to open or to copy: the settings
 * show it under the address field, the uptime card of a project that is on
 * the page under its incidents. A link people are meant to hand out, so it
 * is printed whole, not masked like `CopyField`'s secrets; the address itself
 * is the link, opening in a new tab.
 */
export function StatusPageLink({ url, className }: { url: string; className?: string }) {
  const { copied, copy } = useClipboard();
  return (
    <div className={cn("border-border bg-surface-secondary flex min-w-0 items-center gap-1 rounded-[var(--radius)] border py-1 pr-1 pl-3", className)}>
      <a
        href={url}
        target="_blank"
        rel="noreferrer"
        className="text-foreground flex min-w-0 flex-1 items-center gap-1.5 font-mono text-xs underline-offset-2 hover:underline"
      >
        <span className="min-w-0 truncate">{url}</span>
        <Icon icon="solar:square-arrow-right-up-linear" width={13} className="text-muted shrink-0" aria-hidden />
        <span className="sr-only">(si apre in una nuova scheda)</span>
      </a>
      <Tip content={copied ? "Copiato" : "Copia il link"}>
        <Button variant="ghost" size="sm" isIconOnly aria-label="Copia il link della pagina di stato" onPress={() => void copy(url)}>
          <Icon icon={copied ? "solar:check-read-linear" : "solar:copy-linear"} width={15} aria-hidden />
        </Button>
      </Tip>
    </div>
  );
}
