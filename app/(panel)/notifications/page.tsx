"use client";

import { useState } from "react";
import Link from "next/link";
import { Button } from "@heroui/react";
import { Icon } from "@iconify/react";
import { PageHeader } from "@/components/ui/PageHeader";
import { Panel } from "@/components/ui/Panel";
import { PageState, ListSkeleton } from "@/components/ui/PageState";
import { EmptyState } from "@/components/ui/EmptyState";
import { Segmented } from "@/components/ui/Segmented";
import { SelectField } from "@/components/ui/SelectField";
import { NotificationItem } from "@/components/notifications/NotificationItem";
import { inboxQuery, useInbox, type InboxItem, type InboxPage } from "@/components/notifications/useInbox";
import { NOTIFY_GROUPS } from "@/lib/notify-events";
import { useCan } from "@/lib/hooks/useMe";
import { useNodeApi, useServerHref } from "@/lib/hooks/useNode";
import { toast } from "@/lib/toast";
import { MSG } from "@/lib/copy";

type Show = "all" | "unread";
type LevelFilter = "any" | "problems" | "danger" | "warn" | "ok" | "info";

const LEVEL_OPTIONS: { value: LevelFilter; label: string }[] = [
  { value: "any", label: "Qualsiasi gravità" },
  { value: "problems", label: "Solo i problemi" },
  { value: "danger", label: "Errori" },
  { value: "warn", label: "Avvertimenti" },
  { value: "ok", label: "Buone notizie" },
  { value: "info", label: "Informazioni" },
];

const GROUP_OPTIONS = [
  { value: "any", label: "Tutti gli argomenti" },
  ...NOTIFY_GROUPS.map((group) => ({ value: group.id, label: group.label, description: group.description })),
];

const PAGE_SIZE = 30;

/**
 * Everything the panel has said, for the person reading it.
 *
 * Every account has this page — it is reached from the bell, not the sidebar —
 * and sees in it only what it may see. Kept for thirty days. Where the same
 * events are also *sent*, by email or to a chat, is the channels' business, on
 * the settings page.
 */
export default function NotificationsPage() {
  const api = useNodeApi();
  const href = useServerHref();
  const canManage = useCan("notifications");

  const [show, setShow] = useState<Show>("all");
  const [level, setLevel] = useState<LevelFilter>("any");
  const [group, setGroup] = useState("any");

  const filter = {
    limit: PAGE_SIZE,
    unreadOnly: show === "unread",
    level: level === "any" ? null : level,
    group: group === "any" ? null : group,
  };
  const { data, loading, error, refresh, markRead, markAll } = useInbox(filter);

  // Further pages, kept apart from the first so a live update can refresh the
  // first without throwing away what was scrolled to. Keyed by the filter, so
  // changing it starts again from the top.
  const filterKey = JSON.stringify(filter);
  const [more, setMore] = useState<{ key: string; items: InboxItem[]; cursor: string | null }>({ key: filterKey, items: [], cursor: null });
  const [loadingMore, setLoadingMore] = useState(false);
  const extra = more.key === filterKey ? more : { key: filterKey, items: [], cursor: null };

  const first = data?.items ?? [];
  const firstIds = new Set(first.map((item) => item.id));
  const items = [...first, ...extra.items.filter((item) => !firstIds.has(item.id))];
  const cursor = extra.items.length > 0 ? extra.cursor : (data?.nextBefore ?? null);
  const unread = data?.unread ?? 0;

  async function loadMore() {
    if (!cursor) return;
    setLoadingMore(true);
    try {
      const res = await fetch(api(inboxQuery({ ...filter, before: cursor })));
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const page = (await res.json()) as InboxPage;
      setMore({ key: filterKey, items: [...extra.items, ...page.items], cursor: page.nextBefore });
    } catch {
      toast.error(MSG.loadFailed);
    } finally {
      setLoadingMore(false);
    }
  }

  async function readAll() {
    try {
      await markAll();
      setMore({ key: filterKey, items: [], cursor: null });
    } catch {
      toast.error(MSG.saveFailed);
    }
  }

  async function readOne(item: InboxItem) {
    try {
      await markRead([item.id]);
      setMore((current) => ({ ...current, items: current.items.map((i) => (i.id === item.id ? { ...i, read: true } : i)) }));
    } catch {
      toast.error(MSG.saveFailed);
    }
  }

  const filtered = show === "unread" || level !== "any" || group !== "any";

  return (
    <>
      <PageHeader
        title="Notifiche"
        description="Quello che è successo su questo server, tra ciò che puoi vedere. Restano qui 30 giorni."
        actions={
          <>
            {canManage && (
              <Link
                href={href("/settings?open=notifications")}
                className="text-muted hover:text-foreground inline-flex items-center gap-1.5 text-sm"
              >
                <Icon icon="solar:tuning-2-linear" width={16} aria-hidden />
                Dove ricevere gli avvisi
              </Link>
            )}
            <Button variant="secondary" size="sm" isDisabled={unread === 0} onPress={() => void readAll()}>
              <Icon icon="solar:check-read-linear" width={16} aria-hidden />
              Segna tutte come lette
            </Button>
          </>
        }
      />

      <div className="max-w-3xl space-y-4">
        <div className="flex flex-wrap items-end gap-3">
          <Segmented
            label="Quali notifiche"
            value={show}
            onChange={setShow}
            options={[
              { value: "all", label: "Tutte" },
              { value: "unread", label: unread > 0 ? `Da leggere (${unread > 99 ? "99+" : unread})` : "Da leggere" },
            ]}
          />
          <SelectField ariaLabel="Argomento" value={group} onChange={setGroup} options={GROUP_OPTIONS} className="w-full sm:w-56" />
          <SelectField ariaLabel="Gravità" value={level} onChange={setLevel} options={LEVEL_OPTIONS} className="w-full sm:w-48" />
        </div>

        <PageState
          loading={loading}
          error={error}
          hasData={Boolean(data)}
          onRetry={() => void refresh()}
          what="le notifiche"
          skeleton={<ListSkeleton rows={5} />}
          empty={
            items.length === 0 && (
              <Panel>
                <EmptyState
                  icon={filtered ? "solar:filter-linear" : "solar:bell-off-linear"}
                  title={filtered ? "Nessuna notifica con questi filtri" : "Nessuna notifica"}
                  description={
                    filtered
                      ? "Prova a togliere un filtro."
                      : "Qui compaiono crash, esiti dei deploy e dei backup, spazio su disco e aggiornamenti, appena succedono."
                  }
                />
              </Panel>
            )
          }
        >
          <Panel padding="flush" className="divide-separator divide-y overflow-hidden">
            {items.map((item) => (
              <NotificationItem
                key={item.id}
                item={item}
                onOpen={(opened) => {
                  if (!opened.read) void readOne(opened);
                }}
                onMarkRead={(target) => void readOne(target)}
              />
            ))}
          </Panel>
          {cursor && (
            <div className="flex justify-center">
              <Button variant="ghost" size="sm" isPending={loadingMore} onPress={() => void loadMore()}>
                Carica le precedenti
              </Button>
            </div>
          )}
        </PageState>
      </div>
    </>
  );
}
