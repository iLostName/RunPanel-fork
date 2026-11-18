"use client";

import Link from "next/link";
import { Icon } from "@iconify/react";
import { Panel } from "@/components/ui/Panel";
import { useResource } from "@/lib/hooks/useResource";
import { useCan } from "@/lib/hooks/useMe";
import { useNodeApi, useServerHref } from "@/lib/hooks/useNode";
import { actionLabel } from "@/lib/audit-labels";
import { formatRelative } from "@/lib/format";
import { cn } from "@/lib/utils";

interface Entry {
  id: string;
  at: string;
  email: string | null;
  category: string;
  action: string;
  scopeName: string | null;
}

const CATEGORY_ICON: Record<string, string> = {
  deploy: "solar:rocket-2-linear",
  config: "solar:tuning-2-linear",
  security: "solar:shield-user-linear",
  backup: "solar:archive-linear",
  terminal: "solar:command-linear",
  system: "solar:settings-linear",
  delete: "solar:trash-bin-trash-linear",
};

/**
 * What changed lately, on the Overview: the last few entries of the activity
 * log, so "who deployed that, and when" does not need a trip to Team.
 *
 * Only for accounts that may read the log, and only what they may see of it:
 * the route filters by permission, exactly as the full log page does.
 */
export function ActivityFeed({ className }: { className?: string }) {
  const canView = useCan("audit.view");
  const api = useNodeApi();
  const href = useServerHref();
  const { data } = useResource<{ entries: Entry[] }>(canView ? api("/api/audit?limit=6") : null, { intervalMs: 30_000 });

  if (!canView || !data) return null;
  const entries = data.entries ?? [];

  return (
    <Panel padding="flush" className={cn("overflow-hidden", className)} role="region" aria-labelledby="activity-title">
      <div className="flex items-center gap-3 px-4 py-3">
        <h2 id="activity-title" className="text-foreground flex-1 text-sm font-semibold">
          Attività recente
        </h2>
        <Link href={href("/audit")} className="text-accent text-xs hover:underline">
          Registro completo
        </Link>
      </div>
      {entries.length === 0 ? (
        <p className="border-separator text-muted border-t px-4 py-6 text-center text-xs">
          Ancora niente: qui compariranno deploy, modifiche e accessi.
        </p>
      ) : (
        <ul className="border-separator divide-separator divide-y border-t">
          {entries.map((entry) => (
            <li key={entry.id} className="flex items-start gap-3 px-4 py-2.5">
              <span className="bg-surface-secondary text-muted mt-0.5 grid size-7 shrink-0 place-items-center rounded-lg">
                <Icon icon={CATEGORY_ICON[entry.category] ?? "solar:history-linear"} width={15} aria-hidden />
              </span>
              <div className="min-w-0 flex-1">
                <p className="text-foreground truncate text-sm">
                  {actionLabel(entry.action)}
                  {entry.scopeName && <span className="text-muted"> · {entry.scopeName}</span>}
                </p>
                <p className="text-muted truncate text-meta">
                  {entry.email ?? "Il pannello"} · <time dateTime={entry.at}>{formatRelative(entry.at)}</time>
                </p>
              </div>
            </li>
          ))}
        </ul>
      )}
    </Panel>
  );
}
