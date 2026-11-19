"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Button } from "@heroui/react";
import { Icon } from "@iconify/react";
import { Badge, type BadgeTone } from "@/components/ui/Badge";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { Hint } from "@/components/ui/Hint";
import { ListRow, RowMenu } from "@/components/ui/ListRow";
import { LoadError } from "@/components/ui/LoadError";
import { Panel } from "@/components/ui/Panel";
import { ListSkeleton } from "@/components/ui/PageState";
import { Section } from "@/components/ui/Section";
import { IosInstallSteps } from "@/components/pwa/InstallDialog";
import { useResource } from "@/lib/hooks/useResource";
import { useMe } from "@/lib/hooks/useMe";
import { useNode } from "@/lib/hooks/useNode";
import { channelHealth, type ChannelHealth } from "@/lib/notify-channels";
import { isMobileAgent } from "@/lib/device-name";
import { formatRelative, formatWhen } from "@/lib/format";
import { toast } from "@/lib/toast";
import { MSG } from "@/lib/copy";
import type { PublicPushDevice } from "@/lib/push-rules";
import {
  PushError,
  currentSubscription,
  defaultDeviceName,
  endpointHash,
  forgetThisDevice,
  notificationPermission,
  pushAvailability,
  subscribeThisDevice,
  type PushAvailability,
} from "@/lib/pwa/push";
import { PushDeviceDialog } from "./PushDeviceDialog";

interface PushResponse {
  publicKey: string;
  devices: PublicPushDevice[];
  max: number;
}

/**
 * The account's devices, and this browser among them.
 *
 * What can only be known here — whether push works in this browser, what it
 * was answered when it asked for permission, which row of the list it is — is
 * read after mount, never during the server render.
 */
interface LocalPush {
  availability: PushAvailability | null;
  permission: NotificationPermission | null;
  /** The hash of this browser's endpoint, when it has a subscription. */
  thisHash: string | null;
}

/** What this browser says, read in one go: the three answers belong together. */
async function probeLocal(): Promise<LocalPush> {
  const subscription = await currentSubscription().catch(() => null);
  const thisHash = subscription ? await endpointHash(subscription.endpoint) : null;
  return { availability: pushAvailability(), permission: notificationPermission(), thisHash };
}

