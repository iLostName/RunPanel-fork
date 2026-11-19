"use client";

import { useState } from "react";
import Link from "next/link";
import { Button, Popover } from "@heroui/react";
import { Icon } from "@iconify/react";
import { toast } from "@/lib/toast";
import { MSG } from "@/lib/copy";
import { useCan } from "@/lib/hooks/useMe";
import { useServerHref } from "@/lib/hooks/useNode";
import { SkeletonText } from "@/components/ui/Skeletons";
import { NotificationItem } from "./NotificationItem";
import { useShellInbox } from "./InboxProvider";
import type { InboxItem } from "./useInbox";

/**
 * The bell in the top bar: how many notifications are unread, and the latest.
 *
 * What is in it is decided by the server per account — a project nobody gave
 * you is not in your bell — and it updates live, over the stream it shares with
 * the Notifiche page. Following a notification marks it read; "Segna tutte come
 * lette" clears the count everywhere the account is signed in.
 */
export function NotificationBell() {
  const [open, setOpen] = useState(false);
  const href = useServerHref();
  const canManage = useCan("notifications");
  const { data, loading, error, markRead, markAll } = useShellInbox();

  const unread = data?.unread ?? 0;
  const items = data?.items ?? [];
  const label = unread > 0 ? `Notifiche: ${unread} da leggere` : "Notifiche";

  function opened(item: InboxItem) {
    setOpen(false);
    if (!item.read) void markRead([item.id]).catch(() => {});
  }

  async function readAll() {
    try {
      await markAll();
    } catch {
      toast.error(MSG.saveFailed);
    }
  }

  return (
    <Popover isOpen={open} onOpenChange={setOpen}>
      <Button variant="ghost" size="sm" isIconOnly aria-label={label} className="relative">
        <Icon icon={unread > 0 ? "solar:bell-bing-linear" : "solar:bell-linear"} width={18} aria-hidden />
        {unread > 0 && (
          <span
            aria-hidden
            className="bg-danger text-danger-foreground absolute -top-0.5 -right-0.5 grid h-4 min-w-4 place-items-center rounded-full px-1 text-[10px] leading-none font-semibold"
          >
            {unread > 99 ? "99+" : unread}
          </span>
        )}
      </Button>
      <Popover.Content placement="bottom end" className="w-[min(26rem,calc(100vw-1.5rem))] p-0">
        <Popover.Dialog aria-label="Notifiche" className="p-0 outline-none">
          <div className="border-separator flex items-center justify-between gap-2 border-b px-4 py-2.5">
            <p className="text-foreground text-sm font-medium">
              Notifiche
              {unread > 0 && <span className="text-muted ml-1.5 font-normal">{unread} da leggere</span>}
            </p>
            <Button size="sm" variant="ghost" isDisabled={unread === 0} onPress={() => void readAll()}>
              Segna tutte come lette
            </Button>
          </div>

          <div className="divide-separator max-h-[min(28rem,65vh)] divide-y overflow-y-auto">
            {!data && loading ? (
              <div className="space-y-2 px-4 py-4" aria-busy="true" aria-label="Caricamento">
                <SkeletonText className="w-48" />
                <SkeletonText className="w-64 opacity-70" />
              </div>
            ) : !data && error ? (
              <p className="text-muted px-4 py-6 text-center text-sm">Impossibile caricare le notifiche. Riprova tra poco.</p>
            ) : items.length === 0 ? (
              <div className="flex flex-col items-center px-6 py-8 text-center">
                <Icon icon="solar:bell-off-linear" width={28} className="text-muted/60" aria-hidden />
                <p className="text-foreground mt-2 text-sm font-medium">Nessuna notifica</p>
                <p className="text-muted mt-1 max-w-xs text-xs">
                  Qui compaiono crash, deploy, backup e problemi del server, appena succedono.
                </p>
              </div>
            ) : (
              items.map((item) => <NotificationItem key={item.id} item={item} compact onOpen={opened} />)
            )}
          </div>

          <div className="border-separator flex items-center justify-between gap-2 border-t px-4 py-2">
            <Link href={href("/notifications")} onClick={() => setOpen(false)} className="text-accent text-sm hover:underline">
              Vedi tutte
            </Link>
            {canManage ? (
              <Link
                href={href("/settings?open=notifications")}
                onClick={() => setOpen(false)}
                className="text-muted hover:text-foreground inline-flex items-center gap-1 text-xs"
              >
                <Icon icon="solar:tuning-2-linear" width={14} aria-hidden />
                Dove ricevere gli avvisi
              </Link>
            ) : (
              // Everyone else's way out of the panel: notifications on their own devices.
              <Link
                href="/account?open=push"
                onClick={() => setOpen(false)}
                className="text-muted hover:text-foreground inline-flex items-center gap-1 text-xs"
              >
                <Icon icon="solar:smartphone-2-linear" width={14} aria-hidden />
                Ricevile su questo dispositivo
              </Link>
            )}
          </div>
        </Popover.Dialog>
      </Popover.Content>
    </Popover>
  );
}
