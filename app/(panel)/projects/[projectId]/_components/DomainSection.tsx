"use client";

import { useState } from "react";
import Link from "next/link";
import { Button, Input, TextField } from "@heroui/react";
import { FormDialog } from "@/components/ui/FormDialog";
import { Icon } from "@iconify/react";
import { toast } from "sonner";
import { Section } from "@/components/ui/Section";
import { Field } from "@/components/ui/Field";
import { SelectField } from "@/components/ui/SelectField";
import { CheckboxField } from "@/components/ui/CheckboxField";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { Code, FieldHint, Hint } from "@/components/ui/Hint";
import { MSG } from "@/lib/copy";
import { formatWhen } from "@/lib/format";
import { HOST_STATUS } from "@/lib/host-status";
import { TONE_DOT } from "@/lib/status";
import { cn } from "@/lib/utils";
import { useResource } from "@/lib/hooks/useResource";
import { usePollInterval } from "@/lib/hooks/usePollingInterval";
import { useNodeApi, useServerHref } from "@/lib/hooks/useNode";
import { HOST_PASSWORD_MIN, HOST_USER_RULE, SUBDOMAIN_RULE, hostAuthSchema, subdomainSchema } from "@/lib/validation";
import type { HostView } from "@/services/proxy";

/**
 * The names a project is served on.
 *
 * Saved on its own, like the access section, rather than through the sticky
 * bar: assigning a name rewrites nginx and asks Let's Encrypt for a
 * certificate, which is not something a form save should do in passing.
 */

interface HostsData {
  hosts: HostView[];
  domains: { id: string; name: string }[];
  proxy: { state: string; detail: string };
  hasPort: boolean;
  restricted: boolean;
  canManageDomains: boolean;
}

const SERVES = new Set(["ready", "no-certbot"]);

