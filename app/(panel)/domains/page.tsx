"use client";

import { useState } from "react";
import Link from "next/link";
import { Button, Input, TextField } from "@heroui/react";
import { Icon } from "@iconify/react";
import { toast } from "@/lib/toast";
import { MSG } from "@/lib/copy";
import { PageHeader } from "@/components/ui/PageHeader";
import { LoadError } from "@/components/ui/LoadError";
import { Panel, PanelHeader } from "@/components/ui/Panel";
import { EmptyState } from "@/components/ui/EmptyState";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { Field } from "@/components/ui/Field";
import { Badge } from "@/components/ui/Badge";
import { RowMenu } from "@/components/ui/ListRow";
import { KeyValue } from "@/components/ui/KeyValue";
import { Advanced, Technical } from "@/components/ui/Technical";
import { Code, FieldHint, Hint } from "@/components/ui/Hint";
import { SkeletonBlock } from "@/components/ui/Skeletons";
import { useResource } from "@/lib/hooks/useResource";
import { usePollInterval } from "@/lib/hooks/usePollingInterval";
import { useNodeApi, useServerHref } from "@/lib/hooks/useNode";
import { formatWhen } from "@/lib/format";
import { instantDomainAddress } from "@/lib/proxy-names";
import { DOMAIN_RULE, domainNameSchema } from "@/lib/validation";
import type { ProxyProbe } from "@/services/proxy/host";
import type { HostView } from "@/services/proxy";
import { AddressBadge, addressDetail } from "./_components/AddressStatus";
import { PROXY_SERVES, ProxySetup } from "./_components/ProxySetup";

/**
 * Domains this server's nginx answers for, and every address under them.
 *
 * The page leads with whether nginx can take a configuration at all, because
 * nothing below it works until it can — and, when it cannot, with exactly the
 * step to take, the same one a project's address dialog offers. Cloudflare and
 * the Let's Encrypt contact are optional, so they wait under "Avanzate".
 */

interface DomainsData {
  proxy: ProxyProbe;
  acmeEmail: string;
  addresses: string[];
  /** The IPv4 came from asking outside: the server is behind NAT. */
  addressesDetected?: boolean;
  cloudflare: {
    connected: boolean;
    zones: { id: string; name: string; status: string; domainId: string | null }[];
    error: string | null;
  };
  domains: { id: string; name: string; cloudflare: boolean; hostCount: number; created_at: string }[];
  hosts: HostView[];
  /** The panel's own HTTPS name; absent from a server on an older panel. */
  panelHost?: Pick<HostView, "hostname" | "status" | "certificate" | "certificateDaysLeft" | "applyError"> | null;
}

