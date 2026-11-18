"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { Button, Modal, Spinner } from "@heroui/react";
import { Icon } from "@iconify/react";
import { Hint } from "@/components/ui/Hint";
import { Advanced, Technical } from "@/components/ui/Technical";
import { LoadError } from "@/components/ui/LoadError";
import { SkeletonBlock } from "@/components/ui/Skeletons";
import { outsideToasts, toast } from "@/lib/toast";
import { SheetGrip } from "@/components/ui/SheetGrip";
import { MSG } from "@/lib/copy";
import { formatWhen } from "@/lib/format";
import { cn } from "@/lib/utils";
import { useResource } from "@/lib/hooks/useResource";
import { usePollInterval } from "@/lib/hooks/usePollingInterval";
import { useNodeApi, useServerHref } from "@/lib/hooks/useNode";
import { isInstantHostname } from "@/lib/proxy-names";
import { AddressBadge, addressDetail } from "@/app/(panel)/domains/_components/AddressStatus";
import { PROXY_SERVES, ProxySetup, type ProxyInfo } from "@/app/(panel)/domains/_components/ProxySetup";
import type { HostView } from "@/services/proxy";
import { DnsVerdictBadge, DomainDnsRecords, type DnsName } from "./DomainDnsRecords";

interface DnsData {
  proxy: { state: string; detail: string };
  names: DnsName[];
}

/** A name whose record needs nothing more from anyone. */
function settled(name: DnsName): boolean {
  return name.check.state === "ok" || (name.check.state === "cloudflare" && name.check.ready);
}

type StepTone = "done" | "waiting" | "problem";

const STEP_ICON: Record<StepTone, { icon: string; className: string }> = {
  done: { icon: "solar:check-circle-linear", className: "text-success" },
  waiting: { icon: "solar:clock-circle-linear", className: "text-muted" },
  problem: { icon: "solar:danger-triangle-linear", className: "text-warning" },
};

function Step({ title, tone, children }: { title: string; tone: StepTone; children: React.ReactNode }) {
  const mark = STEP_ICON[tone];
  return (
    <section className="flex gap-3">
      <Icon icon={mark.icon} width={20} className={cn("mt-0.5 shrink-0", mark.className)} aria-hidden />
      <div className="min-w-0 flex-1 space-y-3">
        <h3 className="text-foreground text-sm font-medium">{title}</h3>
        {children}
      </div>
    </section>
  );
}

/**
 * Everything between "added" and "padlock" for one address, in the order it
 * happens: the server can serve it, its DNS record leads here, the
 * certificate is there.
 *
 * The record is looked up again every few seconds while it is not right yet —
 * which is when someone has this open next to their DNS provider's page — and
 * no more once it is, or once the dialog closes. When it turns right and the
 * certificate is still waiting, it is asked for at once rather than at the
 * server's next look, two minutes later.
 */
export function DomainCheckDialog({
  projectId,
  host,
  hosts,
  proxy,
  canEdit,
  canManageDomains,
  onClose,
  onChanged,
}: {
  projectId: string;
  /** The address to look at; null keeps the dialog closed. */
  host: HostView | null;
  /** The project's addresses as the section last read them: the certificates' state, live. */
  hosts: HostView[];
  proxy: ProxyInfo;
  canEdit: boolean;
  canManageDomains: boolean;
  onClose: () => void;
  onChanged: () => Promise<void>;
}) {
  return (
    <Modal.Backdrop
      isOpen={host !== null}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      shouldCloseOnInteractOutside={outsideToasts}
    >
      <Modal.Container>
        <Modal.Dialog className="max-w-2xl">
          <SheetGrip />
          {host && (
            <CheckBody
              projectId={projectId}
              host={host}
              hosts={hosts}
              proxy={proxy}
              canEdit={canEdit}
              canManageDomains={canManageDomains}
              onClose={onClose}
              onChanged={onChanged}
            />
          )}
        </Modal.Dialog>
      </Modal.Container>
    </Modal.Backdrop>
  );
}

