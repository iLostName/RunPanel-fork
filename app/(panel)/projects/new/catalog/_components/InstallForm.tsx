"use client";

import { useMemo, useState, useSyncExternalStore } from "react";
import { Button, Input, TextField } from "@heroui/react";
import { Icon } from "@iconify/react";
import { useResource } from "@/lib/hooks/useResource";
import { useNode, useNodeApi, useServerHref } from "@/lib/hooks/useNode";
import { MSG } from "@/lib/copy";
import { Panel, PanelHeader } from "@/components/ui/Panel";
import { Field } from "@/components/ui/Field";
import { Code } from "@/components/ui/Hint";
import { Advanced } from "@/components/ui/Technical";
import { LinkButton } from "@/components/ui/LinkButton";
import { ServerPicker } from "@/components/cluster/ServerBits";
import { firstFreePort, portsInUse } from "@/lib/ports";
import { hostnameFor, normalizeSubdomain } from "@/lib/proxy-names";
import {
  MIN_APP_PORT,
  answerProblem,
  buildEnvironment,
  defaultAnswers,
  isPublicHost,
  locateApp,
  slugPreview,
  suggestProjectName,
  type CatalogInstallRefusal,
  type CatalogInstallResponse,
  type CatalogQuestion,
  type CatalogTemplate,
} from "@/lib/app-catalog";
import { AboutApp } from "./AboutApp";
import { AddressPanel, type DomainsResponse } from "./AddressPanel";
import { QuestionField } from "./QuestionField";
import { TemplateDetails } from "./TemplateDetails";

type ProjectRow = { name: string; slug: string; port: number | null };
type ServiceRow = { name: string; port: number; access_port?: number | null };

const subscribeNothing = () => () => {};

/**
 * A value only the browser has. Rendered on the server too, where it is the
 * fallback; read after hydration, so the two renders never disagree.
 */
function useBrowserValue(read: () => string, fallback: string): string {
  return useSyncExternalStore(subscribeNothing, read, () => fallback);
}

function hostnameOf(url: string | undefined): string | null {
  if (!url) return null;
  try {
    return new URL(url).hostname.replace(/^\[|\]$/g, "");
  } catch {
    return null;
  }
}

/**
 * The install page: the template's own questions and nothing else.
 *
 * Everything starts filled: the name from the app, a free port, the time zone
 * of this browser, the subdomain from the name. Each field shows its suggestion
 * until it is typed in, and only what was typed is sent where the server can do
 * better — an untouched port is left out, and the server picks one that is free
 * on the machine, not only in the panel's lists. The checks here are the
 * server's own functions, so what passes here is what the server accepts, short
 * of what only the server can see.
 */
