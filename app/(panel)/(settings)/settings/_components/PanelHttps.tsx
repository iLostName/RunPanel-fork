"use client";

import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import Link from "next/link";
import { Button, Input, Spinner, TextField } from "@heroui/react";
import { Icon } from "@iconify/react";
import { Section } from "@/components/ui/Section";
import { Field } from "@/components/ui/Field";
import { SelectField } from "@/components/ui/SelectField";
import { Segmented } from "@/components/ui/Segmented";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { KeyValue } from "@/components/ui/KeyValue";
import { LoadError } from "@/components/ui/LoadError";
import { SkeletonBlock } from "@/components/ui/Skeletons";
import { Technical } from "@/components/ui/Technical";
import { Code, FieldHint, Hint } from "@/components/ui/Hint";
import { toast } from "@/lib/toast";
import { MSG } from "@/lib/copy";
import { cn } from "@/lib/utils";
import { formatWhen } from "@/lib/format";
import { useResource } from "@/lib/hooks/useResource";
import { usePollInterval } from "@/lib/hooks/usePollingInterval";
import { useNode, useNodeApi, useServerHref } from "@/lib/hooks/useNode";
import { hostnameFor, isInstantHostname, panelHttpsUrl } from "@/lib/proxy-names";
import { DOMAIN_RULE, domainNameSchema, subdomainSchema } from "@/lib/validation";
import { AddressBadge, addressDetail } from "@/app/(panel)/domains/_components/AddressStatus";
import { PROXY_SERVES, ProxySetup } from "@/app/(panel)/domains/_components/ProxySetup";
import { DomainDnsRecords, type DnsName } from "@/app/(panel)/projects/[projectId]/_components/DomainDnsRecords";
import type { PanelHttpsState, PanelVerdict } from "@/services/proxy/panel";

/**
 * "Metti il pannello su HTTPS": the panel on a name of the owner's, with the
 * padlock, through the nginx and certbot the projects' names already use.
 *
 * In the order it happens, each step shown only once the one before it is
 * done: nginx ready, a name, its DNS record, its certificate, a proof that the
 * name answers as this panel — from the server and from this browser — and
 * only then the offer to make it the panel's public address. The address in
 * use now keeps working throughout, and "Disattiva" undoes all of it.
 */

type Data = PanelHttpsState;

interface DnsData {
  proxy: { state: string; detail: string };
  names: DnsName[];
}

const noSubscription = () => () => {};

/** Where this browser has the panel open. The server cannot know; empty on the server so the first render matches. */
function useHere(): string {
  return useSyncExternalStore(
    noSubscription,
    () => window.location.origin,
    () => ""
  );
}