/** Mounted only while open, so its polling and its one-shot requests start and end with the dialog. */
function CheckBody({
  projectId,
  host,
  hosts,
  proxy,
  canEdit,
  canManageDomains,
  onClose,
  onChanged,
}: {
  projectId: string;
  host: HostView;
  hosts: HostView[];
  proxy: ProxyInfo;
  canEdit: boolean;
  canManageDomains: boolean;
  onClose: () => void;
  onChanged: () => Promise<void>;
}) {
  const api = useNodeApi();
  const href = useServerHref();
  const poll = usePollInterval(12_000);
  const dnsPath = `/api/projects/${projectId}/hosts/${host.id}/dns`;

  // Stopped once every record is right: from then on only "Verifica ora" asks again.
  const [allSettled, setAllSettled] = useState(false);
  const { data, error, refresh, refreshing } = useResource<DnsData>(api(dnsPath), {
    intervalMs: allSettled ? 0 : poll,
    refreshUrl: api(`${dnsPath}?fresh=1`),
  });
  const names = useMemo(() => data?.names ?? [], [data]);
  const nowSettled = names.length > 0 && names.every(settled);
  // Derived from the answer while rendering it, as React has it for state that follows other state.
  if (nowSettled !== allSettled) setAllSettled(nowSettled);

  // The certificates as the section polls them: the address and its twins.
  const live =
    names.length > 0 ? names.map((name) => hosts.find((h) => h.id === name.hostId)).filter((h): h is HostView => !!h) : [host];
  const serves = PROXY_SERVES.has(proxy.state);
  // An instant address has no record to create and no certificate to wait for.
  const instant = isInstantHostname(host.hostname);

  const retry = useCallback(
    async (hostId: string, quiet = false) => {
      try {
        const res = await fetch(api(`/api/projects/${projectId}/hosts/${hostId}`), {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action: "retry" }),
        });
        const body = await res.json().catch(() => ({}));
        if (!res.ok) {
          if (!quiet) toast.error(body.error ?? MSG.saveFailed);
          return;
        }
        await onChanged();
      } catch {
        if (!quiet) toast.error(MSG.unreachable);
      }
    },
    [api, projectId, onChanged]
  );

  // Once per name and opening: a record that turned right asks for its certificate now.
  const asked = useRef(new Set<string>());
  useEffect(() => {
    if (!canEdit || proxy.state !== "ready" || instant) return;
    for (const name of names) {
      const current = hosts.find((h) => h.id === name.hostId);
      if (!current || current.status !== "pending" || !name.check.ready || asked.current.has(name.hostId)) continue;
      asked.current.add(name.hostId);
      void retry(name.hostId, true);
    }
  }, [names, hosts, canEdit, proxy.state, retry, instant]);

  const dnsTone: StepTone = !data ? "waiting" : names.every(settled) ? "done" : names.some((n) => n.check.state === "elsewhere") ? "problem" : "waiting";
  const certificates = live.map((h) => h.certificate ?? (h.status === "active" ? "active" : "missing"));
  const certTone: StepTone = certificates.every((state) => state === "active")
    ? "done"
    : certificates.some((state) => state === "error" || state === "expired")
      ? "problem"
      : "waiting";
  const linkedToCloudflare = names.some((name) => name.cloudflare);

  return (
    <>
      <Modal.Header>
        <Modal.Heading>{host.hostname}</Modal.Heading>
      </Modal.Header>
      <Modal.Body className="space-y-6">
        <Step title="Il server" tone={proxy.state === "ready" ? "done" : "problem"}>
          {proxy.state === "ready" ? (
            <p className="text-muted text-sm">nginx e certbot sono pronti a servire l&apos;indirizzo.</p>
          ) : canManageDomains ? (
            <ProxySetup proxy={proxy} onChanged={onChanged} />
          ) : (
            <Hint tone="warn" title="nginx su questo server non è pronto">
              {proxy.detail} Lo prepara chi ha il permesso Accesso all&apos;host, dalla pagina Domini: l&apos;indirizzo
              intanto resta in attesa.
            </Hint>
          )}
        </Step>

        <Step title="Il record DNS" tone={dnsTone}>
          {!data && error ? (
            <LoadError what="il controllo del DNS" error={error} onRetry={() => void refresh()} />
          ) : !data ? (
            <SkeletonBlock className="h-40" />
          ) : instant ? (
            <div className="space-y-3">
              <p className="text-muted text-sm">
                Nessun record da creare: sslip.io risponde da solo, con l&apos;IP che c&apos;è nel nome.
              </p>
              {names.map((name) => (
                <div key={name.hostId} className="space-y-1">
                  <p className="flex flex-wrap items-center gap-2">
                    <span className="text-foreground font-mono text-sm">{name.hostname}</span>
                    <DnsVerdictBadge name={name} />
                  </p>
                  <p className="text-muted text-xs">
                    {name.check.state === "elsewhere"
                      ? "Porta a un altro IP: l'indirizzo del server è cambiato. Rimuovi questo indirizzo e creane uno nuovo."
                      : name.check.summary}
                  </p>
                </div>
              ))}
              <Button size="sm" variant="secondary" onPress={() => void refresh()} isPending={refreshing}>
                <Icon icon="solar:refresh-linear" width={16} aria-hidden />
                Verifica ora
              </Button>
            </div>
          ) : (
            <>
              <p className="text-muted text-sm">
                Crea {names.length > 1 ? "questi record" : "questo record"} nel pannello di chi gestisce il DNS del dominio
                (il registrar o Cloudflare). Il pannello lo ricontrolla da solo finché non è giusto.
              </p>
              <div className="space-y-5">
                {names.map((name) => (
                  <DomainDnsRecords key={name.hostId} name={name} />
                ))}
              </div>
              <div className="flex flex-wrap items-center gap-3">
                <Button size="sm" variant="secondary" onPress={() => void refresh()} isPending={refreshing}>
                  <Icon icon="solar:refresh-linear" width={16} aria-hidden />
                  Verifica ora
                </Button>
                {!names.every(settled) && (
                  <span className="text-muted inline-flex items-center gap-1.5 text-xs">
                    <Spinner size="sm" />
                    Ricontrollo ogni pochi secondi
                  </span>
                )}
              </div>
              <Advanced title="Usi Cloudflare?" summary="nuvola arancione e certificati dal DNS">
                <p className="text-muted text-sm">
                  {linkedToCloudflare
                    ? "Il dominio è sul tuo account Cloudflare collegato: il certificato passa dal DNS di Cloudflare, quindi la nuvola arancione può restare accesa e la porta 80 può anche essere chiusa."
                    : "Con la nuvola arancione il nome risolve agli indirizzi di Cloudflare, e da qui non si vede dove porta. Due strade: metti la nuvola grigia finché il certificato non arriva, oppure collega Cloudflare con un token, e il certificato passerà dal suo DNS."}
                </p>
                <p className="text-muted text-sm">
                  In Cloudflare, SSL/TLS va su <strong className="text-foreground">Full (strict)</strong>: con Flexible
                  il rimando a HTTPS gira in tondo.
                </p>
                {canManageDomains && !linkedToCloudflare && (
                  <Link href={href("/domains")} className="text-accent text-sm hover:underline">
                    Collega Cloudflare dalla pagina Domini
                  </Link>
                )}
              </Advanced>
            </>
          )}
        </Step>

        <Step title="Il certificato HTTPS" tone={instant ? "waiting" : certTone}>
          {instant && (
            <Hint title="Gli indirizzi di prova restano in HTTP">
              sslip.io è condiviso da tutti quelli che lo usano, e Let&apos;s Encrypt conta i loro certificati su un unico
              limite: il lucchetto non sarebbe una promessa mantenibile. Per l&apos;HTTPS dai al progetto un tuo dominio.
            </Hint>
          )}
          <ul className="space-y-3">
            {live.map((current) => (
              <li key={current.id} className="space-y-1">
                <p className="flex flex-wrap items-center gap-2">
                  <span className="text-foreground font-mono text-sm">{current.hostname}</span>
                  <AddressBadge host={current} />
                </p>
                <p className={cn("text-xs", current.status === "error" ? "text-danger" : "text-muted")}>
                  {addressDetail(current, serves)}
                </p>
                {current.status === "error" && current.explanation && current.lastError && (
                  <Technical>
                    <p className="text-muted font-mono text-meta break-words">{current.lastError}</p>
                  </Technical>
                )}
                {current.certExpiresAt && current.status === "active" && (
                  <p className="text-muted text-xs">Valido fino al {formatWhen(current.certExpiresAt)}.</p>
                )}
                {canEdit &&
                  !instant &&
                  proxy.state === "ready" &&
                  (current.status === "error" || current.status === "pending" || current.certificate === "expiring" || current.certificate === "expired") && (
                    <Button size="sm" variant="ghost" onPress={() => void retry(current.id)}>
                      <Icon icon="solar:restart-linear" width={16} aria-hidden />
                      Richiedi il certificato adesso
                    </Button>
                  )}
              </li>
            ))}
          </ul>
        </Step>
      </Modal.Body>
      <Modal.Footer className="justify-end gap-2">
        <Button onPress={onClose}>Chiudi</Button>
      </Modal.Footer>
    </>
  );
}