export function InstallForm({
  template,
  onInstalled,
}: {
  template: CatalogTemplate;
  onInstalled: (result: CatalogInstallResponse) => void;
}) {
  const api = useNodeApi();
  const href = useServerHref();
  const { current, isRemote } = useNode();
  const zone = useBrowserValue(() => Intl.DateTimeFormat().resolvedOptions().timeZone, "UTC");
  const pageHost = useBrowserValue(() => window.location.hostname, "");
  const pagePort = useBrowserValue(() => window.location.port, "");

  // --- what this server already has -------------------------------------------------
  const { data: projectsData, loading: projectsLoading } = useResource<ProjectRow[]>(api("/api/projects"));
  const { data: servicesData } = useResource<ServiceRow[]>(api("/api/services"));
  const { data: domainsData } = useResource<DomainsResponse>(api("/api/domains"));
  const projects = useMemo(() => (Array.isArray(projectsData) ? projectsData : []), [projectsData]);
  const services = useMemo(() => (Array.isArray(servicesData) ? servicesData : []), [servicesData]);
  const takenSlugs = useMemo(() => new Set(projects.map((p) => p.slug)), [projects]);
  const used = useMemo(() => {
    const ports = portsInUse([...services, ...projects]);
    // The panel itself, when the page was opened on its own port.
    if (/^\d+$/.test(pagePort)) ports.add(Number(pagePort));
    return ports;
  }, [services, projects, pagePort]);
  const ownerOf = (port: number) =>
    projects.find((p) => p.port === port)?.name ?? services.find((s) => s.port === port || s.access_port === port)?.name;

  // --- the answers: suggestions until typed ---------------------------------------------
  const [nameTyped, setNameTyped] = useState<string | null>(null);
  const [typed, setTyped] = useState<Record<string, string>>({});
  const [portTyped, setPortTyped] = useState<string | null>(null);
  const [domainChoice, setDomainChoice] = useState<string | null>(null);
  const [subdomainTyped, setSubdomainTyped] = useState<string | null>(null);
  const [publicHostTyped, setPublicHostTyped] = useState<string | null>(null);
  const [serverErrors, setServerErrors] = useState<Record<string, string>>({});
  const [offer, setOffer] = useState<{ field: string; value: string } | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const name = nameTyped ?? suggestProjectName(template.name, takenSlugs);
  const slug = slugPreview(name);
  const nameProblem = !name.trim()
    ? "Serve un nome"
    : name.trim().length > 100
      ? "Al massimo 100 caratteri"
      : takenSlugs.has(slug)
        ? `Esiste già un progetto con il nome interno «${slug}»`
        : null;

  const suggestedPort = firstFreePort(template.web.defaultPort, used);
  const portText = portTyped ?? String(suggestedPort);
  const typedPort = /^\d{1,5}$/.test(portText.trim()) ? Number(portText.trim()) : Number.NaN;
  const port = Number.isInteger(typedPort) ? typedPort : suggestedPort;
  const portProblem =
    portTyped === null
      ? null
      : !Number.isInteger(typedPort) || typedPort < MIN_APP_PORT || typedPort > 65535
        ? `Una porta tra ${MIN_APP_PORT} e 65535`
        : used.has(typedPort)
          ? `La usa già «${ownerOf(typedPort) ?? "il pannello"}»`
          : null;

  const defaults = useMemo(() => defaultAnswers(template, { timezone: zone }), [template, zone]);
  const portSuggestions = useMemo(() => {
    const taken = new Set([...used, port]);
    const out: Record<string, string> = {};
    for (const question of template.questions) {
      if (!question.port) continue;
      const free = firstFreePort(Number.parseInt(question.default ?? "", 10) || port + 1, taken);
      taken.add(free);
      out[question.key] = String(free);
    }
    return out;
  }, [template, used, port]);

  const valueOf = (question: CatalogQuestion) =>
    typed[question.key] ?? (question.port ? portSuggestions[question.key] : defaults[question.key]) ?? "";
  /** Null for a port question nobody typed in: the server chooses that one. */
  const problemOf = (question: CatalogQuestion): string | null => {
    if (question.port && typed[question.key] === undefined) return null;
    const raw = valueOf(question);
    const problem = answerProblem(question, question.type === "password" ? raw : raw.trim());
    if (problem || !question.port) return problem;
    const n = Number(raw.trim());
    return used.has(n) || n === port ? `La usa già «${n === port ? "l'app stessa" : (ownerOf(n) ?? "il pannello")}»` : null;
  };

  // --- the address ------------------------------------------------------------------
  const domains = domainsData?.domains ?? [];
  const required = template.address === "required";
  const domainId = domainChoice ?? (required ? (domains[0]?.id ?? "") : "");
  const domain = domains.find((d) => d.id === domainId) ?? null;
  const subdomainText = subdomainTyped ?? (slug.slice(0, 63).replace(/-+$/, "") || template.id);
  const label = normalizeSubdomain(subdomainText);
  const hostname = domain && label !== null ? hostnameFor(label, domain.name) : null;
  const hostTaken = hostname ? (domainsData?.hosts ?? []).some((h) => h.hostname === hostname) : false;
  const addressProblem =
    domain && label === null
      ? "Una sola parola: minuscole, numeri e trattini"
      : hostTaken
        ? `${hostname} è già usato da un altro progetto`
        : required && !domain
          ? `${template.name} ha bisogno di un indirizzo`
          : null;

  const defaultHost = (isRemote ? hostnameOf(current?.url) : null) ?? (pageHost || "localhost");
  const publicHost = (publicHostTyped ?? defaultHost).trim().toLowerCase();
  const publicHostProblem = !hostname && !isPublicHost(publicHost) ? "Un nome o un indirizzo IP, senza http:// e senza porta" : null;
  const location = locateApp({ hostname, publicHost: isPublicHost(publicHost) ? publicHost : "localhost", port });

  // A handful of entries, rebuilt on every keystroke: cheaper than keeping a memo honest.
  const answers = Object.fromEntries(template.questions.map((question) => [question.key, valueOf(question)]));
  const preview = buildEnvironment(template, { answers, secrets: {}, location, port });

  const problem =
    [
      nameProblem,
      portProblem,
      ...template.questions.map((question) => {
        const found = problemOf(question);
        return found ? `«${question.label}»: ${found}` : null;
      }),
      addressProblem,
      publicHostProblem,
    ].find(Boolean) ?? null;

  /** A field's refusal goes as soon as the field is edited: it was about the old value. */
  function forget(field: string) {
    if (!serverErrors[field] && offer?.field !== field) return;
    setServerErrors((errors) => {
      const next = { ...errors };
      delete next[field];
      return next;
    });
    if (offer?.field === field) setOffer(null);
  }

  async function install() {
    if (problem || submitting) return;
    setSubmitting(true);
    setServerErrors({});
    setOffer(null);

    const sent: Record<string, string> = {};
    for (const question of template.questions) {
      // An untouched port is the server's to choose: it sees what is listening.
      if (question.port && typed[question.key] === undefined) continue;
      sent[question.key] = question.type === "password" ? valueOf(question) : valueOf(question).trim();
    }

    try {
      const res = await fetch(api("/api/catalog/install"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          templateId: template.id,
          name: name.trim(),
          ...(portTyped !== null ? { port: typedPort } : {}),
          answers: sent,
          address: domain && label !== null ? { domainId: domain.id, subdomain: label } : null,
          publicHost,
        }),
      });
      const data = (await res.json().catch(() => ({}))) as Partial<CatalogInstallResponse & CatalogInstallRefusal>;
      if (res.status === 201 && data.project) {
        onInstalled(data as CatalogInstallResponse);
        return;
      }
      const field = data.field && /^(name|port|address|answers\.[A-Z0-9_]+)$/.test(data.field) ? data.field : "general";
      setServerErrors({ [field]: data.error ?? `Il server ha risposto ${res.status}` });
      if (data.suggestedName) setOffer({ field: "name", value: data.suggestedName });
      else if (data.suggestedPort) setOffer({ field, value: String(data.suggestedPort) });
    } catch {
      setServerErrors({ general: MSG.unreachable });
    }
    setSubmitting(false);
  }

  function acceptOffer() {
    if (!offer) return;
    if (offer.field === "name") setNameTyped(offer.value);
    else if (offer.field === "port") setPortTyped(offer.value);
    else if (offer.field.startsWith("answers.")) {
      const key = offer.field.slice("answers.".length);
      setTyped((t) => ({ ...t, [key]: offer.value }));
    }
    setServerErrors({});
    setOffer(null);
  }

  const serverMessage = Object.values(serverErrors)[0] ?? null;
  const renderQuestion = (question: CatalogQuestion) => (
    <QuestionField
      key={question.key}
      question={question}
      value={valueOf(question)}
      onChange={(value) => {
        setTyped((t) => ({ ...t, [question.key]: value }));
        forget(`answers.${question.key}`);
      }}
      error={serverErrors[`answers.${question.key}`] ?? problemOf(question)}
    />
  );

  return (
    <div className="max-w-2xl space-y-4">
      <AboutApp template={template} />

      <Panel className="space-y-5">
        <PanelHeader title="L'app" />
        <ServerPicker description="L'app vivrà su questo server: container, dati e porte stanno lì." />
        <Field
          label="Nome"
          hint="Come la vedrai nel pannello. Diventa anche il nome della cartella e dello stack."
          error={serverErrors.name ?? (nameTyped !== null ? nameProblem : null)}
        >
          <TextField
            value={name}
            onChange={(value) => {
              setNameTyped(value);
              forget("name");
            }}
            aria-label="Nome"
          >
            <Input placeholder={template.name} />
          </TextField>
        </Field>
        {template.questions.filter((q) => !q.advanced).map(renderQuestion)}
      </Panel>

      <AddressPanel
        template={template}
        domains={domains}
        proxy={domainsData?.proxy}
        domainId={domainId}
        onDomain={(id) => {
          setDomainChoice(id);
          forget("address");
        }}
        subdomain={subdomainText}
        onSubdomain={(value) => {
          setSubdomainTyped(value);
          forget("address");
        }}
        hostname={hostname}
        error={serverErrors.address ?? (domain ? addressProblem : null)}
        domainsHref={href("/domains")}
      />

      {/* For whoever wants to see, or change, what is deployed. */}
      <Advanced summary="porta, file Compose, variabili">
        <Field
          label="Porta sul server"
          hint={
            portTyped === null
              ? "Ne ho scelta una libera. Se al momento dell'installazione risulta occupata, ne prendo un'altra."
              : `Dentro il container l'app risponde sulla ${template.web.internalPort}: questa è la porta che lo stack pubblica sul server.`
          }
          error={serverErrors.port ?? portProblem}
        >
          <TextField
            value={portText}
            onChange={(value) => {
              setPortTyped(value);
              forget("port");
            }}
            aria-label="Porta sul server"
          >
            <Input inputMode="numeric" className="max-w-[10rem] font-mono text-sm" />
          </TextField>
        </Field>
        {template.questions.filter((q) => q.advanced).map(renderQuestion)}
        {!hostname && (
          <Field
            label="Nome del server"
            hint={
              <>
                L&apos;app lo usa nei propri link finché non ha un indirizzo: <Code>{location.url}</Code>
              </>
            }
            error={publicHostTyped !== null ? publicHostProblem : null}
          >
            <TextField value={publicHostTyped ?? defaultHost} onChange={setPublicHostTyped} aria-label="Nome del server">
              <Input className="font-mono text-sm" placeholder="192.168.1.10" />
            </TextField>
          </Field>
        )}
        <TemplateDetails template={template} preview={preview} />
      </Advanced>

      <Panel className="space-y-3">
        <p className="text-foreground text-sm">{summaryLine(template, name, hostname, port)}</p>
        {(serverMessage || problem) && (
          <div className="space-y-2" role="alert">
            <p className="text-danger text-sm">{serverMessage ?? problem}</p>
            {offer && (
              <Button variant="secondary" size="sm" onPress={acceptOffer}>
                {offer.field === "name" ? `Usa «${offer.value}»` : `Usa la porta ${offer.value}`}
              </Button>
            )}
          </div>
        )}
        <div className="flex flex-wrap items-center justify-between gap-2">
          <LinkButton href={href("/projects/new/catalog")}>
            <Icon icon="solar:alt-arrow-left-linear" width={16} aria-hidden />
            Catalogo
          </LinkButton>
          {/* Held while the project list loads: the suggested name is checked against it. */}
          <Button
            variant="primary"
            isDisabled={Boolean(problem) || (projectsLoading && !projectsData)}
            isPending={submitting}
            onPress={install}
          >
            <Icon icon="solar:rocket-2-linear" width={16} aria-hidden />
            Installa e metti online
          </Button>
        </div>
        {submitting && (
          <p className="text-muted text-xs" aria-live="polite">
            Controllo il server, scrivo i file e creo il progetto…
          </p>
        )}
      </Panel>
    </div>
  );
}

/** One sentence saying what the button will do. */
function summaryLine(template: CatalogTemplate, name: string, hostname: string | null, port: number): string {
  let line = `Installo «${name.trim() || template.name}»`;
  if (template.databases.length > 0) line += ` con ${template.databases.map((d) => d.engine).join(" e ")}`;
  line += hostname ? `, la metto su ${hostname}` : `, sulla porta ${port}`;
  return `${line} e faccio il primo deploy.`;
}