export function DomainSection({ projectId }: { projectId: string }) {
  const api = useNodeApi();
  const href = useServerHref();
  // Polled with the page: a certificate arrives seconds after the name is assigned.
  const { data, refresh } = useResource<HostsData>(api(`/api/projects/${projectId}/hosts`), {
    intervalMs: usePollInterval(5000),
  });

  const [subdomain, setSubdomain] = useState("");
  const [domainId, setDomainId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [removing, setRemoving] = useState<HostView | null>(null);
  const [locking, setLocking] = useState<HostView | null>(null);
  const [unlocking, setUnlocking] = useState<HostView | null>(null);
  const [authUser, setAuthUser] = useState("");
  const [authPassword, setAuthPassword] = useState("");
  const [authErrors, setAuthErrors] = useState<{ user?: string; password?: string }>({});

  const hosts = data?.hosts ?? [];
  const domains = data?.domains ?? [];
  const chosen = domains.find((d) => d.id === domainId) ?? (domains.length === 1 ? domains[0] : null);

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

  async function assign() {
    const parsed = subdomainSchema.safeParse(subdomain);
    if (!parsed.success) {
      setError(parsed.error.issues[0]?.message ?? SUBDOMAIN_RULE);
      return;
    }
    if (!chosen) return;
    setBusy("add");
    const body = await send(`/api/projects/${projectId}/hosts`, {
      method: "POST",
      body: JSON.stringify({ domainId: chosen.id, subdomain: parsed.data }),
    });
    setBusy(null);
    if (!body) return;
    toast.success(`${parsed.data}.${chosen.name} assegnato`);
    setSubdomain("");
    setError(null);
    await refresh();
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

  const proxyServes = data ? SERVES.has(data.proxy.state) : true;
  const domainsLink = data?.canManageDomains ? (
    <Link href={href("/domains")} className="text-accent hover:underline">
      Sistema › Domini
    </Link>
  ) : (
    "Sistema › Domini (serve il permesso Accesso all'host)"
  );

  return (
    <Section
      title="Dominio"
      summary={hosts.length > 0 ? hosts.map((h) => h.hostname).join(", ") : "Nessun sottodominio"}
    >
      {data && !proxyServes && (
        <Hint tone="warn" title="nginx su questo server non è pronto">
          {data.proxy.detail} Si sistema da {domainsLink}: i nomi assegnati intanto restano in attesa.
        </Hint>
      )}

      {hosts.length > 0 && (
        <ul className="divide-border divide-y">
          {hosts.map((host) => {
            const status = HOST_STATUS[host.status] ?? HOST_STATUS.pending;
            const url = `${host.status === "active" ? "https" : "http"}://${host.hostname}`;
            return (
              <li key={host.id} className="space-y-2 py-3 first:pt-0">
                <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
                  <div className="min-w-0 space-y-1">
                    <a href={url} target="_blank" rel="noreferrer" className="text-foreground inline-flex items-center gap-1 font-mono text-sm hover:underline">
                      {host.hostname}
                      <Icon icon="solar:square-arrow-right-up-linear" width={14} aria-hidden />
                    </a>
                    <p className="text-muted flex flex-wrap items-center gap-x-3 text-xs">
                      <span className="inline-flex items-center gap-1.5">
                        <span className={cn("size-1.5 rounded-full", TONE_DOT[status.tone])} aria-hidden />
                        {status.label}
                      </span>
                      {host.certExpiresAt && <span>scade {formatWhen(host.certExpiresAt)}, si rinnova da solo</span>}
                      {host.authUser && (
                        <span className="inline-flex items-center gap-1">
                          <Icon icon="solar:lock-keyhole-minimalistic-linear" width={12} aria-hidden />
                          password per <span className="font-mono">{host.authUser}</span>
                        </span>
                      )}
                    </p>
                  </div>
                  <div className="flex shrink-0 gap-1.5">
                    {(host.status === "error" || host.status === "pending") && data?.proxy.state === "ready" && (
                      <Button variant="ghost" size="sm" onPress={() => retry(host)} isPending={busy === host.id}>
                        <Icon icon="solar:restart-linear" width={16} aria-hidden />
                        Richiedi il certificato
                      </Button>
                    )}
                    <Button variant="ghost" size="sm" className="text-danger" onPress={() => setRemoving(host)}>
                      Rimuovi
                    </Button>
                  </div>
                </div>

                {host.applyError && <p className="text-danger text-xs">{host.applyError}</p>}
                {host.status === "error" && host.lastError && <p className="text-danger text-xs">{host.lastError}</p>}

                {data?.restricted && (
                  <CheckboxField
                    label="Raggiungibile da tutti tramite il nome"
                    description={
                      host.publicAccess
                        ? "La porta resta limitata, il nome è aperto: è il modo per esporre il progetto solo in HTTPS."
                        : "Il nome segue le stesse regole della porta, in Chi può collegarsi."
                    }
                    isSelected={host.publicAccess}
                    onChange={(next) => setPublic(host, next)}
                    isDisabled={busy === host.id}
                  />
                )}

                <div className="flex flex-wrap items-start gap-x-3 gap-y-1">
                  <CheckboxField
                    label="Chiedi una password"
                    description={
                      host.authUser
                        ? "Il browser chiede utente e password prima di mostrare il progetto. La porta non cambia."
                        : "Chi apre il nome deve inserire utente e password. La porta non cambia."
                    }
                    isSelected={host.authUser !== null}
                    onChange={(next) => (next ? openLock(host) : setUnlocking(host))}
                    isDisabled={busy === host.id}
                    className="flex-1"
                  />
                  {host.authUser && (
                    <Button variant="ghost" size="sm" onPress={() => openLock(host)}>
                      <Icon icon="solar:key-minimalistic-linear" width={16} aria-hidden />
                      Cambia password
                    </Button>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      )}

      {!data ? null : !data.hasPort ? (
        <FieldHint>Senza una porta non c&apos;è niente da servire: impostala in Build e avvio.</FieldHint>
      ) : domains.length === 0 ? (
        <Hint title="Nessun dominio su questo server">Aggiungine uno da {domainsLink}, poi torna qui.</Hint>
      ) : (
        <>
          <div className="flex flex-col gap-2 sm:flex-row sm:items-start">
            <Field label="Sottodominio" hint={SUBDOMAIN_RULE} error={error ?? undefined} className="sm:flex-1">
              <TextField
                value={subdomain}
                onChange={(value) => {
                  setSubdomain(value);
                  setError(null);
                }}
                aria-label="Sottodominio"
              >
                <Input placeholder="app" className="font-mono" />
              </TextField>
            </Field>
            <div className="sm:mt-7 sm:w-56">
              <SelectField
                ariaLabel="Dominio"
                value={chosen?.id ?? null}
                onChange={setDomainId}
                options={domains.map((d) => ({ value: d.id, label: `.${d.name}` }))}
              />
            </div>
            <Button
              size="sm"
              className="sm:mt-7"
              onPress={assign}
              isPending={busy === "add"}
              isDisabled={!subdomain.trim() || !chosen}
            >
              <Icon icon="solar:link-round-linear" width={16} aria-hidden />
              Assegna
            </Button>
          </div>
          {subdomain.trim() && chosen && (
            <FieldHint>
              Il progetto risponderà su <Code>https://{subdomain.trim().toLowerCase()}.{chosen.name}</Code>. Il
              certificato arriva da solo in qualche secondo, se il record DNS punta a questo server.
            </FieldHint>
          )}
        </>
      )}

      <ConfirmDialog
        isOpen={removing !== null}
        onOpenChange={(open) => !open && setRemoving(null)}
        title={`Rimuovere ${removing?.hostname ?? ""}?`}
        description="nginx smette di servire il nome e il suo certificato viene cancellato. Il progetto resta raggiungibile dalla sua porta."
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
            Finché il nome è servito in HTTP la password viaggia in chiaro: aspetta il certificato prima di usarla
            su una rete che non controlli.
          </Hint>
        )}
      </FormDialog>

      <ConfirmDialog
        isOpen={unlocking !== null}
        onOpenChange={(open) => !open && setUnlocking(null)}
        title={`Togliere la password da ${unlocking?.hostname ?? ""}?`}
        description="Il nome torna aperto a chi lo raggiunge, secondo le regole di accesso del progetto."
        confirmLabel="Togli la password"
        destructive
        onConfirm={unlock}
      />
    </Section>
  );
}