export default function DomainsPage() {
  const api = useNodeApi();
  const href = useServerHref();
  const poll = usePollInterval(10000);
  const { data, loading, error, refresh } = useResource<DomainsData>(api("/api/domains"), {
    intervalMs: poll,
    refreshUrl: api("/api/domains?fresh=1"),
  });

  const [name, setName] = useState("");
  const [nameError, setNameError] = useState<string | null>(null);
  const [email, setEmail] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [removing, setRemoving] = useState<DomainsData["domains"][number] | null>(null);
  const [cloudflareToken, setCloudflareToken] = useState("");
  const [disconnecting, setDisconnecting] = useState(false);

  // The field shows what is stored until the operator types; then it is theirs.
  const emailValue = email ?? data?.acmeEmail ?? "";

  async function send(path: string, init: RequestInit): Promise<Record<string, unknown> | null> {
    try {
      const res = await fetch(api(path), { headers: { "Content-Type": "application/json" }, ...init });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        toast.error(body.details?.[0]?.message ?? body.error ?? body.message ?? MSG.saveFailed);
        return null;
      }
      return body;
    } catch {
      toast.error(MSG.unreachable);
      return null;
    }
  }

  async function addDomain() {
    const parsed = domainNameSchema.safeParse(name);
    if (!parsed.success) {
      setNameError(parsed.error.issues[0]?.message ?? DOMAIN_RULE);
      return;
    }
    setBusy("add");
    const body = await send("/api/domains", { method: "POST", body: JSON.stringify({ name: parsed.data }) });
    setBusy(null);
    if (!body) return;
    toast.success(`${parsed.data} aggiunto`);
    setName("");
    setNameError(null);
    await refresh();
  }

  /** One of the Cloudflare account's zones, added as it is. */
  async function addZone(zone: string) {
    setBusy(`zone:${zone}`);
    const body = await send("/api/domains", { method: "POST", body: JSON.stringify({ name: zone }) });
    setBusy(null);
    if (!body) return;
    toast.success(`${zone} aggiunto`);
    await refresh();
  }

  async function connectCloudflare() {
    setBusy("cloudflare");
    const body = await send("/api/domains/cloudflare", {
      method: "PUT",
      body: JSON.stringify({ token: cloudflareToken }),
    });
    setBusy(null);
    if (!body) return;
    toast.success("Cloudflare collegato");
    setCloudflareToken("");
    await refresh();
  }

  async function disconnectCloudflare(): Promise<boolean> {
    const body = await send("/api/domains/cloudflare", { method: "DELETE" });
    if (!body) return false;
    toast.success("Cloudflare scollegato");
    await refresh();
    return true;
  }

  /** Write every block again and reload, after nginx was edited by hand. */
  async function reapply() {
    setBusy("apply");
    try {
      const res = await fetch(api("/api/domains/proxy"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "apply" }),
      });
      const body = await res.json().catch(() => ({}));
      if (body.ok) {
        const requested = Number(body.requested ?? 0);
        toast.success(
          requested > 0 ? `${body.message} I certificati in attesa arrivano appena il loro record DNS è pronto.` : String(body.message ?? "Fatto")
        );
      } else {
        toast.error(String(body.message ?? body.error ?? "Operazione non riuscita"));
      }
    } catch {
      toast.error(MSG.unreachable);
    } finally {
      setBusy(null);
    }
    await refresh();
  }

  async function saveEmail() {
    setBusy("email");
    const body = await send("/api/domains/settings", { method: "PUT", body: JSON.stringify({ acmeEmail: emailValue }) });
    setBusy(null);
    if (body) toast.success("Email salvata");
  }

  async function removeDomain(): Promise<boolean> {
    if (!removing) return true;
    const body = await send(`/api/domains/${removing.id}`, { method: "DELETE" });
    if (!body) return false;
    toast.success(`${removing.name} rimosso`);
    await refresh();
    return true;
  }

  if (!data && error) {
    return (
      <>
        <PageHeader title="Domini" />
        <LoadError what="i domini" error={error} onRetry={() => void refresh()} />
      </>
    );
  }

  if (loading && !data) {
    return (
      <>
        <PageHeader title="Domini" />
        <div className="space-y-4">
          <SkeletonBlock className="h-40" />
          <SkeletonBlock className="h-56" />
        </div>
      </>
    );
  }

  const proxy = data?.proxy;
  const cloudflare = data?.cloudflare;
  const ready = proxy ? PROXY_SERVES.has(proxy.state) : false;
  const target = data?.addresses.length ? data.addresses.join(" / ") : "l'IP pubblico di questo server";
  const byId = new Map((data?.hosts ?? []).map((host) => [host.id, host]));

  return (
    <>
      <PageHeader
        title="Domini"
        description="Un indirizzo HTTPS per ogni progetto, servito dal tuo nginx"
        actions={
          ready ? (
            <Button size="sm" variant="secondary" onPress={reapply} isPending={busy === "apply"}>
              <Icon icon="solar:refresh-linear" width={16} aria-hidden />
              Riapplica a nginx
            </Button>
          ) : undefined
        }
      />

      <div className="space-y-4">
        <Panel>
          <PanelHeader
            title={proxy?.state === "ready" ? "Il server è pronto" : ready ? "Il server serve gli indirizzi, ma senza HTTPS" : "Il server non è ancora pronto"}
            description={proxy?.detail}
          />
          {proxy && <ProxySetup className="mt-4" proxy={proxy} onChanged={refresh} />}
          {proxy && (proxy.nginx.version || proxy.certbot.version) && (
            <KeyValue
              className="mt-4 text-xs"
              items={[
                { label: "nginx", value: proxy.nginx.version ?? "non trovato", technical: true, mono: true },
                { label: "certbot", value: proxy.certbot.version ?? "non trovato", technical: true, mono: true },
              ]}
            />
          )}
        </Panel>

        <Panel>
          <PanelHeader title="Domini" description="Quelli di cui questo server serve i sottodomini" />
          <div className="mt-4 space-y-4">
            {(data?.domains.length ?? 0) === 0 ? (
              <EmptyState
                icon="solar:global-linear"
                title="Nessun dominio"
                description="Aggiungi un dominio che possiedi: ogni progetto potrà averne un indirizzo."
                className="py-6"
              />
            ) : (
              <ul className="divide-border divide-y">
                {data?.domains.map((domain) => (
                  <li key={domain.id} className="flex flex-col gap-2 py-3 sm:flex-row sm:items-center sm:justify-between">
                    <div className="min-w-0 space-y-1">
                      <p className="flex items-center gap-2">
                        <span className="text-foreground min-w-0 font-mono text-sm [overflow-wrap:anywhere]">{domain.name}</span>
                        {domain.cloudflare && <Badge icon="solar:cloud-linear">Cloudflare</Badge>}
                        {/* On a phone the delete is in the row's ⋯, as everywhere
                            else there, instead of a red button on a line of its own. */}
                        <span className="ml-auto sm:hidden">
                          <RowMenu
                            label={`Azioni per ${domain.name}`}
                            actions={[
                              {
                                id: "remove",
                                label: "Rimuovi…",
                                icon: "solar:trash-bin-trash-linear",
                                danger: true,
                                onAction: () => setRemoving(domain),
                              },
                            ]}
                          />
                        </span>
                      </p>
                      <p className="text-muted text-xs">
                        {instantDomainAddress(domain.name) ? (
                          // sslip.io answers for it: there is no record to create, and no HTTPS.
                          <>Indirizzi di prova: nessun record da creare, solo HTTP</>
                        ) : (
                          <>
                            Record DNS: <Code>*.{domain.name}</Code> → {target}
                          </>
                        )}
                        {" · "}
                        {domain.hostCount === 0
                          ? "nessun indirizzo"
                          : domain.hostCount === 1
                            ? "1 indirizzo"
                            : `${domain.hostCount} indirizzi`}
                      </p>
                    </div>
                    <Button variant="ghost" size="sm" className="text-danger shrink-0 max-sm:hidden" onPress={() => setRemoving(domain)}>
                      <Icon icon="solar:trash-bin-trash-linear" width={16} aria-hidden />
                      Rimuovi
                    </Button>
                  </li>
                ))}
              </ul>
            )}

            <div className="flex flex-col gap-2 sm:flex-row sm:items-start">
              <Field label="Nuovo dominio" hint={DOMAIN_RULE} error={nameError ?? undefined} className="flex-1">
                <TextField
                  value={name}
                  onChange={(value) => {
                    setName(value);
                    setNameError(null);
                  }}
                  aria-label="Nuovo dominio"
                >
                  <Input placeholder="esempio.it" className="font-mono" />
                </TextField>
              </Field>
              <Button size="sm" className="sm:mt-7" onPress={addDomain} isPending={busy === "add"} isDisabled={!name.trim()}>
                <Icon icon="solar:add-circle-linear" width={16} aria-hidden />
                Aggiungi
              </Button>
            </div>
            <FieldHint>
              Presso il tuo provider DNS crea un record <Code>A</Code> (e <Code>AAAA</Code> se il server ha IPv6) per{" "}
              <Code>*.dominio</Code> che punti a questo server: un solo record copre tutti i sottodomini. Il dominio
              intero vuole un record suo. Ogni progetto mostra il record esatto quando gli aggiungi un indirizzo, e lo
              verifica.
              {data?.addressesDetected && (
                <>
                  {" "}
                  L&apos;indirizzo qui sopra è quello che si vede da fuori: il server è dietro NAT, quindi il router deve
                  inoltrargli le porte 80 e 443.
                </>
              )}
            </FieldHint>
          </div>
        </Panel>

        <Panel padding="flush">
          <PanelHeader
            title="Indirizzi"
            description="Si aggiungono dalla pagina di ogni progetto, in Impostazioni › Indirizzi"
            className="px-4 pt-4"
          />
          {/* The panel's own name is one nginx serves too, and a name no project can take. */}
          {data?.panelHost && (
            <div className="border-border mt-2 flex flex-col gap-1 border-b px-4 py-3">
              <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                <a
                  href={`${data.panelHost.certificate === "active" || data.panelHost.certificate === "expiring" ? "https" : "http"}://${data.panelHost.hostname}`}
                  target="_blank"
                  rel="noreferrer"
                  className="text-foreground font-mono text-sm hover:underline"
                >
                  {data.panelHost.hostname}
                </a>
                <AddressBadge host={{ ...data.panelHost, explanation: null, lastError: null, dns: null }} />
                <Link href={href("/settings")} className="text-muted hover:text-foreground text-xs">
                  il pannello stesso
                </Link>
              </div>
              {data.panelHost.applyError && <p className="text-danger text-xs">{data.panelHost.applyError}</p>}
            </div>
          )}
          {(data?.hosts.length ?? 0) === 0 ? (
            <EmptyState
              icon="solar:link-round-linear"
              title="Nessun indirizzo"
              description="Apri un progetto, Impostazioni › Indirizzi."
              className="py-8"
            />
          ) : (
            <ul className="divide-border mt-2 divide-y">
              {data?.hosts.map((host) => {
                const twinOf = host.redirectTo ? byId.get(host.redirectTo) : undefined;
                return (
                  <li key={host.id} className="flex flex-col gap-1 px-4 py-3">
                    <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                      <a
                        href={`${host.status === "active" ? "https" : "http"}://${host.hostname}`}
                        target="_blank"
                        rel="noreferrer"
                        className="text-foreground font-mono text-sm hover:underline"
                      >
                        {host.hostname}
                      </a>
                      <AddressBadge host={host} />
                      {twinOf && <span className="text-muted text-xs">rimanda a {twinOf.hostname}</span>}
                      {host.authUser && (
                        <span className="text-muted inline-flex items-center gap-1 text-xs">
                          <Icon icon="solar:lock-keyhole-minimalistic-linear" width={12} aria-hidden />
                          con password
                        </span>
                      )}
                      <Link
                        href={href(`/projects/${host.projectId}/settings`)}
                        className="text-muted hover:text-foreground text-xs"
                      >
                        {host.projectName}
                      </Link>
                    </div>
                    {(host.applyError || host.status === "error" || host.certificate === "expiring" || host.certificate === "expired") && (
                      <p className={host.certificate === "expiring" ? "text-warning text-xs" : "text-danger text-xs"}>
                        {addressDetail(host, ready)}
                      </p>
                    )}
                    {host.status === "error" && host.explanation && host.lastError && (
                      <Technical>
                        <p className="text-muted font-mono text-meta break-words">{host.lastError}</p>
                      </Technical>
                    )}
                    {host.certExpiresAt && host.status === "active" && (
                      <Technical>
                        <p className="text-muted text-xs">Certificato valido fino al {formatWhen(host.certExpiresAt)}</p>
                      </Technical>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </Panel>

        {/* Folded away like the rest of Cloudflare, a token it refuses would stop certificates unseen. */}
        {cloudflare?.connected && cloudflare.error && (
          <Hint tone="warn" title="Cloudflare non accetta più il token">
            {cloudflare.error}
          </Hint>
        )}

        <Advanced summary="Cloudflare, email per Let's Encrypt" defaultExpanded={cloudflare?.connected ? true : undefined}>
          <section className="space-y-3">
            <div className="flex flex-wrap items-start justify-between gap-2">
              <div className="min-w-0">
                <h3 className="text-foreground text-sm font-medium">
                  {cloudflare?.connected ? "Cloudflare collegato" : "Cloudflare"}
                </h3>
                <p className="text-muted text-xs">
                  {cloudflare?.connected
                    ? "I domini che il token vede: i loro certificati passano dal DNS, anche con il proxy attivo"
                    : "Facoltativo: con un API token i certificati passano dal DNS di Cloudflare, anche con la nuvola arancione e la porta 80 chiusa"}
                </p>
              </div>
              {cloudflare?.connected && (
                <Button variant="ghost" size="sm" className="text-danger" onPress={() => setDisconnecting(true)}>
                  Scollega
                </Button>
              )}
            </div>

            {cloudflare?.connected ? (
              <>
                {cloudflare.error ? (
                  <p className="text-danger text-sm">{cloudflare.error}</p>
                ) : cloudflare.zones.length === 0 ? (
                  <p className="text-muted text-sm">
                    Il token non vede nessun dominio: gli serve il permesso Zone · Zone · Read.
                  </p>
                ) : (
                  <ul className="divide-border divide-y">
                    {cloudflare.zones.map((zone) => (
                      <li key={zone.id} className="flex items-center justify-between gap-3 py-2.5">
                        <div className="min-w-0">
                          <p className="text-foreground truncate font-mono text-sm">{zone.name}</p>
                          {zone.status !== "active" && (
                            <p className="text-muted text-xs">
                              In attesa su Cloudflare: finché i nameserver non puntano lì, i certificati passano dalla
                              porta 80
                            </p>
                          )}
                        </div>
                        {zone.domainId ? (
                          <span className="text-muted shrink-0 text-xs">Aggiunto</span>
                        ) : (
                          <Button
                            size="sm"
                            variant="secondary"
                            className="shrink-0"
                            onPress={() => addZone(zone.name)}
                            isPending={busy === `zone:${zone.name}`}
                          >
                            <Icon icon="solar:add-circle-linear" width={16} aria-hidden />
                            Aggiungi
                          </Button>
                        )}
                      </li>
                    ))}
                  </ul>
                )}
                <Hint title="Con la nuvola arancione">
                  In Cloudflare metti SSL/TLS su <strong className="text-foreground">Full (strict)</strong>: con Flexible
                  il redirect a HTTPS gira in tondo. nginx prende l&apos;indirizzo del visitatore da{" "}
                  <Code>CF-Connecting-IP</Code>, e solo dalle connessioni che arrivano da Cloudflare, così le regole di
                  accesso dei progetti continuano a valere.
                </Hint>
              </>
            ) : (
              <div>
                <div className="flex flex-col gap-2 sm:flex-row sm:items-end">
                  <TextField
                    type="password"
                    value={cloudflareToken}
                    onChange={setCloudflareToken}
                    aria-label="API token di Cloudflare"
                    className="flex-1"
                  >
                    <Input placeholder="API token" className="font-mono text-sm" />
                  </TextField>
                  <Button
                    size="sm"
                    onPress={connectCloudflare}
                    isPending={busy === "cloudflare"}
                    isDisabled={!cloudflareToken.trim()}
                  >
                    <Icon icon="solar:link-round-linear" width={16} aria-hidden />
                    Collega
                  </Button>
                </div>
                <FieldHint>
                  Su Cloudflare: My Profile › API Tokens › Create Token, con i permessi{" "}
                  <strong className="text-foreground">Zone · Zone · Read</strong> e{" "}
                  <strong className="text-foreground">Zone · DNS · Edit</strong>. Viene cifrato nel pannello e passato a
                  certbot solo per pubblicare il record della verifica.
                </FieldHint>
              </div>
            )}
          </section>

          <section className="border-separator space-y-3 border-t pt-4">
            <div>
              <h3 className="text-foreground text-sm font-medium">Email per Let&apos;s Encrypt</h3>
              <p className="text-muted text-xs">
                Facoltativa: è il contatto dell&apos;account. I rinnovi li fa il pannello, e le scadenze sono qui sopra
              </p>
            </div>
            <div className="flex flex-col gap-2 sm:flex-row sm:items-end">
              <TextField value={emailValue} onChange={setEmail} aria-label="Email per Let's Encrypt" className="flex-1">
                <Input type="email" placeholder="tu@esempio.it" />
              </TextField>
              <Button size="sm" variant="secondary" onPress={saveEmail} isPending={busy === "email"}>
                <Icon icon="solar:diskette-linear" width={16} aria-hidden />
                Salva
              </Button>
            </div>
          </section>
        </Advanced>
      </div>

      <ConfirmDialog
        isOpen={removing !== null}
        onOpenChange={(open) => !open && setRemoving(null)}
        title={`Rimuovere ${removing?.name ?? ""}?`}
        description="Il dominio sparisce dalla lista. Si può togliere solo quando nessun progetto lo usa."
        confirmLabel="Rimuovi"
        destructive
        onConfirm={removeDomain}
      />

      <ConfirmDialog
        isOpen={disconnecting}
        onOpenChange={(open) => !open && setDisconnecting(false)}
        title="Scollegare Cloudflare?"
        description="Il token viene cancellato dal pannello. I certificati già emessi restano, ma ai rinnovi i loro nomi tornano alla verifica sulla porta 80, che dietro il proxy di Cloudflare non passa."
        confirmLabel="Scollega"
        destructive
        onConfirm={disconnectCloudflare}
      />
    </>
  );
}