export function usePushDevices() {
  const resource = useResource<PushResponse>("/api/account/push");
  const [local, setLocal] = useState<LocalPush>({ availability: null, permission: null, thisHash: null });

  const readLocal = useCallback(() => probeLocal().then(setLocal), []);
  const setPermission = useCallback((permission: NotificationPermission) => setLocal((current) => ({ ...current, permission })), []);
  const { availability, permission, thisHash } = local;

  useEffect(() => {
    // Read once mounted, and again whenever the page comes back into view:
    // the permission is often changed in the browser's settings, elsewhere.
    let live = true;
    const read = () => {
      void probeLocal().then((next) => {
        if (live) setLocal(next);
      });
    };
    read();
    const onVisible = () => {
      if (document.visibilityState === "visible") read();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      live = false;
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, []);

  const devices = resource.data?.devices ?? [];
  const thisDevice = thisHash ? (devices.find((device) => device.endpointHash === thisHash) ?? null) : null;
  return { ...resource, devices, thisDevice, availability, permission, setPermission, readLocal };
}

const HEALTH: Record<ChannelHealth, { label: string; tone: BadgeTone }> = {
  off: { label: "Spento", tone: "neutral" },
  never: { label: "Mai usato", tone: "neutral" },
  ok: { label: "Funziona", tone: "success" },
  failing: { label: "Non riesce a inviare", tone: "danger" },
};

function eventsText(count: number): string {
  if (count === 0) return "nessun evento";
  return count === 1 ? "1 tipo di evento" : `${count} tipi di evento`;
}

/** How to undo "Blocca", where this browser keeps it. */
function reEnableSteps(): string {
  const ua = navigator.userAgent;
  if (/iPhone|iPad|iPod/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1)) {
    return "Apri Impostazioni sul telefono › Notifiche › RunPanel e attiva «Consenti notifiche», poi torna qui.";
  }
  if (/Android/.test(ua)) {
    return "Nel browser: menu ⋮ › Impostazioni › Impostazioni sito › Notifiche, e togli il blocco a questo indirizzo. Nell'app installata: tieni premuta la sua icona › Informazioni app › Notifiche. Poi ricarica la pagina.";
  }
  if (/Firefox\//.test(ua)) return "Premi l'icona a sinistra dell'indirizzo, togli il blocco alle notifiche e ricarica la pagina.";
  if (/Safari\//.test(ua) && !/Chrome\/|Edg\//.test(ua)) {
    return "In Safari › Impostazioni › Siti web › Notifiche scegli «Consenti» per questo sito, poi ricarica la pagina.";
  }
  return "Premi l'icona a sinistra dell'indirizzo (il lucchetto o le impostazioni del sito), metti Notifiche su «Consenti» e ricarica la pagina. Nell'app installata la stessa voce è nel menu ⋯ › Informazioni sull'app.";
}

/** "Notifiche push" on Account: the section, with what it holds said while it is closed. */
export function PushSection({ defaultExpanded = false }: { defaultExpanded?: boolean }) {
  const push = usePushDevices();
  const others = push.devices.filter((device) => device !== push.thisDevice).length;
  const summary = !push.data
    ? "Gli avvisi sul telefono o sul computer, anche a pannello chiuso"
    : push.thisDevice
      ? others > 0
        ? `Attive su questo dispositivo e su ${others === 1 ? "un altro" : `altri ${others}`}`
        : "Attive su questo dispositivo"
      : push.devices.length > 0
        ? `Attive su ${push.devices.length === 1 ? "un dispositivo" : `${push.devices.length} dispositivi`}, non su questo`
        : "Spente: attivale per ricevere gli avvisi anche a pannello chiuso";

  return (
    <Section title="Notifiche push" summary={summary} defaultExpanded={defaultExpanded}>
      <PushSettings push={push} />
    </Section>
  );
}

/**
 * Notifications on the person's own devices: this one first — whether it can
 * have them and why not, or the button that turns them on — then every device
 * of the account, each with its name, what it receives, how its last
 * notification went, a test and a menu.
 */
export function PushSettings({ push }: { push: ReturnType<typeof usePushDevices> }) {
  const me = useMe();
  const router = useRouter();
  const { isSolo, nameOf, selfId } = useNode();
  const { data, error, loading, refresh, devices, thisDevice, availability, permission, setPermission, readLocal } = push;

  const [busy, setBusy] = useState<"enable" | "disable" | null>(null);
  const [testing, setTesting] = useState<string | null>(null);
  const [editing, setEditing] = useState<{ key: number; device: PublicPushDevice } | null>(null);
  const [editOpen, setEditOpen] = useState(false);
  const [removing, setRemoving] = useState<PublicPushDevice | null>(null);

  async function test(device: PublicPushDevice, quiet = false): Promise<boolean> {
    setTesting(device.id);
    try {
      const res = await fetch(`/api/account/push/devices/${encodeURIComponent(device.id)}/test`, { method: "POST" });
      const body = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string; removed?: boolean };
      if (body.ok) {
        if (!quiet) toast.success(`Prova inviata a «${device.name}»: controlla che sia arrivata.`);
        return true;
      }
      toast.error(body.removed ? `«${device.name}» non riceve più notifiche ed è stato tolto dall'elenco` : (body.error ?? "Invio non riuscito"), {
        description: body.removed ? "Il suo servizio push non lo conosce più. Per riattivarlo, apri il pannello su quel dispositivo." : undefined,
      });
      return false;
    } catch {
      toast.error(MSG.unreachable);
      return false;
    } finally {
      setTesting(null);
      void refresh();
    }
  }

  async function enable() {
    if (!data) return;
    // Asked first, before anything is awaited: Safari grants the permission
    // only from inside the press itself.
    const asking = Notification.permission === "default" ? Notification.requestPermission() : Promise.resolve(Notification.permission);
    setBusy("enable");
    try {
      const answer = await asking;
      setPermission(answer);
      if (answer !== "granted") {
        if (answer === "denied") toast.error("Le notifiche sono bloccate per questo sito", { description: "Qui sotto trovi come sbloccarle." });
        return;
      }
      const device = await subscribeThisDevice(data.publicKey, thisDevice?.name ?? defaultDeviceName());
      await readLocal();
      await refresh();
      // Like a new channel, tried at once: a first notification is the proof
      // that it works, and it arrives while the person is still looking.
      if (await test(device, true)) toast.success("Notifiche attive su questo dispositivo", { description: "Ti ho mandato una prova: controlla che sia arrivata." });
    } catch (err) {
      if (err instanceof PushError && err.code === "key_changed") {
        toast.error("La chiave del pannello per le notifiche è cambiata", { description: "Ricarica la pagina e premi di nuovo «Attiva le notifiche»." });
      } else if (err instanceof PushError) {
        toast.error(err.message, { description: err.detail ? `Dettagli: ${err.detail}` : undefined });
      } else {
        toast.error("Attivazione non riuscita", { description: err instanceof Error ? `Dettagli: ${err.message}` : undefined });
      }
    } finally {
      setBusy(null);
    }
  }

  async function disableHere() {
    setBusy("disable");
    try {
      await forgetThisDevice();
      toast.success("Notifiche spente su questo dispositivo");
    } catch {
      toast.error(MSG.unreachable);
    } finally {
      setBusy(null);
      await readLocal();
      void refresh();
    }
  }

  async function setEnabled(device: PublicPushDevice, enabled: boolean) {
    try {
      const res = await fetch(`/api/account/push/devices/${encodeURIComponent(device.id)}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enabled }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        toast.error(body.error ?? MSG.saveFailed);
        return;
      }
      toast.success(enabled ? `«${device.name}» riattivato` : `«${device.name}» spento: non riceve niente finché non lo riattivi`);
      void refresh();
    } catch {
      toast.error(MSG.unreachable);
    }
  }

  async function remove(device: PublicPushDevice): Promise<boolean | void> {
    try {
      if (device.id === thisDevice?.id) {
        await forgetThisDevice();
        await readLocal();
      } else {
        const res = await fetch(`/api/account/push/devices/${encodeURIComponent(device.id)}`, { method: "DELETE" });
        if (!res.ok && res.status !== 404) {
          toast.error(MSG.removeFailed);
          return false;
        }
      }
      toast.success(`«${device.name}» tolto: non riceve più notifiche`);
      void refresh();
    } catch {
      toast.error(MSG.unreachable);
      return false;
    }
  }

  function openEditor(device: PublicPushDevice) {
    setEditing((current) => ({ key: (current?.key ?? 0) + 1, device }));
    setEditOpen(true);
  }

  if (!data && error) return <LoadError what="i dispositivi con le notifiche" error={error} onRetry={() => void refresh()} />;
  if ((loading && !data) || !data || availability === null) return <ListSkeleton rows={2} />;

  const full = devices.length >= data.max && !thisDevice;

  return (
    <div className="space-y-4">
      <p className="text-muted text-sm">
        Gli avvisi che hai scelto, sul telefono o sul computer, anche con il pannello chiuso. Ognuno arriva solo se riguarda
        qualcosa che puoi vedere, e si apre sulla pagina giusta del pannello.
      </p>

      {/* --- this device ---------------------------------------------------------- */}
      <Panel nested className="space-y-3">
        <div className="flex flex-wrap items-center gap-2">
          <Icon icon="solar:smartphone-2-linear" width={18} className="text-muted" aria-hidden />
          <span className="text-foreground text-sm font-medium">Questo dispositivo</span>
          {availability === "ready" &&
            permission !== "denied" &&
            (thisDevice ? (
              thisDevice.stale ? (
                <Badge tone="warning">Da riattivare</Badge>
              ) : thisDevice.enabled ? (
                <Badge tone="success">Notifiche attive</Badge>
              ) : (
                <Badge>Spento</Badge>
              )
            ) : (
              <Badge>Notifiche spente</Badge>
            ))}
        </div>

        {availability === "insecure" && (
          <Hint tone="warn" title="Serve HTTPS">
            Il browser manda notifiche solo a un indirizzo con il lucchetto, e ora il pannello è aperto su{" "}
            <span className="text-foreground font-mono">{window.location.host}</span>, senza HTTPS.{" "}
            {me.isOwner ? (
              <>
                Dagli un nome sul tuo dominio con <strong className="text-foreground">Metti il pannello su HTTPS</strong>, in
                Impostazioni › Generale: DNS e certificato li prepara il pannello. Poi aprilo da lì e torna qui.
              </>
            ) : (
              <>Chiedi a chi gestisce il pannello di metterlo su HTTPS, da Impostazioni › Generale.</>
            )}
          </Hint>
        )}
        {availability === "insecure" && me.isOwner && (
          <Button variant="secondary" size="sm" onPress={() => router.push("/settings?open=https")}>
            <Icon icon="solar:lock-keyhole-minimalistic-linear" width={16} aria-hidden />
            Metti il pannello su HTTPS
          </Button>
        )}

        {availability === "ios-install" && (
          <>
            <Hint tone="tip" title="Su iPhone e iPad, dall'app sulla schermata Home">
              Apple manda le notifiche di un sito solo all&apos;app aggiunta alla schermata Home, da iOS 16.4 in poi: nel browser non
              arrivano. Aggiungi RunPanel così, aprilo dalla sua icona e torna in Account › Notifiche push.
            </Hint>
            <IosInstallSteps />
          </>
        )}

        {availability === "ios-old" && (
          <Hint tone="warn" title="Serve iOS 16.4 o successivo">
            Su questa versione di iOS le app della schermata Home non ricevono notifiche. Aggiorna il telefono da Impostazioni ›
            Generali › Aggiornamento software, poi torna qui.
          </Hint>
        )}

        {availability === "unsupported" && (
          <Hint tone="warn" title="Questo browser non riceve notifiche dai siti">
            Apri il pannello con Chrome, Edge, Firefox o Safari, o installalo come app dal menu dell&apos;account.
          </Hint>
        )}

        {availability === "ready" && permission === "denied" && (
          <Hint tone="warn" title="Le notifiche sono bloccate per questo sito">
            {reEnableSteps()} Se ancora non arrivano, controlla che le notifiche del browser non siano spente nelle impostazioni del
            sistema.
          </Hint>
        )}

        {availability === "ready" && permission !== "denied" && (
          <>
            <p className="text-muted text-xs leading-relaxed">
              {thisDevice
                ? thisDevice.stale
                  ? "La chiave del pannello per le notifiche è cambiata: premi «Riattiva» per riceverle di nuovo qui."
                  : thisDevice.enabled
                    ? `Qui arrivano ${eventsText(thisDevice.events.length)}${thisDevice.filter === "problems" ? ", solo quando qualcosa va storto" : ""}. Lo trovi nell'elenco come «${thisDevice.name}».`
                    : "Questo dispositivo è nell'elenco ma spento: non riceve niente finché non lo riattivi dal suo menu."
                : permission === "granted"
                  ? "Il browser le consente già: premi «Attiva le notifiche» e questo dispositivo si aggiunge all'elenco."
                  : "Il browser ti chiederà il permesso. Puoi spegnerle quando vuoi, da qui o dalle impostazioni del browser."}
            </p>
            <div className="flex flex-wrap items-center gap-2">
              {!thisDevice || thisDevice.stale ? (
                <Button variant="primary" size="sm" isPending={busy === "enable"} isDisabled={busy !== null || full} onPress={() => void enable()}>
                  <Icon icon="solar:bell-bing-linear" width={16} aria-hidden />
                  {thisDevice?.stale ? "Riattiva" : "Attiva le notifiche"}
                </Button>
              ) : (
                <>
                  <Button
                    variant="secondary"
                    size="sm"
                    isPending={testing === thisDevice.id}
                    isDisabled={testing !== null || !thisDevice.enabled}
                    onPress={() => void test(thisDevice)}
                  >
                    <Icon icon="solar:plain-linear" width={15} aria-hidden />
                    Invia una prova
                  </Button>
                  <Button variant="ghost" size="sm" isPending={busy === "disable"} isDisabled={busy !== null} onPress={() => void disableHere()}>
                    Spegni qui
                  </Button>
                </>
              )}
            </div>
            {full && (
              <p className="text-warning text-meta">
                Hai già {data.max} dispositivi con le notifiche: togline uno dall&apos;elenco per aggiungere questo.
              </p>
            )}
          </>
        )}
      </Panel>

      {/* --- every device of the account --------------------------------------------- */}
      {devices.length > 0 && (
        <div className="space-y-2">
          <span className="text-muted/70 text-meta block tracking-wider uppercase">I tuoi dispositivi</span>
          <Panel nested padding="flush" className="divide-separator divide-y overflow-hidden">
            {devices.map((device) => {
              const current = device.id === thisDevice?.id;
              const health = channelHealth(device);
              const look = device.stale ? { label: "Da riattivare", tone: "warning" as const } : HEALTH[health];
              return (
                <div key={device.id}>
                  <ListRow
                    icon={isMobileAgent(device.userAgent) ? "solar:smartphone-2-linear" : "solar:monitor-linear"}
                    title={device.name}
                    status={<Badge tone={look.tone}>{look.label}</Badge>}
                    badges={
                      <>
                        {current && <Badge tone="accent">Questo dispositivo</Badge>}
                        {device.filter === "problems" && <Badge tone="warning">Solo problemi</Badge>}
                      </>
                    }
                    description={`${eventsText(device.events.length)} · tramite ${device.pushService}`}
                    meta={
                      device.stale ? (
                        "Si riattiva da solo la prossima volta che apri il pannello su questo dispositivo"
                      ) : health === "ok" && device.lastOkAt ? (
                        <span title={formatWhen(device.lastOkAt)}>Ultimo invio riuscito {formatRelative(device.lastOkAt)}</span>
                      ) : (
                        <span title={formatWhen(device.createdAt)}>Attivato {formatRelative(device.createdAt)}</span>
                      )
                    }
                    action={
                      <Button
                        size="sm"
                        variant="ghost"
                        isPending={testing === device.id}
                        isDisabled={testing !== null || !device.enabled || device.stale}
                        onPress={() => void test(device)}
                        aria-label={`Invia una prova a ${device.name}`}
                      >
                        <Icon icon="solar:plain-linear" width={15} aria-hidden />
                        <span className="hidden sm:inline">Invia una prova</span>
                      </Button>
                    }
                    menu={
                      <RowMenu
                        label={`Azioni per ${device.name}`}
                        actions={[
                          { id: "edit", label: "Modifica", icon: "solar:pen-linear", onAction: () => openEditor(device) },
                          device.enabled
                            ? { id: "off", label: "Spegni", icon: "solar:pause-circle-linear", onAction: () => void setEnabled(device, false) }
                            : { id: "on", label: "Riattiva", icon: "solar:play-circle-linear", onAction: () => void setEnabled(device, true) },
                          { id: "remove", label: "Rimuovi", icon: "solar:trash-bin-trash-linear", danger: true, onAction: () => setRemoving(device) },
                        ]}
                      />
                    }
                  />
                  {!device.stale && health === "failing" && device.lastError && (
                    <p role="status" className="text-danger -mt-1.5 pr-4 pb-3 pl-[60px] text-xs break-words">
                      <span title={device.lastErrorAt ? formatWhen(device.lastErrorAt) : undefined}>
                        Ultimo invio non riuscito {formatRelative(device.lastErrorAt)}:
                      </span>{" "}
                      {device.lastError}
                    </p>
                  )}
                </div>
              );
            })}
          </Panel>
        </div>
      )}

      {!isSolo && (
        <Hint title="Con più server">
          Qui arrivano gli avvisi di questo pannello{selfId && nameOf(selfId) ? ` (${nameOf(selfId)})` : ""}. Per quelli di un server
          collegato, attiva le notifiche anche aprendo il suo pannello, se ne ha uno; per un nodo, aggiungi un canale con quel server
          selezionato, in <Link href="/settings?open=notifications" className="text-accent hover:underline">Impostazioni › Generale › Notifiche</Link>.
        </Hint>
      )}

      {editing && (
        <PushDeviceDialog
          key={editing.key}
          isOpen={editOpen}
          onOpenChange={setEditOpen}
          device={editing.device}
          onSaved={() => void refresh()}
        />
      )}

      <ConfirmDialog
        isOpen={removing !== null}
        onOpenChange={(open) => {
          if (!open) setRemoving(null);
        }}
        title={removing ? `Rimuovere «${removing.name}»?` : "Rimuovere il dispositivo?"}
        description={
          removing?.id === thisDevice?.id
            ? "Su questo dispositivo smettono di arrivare le notifiche. Le trovi comunque nella campanella, e puoi riattivarle da qui quando vuoi."
            : "Non riceverà più notifiche. Per riattivarle, apri il pannello su quel dispositivo e premi «Attiva le notifiche». Restano comunque nella campanella."
        }
        confirmLabel="Rimuovi"
        destructive
        onConfirm={() => (removing ? remove(removing) : undefined)}
      />
    </div>
  );
}

/**
 * The same, as one row of the channels list in Impostazioni › Generale ›
 * Notifiche: the channel every account turns on for itself, so whoever sets
 * up the panel's channels sees that it exists and where it lives.
 */
export function PushChannelRow() {
  const push = usePushDevices();
  const here = push.thisDevice;
  const count = push.devices.length;
  return (
    <ListRow
      icon="solar:smartphone-2-linear"
      title="Questo dispositivo (notifiche push)"
      status={
        push.data ? (
          here && !here.stale && here.enabled ? <Badge tone="success">Attive qui</Badge> : <Badge>Spente qui</Badge>
        ) : undefined
      }
      description={
        count > 0
          ? `Le tue sono attive su ${count === 1 ? "un dispositivo" : `${count} dispositivi`}. Ognuno le attiva per sé, in Account.`
          : "Sul telefono o sul computer, anche a pannello chiuso. Ognuno le attiva per sé, in Account."
      }
      action={
        <Link href="/account?open=push" className="text-accent inline-flex items-center gap-1 text-sm hover:underline">
          Gestisci
          <Icon icon="solar:alt-arrow-right-linear" width={14} aria-hidden />
        </Link>
      }
    />
  );
}
