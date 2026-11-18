"use client";

import Link from "next/link";
import { Button } from "@heroui/react";
import { Icon } from "@iconify/react";
import { formatRelative, formatWhen } from "@/lib/format";
import { useServerHref } from "@/lib/hooks/useNode";
import { cn } from "@/lib/utils";
import { NotifyBody } from "./NotifyBody";
import type { InboxItem } from "./useInbox";

/** What each level looks like, and what it is called for a screen reader. */
export const LEVEL_LOOK: Record<InboxItem["level"], { icon: string; className: string; label: string }> = {
  danger: { icon: "solar:danger-circle-linear", className: "text-danger", label: "Problema" },
  warn: { icon: "solar:danger-triangle-linear", className: "text-warning", label: "Attenzione" },
  ok: { icon: "solar:check-circle-linear", className: "text-success", label: "Tutto bene" },
  info: { icon: "solar:info-circle-linear", className: "text-muted", label: "Informazione" },
};

function repeatsText(item: InboxItem): string | null {
  if (item.repeats <= 0) return null;
  const times = item.repeats === 1 ? "un'altra volta" : `altre ${item.repeats} volte`;
  return `poi è successo ${times}, l'ultima ${formatRelative(item.lastAt)}`;
}

/**
 * One notification: how bad, what, when, and where to look.
 *
 * `compact` is the bell's: two lines of body at most and no buttons, since
 * opening it is the action. The full list adds "Segna come letta".
 */
export function NotificationItem({
  item,
  compact = false,
  onOpen,
  onMarkRead,
}: {
  item: InboxItem;
  compact?: boolean;
  /** Called when the title is followed: the place to mark it read and close a popover. */
  onOpen?: (item: InboxItem) => void;
  onMarkRead?: (item: InboxItem) => void;
}) {
  const href = useServerHref();
  const look = LEVEL_LOOK[item.level] ?? LEVEL_LOOK.info;
  const repeats = repeatsText(item);

  return (
    <div className={cn("flex min-w-0 gap-3 px-4 py-3", !item.read && "bg-accent/5")}>
      <Icon icon={look.icon} width={18} className={cn("mt-0.5 shrink-0", look.className)} aria-label={look.label} role="img" />
      <div className="min-w-0 flex-1">
        <div className="flex min-w-0 items-start gap-2">
          {item.href ? (
            <Link
              href={href(item.href)}
              onClick={() => onOpen?.(item)}
              className="text-foreground min-w-0 text-sm font-medium break-words hover:underline"
            >
              {item.title}
            </Link>
          ) : (
            <span className="text-foreground min-w-0 text-sm font-medium break-words">{item.title}</span>
          )}
          {!item.read && <span className="bg-accent mt-1.5 size-2 shrink-0 rounded-full" role="img" aria-label="Da leggere" />}
        </div>
        <NotifyBody html={item.body} className={cn("text-muted mt-0.5 text-xs leading-relaxed", compact && "line-clamp-2")} />
        <p className="text-muted/80 text-meta mt-1">
          <time dateTime={item.createdAt} title={formatWhen(item.createdAt)}>
            {formatRelative(item.createdAt)}
          </time>
          {repeats && <> · {repeats}</>}
        </p>
      </div>
      {!compact && !item.read && onMarkRead && (
        <Button size="sm" variant="ghost" className="shrink-0 self-start" onPress={() => onMarkRead(item)} aria-label={`Segna come letta: ${item.title}`}>
          <Icon icon="solar:check-read-linear" width={15} aria-hidden />
          <span className="hidden sm:inline">Segna come letta</span>
        </Button>
      )}
    </div>
  );
}
