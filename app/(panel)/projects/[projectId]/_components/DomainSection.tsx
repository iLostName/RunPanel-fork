"use client";

import { useRef, useState } from "react";
import Link from "next/link";
import { Button, Input, TextField } from "@heroui/react";
import { Icon } from "@iconify/react";
import { FormDialog } from "@/components/ui/FormDialog";
import { toast } from "@/lib/toast";
import { Section } from "@/components/ui/Section";
import { Field } from "@/components/ui/Field";
import { CheckboxField } from "@/components/ui/CheckboxField";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { Badge } from "@/components/ui/Badge";
import { ListRow, RowMenu, type RowAction } from "@/components/ui/ListRow";
import { Technical } from "@/components/ui/Technical";
import { FieldHint, Hint } from "@/components/ui/Hint";
import { useExpertMode } from "@/components/Providers";
import { MSG } from "@/lib/copy";
import { formatWhen } from "@/lib/format";
import { useResource } from "@/lib/hooks/useResource";
import { usePollInterval } from "@/lib/hooks/usePollingInterval";
import { useNodeApi, useServerHref } from "@/lib/hooks/useNode";
import { wwwTwin } from "@/lib/proxy-names";
import { HOST_PASSWORD_MIN, HOST_USER_RULE, hostAuthSchema } from "@/lib/validation";
import { AddressBadge, addressDetail, needsAttention } from "@/app/(panel)/domains/_components/AddressStatus";
import { PROXY_SERVES, ProxySetup, type ProxyInfo } from "@/app/(panel)/domains/_components/ProxySetup";
import type { HostView } from "@/services/proxy";
import { DomainAddDialog } from "./DomainAddDialog";
import { DomainCheckDialog } from "./DomainCheckDialog";

/**
 * The addresses a project is served on, and everything it takes to get one:
 * the domain, the DNS record, nginx, the certificate — from here, without a
 * trip to the Domains page unless the reader wants one.
 *
 * Saved on its own, like the access section, rather than through the sticky
 * bar: adding an address rewrites nginx and asks Let's Encrypt for a
 * certificate, which is not something a form save should do in passing.
 */

interface HostsData {
  hosts: HostView[];
  domains: { id: string; name: string; cloudflare?: boolean }[];
  proxy: ProxyInfo;
  hasPort: boolean;
  restricted: boolean;
  /** Absent from a server on an older panel, which let the routes decide. */
  canEdit?: boolean;
  canManageDomains: boolean;
  panelHostname?: string | null;
}

