"use client";

import { useState } from "react";
import { Button } from "@heroui/react";
import { Icon } from "@iconify/react";
import { LoadError } from "./LoadError";
import { ListSkeleton } from "./PageState";
import { ListRow, RowMenu } from "./ListRow";
import { Badge, type BadgeTone } from "./Badge";
import { Panel } from "./Panel";
import { ConfirmDialog } from "./ConfirmDialog";
import { Technical } from "./Technical";
import { ChannelDialog } from "@/components/notifications/ChannelDialog";
import { useResource } from "@/lib/hooks/useResource";
import { useMe } from "@/lib/hooks/useMe";
import { useNodeApi } from "@/lib/hooks/useNode";
import { formatRelative, formatWhen } from "@/lib/format";
import { toast } from "@/lib/toast";
import { MSG } from "@/lib/copy";
import { CHANNEL_KIND_INFO, DEFAULT_NTFY_SERVER, channelHealth, type ChannelHealth, type PublicChannel } from "@/lib/notify-channels";

interface ChannelsResponse {
  channels: PublicChannel[];
  mailReady: boolean;
  max: number;
}

const HEALTH: Record<ChannelHealth, { label: string; tone: BadgeTone }> = {
  off: { label: "Spento", tone: "neutral" },
  never: { label: "Mai usato", tone: "neutral" },
  ok: { label: "Funziona", tone: "success" },
  failing: { label: "Non riesce a inviare", tone: "danger" },
};

/** Where a channel sends, in a few words, without any of its secrets. */
function destination(channel: PublicChannel): string {
  const config = channel.config;
  switch (channel.kind) {
    case "email":
      return Array.isArray(config.to) ? (config.to as string[]).join(", ") : "";
    case "telegram":
      return typeof config.chatId === "string" && config.chatId ? `Chat ${config.chatId}` : "Chat da scegliere";
    case "ntfy": {
      const server =
        typeof config.server === "string" && config.server !== DEFAULT_NTFY_SERVER ? ` su ${config.server.replace(/^https?:\/\//, "")}` : "";
      return `Argomento ${String(config.topic ?? "")}${server}`;
    }
    default:
      return typeof config.hint === "string" ? config.hint : "";
  }
}

function eventsText(count: number): string {
  if (count === 0) return "nessun evento";
  return count === 1 ? "1 tipo di evento" : `${count} tipi di evento`;
}

/**
 * The places notifications are sent, besides the bell.
 *
 * One row per channel, saying what it is, where it sends, what it receives and
 * how its last attempt went — "non riesce a inviare", with the reason, is the
 * row's whole point when something is wrong. Adding and editing happen in a
 * dialog; trying a channel is one press.
 *
 * Replaces the single Telegram form that lived here: that bot, if there was
 * one, is the first channel of the list.
 */
