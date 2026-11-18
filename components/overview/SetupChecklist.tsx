"use client";

import { useState } from "react";
import Link from "next/link";
import { Button } from "@heroui/react";
import { Icon } from "@iconify/react";
import { Panel } from "@/components/ui/Panel";
import { useResource } from "@/lib/hooks/useResource";
import { useMe } from "@/lib/hooks/useMe";
import { useNodeApi, useServerHref } from "@/lib/hooks/useNode";
import type { OnboardingItem } from "@/lib/onboarding";
import { cn } from "@/lib/utils";

const HIDDEN_KEY = "runpanel.onboarding.hidden";

function readHidden(): boolean {
  try {
    return localStorage.getItem(HIDDEN_KEY) === "1";
  } catch {
    return false;
  }
}

/**
 * The steps a server needs to run on its own, in order, on the Overview.
 *
 * Owner only, like the steps themselves (see `/api/onboarding`). Goes away by
 * itself once everything is done, or when hidden — per browser, like the
 * folders kept shut on this page.
 */
export function SetupChecklist({ className }: { className?: string }) {
  const me = useMe();
  const api = useNodeApi();
  const href = useServerHref();
  const [hidden, setHidden] = useState(readHidden);
  const { data } = useResource<{ items: OnboardingItem[] }>(me.isOwner && !hidden ? api("/api/onboarding") : null, {
    intervalMs: 60_000,
  });

  const items = data?.items ?? [];
  const done = items.filter((item) => item.done).length;
  if (!me.isOwner || hidden || items.length === 0 || done === items.length) return null;

  const hide = () => {
    setHidden(true);
    try {
      localStorage.setItem(HIDDEN_KEY, "1");
    } catch {
      /* hidden for this visit only */
    }
  };
  const next = items.find((item) => !item.done);

  return (
    <Panel padding="flush" className={cn("overflow-hidden", className)} role="region" aria-labelledby="setup-title">
      <div className="flex flex-wrap items-center gap-3 px-4 py-3">
        <div className="min-w-0 flex-1">
          <h2 id="setup-title" className="text-foreground text-sm font-semibold">
            Prima configurazione
          </h2>
          <p className="text-muted text-xs">
            {done} di {items.length} fatti · quello che serve perché il server vada avanti da solo
          </p>
        </div>
        <div
          className="bg-default h-1.5 w-28 overflow-hidden rounded-full"
          role="progressbar"
          aria-label="Configurazione completata"
          aria-valuemin={0}
          aria-valuemax={items.length}
          aria-valuenow={done}
        >
          <div className="bg-success h-full rounded-full transition-[width] duration-500" style={{ width: `${(done / items.length) * 100}%` }} />
        </div>
        <Button variant="ghost" size="sm" onPress={hide}>
          Nascondi
        </Button>
      </div>
      <ol className="border-separator divide-separator divide-y border-t">
        {items.map((item, index) => (
          <li key={item.id} className="flex items-center gap-3 px-4 py-2.5">
            <span
              className={cn(
                "grid size-6 shrink-0 place-items-center rounded-full border text-meta tabular-nums",
                item.done ? "bg-success/15 text-success border-transparent" : "border-border text-muted"
              )}
              aria-hidden
            >
              {item.done ? <Icon icon="solar:check-read-linear" width={13} /> : index + 1}
            </span>
            <div className="min-w-0 flex-1">
              <p className={cn("text-sm", item.done ? "text-muted line-through decoration-muted/40" : "text-foreground")}>
                {item.title}
                <span className="sr-only">{item.done ? " (fatto)" : " (da fare)"}</span>
              </p>
              {!item.done && <p className="text-muted mt-0.5 text-xs">{item.description}</p>}
            </div>
            {!item.done && (
              <Link
                href={href(item.href)}
                className={cn(
                  "inline-flex h-8 shrink-0 items-center rounded-[var(--radius)] px-3 text-sm font-medium transition-colors",
                  item === next
                    ? "bg-accent text-accent-foreground hover:opacity-90"
                    : "border-border bg-surface text-foreground hover:bg-surface-hover border"
                )}
              >
                {item.cta}
              </Link>
            )}
          </li>
        ))}
      </ol>
    </Panel>
  );
}