export function DomainSection({ projectId }: { projectId: string }) {
  const api = useNodeApi();
  const href = useServerHref();
  const { expert } = useExpertMode();
  // Polled with the page: a certificate arrives seconds after the DNS record is right.
  const { data, refresh } = useResource<HostsData>(api(`/api/projects/${projectId}/hosts`), {
    intervalMs: usePollInterval(5000),
  });

  const [adding, setAdding] = useState(false);
  // A fresh form at every opening, without resetting it field by field.
  const [addKey, setAddKey] = useState(0);
  const [checking, setChecking] = useState<HostView | null>(null);
  const justAdded = useRef<HostView | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [removing, setRemoving] = useState<HostView | null>(null);
  const [locking, setLocking] = useState<HostView | null>(null);
  const [unlocking, setUnlocking] = useState<HostView | null>(null);
  const [authUser, setAuthUser] = useState("");
  const [authPassword, setAuthPassword] = useState("");
  const [authErrors, setAuthErrors] = useState<{ user?: string; password?: string }>({});

  const hosts = data?.hosts ?? [];
  const canEdit = data?.canEdit ?? true;
  const canAdd = !!data && canEdit && data.canManageDomains && data.hasPort;
  const proxyServes = data ? PROXY_SERVES.has(data.proxy.state) : true;
  const byId = new Map(hosts.map((host) => [host.id, host]));
  // Each name, then the twin that redirects to it.
  const ordered = hosts
    .filter((host) => !host.redirectTo || !byId.has(host.redirectTo))
    .flatMap((host) => [host, ...hosts.filter((twin) => twin.redirectTo === host.id)]);
  const twinsOf = (host: HostView) => hosts.filter((twin) => twin.redirectTo === host.id);

  async function send(path: string, init: RequestInit): Promise<Record<string, unknown> | null> {
    try {
      const res = await fetch(api(path), { headers: { "Content-Type": "application/json" }, ...init });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        toast.error(body.details?.[0]?.message ?? body.error ?? MSG.saveFailed);
        return null;
      }
      return body;
    } catch {
      toast.error(MSG.unreachable);
      return null;
    }
  }

  function openAdd() {
    setAddKey((key) => key + 1);
    setAdding(true);
  }

  async function retry(host: HostView) {
    setBusy(host.id);
    const body = await send(`/api/projects/${projectId}/hosts/${host.id}`, {
      method: "POST",
      body: JSON.stringify({ action: "retry" }),
    });
    setBusy(null);
    if (body) await refresh();
  }

  async function setPublic(host: HostView, publicAccess: boolean) {
    setBusy(host.id);
    const body = await send(`/api/projects/${projectId}/hosts/${host.id}`, {
      method: "PATCH",
      body: JSON.stringify({ publicAccess }),
    });
    setBusy(null);
    if (body) await refresh();
  }

  async function addTwin(host: HostView, twinName: string) {
    setBusy(host.id);
    const body = await send(`/api/projects/${projectId}/hosts/${host.id}`, {
      method: "PATCH",
      body: JSON.stringify({ www: true }),
    });
    setBusy(null);
    if (!body) return;
    toast.success(`${twinName} ora rimanda a ${host.hostname}`);
    await refresh();
  }

  function openLock(host: HostView) {
    setLocking(host);
    setAuthUser(host.authUser ?? "admin");
    setAuthPassword("");
    setAuthErrors({});
  }

  async function lock(): Promise<boolean> {
    if (!locking) return true;
    const parsed = hostAuthSchema.safeParse({ user: authUser, password: authPassword });
    if (!parsed.success) {
      const errors: { user?: string; password?: string } = {};
      for (const issue of parsed.error.issues) {
        const field = issue.path[0] === "user" ? "user" : "password";
        errors[field] ??= issue.message;
      }
      setAuthErrors(errors);
      return false;
    }
    const body = await send(`/api/projects/${projectId}/hosts/${locking.id}`, {
      method: "PATCH",
      body: JSON.stringify({ auth: parsed.data }),
    });
    if (!body) return false;
    toast.success(`${locking.hostname} ora chiede la password`);
    await refresh();
    return true;
  }

  async function unlock(): Promise<boolean> {
    if (!unlocking) return true;
    const body = await send(`/api/projects/${projectId}/hosts/${unlocking.id}`, {
      method: "PATCH",
      body: JSON.stringify({ auth: null }),
    });
    if (!body) return false;
    toast.success(`${unlocking.hostname} non chiede più la password`);
    await refresh();
    return true;
  }

  async function remove(): Promise<boolean> {
    if (!removing) return true;
    const body = await send(`/api/projects/${projectId}/hosts/${removing.id}`, { method: "DELETE" });
    if (!body) return false;
    toast.success(`${removing.hostname} rimosso`);
    await refresh();
    return true;
  }

  const domainsLink = data?.canManageDomains ? (
    <Link href={href("/domains")} className="text-accent hover:underline">
      Domini
    </Link>
  ) : (
    "Domini (serve il permesso Accesso all'host)"
  );

  const names = ordered.filter((host) => !host.redirectTo);
  const problems = hosts.filter(
    (host) => host.applyError !== null || host.certificate === "error" || host.certificate === "expired"
  ).length;
  const summary =
    hosts.length === 0
      ? "Nessun indirizzo"
      : `${names.map((host) => host.hostname).join(", ")}${
          problems > 0
            ? ` · ${problems === 1 ? "1 da sistemare" : `${problems} da sistemare`}`
            : hosts.some(needsAttention)
              ? " · certificato in attesa"
              : ""
        }`;

  function rowActions(host: HostView): RowAction[] {
    const actions: RowAction[] = [
      { id: "check", label: "Controlla DNS e HTTPS", icon: "solar:routing-2-linear", onAction: () => setChecking(host) },
    ];
    if (!canEdit) return actions;
    if (data?.proxy.state === "ready" && host.certificate !== "issuing") {
      actions.push({
        id: "retry",
        label: "Richiedi il certificato",
        icon: "solar:restart-linear",
        disabled: busy === host.id,
        onAction: () => void retry(host),
      });
    }
    const domain = data?.domains.find((d) => d.id === host.domainId);
    const twinName = !host.redirectTo && domain ? wwwTwin(host.subdomain, domain.name)?.hostname : undefined;
    if (twinName && data?.canManageDomains && twinsOf(host).length === 0) {
      actions.push({
        id: "twin",
        label: `Aggiungi ${twinName}, che rimanda qui`,
        icon: "solar:forward-linear",
        disabled: busy === host.id,
        onAction: () => void addTwin(host, twinName),
      });
    }
    if (host.authUser) {
      actions.push({ id: "password", label: "Cambia password", icon: "solar:key-minimalistic-linear", onAction: () => openLock(host) });
    }
    actions.push({ id: "remove", label: "Rimuovi", icon: "solar:trash-bin-trash-linear", danger: true, onAction: () => setRemoving(host) });
    return actions;
  }

  const removingTwins = removing ? twinsOf(removing) : [];

  return (
    <Section
      title="Indirizzi"
      summary={summary}
      actions={
        canAdd ? (
          <Button size="sm" variant="secondary" onPress={openAdd}>
            <Icon icon="solar:add-circle-linear" width={16} aria-hidden />
            Aggiungi
          </Button>
        ) : undefined
      }
    >
      {data && !proxyServes && (
        <div className="space-y-3">
          <Hint tone="warn" title="nginx su questo server non è pronto">
            {data.proxy.detail}{" "}
            {data.canManageDomains
              ? "Gli indirizzi intanto restano in attesa."
              : <>Lo prepara chi ha il permesso Accesso all&apos;host, dalla pagina {domainsLink}: gli indirizzi intanto restano in attesa.</>}
          </Hint>
          {data.canManageDomains && <ProxySetup proxy={data.proxy} onChanged={refresh} />}
        </div>
      )}
      {data && data.proxy.state === "no-certbot" && data.canManageDomains && <ProxySetup proxy={data.proxy} onChanged={refresh} />}

      {ordered.length > 0 && (
        <ul className="divide-border -my-1 divide-y">
          {ordered.map((host) => {
            const twin = host.redirectTo ? byId.get(host.redirectTo) : undefined;
            const url = `${host.status === "active" ? "https" : "http"}://${host.hostname}`;
            const failed = host.status === "error" || host.applyError !== null;
            return (
              <li key={host.id} className={twin ? "pl-6" : undefined}>
                <ListRow
                  className="px-0"
                  title={
                    <a href={url} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 font-mono hover:underline">
                      {twin && <Icon icon="solar:forward-linear" width={14} className="text-muted" aria-hidden />}
                      {host.hostname}
                      <Icon icon="solar:square-arrow-right-up-linear" width={14} aria-hidden />
                    </a>
                  }
                  status={<AddressBadge host={host} />}
                  badges={
                    host.authUser ? (
                      <Badge icon="solar:lock-keyhole-minimalistic-linear">password per {host.authUser}</Badge>
                    ) : undefined
                  }
                  description={twin ? `Rimanda a ${twin.hostname}` : failed ? undefined : addressDetail(host, proxyServes)}
                  meta={
                    expert && host.certExpiresAt && (host.certificate === "active" || host.certificate === "expiring")
                      ? `Certificato valido fino al ${formatWhen(host.certExpiresAt)}`
                      : undefined
                  }
                  action={
                    needsAttention(host) ? (
                      <Button size="sm" variant="secondary" onPress={() => setChecking(host)}>
                        Verifica
                      </Button>
                    ) : undefined
                  }
                  menu={<RowMenu label={`Azioni per ${host.hostname}`} actions={rowActions(host)} />}
                />

                {failed && (
                  <div className="-mt-1 space-y-1 pb-3">
                    <p className="text-danger text-xs">{addressDetail(host, proxyServes)}</p>
                    {host.status === "error" && host.explanation && host.lastError && (
                      <Technical>
                        <p className="text-muted font-mono text-meta break-words">{host.lastError}</p>
                      </Technical>
                    )}
                  </div>
                )}

                {!twin && canEdit && (
                  <div className="space-y-1 pb-3">
                    {data?.restricted && (
                      <CheckboxField
                        label="Raggiungibile da tutti tramite l'indirizzo"
                        description={
                          host.publicAccess
                            ? "La porta resta limitata, l'indirizzo è aperto: è il modo per esporre il progetto solo in HTTPS."
                            : "L'indirizzo segue le stesse regole della porta, quelle della sezione sulla rete."
                        }
                        isSelected={host.publicAccess}
                        onChange={(next) => setPublic(host, next)}
                        isDisabled={busy === host.id}
                      />
                    )}
                    <CheckboxField
                      label="Chiedi una password"
                      description={
                        host.authUser
                          ? "Il browser chiede utente e password prima di mostrare il progetto. La porta non cambia."
                          : "Chi apre l'indirizzo deve inserire utente e password. La porta non cambia."
                      }
                      isSelected={host.authUser !== null}
                      onChange={(next) => (next ? openLock(host) : setUnlocking(host))}
                      isDisabled={busy === host.id}
                    />
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}

      {!data ? null : !data.hasPort ? (
        <FieldHint>
          Per avere un indirizzo il progetto deve avere una porta: impostala nel campo Porta, in Applicazione, e salva.
        </FieldHint>
      ) : !canEdit ? null : !data.canManageDomains ? (
        <FieldHint>Un nuovo indirizzo lo aggiunge chi ha il permesso Accesso all&apos;host.</FieldHint>
      ) : hosts.length === 0 ? (
        <div className="flex flex-col items-start gap-2">
          <p className="text-muted text-sm">
            Con un indirizzo il progetto si apre da <span className="font-mono">app.tuodominio.it</span>, in HTTPS, invece
            che da IP e porta.
          </p>
          <Button size="sm" onPress={openAdd}>
            <Icon icon="solar:add-circle-linear" width={16} aria-hidden />
            Aggiungi un indirizzo
          </Button>
        </div>
      ) : null}

      {data && (
        <DomainAddDialog
          key={addKey}
          projectId={projectId}
          isOpen={adding}
          onOpenChange={(open) => {
            setAdding(open);
            // What comes next for the new address — its DNS record — in the same
            // commit that closes the form, so the two dialogs never overlap.
            if (!open && justAdded.current) {
              setChecking(justAdded.current);
              justAdded.current = null;
            }
          }}
          data={data}
          onChanged={refresh}
          onAdded={(host) => {
            justAdded.current = host;
            void refresh();
          }}
        />
      )}

      {data && (
        <DomainCheckDialog
          projectId={projectId}
          host={checking ? (byId.get(checking.id) ?? checking) : null}
          hosts={hosts}
          proxy={data.proxy}
          canEdit={canEdit}
          canManageDomains={data.canManageDomains}
          onClose={() => setChecking(null)}
          onChanged={refresh}
        />
      )}

      <ConfirmDialog
        isOpen={removing !== null}
        onOpenChange={(open) => !open && setRemoving(null)}
        title={`Rimuovere ${removing?.hostname ?? ""}?`}
        description={
          removingTwins.length > 0
            ? `nginx smette di servirlo, insieme a ${removingTwins.map((t) => t.hostname).join(", ")} che rimanda qui, e i loro certificati vengono cancellati. Il progetto resta raggiungibile dalla sua porta.`
            : "nginx smette di servire l'indirizzo e il suo certificato viene cancellato. Il progetto resta raggiungibile dalla sua porta."
        }
        confirmLabel="Rimuovi"
        destructive
        onConfirm={remove}
      />

      <FormDialog
        isOpen={locking !== null}
        onOpenChange={(open) => !open && setLocking(null)}
        title={locking?.authUser ? `Cambia la password di ${locking.hostname}` : `Password per ${locking?.hostname ?? ""}`}
        description="nginx la chiede prima di passare qualsiasi richiesta al progetto. Il pannello ne tiene solo l'hash: se la dimentichi, ne imposti una nuova."
        submitLabel={locking?.authUser ? "Cambia" : "Proteggi"}
        isSubmitDisabled={!authUser.trim() || !authPassword}
        onSubmit={lock}
      >
        <Field label="Utente" hint={HOST_USER_RULE} error={authErrors.user}>
          <TextField
            value={authUser}
            onChange={(value) => {
              setAuthUser(value);
              setAuthErrors((errors) => ({ ...errors, user: undefined }));
            }}
            aria-label="Utente"
          >
            <Input className="font-mono" autoComplete="off" />
          </TextField>
        </Field>
        <Field label="Password" hint={`Almeno ${HOST_PASSWORD_MIN} caratteri`} error={authErrors.password}>
          <TextField
            type="password"
            value={authPassword}
            onChange={(value) => {
              setAuthPassword(value);
              setAuthErrors((errors) => ({ ...errors, password: undefined }));
            }}
            aria-label="Password"
          >
            <Input autoComplete="new-password" />
          </TextField>
        </Field>
        {locking && locking.status !== "active" && (
          <Hint tone="warn" title="Ancora senza certificato">
            Finché l&apos;indirizzo è servito in HTTP la password viaggia in chiaro: aspetta il certificato prima di
            usarla su una rete che non controlli.
          </Hint>
        )}
      </FormDialog>

      <ConfirmDialog
        isOpen={unlocking !== null}
        onOpenChange={(open) => !open && setUnlocking(null)}
        title={`Togliere la password da ${unlocking?.hostname ?? ""}?`}
        description="L'indirizzo torna aperto a chi lo raggiunge, secondo le regole di accesso del progetto."
        confirmLabel="Togli la password"
        destructive
        onConfirm={unlock}
      />
    </Section>
  );
}