export function NotificationSettings() {
  const api = useNodeApi();
  const me = useMe();
  const { data, loading, error, refresh } = useResource<ChannelsResponse>(api("/api/notifications/channels"));

  const [dialog, setDialog] = useState<{ key: number; channel: PublicChannel | null } | null>(null);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [deleting, setDeleting] = useState<PublicChannel | null>(null);
  const [testing, setTesting] = useState<string | null>(null);

  if (!data && error) return <LoadError what="i canali di notifica" error={error} onRetry={() => void refresh()} />;
  if (loading || !data) return <ListSkeleton rows={2} />;

  const channels = data.channels;

  // A new key per opening, so the dialog starts from the channel as it is now
  // and not from what was typed the last time it was open.
  function openDialog(channel: PublicChannel | null) {
    setDialog((current) => ({ key: (current?.key ?? 0) + 1, channel }));
    setDialogOpen(true);
  }

  async function test(channel: PublicChannel) {
    setTesting(channel.id);
    try {
      const res = await fetch(api(`/api/notifications/channels/${channel.id}/test`), { method: "POST" });
      const body = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string };
      if (body.ok) toast.success(`Prova inviata a «${channel.name}»: controlla che sia arrivata.`);
      else toast.error(body.error ?? "Invio non riuscito");
    } catch {
      toast.error(MSG.unreachable);
    } finally {
      setTesting(null);
      void refresh();
    }
  }

  async function setEnabled(channel: PublicChannel, enabled: boolean) {
    try {
      const res = await fetch(api(`/api/notifications/channels/${channel.id}`), {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enabled }),
      });
      const body = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) {
        toast.error(body.error ?? MSG.saveFailed);
        return;
      }
      toast.success(enabled ? `«${channel.name}» riattivato` : `«${channel.name}» spento`);
      void refresh();
    } catch {
      toast.error(MSG.unreachable);
    }
  }

  async function remove(channel: PublicChannel) {
    const res = await fetch(api(`/api/notifications/channels/${channel.id}`), { method: "DELETE" });
    if (!res.ok) {
      toast.error(MSG.deleteFailed);
      return false;
    }
    toast.success(`«${channel.name}» eliminato`);
    void refresh();
  }

  return (
    <div className="space-y-4">
      <p className="text-muted text-sm">
        Le notifiche compaiono sempre nella campanella in alto. Qui scegli dove mandarle anche fuori dal pannello, e per
        quali eventi: per esempio «avvisami su Telegram quando un deploy fallisce».
      </p>

      {channels.length === 0 ? (
        <div className="border-border flex flex-col items-center rounded-[var(--radius)] border border-dashed px-6 py-8 text-center">
          <Icon icon="solar:bell-bing-linear" width={28} className="text-muted/60" aria-hidden />
          <p className="text-foreground mt-2 text-sm font-medium">Nessun canale</p>
          <p className="text-muted mt-1 max-w-sm text-xs">
            Email, Telegram, Discord, Slack, ntfy sul telefono, o un webhook verso un tuo servizio.
          </p>
          <Button className="mt-4" variant="primary" size="sm" onPress={() => openDialog(null)}>
            <Icon icon="solar:add-circle-linear" width={16} aria-hidden />
            Aggiungi un canale
          </Button>
        </div>
      ) : (
        <Panel nested padding="flush" className="divide-separator divide-y overflow-hidden">
          {channels.map((channel) => {
            const info = CHANNEL_KIND_INFO[channel.kind];
            const health = channelHealth(channel);
            const look = HEALTH[health];
            const noMail = channel.kind === "email" && !data.mailReady;
            const where = destination(channel);
            return (
              <div key={channel.id}>
                <ListRow
                  icon={info.icon}
                  title={channel.name}
                  status={<Badge tone={look.tone}>{look.label}</Badge>}
                  badges={
                    <>
                      <Badge>{info.label}</Badge>
                      {channel.filter === "problems" && <Badge tone="warning">Solo problemi</Badge>}
                      {!channel.secretsReadable && <Badge tone="danger">Segreti da reinserire</Badge>}
                      {noMail && <Badge tone="warning">Manca il server di posta</Badge>}
                    </>
                  }
                  description={`${where}${where ? " · " : ""}${eventsText(channel.events.length)}`}
                  meta={
                    health === "ok" && channel.lastOkAt ? (
                      <span title={formatWhen(channel.lastOkAt)}>Ultimo invio riuscito {formatRelative(channel.lastOkAt)}</span>
                    ) : health === "never" ? (
                      "Non ha ancora inviato niente"
                    ) : undefined
                  }
                  action={
                    <Button
                      size="sm"
                      variant="ghost"
                      isPending={testing === channel.id}
                      isDisabled={testing !== null}
                      onPress={() => void test(channel)}
                      aria-label={`Invia una prova a ${channel.name}`}
                    >
                      <Icon icon="solar:plain-linear" width={15} aria-hidden />
                      <span className="hidden sm:inline">Invia una prova</span>
                    </Button>
                  }
                  menu={
                    <RowMenu
                      label={`Azioni per ${channel.name}`}
                      actions={[
                        { id: "edit", label: "Modifica", icon: "solar:pen-linear", onAction: () => openDialog(channel) },
                        channel.enabled
                          ? { id: "off", label: "Spegni", icon: "solar:pause-circle-linear", onAction: () => void setEnabled(channel, false) }
                          : { id: "on", label: "Riattiva", icon: "solar:play-circle-linear", onAction: () => void setEnabled(channel, true) },
                        {
                          id: "delete",
                          label: "Elimina",
                          icon: "solar:trash-bin-trash-linear",
                          danger: true,
                          onAction: () => setDeleting(channel),
                        },
                      ]}
                    />
                  }
                />
                {health === "failing" && channel.lastError && (
                  <p role="status" className="text-danger -mt-1.5 pr-4 pb-3 pl-[60px] text-xs break-words">
                    <span title={channel.lastErrorAt ? formatWhen(channel.lastErrorAt) : undefined}>
                      Ultimo invio non riuscito {formatRelative(channel.lastErrorAt)}:
                    </span>{" "}
                    {channel.lastError}
                  </p>
                )}
              </div>
            );
          })}
        </Panel>
      )}

      {channels.length > 0 && (
        <div className="flex flex-wrap items-center gap-3">
          <Button variant="outline" size="sm" isDisabled={channels.length >= data.max} onPress={() => openDialog(null)}>
            <Icon icon="solar:add-circle-linear" width={16} aria-hidden />
            Aggiungi un canale
          </Button>
          <Technical>
            <span className="text-muted text-meta">
              Più avvisi ravvicinati arrivano come un messaggio solo; un webhook riceve ogni evento, fino a 30 ogni 10 minuti.
            </span>
          </Technical>
        </div>
      )}

      {dialog && (
        <ChannelDialog
          key={dialog.key}
          isOpen={dialogOpen}
          onOpenChange={setDialogOpen}
          channel={dialog.channel}
          mailReady={data.mailReady}
          isOwner={me.isOwner}
          onSaved={() => void refresh()}
        />
      )}

      <ConfirmDialog
        isOpen={deleting !== null}
        onOpenChange={(open) => {
          if (!open) setDeleting(null);
        }}
        title={deleting ? `Eliminare «${deleting.name}»?` : "Eliminare il canale?"}
        description="Non riceverà più niente. Le notifiche restano comunque nella campanella del pannello."
        confirmLabel="Elimina"
        destructive
        onConfirm={() => (deleting ? remove(deleting) : undefined)}
      />
    </div>
  );
}