function urlOf(raw: string | null | undefined): URL | null {
  return raw && URL.canParse(raw) ? new URL(raw) : null;
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

async function send(url: string, init: RequestInit): Promise<Record<string, unknown> | null> {
  try {
    const res = await fetch(url, { headers: { "Content-Type": "application/json" }, ...init });
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

function summaryOf(data: Data): string {
  const host = data.panelHost;
  if (!host) {
    return data.proxy.state === "ready"
      ? "Il lucchetto sul pannello, con un tuo dominio"
      : "Il lucchetto sul pannello: prima va preparato nginx";
  }
  const state = host.applyError
    ? "non servito"
    : data.adopted && host.certificate === "active"
      ? "attivo, è l'indirizzo pubblico"
      : host.certificate === "active"
        ? "HTTPS attivo, da provare"
        : host.certificate === "issuing"
          ? "certificato in arrivo"
          : host.certificate === "expiring"
            ? "il certificato scade presto"
            : host.certificate === "error" || host.certificate === "expired"
              ? "da sistemare"
              : host.dns && !host.dns.ready
                ? "in attesa del DNS"
                : "in attesa del certificato";
  return `${host.hostname} · ${state}`;
}

export function PanelHttpsSection({ onPublicUrlChange }: { onPublicUrlChange: (url: string) => void }) {
  const api = useNodeApi();
  const steady = usePollInterval(60_000);
  const busy = usePollInterval(8_000);
  const [settledPoll, setSettledPoll] = useState(true);
  const { data, error, refresh } = useResource<Data>(api("/api/panel-https"), {
    intervalMs: settledPoll ? steady : busy,
    refreshUrl: api("/api/panel-https?fresh=1"),
  });
  // Quick while something is on its way, slow once it is all in place. Derived while rendering.
  const host = data?.panelHost ?? null;
  const nowSettled = !host || (host.certificate === "active" && data?.adopted === true) || host.certificate === "error";
  if (data && nowSettled !== settledPoll) setSettledPoll(nowSettled);

  if (!data) {
    if (!error) return <SkeletonBlock className="h-14" />;
    return (
      <Section title="Il pannello su HTTPS" summary="Non disponibile" defaultExpanded>
        {/* A server of the cluster on an older version has no such endpoint. */}
        {error.includes("404") ? (
          <Hint>Questo server ha una versione del pannello che non lo prevede ancora: aggiornalo da Impostazioni › Aggiornamenti.</Hint>
        ) : (
          <LoadError what="l'indirizzo HTTPS del pannello" error={error} onRetry={() => void refresh()} />
        )}
      </Section>
    );
  }

  const attention = host !== null && !(host.certificate === "active" && data.adopted);
  return (
    <Section
      title={host ? "Il pannello su HTTPS" : "Metti il pannello su HTTPS"}
      summary={summaryOf(data)}
      defaultExpanded={attention}
    >
      {host ? (
        <Progress data={data} onChanged={refresh} onPublicUrlChange={onPublicUrlChange} />
      ) : data.proxy.state !== "ready" ? (
        <NotReady data={data} onChanged={refresh} />
      ) : (
        <ChooseName data={data} onChanged={refresh} />
      )}
    </Section>
  );
}

/** nginx or certbot still missing: the one step to take, the same as on the Domains page. */
function NotReady({ data, onChanged }: { data: Data; onChanged: () => Promise<void> }) {
  // In a container, off Linux or on a test instance there is nothing to prepare: the hint below says why.
  const impossible = data.proxy.state === "disabled" || data.proxy.state === "unsupported";
  return (
    <div className="space-y-3">
      <p className="text-muted text-sm">
        Per il lucchetto il pannello usa nginx e certbot, gli stessi degli indirizzi dei progetti.
        {impossible
          ? ""
          : PROXY_SERVES.has(data.proxy.state)
            ? " Manca ancora certbot, che chiede i certificati."
            : " Prima vanno preparati, una volta sola."}
      </p>
      <ProxySetup proxy={data.proxy} onChanged={onChanged} />
    </div>
  );
}

type Mode = "domain" | "typed";

const LABEL_ERROR = "Una sola parola, con minuscole, numeri e trattini (non all'inizio né alla fine)";

/** The name: a word under one of the panel's domains, or a whole name typed out. */
function ChooseName({ data, onChanged }: { data: Data; onChanged: () => Promise<void> }) {
  const api = useNodeApi();
  const href = useServerHref();
  const [mode, setMode] = useState<Mode>(data.domains.length > 0 ? "domain" : "typed");
  const [domainId, setDomainId] = useState<string | null>(null);
  const [label, setLabel] = useState("pannello");
  const [typed, setTyped] = useState("");
  const [serverError, setServerError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const chosen = data.domains.find((domain) => domain.id === domainId) ?? data.domains[0] ?? null;
  const byDomain = mode === "domain" && chosen !== null;

  let hostname: string | null = null;
  let problem: string | null = null;
  if (byDomain) {
    const parsed = subdomainSchema.safeParse(label.trim().toLowerCase());
    if (!parsed.success) problem = label.trim() === "" ? null : LABEL_ERROR;
    else hostname = hostnameFor(parsed.data, chosen.name);
  } else if (typed.trim() !== "") {
    const parsed = domainNameSchema.safeParse(typed);
    if (!parsed.success) problem = parsed.error.issues[0]?.message ?? DOMAIN_RULE;
    else hostname = parsed.data;
  }
  if (hostname && isInstantHostname(hostname)) {
    problem = "Per il pannello serve un tuo dominio: gli indirizzi di prova come sslip.io restano senza HTTPS.";
    hostname = null;
  }

  async function submit() {
    if (!hostname) return;
    setSaving(true);
    setServerError(null);
    try {
      const res = await fetch(api("/api/panel-https"), {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(
          byDomain && chosen ? { domainId: chosen.id, subdomain: label.trim().toLowerCase() } : { hostname }
        ),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        setServerError(body.details?.[0]?.message ?? body.error ?? MSG.saveFailed);
        return;
      }
      toast.success(`${hostname}: ora serve il record DNS`);
      await onChanged();
    } catch {
      toast.error(MSG.unreachable);
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="space-y-4">
      <p className="text-muted text-sm">
        Con un indirizzo come <span className="text-foreground font-mono">https://pannello.esempio.it</span> il pannello si
        apre con il lucchetto, e password e sessione non viaggiano più in chiaro. L&apos;indirizzo che usi adesso continua a
        funzionare: questo è un ingresso in più, e si toglie quando vuoi.
      </p>

      {data.domains.length > 0 && (
        <Segmented
          label="Che indirizzo"
          value={mode}
          onChange={(next) => {
            setMode(next);
            setServerError(null);
          }}
          options={[
            { value: "domain", label: "Un nome su un mio dominio" },
            { value: "typed", label: "Scrivo l'indirizzo intero" },
          ]}
        />
      )}

      {byDomain && chosen ? (
        <div className="grid gap-3 sm:grid-cols-2">
          <SelectField
            label="Dominio"
            value={chosen.id}
            onChange={(next) => {
              setDomainId(next);
              setServerError(null);
            }}
            options={data.domains.map((domain) => ({ value: domain.id, label: domain.name }))}
          />
          <Field label="Nome" hint="Una sola parola, per esempio pannello" error={problem ?? undefined}>
            <div className="flex items-center gap-2">
              <TextField
                value={label}
                onChange={(value) => {
                  setLabel(value);
                  setServerError(null);
                }}
                aria-label="Nome"
                className="flex-1"
              >
                <Input placeholder="pannello" className="font-mono" autoComplete="off" />
              </TextField>
              <span className="text-muted shrink-0 font-mono text-sm">.{chosen.name}</span>
            </div>
          </Field>
        </div>
      ) : (
        <Field
          label="Indirizzo"
          hint="Un nome di un tuo dominio: il record DNS da creare te lo mostro subito dopo"
          error={problem ?? undefined}
        >
          <TextField
            value={typed}
            onChange={(value) => {
              setTyped(value);
              setServerError(null);
            }}
            aria-label="Indirizzo"
          >
            <Input placeholder="pannello.esempio.it" className="font-mono" autoComplete="off" />
          </TextField>
        </Field>
      )}

      {hostname && (
        <div className="bg-surface-secondary rounded-[var(--radius)] px-3 py-2.5">
          <p className="text-muted text-xs">Il pannello si aprirà anche da</p>
          <p className="text-foreground font-mono text-sm break-all">{panelHttpsUrl(hostname)}</p>
        </div>
      )}

      {serverError && (
        <p role="alert" className="text-danger text-sm">
          {serverError}
        </p>
      )}

      <FieldHint>
        Da lì il pannello si raggiunge da internet, protetto dall&apos;accesso come sulla sua porta: conviene attivare la
        verifica in due passaggi, da Account.
      </FieldHint>

      <div className="flex flex-wrap items-center gap-3">
        <Button size="sm" onPress={submit} isPending={saving} isDisabled={!hostname}>
          <Icon icon="solar:shield-check-linear" width={16} aria-hidden />
          Continua
        </Button>
        {data.domains.length === 0 && (
          <span className="text-muted text-xs">
            Hai già un dominio nel pannello? Lo trovi nella pagina{" "}
            <Link href={href("/domains")} className="text-accent hover:underline">
              Domini
            </Link>
            .
          </span>
        )}
      </div>
    </div>
  );
}

type BrowserCheck = "checking" | "ok" | "wrong" | "unreachable";

/**
 * Whether this browser reaches the name over HTTPS and finds this server's
 * token there: DNS, the firewall on 443 and the certificate, as the owner's
 * own network sees them. The answer is readable from here because nginx serves
 * that one path to any origin.
 */
function useBrowserCheck(url: string | null, token: string): { result: BrowserCheck | null; again: () => void } {
  const [attempt, setAttempt] = useState(0);
  const key = url ? `${url}#${attempt}` : null;
  const [answer, setAnswer] = useState<{ key: string; value: BrowserCheck } | null>(null);
  useEffect(() => {
    if (!key || !url) return;
    // Its own flag rather than the signal's: the timeout aborts too, and that answer counts.
    let current = true;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 8_000);
    fetch(url, { cache: "no-store", credentials: "omit", signal: controller.signal })
      .then(async (res) => {
        const text = (await res.text()).trim();
        return res.ok && text === token ? ("ok" as const) : ("wrong" as const);
      })
      .catch(() => "unreachable" as const)
      .then((value) => {
        if (current) setAnswer({ key, value });
      })
      .finally(() => clearTimeout(timer));
    return () => {
      current = false;
      clearTimeout(timer);
      controller.abort();
    };
  }, [key, url, token]);
  return {
    result: !key ? null : answer?.key === key ? answer.value : "checking",
    again: () => setAttempt((n) => n + 1),
  };
}

/** Everything after the name was chosen: DNS, certificate, proof, public address, and the way back. */
function Progress({
  data,
  onChanged,
  onPublicUrlChange,
}: {
  data: Data;
  onChanged: () => Promise<void>;
  onPublicUrlChange: (url: string) => void;
}) {
  const api = useNodeApi();
  const { isRemote } = useNode();
  const host = data.panelHost!;
  const httpsUrl = panelHttpsUrl(host.hostname);
  const here = useHere();
  const hereUrl = urlOf(here);
  const onTheName = !isRemote && hereUrl?.hostname === host.hostname && hereUrl.protocol === "https:";
  const active = host.certificate === "active" || host.certificate === "expiring";
  const ready = data.proxy.state === "ready";

  // The DNS record, looked up again every few seconds while it is not right and the certificate is still to come.
  const dnsPoll = usePollInterval(12_000);
  const [dnsSettled, setDnsSettled] = useState(false);
  const wantsDns = !active && host.certificate !== "issuing";
  const dns = useResource<DnsData>(wantsDns ? api("/api/panel-https/dns") : null, {
    intervalMs: dnsSettled ? 0 : dnsPoll,
    refreshUrl: api("/api/panel-https/dns?fresh=1"),
  });
  const name = dns.data?.names[0] ?? null;
  const nowSettled = name !== null && (name.check.state === "ok" || (name.check.state === "cloudflare" && name.check.ready));
  if (nowSettled !== dnsSettled) setDnsSettled(nowSettled);

  /** Ask for the certificate now; the reason it was refused, or null. */
  const requestCertificate = useCallback(async (): Promise<string | null> => {
    try {
      const res = await fetch(api("/api/panel-https/certificate"), { method: "POST" });
      const body = await res.json().catch(() => ({}));
      await onChanged();
      return res.ok ? null : String(body.error ?? MSG.saveFailed);
    } catch {
      return MSG.unreachable;
    }
  }, [api, onChanged]);

  const [asking, setAsking] = useState(false);
  async function askCertificate() {
    setAsking(true);
    const refused = await requestCertificate();
    setAsking(false);
    if (refused) toast.error(refused);
  }

  // Once per opening: a record that turned right asks for the certificate now, not at the server's next look.
  const asked = useRef(false);
  useEffect(() => {
    if (asked.current || !ready || host.status !== "pending" || !name?.check.ready) return;
    asked.current = true;
    void requestCertificate();
  }, [ready, host.status, name?.check.ready, requestCertificate]);

  // The proof: nginx on this server, then this browser.
  const verify = useResource<PanelVerdict>(active ? api("/api/panel-https/verify") : null);
  const browser = useBrowserCheck(active ? `${httpsUrl}${data.checkPath}` : null, host.checkToken);
  const proven = verify.data?.ok === true && browser.result === "ok";

  const [adopting, setAdopting] = useState(false);
  const [turningOff, setTurningOff] = useState(false);
  const [gone, setGone] = useState<{ removed: string; publicUrl: string | null } | null>(null);

  // What keeps working whatever happens to the name: the address in use now, unless it is the name itself.
  const wayIn = hereUrl && !onTheName && !isRemote ? here : (data.direct[0] ?? null);
  const plainSameName = [here, data.publicUrl].some((raw) => {
    const url = urlOf(raw);
    return url !== null && url.protocol === "http:" && url.hostname === host.hostname;
  });

  async function adopt(): Promise<boolean> {
    const body = await send(api("/api/panel-https/public-url"), { method: "POST" });
    if (!body) return false;
    onPublicUrlChange(String(body.publicUrl ?? httpsUrl));
    toast.success(`L'indirizzo pubblico ora è ${httpsUrl}`);
    await onChanged();
    return true;
  }

  async function turnOff(): Promise<boolean> {
    const body = await send(api("/api/panel-https"), { method: "DELETE" });
    if (!body) return false;
    // Only when it moved: the field above may hold an edit not saved yet.
    if (data.adopted) onPublicUrlChange(typeof body.publicUrl === "string" ? body.publicUrl : "");
    toast.success(`${host.hostname} non serve più il pannello`);
    setGone({ removed: host.hostname, publicUrl: typeof body.publicUrl === "string" ? body.publicUrl : null });
    // On the name itself the next request has nowhere to go: say where the panel is, and stop asking.
    if (!onTheName) await onChanged();
    return true;
  }

  if (gone && onTheName) {
    return (
      <Hint tone="warn" title={`${gone.removed} è stato tolto`}>
        Questa pagina era aperta proprio da lì, quindi da adesso non risponde più. Il pannello è dove è sempre stato:
        {data.direct.length > 0 ? (
          <span className="mt-1 flex flex-col gap-0.5">
            {data.direct.map((url) => (
              <a key={url} href={url} className="text-accent font-mono hover:underline">
                {url}
              </a>
            ))}
          </span>
        ) : (
          " sulla sua porta, all'indirizzo che usavi prima."
        )}
      </Hint>
    );
  }

  const dnsTone: StepTone = active || host.certificate === "issuing" || nowSettled ? "done" : name?.check.state === "elsewhere" ? "problem" : "waiting";
  const certTone: StepTone = active ? "done" : host.certificate === "error" || host.certificate === "expired" || host.applyError ? "problem" : "waiting";
  const proofTone: StepTone = !active ? "waiting" : proven ? "done" : verify.data?.ok === false || browser.result === "wrong" || browser.result === "unreachable" ? "problem" : "waiting";

  return (
    <div className="space-y-6">
      {!ready && (
        <div className="space-y-3">
          <Hint tone="warn" title="nginx non è pronto">
            {data.proxy.detail} Il certificato del pannello aspetta che lo sia.
          </Hint>
          <ProxySetup proxy={data.proxy} onChanged={onChanged} />
        </div>
      )}

      <Step title="Il record DNS" tone={dnsTone}>
        {active || host.certificate === "issuing" ? (
          <p className="text-muted text-sm">{host.hostname} porta a questo server.</p>
        ) : !dns.data && dns.error ? (
          <LoadError what="il controllo del DNS" error={dns.error} onRetry={() => void dns.refresh()} />
        ) : !name ? (
          <SkeletonBlock className="h-32" />
        ) : (
          <>
            <p className="text-muted text-sm">
              Crea questo record nel pannello di chi gestisce il DNS del dominio (il registrar, o Cloudflare). Lo ricontrollo
              da solo finché non è giusto, e poi chiedo il certificato.
            </p>
            <DomainDnsRecords name={name} />
            <div className="flex flex-wrap items-center gap-3">
              <Button size="sm" variant="secondary" onPress={() => void dns.refresh()} isPending={dns.refreshing}>
                <Icon icon="solar:refresh-linear" width={16} aria-hidden />
                Verifica ora
              </Button>
              {!nowSettled && (
                <span className="text-muted inline-flex items-center gap-1.5 text-xs">
                  <Spinner size="sm" />
                  Ricontrollo ogni pochi secondi
                </span>
              )}
            </div>
          </>
        )}
      </Step>

      <Step title="Il certificato HTTPS" tone={certTone}>
        <div className="space-y-1">
          <p className="flex flex-wrap items-center gap-2">
            <span className="text-foreground font-mono text-sm">{host.hostname}</span>
            <AddressBadge host={host} />
          </p>
          <p className={cn("text-xs", host.certificate === "error" || host.applyError ? "text-danger" : "text-muted")}>
            {active ? "Il certificato si rinnova da solo." : addressDetail(host, PROXY_SERVES.has(data.proxy.state))}
          </p>
          {host.status === "error" && host.explanation && host.lastError && (
            <Technical>
              <p className="text-muted font-mono text-meta break-words">{host.lastError}</p>
            </Technical>
          )}
          {host.certExpiresAt && active && (
            <Technical>
              <p className="text-muted text-xs">Valido fino al {formatWhen(host.certExpiresAt)}.</p>
            </Technical>
          )}
        </div>
        {ready && (host.status === "error" || host.status === "pending" || host.certificate === "expiring" || host.certificate === "expired") && (
          <Button size="sm" variant="ghost" onPress={() => void askCertificate()} isPending={asking}>
            <Icon icon="solar:restart-linear" width={16} aria-hidden />
            Richiedi il certificato adesso
          </Button>
        )}
      </Step>

      <Step title="La prova" tone={proofTone}>
        {!active ? (
          <p className="text-muted text-sm">Appena c&apos;è il certificato provo l&apos;indirizzo, dal server e da questo browser.</p>
        ) : (
          <>
            <ul className="space-y-1.5 text-sm">
              {!verify.data ? (
                <li className="text-muted inline-flex items-center gap-2">
                  {verify.error ? `Il server non è riuscito a provarlo: ${verify.error}` : (
                    <>
                      <Spinner size="sm" /> Il server prova l&apos;indirizzo…
                    </>
                  )}
                </li>
              ) : (
                verify.data.checks.map((check) => (
                  <li key={check.id} className="flex items-start gap-2">
                    <Icon
                      icon={check.ok ? "solar:check-circle-linear" : "solar:close-circle-linear"}
                      width={16}
                      className={cn("mt-0.5 shrink-0", check.ok ? "text-success" : "text-danger")}
                      aria-hidden
                    />
                    <span className={check.ok ? "text-muted" : "text-foreground"}>{check.detail}</span>
                  </li>
                ))
              )}
              <li className="flex items-start gap-2">
                {browser.result === "checking" || browser.result === null ? (
                  <span className="mt-0.5 shrink-0">
                    <Spinner size="sm" />
                  </span>
                ) : (
                  <Icon
                    icon={browser.result === "ok" ? "solar:check-circle-linear" : "solar:close-circle-linear"}
                    width={16}
                    className={cn("mt-0.5 shrink-0", browser.result === "ok" ? "text-success" : "text-danger")}
                    aria-hidden
                  />
                )}
                <span className={browser.result === "ok" ? "text-muted" : "text-foreground"}>
                  {browser.result === "ok"
                    ? `Da questo browser ${httpsUrl} si apre, con il lucchetto.`
                    : browser.result === "wrong"
                      ? `Da questo browser ${httpsUrl} porta a un altro server: controlla il record DNS (anche l'AAAA).`
                      : browser.result === "unreachable"
                        ? `Da questo browser ${httpsUrl} non risponde: controlla che la porta 443 sia aperta nel firewall del server (e sul router, se è dietro NAT).`
                        : "Provo l'indirizzo da questo browser…"}
                </span>
              </li>
            </ul>
            <Button
              size="sm"
              variant="secondary"
              onPress={() => {
                void verify.refresh();
                browser.again();
              }}
              isPending={verify.refreshing}
            >
              <Icon icon="solar:refresh-linear" width={16} aria-hidden />
              Prova di nuovo
            </Button>
          </>
        )}
      </Step>

      <Step title="L'indirizzo pubblico" tone={data.adopted ? "done" : "waiting"}>
        {data.adopted ? (
          <div className="space-y-2">
            <p className="text-muted text-sm">
              {httpsUrl} è l&apos;indirizzo con cui il pannello si presenta: webhook, link nelle notifiche, server che si
              collegano. {wayIn ? <>Anche {wayIn} continua a funzionare.</> : null}
            </p>
            {!onTheName && (
              <a href={httpsUrl} className="text-accent inline-flex items-center gap-1 text-sm hover:underline">
                Apri il pannello su {httpsUrl}
                <Icon icon="solar:square-arrow-right-up-linear" width={14} aria-hidden />
              </a>
            )}
            {!onTheName && <FieldHint>Lì si accede di nuovo: ogni indirizzo ha le sue sessioni.</FieldHint>}
          </div>
        ) : proven ? (
          <div className="space-y-2">
            <p className="text-muted text-sm">
              Tutto a posto. Vuoi che il pannello si presenti con {httpsUrl}? Lo useranno i webhook GitHub che colleghi da
              adesso, i link nelle notifiche e i server che si collegano a questo.
            </p>
            <Button size="sm" onPress={() => setAdopting(true)}>
              <Icon icon="solar:shield-check-linear" width={16} aria-hidden />
              Usalo come indirizzo pubblico
            </Button>
          </div>
        ) : (
          <p className="text-muted text-sm">
            Te lo propongo quando la prova è riuscita. Fino ad allora l&apos;indirizzo pubblico resta{" "}
            {data.publicUrl ? <Code>{data.publicUrl}</Code> : "quello dedotto dalla richiesta"}.
          </p>
        )}
      </Step>

      <Technical>
        <KeyValue
          className="text-xs"
          items={[
            { label: "Blocco nginx", value: data.blockFile ?? "—", mono: true },
            { label: "Verso", value: `http://127.0.0.1:${data.port}`, mono: true },
            {
              label: "Header",
              value: "Host, X-Forwarded-Proto, X-Forwarded-Host e X-Forwarded-For li scrive nginx, sostituendo quelli del visitatore",
            },
            {
              label: "X-Forwarded-For",
              value:
                data.trustedProxyHops > 0
                  ? `letto dal pannello (RUNPANEL_TRUSTED_PROXY_HOPS=${data.trustedProxyHops}): tienilo così solo se la porta ${data.port} non è raggiungibile da fuori, o chi la usa direttamente sceglie il proprio indirizzo`
                  : `ignorato (RUNPANEL_TRUSTED_PROXY_HOPS=0): la porta ${data.port} resta aperta, e lì l'header lo scrive il client`,
            },
            { label: "HSTS", value: data.adopted ? "max-age=63072000, senza includeSubDomains" : "non inviato finché non è l'indirizzo pubblico" },
            ...(verify.data?.certificate.issuer ? [{ label: "Emesso da", value: verify.data.certificate.issuer }] : []),
          ]}
        />
      </Technical>

      <div className="border-separator flex flex-wrap items-center justify-between gap-3 border-t pt-4">
        <p className="text-muted text-xs">
          {wayIn ? (
            <>
              Il pannello resta raggiungibile anche da <span className="text-foreground font-mono">{wayIn}</span>.
            </>
          ) : (
            "Il pannello resta raggiungibile anche dalla sua porta, all'indirizzo di sempre."
          )}
        </p>
        <Button size="sm" variant="ghost" className="text-danger" onPress={() => setTurningOff(true)}>
          <Icon icon="solar:power-linear" width={16} aria-hidden />
          Disattiva
        </Button>
      </div>

      <ConfirmDialog
        isOpen={adopting}
        onOpenChange={setAdopting}
        title={`Usare ${httpsUrl} come indirizzo pubblico?`}
        confirmLabel="Usalo"
        onConfirm={adopt}
        description={
          <div className="space-y-2">
            <p>
              Il pannello si presenterà con {httpsUrl}: i webhook GitHub che colleghi da adesso, i link nelle notifiche,
              l&apos;indirizzo dato ai server che si collegano. Quello di prima continua a funzionare, e i webhook già
              registrati restano lì finché non premi Riallinea nella sezione Webhook di un progetto.
            </p>
            <p>
              I browser che aprono {httpsUrl} ricorderanno di usare sempre HTTPS per questo nome
              {plainSameName ? (
                <>
                  : <strong className="text-foreground">http://{host.hostname} con la porta non si aprirà più da lì</strong>, usa
                  il nuovo indirizzo o l&apos;IP del server
                </>
              ) : null}
              .
            </p>
          </div>
        }
      />

      <ConfirmDialog
        isOpen={turningOff}
        onOpenChange={setTurningOff}
        title="Togliere l'HTTPS dal pannello?"
        confirmLabel="Disattiva"
        destructive
        onConfirm={turnOff}
        description={
          <div className="space-y-2">
            <p>
              nginx smette di servire {httpsUrl} e il suo certificato viene cancellato. Il pannello resta raggiungibile{" "}
              {wayIn ? <span className="text-foreground font-mono">da {wayIn}</span> : "dalla sua porta, all'indirizzo di sempre"}.
            </p>
            {data.adopted && (
              <p>
                L&apos;indirizzo pubblico torna a{" "}
                {data.previousPublicUrl ? <Code>{data.previousPublicUrl}</Code> : "quello dedotto dalla richiesta"}. I webhook
                registrati su {httpsUrl} smettono di arrivare finché non li riallinei dai progetti. I browser che l&apos;hanno
                aperto continueranno a chiedere https:// per questo nome.
              </p>
            )}
            {onTheName && (
              <p className="text-warning">
                Stai usando proprio questo indirizzo: dopo, apri il pannello da{" "}
                {data.direct[0] ? <span className="font-mono">{data.direct[0]}</span> : "quello che usavi prima"}.
              </p>
            )}
            {data.clusterUsesName && (
              <p className="text-warning">
                Gli altri server del cluster raggiungono questo proprio da {httpsUrl}: dopo non lo raggiungeranno più, finché
                non cambi l&apos;indirizzo con cui è registrato nel cluster.
              </p>
            )}
          </div>
        }
      />
    </div>
  );
}
